/**
 * /api/scan-now
 *
 * Triggered ONLY by:
 *   - Make.com Watch Files webhook (POST) when a new file lands in Scans
 *   - file-page.js after each file completes (POST) to pick up the next file
 *
 * NOT triggered by a Vercel cron — the system is fully event-driven.
 * Make.com detects new files and calls this endpoint. This eliminates
 * the every-minute Firestore reads that were causing 40K reads/12h.
 *
 * POST /api/scan-now
 */

const db = require('../lib/firebase');
const { fileProcessing, fileError } = require('../lib/statusWriter');
const { downloadFile, graphRequest } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const axios = require('axios');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

module.exports.config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 300,
};

module.exports = async function handler(req, res) {
  // Accept POST (from Make.com and file-page) and GET (manual trigger / health check)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read file details from POST body if Make.com sent them
  // This is the fast path — no need to scan the whole folder
  const body       = req.body || {};
  const fileId     = body.fileId   || null;
  const fileName   = body.fileName || null;
  const fileSize   = body.fileSize || null;

  if (fileId && fileName) {
    console.log(`[scan-now] Make.com sent file directly: "${fileName}" (${fileId})`);
  } else {
    console.log(`[scan-now] No file in body — will scan Scans folder`);
  }

  // Respond immediately to Make.com — they require a fast response
  res.status(200).json({ status: 'scanning', message: 'Scan started' });

  // Keep the function alive for background processing via Vercel Fluid Compute
  try {
    const { waitUntil } = require('@vercel/functions');
    waitUntil(
      scanAndProcess({ fileId, fileName, fileSize }).catch(err => {
        console.error('[scan-now] Background processing error:', err.message);
      })
    );
  } catch (importErr) {
    // @vercel/functions not available — fall back to direct await (local dev)
    console.warn('[scan-now] waitUntil not available — running inline:', importErr.message);
    try {
      await scanAndProcess({ fileId, fileName, fileSize });
    } catch (err) {
      console.error('[scan-now] Error:', err.message);
    }
  }
};

async function scanAndProcess({ fileId: incomingFileId, fileName: incomingFileName } = {}) {
  const userId     = process.env.ONEDRIVE_USER_ID;
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
  const token      = await getToken();

  let allPdfs = [];

  // ── Fast path — Make.com sent the file details directly ──────────────────
  // No need to scan the whole folder — process this specific file immediately
  if (incomingFileId && incomingFileName) {
    const name = incomingFileName.toLowerCase();
    const isPdf = name.endsWith('.pdf');
    if (!isPdf) {
      console.log(`[scan-now] "${incomingFileName}" is not a PDF — ignoring`);
      return;
    }
    console.log(`[scan-now] Fast path — processing: "${incomingFileName}"`);
    allPdfs = [{
      id:              incomingFileId,
      name:            incomingFileName,
      createdDateTime: new Date().toISOString(),
      file:            { mimeType: 'application/pdf' },
    }];
  } else {
    // ── Fallback — scan the whole folder (manual trigger or file-page chain) ─
    console.log(`[scan-now] Scanning Scans folder...`);
    const result = await graphRequest(
      'GET',
      `/users/${userId}/drive/root:/${folderPath}:/children` +
      `?$select=id,name,file,size,createdDateTime&$top=200`
    );
    allPdfs = (result?.value || [])
      .filter(item => {
        const name = (item.name || '').toLowerCase();
        const mime = item.file?.mimeType || '';
        return name.endsWith('.pdf') || mime.includes('pdf');
      });
  }

  console.log(`[scan-now] ${allPdfs.length} PDF(s) found`);

  if (!allPdfs.length) {
    console.log('[scan-now] No PDFs found — nothing to do');
    return;
  }

  // Single batch read for all file records
  const records = await batchGetRecords(allPdfs.map(f => f.id));

  const pending = [];

  for (const file of allPdfs) {
    const existing = records[file.id];

    // Already completed — clean up from Scans folder
    if (existing && (existing.status === 'complete' || existing.status === 'completed')) {
      console.log(`[scan-now] "${file.name}" already completed — removing from Scans`);
      await deleteFromScans(file.id, file.name, userId, token);
      continue;
    }

    // Already actively processing — check for stuck files
    if (existing && existing.status === 'processing') {
      const STUCK_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes — reset if stuck
      const updatedAt = existing.updatedAt?.toMillis?.() || (existing.updatedAt?._seconds || 0) * 1000;
      const createdAt = existing.createdAt?.toMillis?.() || (existing.createdAt?._seconds || 0) * 1000;
      const lastActivity = Math.max(updatedAt, createdAt);
      const stuckFor = Date.now() - lastActivity;
      if (lastActivity > 0 && stuckFor > STUCK_THRESHOLD_MS) {
        console.log(`[scan-now] "${file.name}" stuck for ${Math.round(stuckFor / 60000)}min — resetting`);
        await db.updateRecord(file.id, {
          status: 'reset',
          error: `Auto-reset after being stuck for ${Math.round(stuckFor / 60000)} minutes`,
        });
        pending.push({ file, existing: { ...existing, status: 'reset' } });
      } else {
        console.log(`[scan-now] "${file.name}" is processing — skipping`);
      }
      continue;
    }

    // Paused — queue for resume
    if (existing && existing.status === 'paused') {
      pending.push({ file, existing, paused: true });
      continue;
    }

    // Not yet started, reset, detected, or waiting
    if (!existing || ['reset', 'detected', 'waiting', null, undefined].includes(existing?.status)) {
      pending.push({ file, existing, paused: false });
    }
  }

  if (!pending.length) {
    console.log('[scan-now] No files to process');
    return;
  }

  // Sort: oldest first so files are processed in arrival order
  pending.sort((a, b) => new Date(a.file.createdDateTime) - new Date(b.file.createdDateTime));

  // Paused file takes priority (resume where we left off)
  const pausedEntry = pending.find(e => e.paused);
  if (pausedEntry) {
    const queue = await db.getQueue();
    console.log(`[scan-now] Resuming PAUSED file: "${pausedEntry.file.name}"`);
    await resumePausedFile(pausedEntry.file, queue.pausedFile, token, userId);
    return;
  }

  // Process the oldest pending file
  const next = pending[0];
  console.log(`[scan-now] Processing: "${next.file.name}"`);
  fileProcessing(next.file.id, next.file.name, null).catch(() => {});
  await processFile(next.file.id, next.file.name, token, userId);
}

