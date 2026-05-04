/**
 * lib/statusWriter.js
 * ────────────────────
 * Writes PDF router status updates to Firestore.
 *
 * SIMPLIFIED — two collections only:
 *   pdfRouterStatus/{fileId}   — per-file processing status (dashboard reads this)
 *   pdfRouterErrors/{fileId}   — errors including Cin7 no-match (dashboard reads this)
 *
 * REMOVED:
 *   pdfRouterActivity — was never read by the dashboard after activity feed removal.
 *   Removing it eliminates 3-5 unnecessary writes per page processed.
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

// ── Core write functions ──────────────────────────────────────────────────────

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

// ── Convenience helpers ───────────────────────────────────────────────────────

async function fileDetected(fileId, fileName, fileCount) {
  await writeFileStatus(fileId, {
    fileName,
    status: 'detected',
    detectedAt: new Date().toISOString(),
    fileCount,
  });
  // No activity log write — removed to reduce Firebase reads/writes
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
  // Safeguard: if totalPages is not a valid number, treat this page as the last
  // (otherwise the comparison fails and status gets stuck on 'processing')
  const safePageNumber = Number(pageNumber) || 1;
  const safeTotalPages = Number(totalPages) || safePageNumber;
  const isComplete = safePageNumber >= safeTotalPages;

  await writeFileStatus(fileId, {
    status: isComplete ? 'complete' : 'processing',
    [`page_${safePageNumber}`]: {
      status: 'complete',
      ...data,
      completedAt: new Date().toISOString(),
    },
    pagesCompleted: safePageNumber,
    totalPages: safeTotalPages,
  });
}

async function fileComplete(fileId, data = {}) {
  // Write final status — strip heavy internal fields to keep document lean
  await writeFileStatus(fileId, {
    status: 'complete',
    completedAt: new Date().toISOString(),
    ...data,
  });
  // No activity log write — removed to reduce Firebase reads/writes
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
      cin7Status:     'no_match',
      cin7SearchName: searchName,
      cin7Error:      message,
    }),
    writeError(fileId, 'cin7_no_match', message, { searchName, pdfRef }),
    // No activity log — removed
  ]);
}

async function cin7Matched(fileId, result) {
  await writeFileStatus(fileId, {
    cin7Status:    'matched',
    cin7FolderName: result.folderName,
    cin7OrderRef:   result.cin7OrderRef,
    cin7Source:     result.source,
    cin7MatchMethod: result.matchMethod ?? null,
  });
}

module.exports = {
  writeFileStatus,
  writeError,
  fileDetected,
  fileProcessing,
  pageComplete,
  fileComplete,
  fileError,
  cin7NoMatch,
  cin7Matched,
};
