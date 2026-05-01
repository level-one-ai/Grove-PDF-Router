/**
 * lib/statusWriter.js
 * ────────────────────
 * Writes PDF router status updates to Firestore.
 *
 * This replaces ALL dashboard HTTP calls (notifyDashboard, notify endpoint).
 * The Grove Bedding Dashboard reads from these Firestore collections
 * independently — the router never calls the dashboard directly.
 *
 * Firestore collections written to:
 *   pdfRouterStatus/{fileId}   — per-file processing status
 *   pdfRouterErrors/{fileId}   — errors including Cin7 no-match
 *   pdfRouterActivity          — recent activity log (last 100 events)
 */

let _firestore = null;
let _FieldValue = null;

function getFirestore() {
  if (!_firestore) {
    const admin = require('firebase-admin');
    _firestore  = admin.firestore();
    _FieldValue = admin.firestore.FieldValue;
  }
  return { firestore: _firestore, FieldValue: _FieldValue };
}

/**
 * Write or update a file's processing status.
 * Called at each stage of processing.
 */
async function writeFileStatus(fileId, data) {
  try {
    const { firestore, FieldValue } = getFirestore();
    await firestore.collection('pdfRouterStatus').doc(fileId).set({
      fileId,
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn('[statusWriter] writeFileStatus failed (non-fatal):', err.message);
  }
}

/**
 * Write an activity log entry.
 * The dashboard reads these to show a live feed.
 */
async function writeActivity(event, data) {
  try {
    const { firestore, FieldValue } = getFirestore();
    await firestore.collection('pdfRouterActivity').add({
      event,
      ...data,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn('[statusWriter] writeActivity failed (non-fatal):', err.message);
  }
}

/**
 * Write an error entry.
 */
async function writeError(fileId, type, message, extra = {}) {
  try {
    const { firestore, FieldValue } = getFirestore();
    await firestore.collection('pdfRouterErrors').doc(`${fileId}_${Date.now()}`).set({
      fileId,
      type,
      message,
      ...extra,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn('[statusWriter] writeError failed (non-fatal):', err.message);
  }
}

// ── Convenience helpers ──────────────────────────────────

async function fileDetected(fileId, fileName, fileCount) {
  await Promise.all([
    writeFileStatus(fileId, {
      fileName,
      status: 'detected',
      detectedAt: new Date().toISOString(),
    }),
    writeActivity('file_detected', { fileId, fileName, fileCount }),
  ]);
}

async function fileProcessing(fileId, fileName, totalPages) {
  await writeFileStatus(fileId, {
    fileName,
    status: 'processing',
    totalPages,
    processingStartedAt: new Date().toISOString(),
  });
}

async function pageComplete(fileId, pageNumber, totalPages, data = {}) {
  await writeFileStatus(fileId, {
    status: pageNumber >= totalPages ? 'complete' : 'processing',
    [`page_${pageNumber}`]: {
      status: 'complete',
      ...data,
      completedAt: new Date().toISOString(),
    },
    pagesCompleted: pageNumber,
  });
}

async function fileComplete(fileId, data = {}) {
  await Promise.all([
    writeFileStatus(fileId, {
      status: 'complete',
      completedAt: new Date().toISOString(),
      ...data,
    }),
    writeActivity('file_complete', { fileId, ...data }),
  ]);
}

async function fileError(fileId, fileName, error) {
  await Promise.all([
    writeFileStatus(fileId, {
      fileName,
      status: 'error',
      error: error.message || String(error),
      errorAt: new Date().toISOString(),
    }),
    writeError(fileId, 'processing_error', error.message || String(error), { fileName }),
  ]);
}

async function cin7NoMatch(fileId, searchName, pdfRef, message) {
  await Promise.all([
    writeFileStatus(fileId, {
      cin7Status: 'no_match',
      cin7SearchName: searchName,
      cin7Error: message,
    }),
    writeError(fileId, 'cin7_no_match', message, { searchName, pdfRef }),
    writeActivity('cin7_no_match', { fileId, searchName, pdfRef, message }),
  ]);
}

async function cin7Matched(fileId, result) {
  await writeFileStatus(fileId, {
    cin7Status: 'matched',
    cin7FolderName: result.folderName,
    cin7OrderRef:   result.cin7OrderRef,
    cin7Source:     result.source,
  });
}

module.exports = {
  writeFileStatus,
  writeActivity,
  writeError,
  fileDetected,
  fileProcessing,
  pageComplete,
  fileComplete,
  fileError,
  cin7NoMatch,
  cin7Matched,
};
