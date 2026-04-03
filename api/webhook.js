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
const { downloadFile, graphRequest } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const axios = require('axios');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

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
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
  const processedPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';

  const result = await graphRequest(
    'GET',
    `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,file,createdDateTime&$top=100`
  );

  const pdfFiles = (result?.value || [])
    .filter(item => {
      const name = (item.name || '').toLowerCase();
      const mime = item.file?.mimeType || '';
      return name.endsWith('.pdf') || mime.includes('pdf');
    })
    .sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime)); // newest first

  const mode = await db.getMode();
  console.log(`[webhook] Mode: ${mode} — ${pdfFiles.length} PDF(s)`);

  // Get token once for all file checks
  const token = await getToken();

  for (const file of pdfFiles) {
    const existing = await db.getRecord(file.id);

    // Already completed — check if still in Scans and delete it
    if (existing && existing.status === 'completed') {
      console.log(`[webhook] "${file.name}" already completed — removing from Scans`);
      await deleteFromScans(file.id, file.name, userId, token);
      continue;
    }

    // Already processing, waiting, or errored — skip
    if (existing && !['reset', null, undefined].includes(existing.status)) {
      console.log(`[webhook] Skipping "${file.name}" — status: ${existing.status}`);
      continue;
    }

    // Check stop flag in auto mode
    if (mode === 'auto') {
      const stopped = await db.isAutoStopped();
      if (stopped) {
        console.log('[webhook] Stopped — halting');
        break;
      }
    }

    const isOldFile = await db.isOldFile(file.id);
    console.log(`[webhook] Processing: "${file.name}" (${isOldFile ? 'old-queue' : 'NEW — priority'})`);
    await processFile(file.id, file.name, mode);
  }
}

async function processFile(itemId, fileName, mode) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');

  // Create Firestore record
  const existing = await db.getRecord(itemId);
  if (existing) {
    await db.updateRecord(itemId, {
      status: 'processing', pagesReturned: 0, totalPages: null,
      pages: {}, renamedFiles: [], pageStore: {}, completedAt: null, error: null,
    });
  } else {
    await db.createRecord(itemId, originalFileName);
  }

  // Download PDF
  let pdfBuffer;
  try {
    pdfBuffer = await downloadFile(itemId);
    console.log(`[webhook] Downloaded "${originalFileName}" (${pdfBuffer.length} bytes)`);
  } catch (err) {
    console.error(`[webhook] Download failed:`, err.message);
    await db.markError(itemId, err);
    return;
  }

  // Split PDF — handle invalid/corrupted PDFs gracefully
  let pages, totalPages;
  try {
    ({ pages, totalPages } = await splitPdf(pdfBuffer));
    console.log(`[webhook] Split into ${totalPages} page(s)`);
  } catch (splitErr) {
    console.error(`[webhook] Invalid PDF "${originalFileName}": ${splitErr.message}`);
    try {
      const nonOrderPath = 'Grove Group Scotland/Grove Bedding/Scans/Non-Order Documents';
      const userId2 = process.env.ONEDRIVE_USER_ID;
      const token2 = await getToken();
      const destRes = await axios.get(
        `https://graph.microsoft.com/v1.0/users/${userId2}/drive/root:/${nonOrderPath}`,
        { headers: { Authorization: `Bearer ${token2}` } }
      );
      await axios.patch(
        `https://graph.microsoft.com/v1.0/users/${userId2}/drive/items/${itemId}`,
        { parentReference: { id: destRes.data.id }, name: fileName },
        { headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' } }
      );
      console.log(`[webhook] Moved invalid PDF "${fileName}" to Non-Order Documents`);
    } catch (moveErr) {
      console.warn(`[webhook] Could not move invalid PDF:`, moveErr.message);
    }
    await db.markError(itemId, { message: `Invalid PDF: ${splitErr.message}` });
    return;
  }

  // Update record with total pages
  await db.updateRecord(itemId, { totalPages, currentDispatchPage: 1, pagesReturned: 0 });

  if (mode === 'human') {
    // Upload all pages to Temp then add to waiting list
    const pageStore = await uploadAllPagesToTemp(pages, itemId);
    await db.updateRecord(itemId, { pageStore, status: 'waiting', mode: 'human' });
    await db.addWaitingFile(itemId, fileName, totalPages);
    console.log(`[webhook] Human mode — "${originalFileName}" waiting`);
  } else {
    // AUTO: Upload page 1 first, dispatch it, then upload remaining pages
    const token = await getToken();
    const userId = process.env.ONEDRIVE_USER_ID;

    // Upload page 1
    const page1 = pages[0];
    const page1ItemId = await uploadPageToTemp(page1, itemId, token, userId);
    const pageStore = {};
    pageStore[String(page1.pageNumber)] = {
      zeroPadded: page1.zeroPadded,
      tempItemId: page1ItemId,
      tempFileName: `${itemId}_page_${page1.zeroPadded}.pdf`,
    };

    // Save page 1 to Firestore and dispatch immediately
    await db.updateRecord(itemId, { pageStore });
    await dispatchToMake(page1.pageNumber, page1.zeroPadded, itemId, originalFileName, totalPages, page1ItemId);
    console.log(`[webhook] Page 1/${totalPages} dispatched for "${originalFileName}"`);

    // Upload remaining pages in background (non-blocking)
    // These will be ready when Make.com callbacks arrive
    uploadRemainingPages(pages.slice(1), itemId, originalFileName, token, userId, pageStore)
      .catch(err => console.error('[webhook] Error uploading remaining pages:', err.message));
  }
}

async function uploadRemainingPages(remainingPages, fileId, originalFileName, token, userId, pageStore) {
  for (const page of remainingPages) {
    if (!page.buffer) continue;
    const tempItemId = await uploadPageToTemp(page, fileId, token, userId);
    pageStore[String(page.pageNumber)] = {
      zeroPadded: page.zeroPadded,
      tempItemId,
      tempFileName: `${fileId}_page_${page.zeroPadded}.pdf`,
    };
    // Update Firestore after each page upload so it's available for callbacks
    await db.updateRecord(fileId, { [`pageStore.${page.pageNumber}`]: pageStore[String(page.pageNumber)] });
    console.log(`[webhook] Uploaded page ${page.pageNumber} to Temp`);
  }
}

async function uploadAllPagesToTemp(pages, fileId) {
  const token = await getToken();
  const userId = process.env.ONEDRIVE_USER_ID;
  const pageStore = {};
  for (const page of pages) {
    if (!page.buffer) continue;
    const tempItemId = await uploadPageToTemp(page, fileId, token, userId);
    pageStore[String(page.pageNumber)] = {
      zeroPadded: page.zeroPadded,
      tempItemId,
      tempFileName: `${fileId}_page_${page.zeroPadded}.pdf`,
    };
  }
  return pageStore;
}

async function uploadPageToTemp(page, fileId, token, userId) {
  const tempFileName = `${fileId}_page_${page.zeroPadded}.pdf`;
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${TEMP_FOLDER}/${tempFileName}:/content`;
  const response = await axios.put(url, page.buffer, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
    maxBodyLength: Infinity,
  });
  return response.data.id;
}

async function dispatchToMake(pageNumber, zeroPadded, fileId, originalFileName, totalPages, tempItemId) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  const fileName = `${originalFileName}_${zeroPadded}.pdf`;
  const payload = {
    fileName, fileId, tempItemId,
    pageNumber, totalPages,
    originalName: originalFileName,
    zeroPadded,
    secret: process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
  };
  await axios.post(webhookUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
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
