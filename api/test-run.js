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
      await sleep(300);
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
      await sleep(300);
    } catch (err) {
      await db.markError(fileId, err);
      return fail(3, `Split failed: ${err.message}`);
    }

    // Update record with total pages
    await db.updateRecord(fileId, { totalPages, currentDispatchPage: 1, pagesReturned: 0 });

    // Step 4 — Upload page 1 to Temp and dispatch
    progress(4, `Uploading page 1/${totalPages} to temp storage...`);
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
      await sleep(300);

      // Upload remaining pages in background
      uploadRemainingPages(pages.slice(1), fileId, token, userId, pageStore)
        .catch(err => console.error('[test-run] Error uploading remaining pages:', err.message));

    } catch (err) {
      await db.markError(fileId, err);
      return fail(4, `Dispatch failed: ${err.message}`);
    }

    // Keep SSE connection alive with periodic pings
    const keepalive = setInterval(function() {
      try { res.write(': ping\n\n'); } catch(e) { clearInterval(keepalive); }
    }, 15000);

    // Step 5 — Wait for Make.com AI extraction
    progress(5, `Waiting for Make.com + Claude to process page 1/${totalPages}...`);

    const result = await pollForCompletion(fileId, totalPages, (event) => {
      if (event.type === 'dispatched') {
        // Vercel sent next page to Make.com
        progress(4, `Page ${event.page}/${totalPages} sent to Make.com ✓`, 'running');
        progress(5, `Waiting for Claude to extract page ${event.page}/${totalPages}...`, 'running');

      } else if (event.type === 'extraction') {
        // Claude returned extracted data for this page
        progress(5, `Page ${event.page}/${totalPages} extracted by Claude ✓`, 'running');
        if (event.page >= totalPages) {
          progress(4, `All ${totalPages} page(s) sent to Make.com ✓`, 'done');
        }

      } else if (event.type === 'filing') {
        // Filing started for this page
        progress(5, `Page ${event.page}/${totalPages} extracted by Claude ✓`, 'running');
        const docType = (event.pageData && event.pageData.docType)
          ? event.pageData.docType.replace(/_/g, ' ')
          : null;
        if (event.skipped) {
          progress(6, `Page ${event.page}/${totalPages} — ${docType || 'non-order document'} — filing to Non-Order Documents...`, 'running');
        } else {
          progress(6, `Page ${event.page}/${totalPages} — filing to OneDrive & Google Drive...`, 'running');
        }

      } else if (event.type === 'filed') {
        // Page fully filed
        const docType = (event.pageData && event.pageData.docType)
          ? event.pageData.docType.replace(/_/g, ' ')
          : null;
        if (event.skipped) {
          if (event.page >= totalPages) {
            progress(5, `All ${totalPages} page(s) extracted by Claude ✓`, 'done');
            progress(6, `All ${totalPages} page(s) processed ✓`, 'done');
          } else {
            progress(6, `Page ${event.page}/${totalPages} — ${docType || 'non-order'} filed ✓ — waiting for page ${event.page + 1}...`, 'running');
          }
        } else {
          if (event.page >= totalPages) {
            progress(5, `All ${totalPages} page(s) extracted by Claude ✓`, 'done');
            progress(6, `All ${totalPages} page(s) filed to OneDrive & Google Drive ✓`, 'done');
          } else {
            progress(6, `Page ${event.page}/${totalPages} filed to OneDrive & Google Drive ✓ — sending page ${event.page + 1} to Make.com...`, 'running');
          }
        }
      }
    });

    if (result.status === 'error') {
      clearInterval(keepalive);
      return fail(5, `Processing error: ${result.error}`);
    }

    // Ensure all steps show done on completion
    clearInterval(keepalive);
    progress(4, `All ${totalPages} page(s) sent to Make.com ✓`, 'done');
    progress(5, `All ${totalPages} page(s) extracted by Claude ✓`, 'done');
    progress(6, `All ${totalPages} page(s) filed ✓`, 'done');

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

