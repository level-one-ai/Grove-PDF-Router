const { logRead } = require('../lib/logRead');
/**
 * /api/scan-now
 *
 * Triggered by:
 *   - The dashboard "Process All" button (auto mode)
 *   - file-page.js after each file completes (to pick up next)
 *   - file-page.js when pausing an old file (to pick up new priority file)
 *   - webhook.js when a new file arrives
 *
 * Priority logic (auto mode):
 *   1. New files (arrived after auto mode was enabled) are always processed first
 *   2. If a new file arrives while an old file is mid-page, the old file is paused
 *      after its current page completes, then the new file runs in full
 *   3. Once all new files are done, paused old files resume, then remaining old files
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

  // No stop flag check — system always processes

  // Ensure auto-poll is running — fire-and-forget, never blocks processing
  ensureAutoPollRunning().catch(() => {});

  const userId = process.env.ONEDRIVE_USER_ID;
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
  const token = await getToken();

  // Fetch all PDFs in Scans folder
  const result = await graphRequest(
    'GET',
    `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,file,createdDateTime&$top=200`
  );

  const allPdfs = (result?.value || [])
    .filter(item => {
      const name = (item.name || '').toLowerCase();
      const mime = item.file?.mimeType || '';
      return name.endsWith('.pdf') || mime.includes('pdf');
    });

  console.log(`[scan-now] ${allPdfs.length} PDF(s) in Scans`);

  // Separate into new (priority) and old files
  const queue = await db.getQueue();
  const oldFileIds = queue.oldFiles || {};

  const newFiles = [];
  const oldFiles = [];

  // Batch read all file records in a single Firestore call instead of one per file.
  // Reduces reads from N (one per PDF) to 1 regardless of how many files are in Scans.
  const records = await batchGetRecords(allPdfs.map(f => f.id));

  for (const file of allPdfs) {
    const existing = records[file.id];

    // Already completed — clean up from Scans
    if (existing && existing.status === 'completed') {
      console.log(`[scan-now] "${file.name}" already completed — removing from Scans`);
      await deleteFromScans(file.id, file.name, userId, token);
      continue;
    }

    // Already actively processing — leave it alone
    if (existing && existing.status === 'processing') {
      console.log(`[scan-now] "${file.name}" already processing — skipping`);
      continue;
    }

    // Paused — will be handled separately below
    if (existing && existing.status === 'paused') {
      console.log(`[scan-now] "${file.name}" is paused — queued for resume`);
      oldFiles.push({ file, existing, paused: true });
      continue;
    }

    // Not yet started, reset, detected (webhook saw it), or waiting (human mode queued it)
    if (!existing || ['reset', 'detected', 'waiting', null, undefined].includes(existing.status)) {
      if (oldFileIds[file.id]) {
        oldFiles.push({ file, existing, paused: false });
      } else {
        newFiles.push({ file, existing, paused: false });
      }
    }
  }

  // Sort each group: newest first for new files, oldest first for old files
  newFiles.sort((a, b) => new Date(b.file.createdDateTime) - new Date(a.file.createdDateTime));
  oldFiles.sort((a, b) => new Date(a.file.createdDateTime) - new Date(b.file.createdDateTime));

  console.log(`[scan-now] Queue: ${newFiles.length} new file(s), ${oldFiles.length} old/paused file(s)`);

  // ── PRIORITY: Process new files first ──
  if (newFiles.length > 0) {
    const next = newFiles[0];
    console.log(`[scan-now] Processing NEW file: "${next.file.name}"`);
    await processFile(next.file.id, next.file.name, token, userId);
    return;
  }

  // ── No new files — check paused old file first, then unstarted old files ──
  const pausedEntry = oldFiles.find(e => e.paused);
  if (pausedEntry) {
    console.log(`[scan-now] Resuming PAUSED old file: "${pausedEntry.file.name}"`);
    await resumePausedFile(pausedEntry.file, queue.pausedFile, token, userId);
    return;
  }

  // ── Process next unstarted old file ──
  const nextOld = oldFiles.find(e => !e.paused);
  if (nextOld) {
    console.log(`[scan-now] Processing OLD file: "${nextOld.file.name}"`);
    await processFile(nextOld.file.id, nextOld.file.name, token, userId);
    return;
  }

  console.log('[scan-now] No files to process — queue empty');
}

async function resumePausedFile(file, pausedData, token, userId) {
  if (!pausedData || !pausedData.resumeFromPage) {
    // Fallback — restart from beginning if resume data is missing
    console.warn(`[scan-now] No pause data for "${file.name}" — restarting from page 1`);
    await db.clearPausedFile();
    await processFile(file.id, file.name, token, userId);
    return;
  }

  const { resumeFromPage, totalPages } = pausedData;
  console.log(`[scan-now] Resuming "${file.name}" from page ${resumeFromPage}/${totalPages}`);

  // Clear the paused state
  await Promise.all([
    db.clearPausedFile(),
    db.updateRecord(file.id, { status: 'processing' }),
  ]);

  // Check the page is already in Temp (it was uploaded before the pause)
  const record = await db.getRecord(file.id);
  const pageStore = record?.pageStore || {};
  const tempData = pageStore[resumeFromPage] || pageStore[String(resumeFromPage)];

  if (tempData?.tempItemId) {
    // Page already in Temp — dispatch directly
    const originalFileName = file.name.replace(/\.pdf$/i, '');
    const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
    const zeroPadded = String(resumeFromPage).padStart(padWidth, '0');
    await Promise.all([
      dispatchToMake(resumeFromPage, zeroPadded, file.id, originalFileName, totalPages, tempData.tempItemId),
      db.updateRecord(file.id, { currentDispatchPage: resumeFromPage }),
    ]);
    console.log(`[scan-now] Dispatched resume page ${resumeFromPage}/${totalPages} for "${originalFileName}"`);
  } else {
    // Page not in Temp — need to re-download and re-split then upload remaining pages
    console.log(`[scan-now] Page ${resumeFromPage} not in Temp — re-uploading from page ${resumeFromPage}`);
    await reuploadFromPage(file.id, file.name, resumeFromPage, totalPages, token, userId);
  }
}

async function reuploadFromPage(fileId, fileName, fromPage, totalPages, token, userId) {
  // Download the full PDF again and re-upload missing pages to Temp
  const originalFileName = fileName.replace(/\.pdf$/i, '');
  let pdfBuffer;
  try {
    pdfBuffer = await downloadFile(fileId);
  } catch (err) {
    console.error(`[scan-now] Re-download failed for "${originalFileName}":`, err.message);
    await db.markError(fileId, err);
    return;
  }

  let pages, tp;
  try {
    ({ pages, totalPages: tp } = await splitPdf(pdfBuffer));
  } catch (err) {
    console.error(`[scan-now] Re-split failed:`, err.message);
    await db.markError(fileId, err);
    return;
  }

  // Upload only the pages from fromPage onwards that aren't already in Temp
  const record = await db.getRecord(fileId);
  const pageStore = record?.pageStore || {};
  const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;

  for (const page of pages) {
    if (page.pageNumber < fromPage) continue;
    if (pageStore[String(page.pageNumber)]?.tempItemId) continue; // already there
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

  // Dispatch the resume page
  const zeroPadded = String(fromPage).padStart(padWidth, '0');
  const tempData = pageStore[String(fromPage)];
  if (tempData?.tempItemId) {
    await dispatchToMake(fromPage, zeroPadded, fileId, originalFileName, totalPages, tempData.tempItemId);
    await db.updateRecord(fileId, { currentDispatchPage: fromPage });
    console.log(`[scan-now] Dispatched re-upload resume page ${fromPage}/${totalPages}`);
  } else {
    console.error(`[scan-now] Could not get tempItemId for resume page ${fromPage}`);
    await db.markError(fileId, { message: `Resume failed — could not upload page ${fromPage}` });
  }
}

async function processFile(itemId, fileName, token, userId) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');

  const existing = await db.getRecord(itemId);

  // Safety guard — if this file is already actively processing, do not reset it.
  // This can happen if auto-poll triggers scan-now while a multi-page file is
  // mid-chain. Resetting pageStore here would wipe temp page references and
  // break the page dispatch chain.
  if (existing && existing.status === 'processing') {
    console.log(`[scan-now] "${originalFileName}" is already processing — skipping reset`);
    return;
  }

  if (existing) {
    await db.updateRecord(itemId, {
      status: 'processing', pagesReturned: 0, totalPages: null,
      pages: {}, renamedFiles: [], pageStore: {}, completedAt: null, error: null,
      pausedAtPage: null,
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

  // Split — handle invalid/corrupted PDFs gracefully
  let pages, totalPages;
  try {
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
  // Strip control characters (raw newlines, tabs, etc.) from all string fields
  // to prevent "Bad control character in JSON" errors in Make.com's HTTP module
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

/**
 * Fetch multiple Firestore records in a single batch call.
 * Returns a map of { fileId: recordData | null }.
 */
