/**
 * /api/test-run
 *
 * Manually triggers the full processing pipeline for a specific OneDrive file.
 * Used by the test dashboard "Test Run" button.
 *
 * POST /api/test-run
 * Body: { fileId: "onedrive-item-id", fileName: "Scan.pdf" }
 *
 * Uses Server-Sent Events (SSE) to stream live progress back to the browser
 * so the dashboard can show step-by-step status in real time.
 */

const { requireAuth } = require('../lib/auth');
const db = require('../lib/firebase');
const { downloadFile } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const { startDispatch } = require('../lib/queue');

module.exports = async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileId, fileName } = req.body;

  if (!fileId || !fileName) {
    return res.status(400).json({ error: 'fileId and fileName are required' });
  }

  // ── Set up Server-Sent Events for live progress streaming ──
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
    send('progress', { step, message, status, timestamp: new Date().toISOString() });
  }

  function complete(summary) {
    send('complete', summary);
    res.end();
  }

  function fail(step, message) {
    send('error', { step, message, timestamp: new Date().toISOString() });
    res.end();
  }

  try {
    const originalFileName = fileName.replace(/\.pdf$/i, '');

    // ── Step 1: Loop prevention check ──
    progress(1, 'Checking for existing records...');
    const existing = await db.getRecord(fileId);
    if (existing && existing.status === 'completed') {
      // Allow re-runs by clearing the old record for test purposes
      progress(1, `Previous record found (${existing.status}) — clearing for test re-run...`);
      await db.updateRecord(fileId, {
        status: 'processing',
        pagesReturned: 0,
        totalPages: null,
        pages: {},
        renamedFiles: [],
        pageStore: {},
        completedAt: null,
        error: null,
      });
    } else if (existing && existing.status === 'processing') {
      return fail(1, 'This file is already being processed. Please wait for it to complete.');
    } else {
      await db.createRecord(fileId, originalFileName);
    }
    progress(1, 'Record initialised ✓', 'done');

    // ── Step 2: Download PDF ──
    progress(2, `Downloading "${fileName}" from OneDrive...`);
    let pdfBuffer;
    try {
      pdfBuffer = await downloadFile(fileId);
      progress(2, `Downloaded ${formatBytes(pdfBuffer.length)} ✓`, 'done');
    } catch (err) {
      await db.markError(fileId, err);
      return fail(2, `Failed to download file: ${err.message}`);
    }

    // ── Step 3: Split PDF ──
    progress(3, 'Splitting PDF into individual pages...');
    let pages, totalPages;
    try {
      ({ pages, totalPages } = await splitPdf(pdfBuffer));
      progress(3, `Split into ${totalPages} page${totalPages === 1 ? '' : 's'} ✓`, 'done');
    } catch (err) {
      await db.markError(fileId, err);
      return fail(3, `Failed to split PDF: ${err.message}`);
    }

    // ── Step 4: Dispatch to Make.com ──
    progress(4, `Dispatching page 1 of ${totalPages} to Make.com...`);
    try {
      await startDispatch(pages, fileId, originalFileName);
      progress(4, `Page 1 of ${totalPages} sent to Make.com ✓`, 'done');
    } catch (err) {
      await db.markError(fileId, err);
      return fail(4, `Failed to dispatch to Make.com: ${err.message}`);
    }

    // ── Step 5: Wait for completion ──
    // The remaining pages are dispatched sequentially from /api/callback.
    // We poll Firestore here to stream progress back to the dashboard.
    progress(5, `Waiting for Make.com to process ${totalPages} page${totalPages === 1 ? '' : 's'}...`);

    const result = await pollForCompletion(fileId, totalPages, (pagesReturned) => {
      progress(5, `Make.com processed page ${pagesReturned} of ${totalPages}...`);
    });

    if (result.status === 'error') {
      return fail(5, `Processing error: ${result.error}`);
    }

    // ── Complete ──
    progress(6, 'Filing to OneDrive and Google Drive...', 'done');

    complete({
      message: 'Test run completed successfully',
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
    console.error('[test-run] Unexpected error:', err);
    fail('unknown', `Unexpected error: ${err.message}`);
  }
};

/**
 * Poll Firestore until the file is completed or errored.
 * Calls onProgress with the current pagesReturned count.
 * Times out after 10 minutes.
 */
async function pollForCompletion(fileId, totalPages, onProgress) {
  const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
  const POLL_INTERVAL_MS = 3000; // check every 3 seconds
  const startTime = Date.now();
  let lastPagesReturned = 0;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const record = await db.getRecord(fileId);
    if (!record) continue;

    if (record.status === 'error') {
      return { status: 'error', error: record.error };
    }

    if (record.pagesReturned > lastPagesReturned) {
      lastPagesReturned = record.pagesReturned;
      onProgress(lastPagesReturned);
    }

    if (record.status === 'completed') {
      return record;
    }
  }

  return { status: 'error', error: 'Timed out waiting for processing to complete (10 min limit)' };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