async function resumePausedFile(file, pausedData, token, userId) {
  if (!pausedData || !pausedData.resumeFromPage) {
    console.warn(`[scan-now] No pause data for "${file.name}" — restarting`);
    await db.clearPausedFile();
    await processFile(file.id, file.name, token, userId);
    return;
  }

  const { resumeFromPage, totalPages } = pausedData;
  console.log(`[scan-now] Resuming "${file.name}" from page ${resumeFromPage}/${totalPages}`);

  await Promise.all([
    db.clearPausedFile(),
    db.updateRecord(file.id, { status: 'processing' }),
  ]);

  const record = await db.getRecord(file.id);
  const pageStore = record?.pageStore || {};
  const tempData = pageStore[resumeFromPage] || pageStore[String(resumeFromPage)];

  if (tempData?.tempItemId) {
    const originalFileName = file.name.replace(/\.pdf$/i, '');
    const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
    const zeroPadded = String(resumeFromPage).padStart(padWidth, '0');
    await Promise.all([
      dispatchToMake(resumeFromPage, zeroPadded, file.id, originalFileName, totalPages, tempData.tempItemId),
      db.updateRecord(file.id, { currentDispatchPage: resumeFromPage }),
    ]);
  } else {
    await reuploadFromPage(file.id, file.name, resumeFromPage, totalPages, token, userId);
  }
}

async function reuploadFromPage(fileId, fileName, fromPage, totalPages, token, userId) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');
  let pdfBuffer;
  try {
    pdfBuffer = await downloadFile(fileId);
  } catch (err) {
    console.error(`[scan-now] Re-download failed:`, err.message);
    await db.markError(fileId, err);
    return;
  }

  let pages;
  try {
    ({ pages } = await splitPdf(pdfBuffer));
  } catch (err) {
    console.error(`[scan-now] Re-split failed:`, err.message);
    await db.markError(fileId, err);
    return;
  }

  const record = await db.getRecord(fileId);
  const pageStore = record?.pageStore || {};
  const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;

  for (const page of pages) {
    if (page.pageNumber < fromPage) continue;
    if (pageStore[String(page.pageNumber)]?.tempItemId) continue;
    const tempItemId = await uploadPageToTemp(page, fileId, token, userId);
    pageStore[String(page.pageNumber)] = {
      zeroPadded: page.zeroPadded,
      tempItemId,
      tempFileName: `${fileId}_page_${page.zeroPadded}.pdf`,
    };
    await db.updateRecord(fileId, {
      [`pageStore.${page.pageNumber}`]: pageStore[String(page.pageNumber)],
    });
  }

  const zeroPadded = String(fromPage).padStart(padWidth, '0');
  const tempData = pageStore[String(fromPage)];
  if (tempData?.tempItemId) {
    await dispatchToMake(fromPage, zeroPadded, fileId, originalFileName, totalPages, tempData.tempItemId);
    await db.updateRecord(fileId, { currentDispatchPage: fromPage });
  } else {
    await db.markError(fileId, { message: `Resume failed — could not upload page ${fromPage}` });
  }
}

