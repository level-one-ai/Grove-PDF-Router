/**
 * /api/webhook
 *
 * Receives Microsoft Graph API change notifications.
 *
 * AUTO MODE:
 *   - Scans folder oldest-first
 *   - Moves already-completed files still in Scans to Processed
 *   - Processes new files automatically through full pipeline
 *   - Respects stop flag stored in Firestore settings/autoControl
 *
 * HUMAN MODE:
 *   - Downloads and splits only
 *   - Adds to waiting list for manual approval
 */

const db = require('../lib/firebase');
const { downloadFile, graphRequest, uploadFile } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const { startDispatch } = require('../lib/queue');
const axios = require('axios');

module.exports = async function handler(req, res) {
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[webhook] Validation token handshake');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.status(202).json({ status: 'accepted' });

  try {
    const notifications = req.body?.value || [];
    if (notifications.length === 0) return;

    const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
    const valid = notifications.find(n => n.clientState === expectedSecret);
    if (!valid) {
      console.warn('[webhook] Invalid clientState — ignoring');
      return;
    }

    console.log('[webhook] Valid notification received');
    await scanAndProcess();
  } catch (err) {
    console.error('[webhook] Error:', err.message);
  }
};

async function scanAndProcess() {
  const userId = process.env.ONEDRIVE_USER_ID;
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
  const processedPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';

  // Get all PDFs in Scans folder
  const result = await graphRequest(
    'GET',
    `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,file,createdDateTime&$top=100`
  );

  const allItems = result?.value || [];

  // Filter to PDFs only
  const pdfFiles = allItems.filter(item => {
    const name = (item.name || '').toLowerCase();
    const mime = item.file?.mimeType || '';
    return name.endsWith('.pdf') || mime.includes('pdf');
  });

  // Sort oldest first
  pdfFiles.sort((a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime));

  const mode = await db.getMode();
  console.log(`[webhook] Mode: ${mode} — ${pdfFiles.length} PDF(s) found`);

  for (const file of pdfFiles) {
    const existing = await db.getRecord(file.id);

    // Already completed — move to Processed if still in Scans
    if (existing && existing.status === 'completed') {
      console.log(`[webhook] "${file.name}" already completed — moving to Processed`);
      await moveToProcessed(file.id, file.name, userId, folderPath, processedPath);
      continue;
    }

    // Skip files already in progress or waiting (not reset)
    if (existing && !['reset', null, undefined].includes(existing.status)) {
      console.log(`[webhook] Skipping "${file.name}" — status: ${existing.status}`);
      continue;
    }

    // Check stop flag before processing each new file
    if (mode === 'auto') {
      const stopped = await db.isAutoStopped();
      if (stopped) {
        console.log('[webhook] Auto mode stopped — halting processing');
        break;
      }
    }

    console.log(`[webhook] Processing: "${file.name}"`);
    await processFile(file.id, file.name, mode);
  }
}

async function moveToProcessed(itemId, fileName, userId, fromPath, toPath) {
  try {
    // Check if file exists in Processed already
    const token = await getToken();
    const destUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${toPath}/${fileName}`;

    try {
      await axios.get(destUrl, { headers: { Authorization: `Bearer ${token}` } });
      // File already in Processed — just delete from Scans
      console.log(`[webhook] "${fileName}" already in Processed — removing from Scans`);
    } catch (e) {
      // Not in Processed — move it
      const moveUrl = `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}`;
      const destFolderRes = await axios.get(
        `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${toPath}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const destFolderId = destFolderRes.data.id;

      await axios.patch(moveUrl, {
        parentReference: { id: destFolderId },
        name: fileName,
      }, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      console.log(`[webhook] Moved "${fileName}" to Processed`);
    }
  } catch (err) {
    console.warn(`[webhook] Could not move "${fileName}":`, err.message);
  }
}

async function processFile(itemId, fileName, mode) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');

  // Create or reset record
  const existing = await db.getRecord(itemId);
  if (existing) {
    await db.updateRecord(itemId, {
      status: 'processing', pagesReturned: 0, totalPages: null,
      pages: {}, renamedFiles: [], pageStore: {}, completedAt: null, error: null,
    });
  } else {
    await db.createRecord(itemId, originalFileName);
  }

  // Download
  let pdfBuffer;
  try {
    pdfBuffer = await downloadFile(itemId);
    console.log(`[webhook] Downloaded "${originalFileName}" (${pdfBuffer.length} bytes)`);
  } catch (err) {
    await db.markError(itemId, err);
    return;
  }

  // Split
  let pages, totalPages;
  try {
    ({ pages, totalPages } = await splitPdf(pdfBuffer));
    console.log(`[webhook] Split into ${totalPages} page(s)`);
  } catch (err) {
    await db.markError(itemId, err);
    return;
  }

  // Upload pages to temp
  const pageStore = await uploadPagesToTemp(pages, itemId);
  await db.updateRecord(itemId, { pageStore, totalPages, currentDispatchPage: 1, pagesReturned: 0 });

  if (mode === 'human') {
    await db.updateRecord(itemId, { status: 'waiting', totalPages, mode: 'human' });
    await db.addWaitingFile(itemId, fileName, totalPages);
    console.log(`[webhook] Human mode — "${originalFileName}" waiting`);
  } else {
    // AUTO — dispatch immediately
    try {
      await startDispatch(pages, itemId, originalFileName);
      console.log(`[webhook] Auto — page 1/${totalPages} dispatched for "${originalFileName}"`);
    } catch (err) {
      await db.markError(itemId, err);
    }
  }
}

async function uploadPagesToTemp(pages, fileId) {
  const userId = process.env.ONEDRIVE_USER_ID;
  const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';
  const token = await getToken();
  const pageStore = {};

  for (const page of pages) {
    const tempFileName = `${fileId}_page_${page.zeroPadded}.pdf`;
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${TEMP_FOLDER}/${tempFileName}:/content`;
    const response = await axios.put(url, page.buffer, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
      maxBodyLength: Infinity,
    });
    pageStore[page.pageNumber] = { zeroPadded: page.zeroPadded, tempItemId: response.data.id, tempFileName };
  }
  return pageStore;
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