async function batchGetRecords(fileIds) {
  if (!fileIds.length) return {};
  try {
    const admin = require('firebase-admin');
    const firestore = admin.firestore();
    const COLLECTION = 'processedFiles';
    const refs = fileIds.map(id => firestore.collection(COLLECTION).doc(id));
    const docs = await firestore.getAll(...refs);
    const result = {};
    docs.forEach(doc => {
      result[doc.id] = doc.exists ? doc.data() : null;
    });
    logRead('scan-now batchGetRecords', fileIds.length);
    return result;
  } catch (err) {
    console.warn('[scan-now] batchGetRecords error, falling back to individual reads:', err.message);
    const result = {};
    for (const id of fileIds) {
      try { result[id] = await db.getRecord(id); } catch (e) { result[id] = null; }
    }
    return result;
  }
}

/**
 * Ensure auto-poll is alive — starts it if the heartbeat is stale or missing.
 * Called at the start of every scan-now invocation so the safety net
 * is always running regardless of how scan-now was triggered.
 */
async function ensureAutoPollRunning() {
  try {
    const admin = require('firebase-admin');
    const firestore = admin.firestore();
    const lockDoc = await firestore.collection('settings').doc('autoPollLock').get();
    const STALE_MS = 2 * 60 * 1000;
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
      console.log('[scan-now] auto-poll was not running — started it');
    }
  } catch (err) {
    // Non-fatal
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
