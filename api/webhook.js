const { logRead } = require('../lib/logRead');
/**
 * /api/webhook
 *
 * Receives Microsoft Graph API change notifications.
 * Responds immediately then processes in background.
 *
 * To stay under Vercel's 60s timeout:
 * - Responds 202 instantly
 * - Downloads + splits PDF in background
 * - Uploads pages to Temp ONE AT A TIME
 * - Dispatches page 1 to Make.com as soon as it's uploaded
 * - Remaining pages uploaded in background ready for later dispatch
 */

const db = require('../lib/firebase');
const { graphRequest } = require('../lib/graph');
const axios = require('axios');


module.exports = async function handler(req, res) {
  // Graph API validation handshake
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[webhook] Validation token handshake');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Respond immediately — Graph API requires response within 3 seconds.
  // Graph sometimes drops the connection before TLS completes on a cold start,
  // causing ECONNRESET. Catch it so background processing still runs regardless.
  try {
    res.status(202).json({ status: 'accepted' });
  } catch (connErr) {
    console.warn('[webhook] Could not send 202 (Graph disconnected early — harmless):', connErr.message);
  }

  try {
    const notifications = req.body?.value || [];
    if (!notifications.length) return;

    const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
    const valid = notifications.find(n => n.clientState === expectedSecret);
    if (!valid) {
      console.warn('[webhook] Invalid clientState — ignoring');
      return;
    }

    await scanAndProcess();
  } catch (err) {
    console.error('[webhook] Error:', err.message);
  }
};

async function scanAndProcess() {
  // Ensure auto-poll is running — starts it if dead (e.g. fresh deployment)
  ensureAutoPollRunning().catch(() => {}); // fire-and-forget, non-fatal

  const userId = process.env.ONEDRIVE_USER_ID;
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';

  const result = await graphRequest(
    'GET',
    `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,file,size,createdDateTime&$top=100`
  );

  const pdfFiles = (result?.value || [])
    .filter(item => {
      const name = (item.name || '').toLowerCase();
      const mime = item.file?.mimeType || '';
      return name.endsWith('.pdf') || mime.includes('pdf');
    })
    .sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime));

  console.log(`[webhook] ${pdfFiles.length} PDF(s) in Scans`);

  const token = await getToken();
  let newFilesDetected = [];

  // Batch read all records in one Firestore call instead of one per file
  const records = await batchGetRecords(pdfFiles.map(f => f.id));
  logRead('webhook batch check', pdfFiles.length);

  for (const file of pdfFiles) {
    const existing = records[file.id];

    // Already completed — clean up
    if (existing && existing.status === 'completed') {
      console.log(`[webhook] "${file.name}" already completed — removing from Scans`);
      await deleteFromScans(file.id, file.name, userId, token);
      continue;
    }

    // Already processing, waiting, or errored — skip
    // 'detected' is NOT skipped — it means we saw it before but scan-now may not
    // have triggered yet. Allow webhook to re-trigger processing for it.
    if (existing && !['reset', 'detected', null, undefined].includes(existing.status)) {
      console.log(`[webhook] Skipping "${file.name}" — status: ${existing.status}`);
      continue;
    }

    // This is a new or re-detected file — record it
    console.log(`[webhook] New file detected: "${file.name}" (status: ${existing?.status || 'none'})`);
    newFilesDetected.push(file);
  }

  if (newFilesDetected.length === 0) {
    console.log('[webhook] No new files to process');
    return;
  }

  // ── STEP 1: Notify dashboard immediately so scans panel updates ──
  // This fires regardless of mode — the dashboard always sees new files instantly.
  await notifyDashboard(newFilesDetected);

  // ── STEP 2: Always auto-process — system is always watching ──
  // Wait 3 seconds so dashboard has time to update visually before processing starts
  await sleep(3000);

  // Trigger scan-now which handles the full processing logic including priority ordering
  const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
  try {
    await axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log('[webhook] Triggered scan-now after 3s delay');
  } catch (err) {
    console.warn('[webhook] scan-now trigger warning:', err.message);
  }
}

async function notifyDashboard(files) {
  const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
  try {
    await axios.post(`${baseUrl}/api/notify`, {
      secret: process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
      event: 'new-file',
      data: {
        count: files.length,
        files: files.map(f => ({ id: f.id, name: f.name, size: f.size, createdAt: f.createdDateTime })),
      },
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });
    console.log(`[webhook] Dashboard notified — ${files.length} new file(s)`);
  } catch (err) {
    // Non-fatal — dashboard will catch up on its next poll
    console.warn('[webhook] Dashboard notify warning (non-fatal):', err.message);
  }
}


async function deleteFromScans(itemId, fileName, userId, token) {
  try {
    // Check if file still exists in Scans first
    await axios.get(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    // File exists — delete it
    await axios.delete(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[webhook] Deleted "${fileName}" from Scans`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[webhook] "${fileName}" already gone from Scans — skipping delete`);
    } else {
      console.warn(`[webhook] Could not delete "${fileName}" from Scans:`, err.message);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Batch read multiple Firestore records in one call.
 * Returns { fileId: data | null }
 */
async function batchGetRecords(fileIds) {
  if (!fileIds.length) return {};
  try {
    const admin = require('firebase-admin');
    const firestore = admin.firestore();
    const refs = fileIds.map(id => firestore.collection('processedFiles').doc(id));
    const docs = await firestore.getAll(...refs);
    const result = {};
    docs.forEach(doc => { result[doc.id] = doc.exists ? doc.data() : null; });
    return result;
  } catch (err) {
    console.warn('[webhook] batchGetRecords error, falling back:', err.message);
    const result = {};
    for (const id of fileIds) {
      try { result[id] = await db.getRecord(id); } catch (e) { result[id] = null; }
    }
    return result;
  }
}

/**
 * Ensure auto-poll is running when webhook fires.
 * auto-poll may not be running on fresh deployments until cron runs.
 * Checking heartbeat here means any incoming file also restarts the safety net.
 */
async function ensureAutoPollRunning() {
  try {
    const admin = require('firebase-admin');
    const firestore = admin.firestore();
    const lockDoc = await firestore.collection('settings').doc('autoPollLock').get();
    const STALE_MS = 2 * 60 * 1000; // 2 minutes
    let needsStart = true;
    if (lockDoc.exists) {
      const heartbeat = lockDoc.data().heartbeat
        ? new Date(lockDoc.data().heartbeat).getTime() : 0;
      if (Date.now() - heartbeat < STALE_MS) needsStart = false;
    }
    if (needsStart) {
      const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
      axios.post(`${baseUrl}/api/auto-poll`, {}, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      }).catch(() => {});
      console.log('[webhook] auto-poll was not running — started it');
    }
  } catch (err) {
    // Non-fatal
  }
}

async function getToken() {
  const url = `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });
  const r = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return r.data.access_token;
}
