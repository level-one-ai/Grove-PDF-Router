/**
 * /api/test-run
 *
 * Triggers the processing pipeline for a specific file from the dashboard.
 * Uses SSE to stream progress back to the browser.
 *
 * Stays under 60s timeout by:
 * - Only doing download + split + upload page 1 + dispatch page 1
 * - Filing is handled by /api/file-page (triggered by /api/callback)
 * - Polls Firestore for completion status
 */

const db = require('../lib/firebase');
const { downloadFile } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const axios = require('axios');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    responseLimit: false,
  },
  maxDuration: 300, // Vercel Pro allows up to 300 seconds
};

module.exports = async function handler(req, res) {
  // Auth check using Basic Auth header
  const auth = req.headers['authorization'];
  if (auth) {
    const [user, ...passParts] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    const pass = passParts.join(':');
    if (user !== process.env.DASHBOARD_USERNAME || pass !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorised' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileId, fileName } = req.body || {};
  if (!fileId || !fileName) {
    return res.status(400).json({ error: 'fileId and fileName required' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  function send(event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  function progress(step, message, status = 'running') {
    send('progress', { step, message, status });
  }
  function complete(summary) { send('complete', summary); res.end(); }
  function fail(step, message) { send('error', { step, message }); res.end(); }

  try {
    const originalFileName = fileName.replace(/\.pdf$/i, '');

    // Step 1 — Reset or create record
    progress(1, 'Initialising record...');
    const existing = await db.getRecord(fileId);
    if (existing && existing.status === 'completed') {
      await db.updateRecord(fileId, {
        status: 'processing', pagesReturned: 0, totalPages: null,
        pages: {}, renamedFiles: [], pageStore: {}, completedAt: null, error: null,
      });
    } else if (existing && existing.status === 'processing') {
      return fail(1, 'Already processing — please wait or reset the file first.');
    } else if (!existing) {
      await db.createRecord(fileId, originalFileName);
    }
    progress(1, 'Record initialised ✓', 'done');

    // Step 2 — Download
    progress(2, `Downloading "${fileName}" from OneDrive...`);
    let pdfBuffer;
    try {
      pdfBuffer = await downloadFile(fileId);
      progress(2, `Downloaded ${formatBytes(pdfBuffer.length)} ✓`, 'done');
    } catch (err) {
      await db.markError(fileId, err);
      return fail(2, `Download failed: ${err.message}`);
    }

    // Step 3 — Split
    progress(3, 'Splitting PDF into pages...');
    let pages, totalPages;
    try {
      ({ pages, totalPages } = await splitPdf(pdfBuffer));
      progress(3, `Split into ${totalPages} page(s) ✓`, 'done');
    } catch (err) {
      await db.markError(fileId, err);
      return fail(3, `Split failed: ${err.message}`);
    }

    // Update record with total pages
    await db.updateRecord(fileId, { totalPages, currentDispatchPage: 1, pagesReturned: 0 });

    // Step 4 — Upload page 1 to Temp and dispatch
    progress(4, `Uploading page 1 to temp storage...`);
    try {
      const token = await getToken();
      const userId = process.env.ONEDRIVE_USER_ID;

      // Upload page 1
      const page1 = pages[0];
      const tempFileName = `${fileId}_page_${page1.zeroPadded}.pdf`;
      const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${TEMP_FOLDER}/${tempFileName}:/content`;
      const response = await axios.put(url, page1.buffer, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
        maxBodyLength: Infinity,
      });
      const page1ItemId = response.data.id;

      // Save to Firestore
      const pageStore = {};
      pageStore[String(page1.pageNumber)] = {
        zeroPadded: page1.zeroPadded,
        tempItemId: page1ItemId,
        tempFileName,
      };
      await db.updateRecord(fileId, { pageStore });

      // Dispatch page 1 to Make.com
      progress(4, `Sending page 1/${totalPages} to Make.com...`);
      await dispatchToMake(1, page1.zeroPadded, fileId, originalFileName, totalPages, page1ItemId);
      progress(4, `Page 1/${totalPages} dispatched to Make.com ✓`, 'done');

      // Upload remaining pages in background
      uploadRemainingPages(pages.slice(1), fileId, token, userId, pageStore)
        .catch(err => console.error('[test-run] Error uploading remaining pages:', err.message));

    } catch (err) {
      await db.markError(fileId, err);
      return fail(4, `Dispatch failed: ${err.message}`);
    }

    // Step 5 — Poll for completion
    progress(5, `Waiting for Make.com to process ${totalPages} page(s)...`);
    let lastPagesReturned = 0;

    const result = await pollForCompletion(fileId, totalPages, (pagesReturned) => {
      if (pagesReturned > lastPagesReturned) {
        lastPagesReturned = pagesReturned;
        progress(5, `Processed ${pagesReturned}/${totalPages} pages...`);
      }
    });

    if (result.status === 'error') {
      return fail(5, `Processing error: ${result.error}`);
    }

    progress(6, 'Filing to OneDrive & Google Drive ✓', 'done');

    complete({
      message: 'Test run complete',
      fileId,
      originalFileName: fileName,
      totalPages,
      renamedFiles: result.renamedFiles || [],
      customerName: result.customerName,
      ref: result.ref,
      supplier: result.supplier,
      googleDriveFolderUrl: result.googleDriveFolderUrl,
      oneDriveProcessedFolderUrl: result.oneDriveProcessedFolderUrl,
    });

  } catch (err) {
    console.error('[test-run] Unexpected error:', err.message);
    fail('unknown', `Unexpected error: ${err.message}`);
  }
};

async function pollForCompletion(fileId, totalPages, onProgress) {
  const MAX_WAIT = 4 * 60 * 1000; // 4 minutes
  const INTERVAL = 5000;
  const start = Date.now();
  let lastPages = 0;

  while (Date.now() - start < MAX_WAIT) {
    await sleep(INTERVAL);
    const record = await db.getRecord(fileId);
    if (!record) continue;
    if (record.status === 'error') return { status: 'error', error: record.error };
    if (record.pagesReturned > lastPages) {
      lastPages = record.pagesReturned;
      onProgress(lastPages);
    }
    if (record.status === 'completed') return record;
  }
  return { status: 'error', error: 'Timed out after 8 minutes' };
}

async function uploadRemainingPages(remainingPages, fileId, token, userId, pageStore) {
  for (const page of remainingPages) {
    if (!page.buffer) continue;
    const tempFileName = `${fileId}_page_${page.zeroPadded}.pdf`;
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${TEMP_FOLDER}/${tempFileName}:/content`;
    const response = await axios.put(url, page.buffer, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
      maxBodyLength: Infinity,
    });
    pageStore[String(page.pageNumber)] = {
      zeroPadded: page.zeroPadded,
      tempItemId: response.data.id,
      tempFileName,
    };
    await db.updateRecord(fileId, {
      [`pageStore.${page.pageNumber}`]: pageStore[String(page.pageNumber)]
    });
  }
}

async function dispatchToMake(pageNumber, zeroPadded, fileId, originalFileName, totalPages, tempItemId) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  const payload = {
    fileName: `${originalFileName}_${zeroPadded}.pdf`,
    fileId, tempItemId, pageNumber, totalPages,
    originalName: originalFileName, zeroPadded,
    secret: process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
  };
  await axios.post(webhookUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
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

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${['B','KB','MB','GB'][i]}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