async function processFile(itemId, fileName, token, userId) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');

  const existing = await db.getRecord(itemId);

  if (existing && existing.status === 'processing') {
    console.log(`[scan-now] "${originalFileName}" already processing — skipping`);
    return;
  }

  // NOTE: A "global one-at-a-time" queue lock was previously here but was
  // removed because it caused more deadlocks than it prevented. The lock would
  // see stuck Firestore records and block ALL new files indefinitely. Files
  // are processed against their own Firestore record by file ID, so concurrent
  // processing of two different files is safe. The only remaining risk is two
  // pages of two different files trying to create the same customer folder
  // simultaneously, which is rare and self-healing.

  if (existing) {
    await db.updateRecord(itemId, {
      status: 'processing', pagesReturned: 0, totalPages: null,
      pages: {}, renamedFiles: [], pageStore: {}, completedAt: null, error: null,
      pausedAtPage: null,
    });
  } else {
    await db.createRecord(itemId, originalFileName);
  }

  let pdfBuffer;
  try {
    // Write downloading stage
    const { writeFileStatus } = require('../lib/statusWriter');
    writeFileStatus(itemId, { currentStage: 'downloading', fileName: originalFileName }).catch(() => {});
    pdfBuffer = await downloadFile(itemId);
    console.log(`[scan-now] Downloaded "${originalFileName}" (${pdfBuffer.length} bytes)`);
  } catch (err) {
    console.error(`[scan-now] Download failed:`, err.message);
    await db.markError(itemId, err);
    return;
  }

  let pages, totalPages;
  try {
    const { writeFileStatus } = require('../lib/statusWriter');
    writeFileStatus(itemId, { currentStage: 'splitting' }).catch(() => {});
    ({ pages, totalPages } = await splitPdf(pdfBuffer));
    console.log(`[scan-now] Split into ${totalPages} page(s)`);
  } catch (splitErr) {
    console.error(`[scan-now] Invalid PDF "${originalFileName}": ${splitErr.message}`);
    try {
      const nonOrderPath = 'Grove Group Scotland/Grove Bedding/Scans/Non-Order Documents';
      const destRes = await axios.get(
        `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${nonOrderPath}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await axios.patch(
        `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}`,
        { parentReference: { id: destRes.data.id }, name: fileName },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      console.log(`[scan-now] Moved invalid PDF "${fileName}" to Non-Order Documents`);
    } catch (moveErr) {
      console.warn(`[scan-now] Could not move invalid PDF:`, moveErr.message);
    }
    await db.markError(itemId, { message: `Invalid PDF: ${splitErr.message}` });
    return;
  }

  await db.updateRecord(itemId, { totalPages, currentDispatchPage: 1, pagesReturned: 0 });

  const page1 = pages[0];
  const page1ItemId = await uploadPageToTemp(page1, itemId, token, userId);
  const pageStore = {};
  pageStore[String(page1.pageNumber)] = {
    zeroPadded: page1.zeroPadded,
    tempItemId: page1ItemId,
    tempFileName: `${itemId}_page_${page1.zeroPadded}.pdf`,
  };
  await db.updateRecord(itemId, { pageStore });
  const { writeFileStatus } = require('../lib/statusWriter');
  writeFileStatus(itemId, { currentStage: 'dispatching', currentPage: 1 }).catch(() => {});
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
  const clean = s => (typeof s === 'string' ? s.replace(/[\x00-\x1F\x7F]/g, '') : s);
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
  await axios.post(process.env.MAKE_WEBHOOK_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

async function deleteFromScans(itemId, fileName, userId, token) {
  try {
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
    console.warn('[scan-now] batchGetRecords error:', err.message);
    const result = {};
    for (const id of fileIds) {
      try { result[id] = await db.getRecord(id); } catch (e) { result[id] = null; }
    }
    return result;
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


