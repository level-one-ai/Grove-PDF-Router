/**
 * /api/scan-now
 *
 * Manually triggers scanAndProcess() — processes all existing PDFs
 * in the Scans folder in auto mode, oldest first.
 *
 * Called by the dashboard "Process All" button in auto mode.
 * This is the same logic the webhook uses when a new file arrives,
 * but triggered manually so existing files get picked up immediately.
 *
 * POST /api/scan-now
 */

const db = require('../lib/firebase');
const { downloadFile, graphRequest } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const axios = require('axios');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

module.exports.config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 300,
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Return immediately — processing happens async
  res.status(200).json({ status: 'scanning', message: 'Scan started — check Vercel logs for progress' });

  try {
    await scanAndProcess();
  } catch (err) {
    console.error('[scan-now] Error:', err.message);
  }
};

async function scanAndProcess() {
  const userId = process.env.ONEDRIVE_USER_ID;
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';

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
  console.log(`[scan-now] Mode: ${mode} — ${pdfFiles.length} PDF(s) in Scans`);

  if (mode !== 'auto') {
    console.log('[scan-now] Not in auto mode — skipping');
    return;
  }

  const token = await getToken();

  let dispatched = 0;

  for (const file of pdfFiles) {
    const existing = await db.getRecord(file.id);

    // Already completed — delete from Scans
    if (existing && existing.status === 'completed') {
      console.log(`[scan-now] "${file.name}" already completed — removing from Scans`);
      await deleteFromScans(file.id, file.name, userId, token);
      continue;
    }

    // Already in progress — skip (Make.com is handling it)
    if (existing && !['reset', null, undefined].includes(existing.status)) {
      console.log(`[scan-now] Skipping "${file.name}" — status: ${existing.status}`);
      continue;
    }

    // Check stop flag
    const stopped = await db.isAutoStopped();
    if (stopped) {
      console.log('[scan-now] Stopped flag set — halting');
      break;
    }

    console.log(`[scan-now] Processing: "${file.name}"`);
    await processFile(file.id, file.name, token, userId);
    dispatched++;

    // Only dispatch one file at a time — Make.com processes it page by page
    // file-page.js will call /api/scan-now again after completion to pick up the next file
    // This prevents overwhelming Make.com with concurrent files
    console.log(`[scan-now] Dispatched "${file.name}" — waiting for Make.com to process before next file`);
    break;
  }

  if (dispatched === 0) {
    console.log('[scan-now] No files to process — all done or in progress');
  }
}

async function processFile(itemId, fileName, token, userId) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');

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
    console.log(`[scan-now] Downloaded "${originalFileName}" (${pdfBuffer.length} bytes)`);
  } catch (err) {
    console.error(`[scan-now] Download failed:`, err.message);
    await db.markError(itemId, err);
    return;
  }

  // Split
  let pages, totalPages;
  try {
    ({ pages, totalPages } = await splitPdf(pdfBuffer));
    console.log(`[scan-now] Split into ${totalPages} page(s)`);
  } catch (err) {
    console.error(`[scan-now] Split failed:`, err.message);
    await db.markError(itemId, err);
    return;
  }

  await db.updateRecord(itemId, { totalPages, currentDispatchPage: 1, pagesReturned: 0 });

  // Upload page 1 and dispatch
  const page1 = pages[0];
  const page1ItemId = await uploadPageToTemp(page1, itemId, token, userId);
  const pageStore = {};
  pageStore[String(page1.pageNumber)] = {
    zeroPadded: page1.zeroPadded,
    tempItemId: page1ItemId,
    tempFileName: `${itemId}_page_${page1.zeroPadded}.pdf`,
  };
  await db.updateRecord(itemId, { pageStore });
  await dispatchToMake(1, page1.zeroPadded, itemId, originalFileName, totalPages, page1ItemId);
  console.log(`[scan-now] Page 1/${totalPages} dispatched for "${originalFileName}"`);

  // Upload remaining pages in background
  uploadRemainingPages(pages.slice(1), itemId, token, userId, pageStore)
    .catch(err => console.error('[scan-now] Remaining pages error:', err.message));
}

async function uploadRemainingPages(remainingPages, fileId, token, userId, pageStore) {
  for (const page of remainingPages) {
    if (!page.buffer) continue;
    const tempItemId = await uploadPageToTemp(page, fileId, token, userId);
    pageStore[String(page.pageNumber)] = {
      zeroPadded: page.zeroPadded,
      tempItemId,
      tempFileName: `${fileId}_page_${page.zeroPadded}.pdf`,
    };
    await db.updateRecord(fileId, {
      [`pageStore.${page.pageNumber}`]: pageStore[String(page.pageNumber)]
    });
  }
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
  const payload = {
    fileName: `${originalFileName}_${zeroPadded}.pdf`,
    fileId, tempItemId, pageNumber, totalPages,
    originalName: originalFileName, zeroPadded,
    secret: process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
  };
  await axios.post(process.env.MAKE_WEBHOOK_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

async function deleteFromScans(itemId, fileName, userId, token) {
  try {
    await axios.get(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await axios.delete(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[scan-now] Deleted "${fileName}" from Scans`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[scan-now] "${fileName}" already gone`);
    } else {
      console.warn(`[scan-now] Could not delete "${fileName}":`, err.message);
    }
  }
}

async function getToken() {
  const r = await axios.post(
    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return r.data.access_token;
}
