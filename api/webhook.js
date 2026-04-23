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
  const userId = process.env.ONEDRIVE_USER_ID;
  const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';

  // List Scans folder for dashboard notification — best-effort, non-blocking
  // No Firestore reads here — scan-now handles all the Firestore logic internally
  let newFiles = [];
  try {
    const result = await graphRequest(
      'GET',
      `/users/${userId}/drive/root:/Grove Group Scotland/Grove Bedding/Scans:/children` +
      `?$select=id,name,size,createdDateTime,file&$top=100`
    );
    newFiles = (result?.value || [])
      .filter(item => {
        const name = (item.name || '').toLowerCase();
        const mime = item.file?.mimeType || '';
        return name.endsWith('.pdf') || mime.includes('pdf');
      })
      .sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime));
    console.log(`[webhook] ${newFiles.length} PDF(s) in Scans`);
  } catch (err) {
    console.warn('[webhook] Could not list Scans (non-fatal):', err.message);
  }

  // Notify dashboard so the Scans panel refreshes immediately
  if (newFiles.length > 0) {
    await notifyDashboard(newFiles);
  }

  // Trigger scan-now — it handles Firestore, priority ordering, and processing
  try {
    await axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log('[webhook] Triggered scan-now');
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



function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


/**
 * ensureAutoPollRunning — RETIRED (no-op stub)
 * auto-poll has been retired. Detection is handled by Make.com Watch Files.
 * This stub prevents errors from any call sites that still reference this function.
 */
async function ensureAutoPollRunning() {
  // no-op — auto-poll retired, Make.com handles detection
}