async function pollForCompletion(fileId, totalPages, onEvent) {
  // Uses Firestore onSnapshot for instant updates instead of 3-second polling.
  // This eliminates the race condition where the final page gets stuck orange
  // because the poll missed the transition to 'completed'.
  const MAX_TOTAL = 15 * 60 * 1000; // 15 minute hard limit
  const MAX_IDLE  =  3 * 60 * 1000; // 3 minutes without progress = timeout

  return new Promise((resolve) => {
    const start = Date.now();
    let lastProgress = Date.now();
    let resolved = false;
    const reported = { dispatched: new Set(), extraction: new Set(), filing: new Set(), filed: new Set() };

    // Hard deadline timer
    const hardDeadline = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (unsubscribe) unsubscribe();
        resolve({ status: 'error', error: `15 minute limit reached — ${reported.filed.size}/${totalPages} pages filed. File is still processing in background.` });
      }
    }, MAX_TOTAL);

    // Idle timeout — checked every 10 seconds
    const idleCheck = setInterval(() => {
      if (resolved) { clearInterval(idleCheck); return; }
      if (Date.now() - lastProgress > MAX_IDLE) {
        resolved = true;
        clearInterval(idleCheck);
        clearTimeout(hardDeadline);
        if (unsubscribe) unsubscribe();
        resolve({ status: 'error', error: `No progress for 3 minutes — ${reported.filed.size}/${totalPages} pages filed. File may still be processing in background.` });
      }
    }, 10000);

    const admin = require('firebase-admin');
    const firestore = admin.firestore();
    let unsubscribe = null;

    unsubscribe = firestore.collection('processedFiles').doc(fileId)
      .onSnapshot(snap => {
        if (resolved) return;
        if (!snap.exists) return;
        const record = snap.data();

        if (record.status === 'error') {
          resolved = true;
          clearInterval(idleCheck);
          clearTimeout(hardDeadline);
          unsubscribe();
          resolve({ status: 'error', error: record.error });
          return;
        }

        const pages = record.pages || {};
        let anyNew = false;

        // Detect when Vercel dispatches the next page to Make.com
        const dispatchedPage = record.currentDispatchPage || 1;
        if (!reported.dispatched.has(dispatchedPage) && dispatchedPage > 1) {
          reported.dispatched.add(dispatchedPage);
          onEvent({ type: 'dispatched', page: dispatchedPage });
          anyNew = true;
        }

        for (let p = 1; p <= totalPages; p++) {
          const pageData = pages[p] || pages[String(p)];
          if (!pageData) continue;
          const st = pageData.status;

          if (!reported.extraction.has(p) && st && st !== 'pending') {
            reported.extraction.add(p);
            onEvent({ type: 'extraction', page: p });
            anyNew = true;
          }
          if (!reported.filing.has(p) && (st === 'filing' || st === 'completed' || st === 'skipped')) {
            reported.filing.add(p);
            onEvent({ type: 'filing', page: p, skipped: st === 'skipped', pageData });
            anyNew = true;
          }
          if (!reported.filed.has(p) && (st === 'completed' || st === 'skipped')) {
            reported.filed.add(p);
            onEvent({ type: 'filed', page: p, skipped: st === 'skipped', pageData });
            anyNew = true;
          }
        }

        if (anyNew) lastProgress = Date.now();

        // When file is marked completed, fire any remaining filed events then resolve
        if (record.status === 'completed') {
          for (let p = 1; p <= totalPages; p++) {
            const pageData = (record.pages || {})[p] || (record.pages || {})[String(p)];
            if (!pageData) continue;
            const st = pageData.status;
            if (!reported.filed.has(p) && (st === 'completed' || st === 'skipped')) {
              reported.filed.add(p);
              onEvent({ type: 'filed', page: p, skipped: st === 'skipped', pageData });
            }
          }
          resolved = true;
          clearInterval(idleCheck);
          clearTimeout(hardDeadline);
          unsubscribe();
          resolve(record);
        }

      }, err => {
        // Snapshot error — fall back to single read and resolve
        console.warn('[test-run] pollForCompletion snapshot error:', err.message);
        if (!resolved) {
          resolved = true;
          clearInterval(idleCheck);
          clearTimeout(hardDeadline);
          db.getRecord(fileId).then(r => resolve(r || { status: 'error', error: 'Snapshot failed' })).catch(() => resolve({ status: 'error', error: 'Snapshot failed' }));
        }
      });
  });
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
  // Strip control characters (raw newlines, tabs, etc.) from all string fields
  // to prevent "Bad control character in JSON" errors in Make.com's HTTP module
  const clean = s => (typeof s === 'string' ? s.replace(/[\x00-\x1F\x7F]/g, '') : s);

  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  const payload = {
    fileName: clean(`${originalFileName}_${zeroPadded}.pdf`),
    fileId: clean(fileId),
    tempItemId: clean(tempItemId),
    pageNumber,
    totalPages,
    originalName: clean(originalFileName),
    zeroPadded: clean(zeroPadded),
    secret: clean(process.env.CALLBACK_SECRET || 'grove-pdf-router-secret'),
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
