const admin = require('firebase-admin');

function getFirebase() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });

    const db = admin.firestore();
    db.settings({ preferRest: true });
  }
  return admin.firestore();
}

/**
 * Retry wrapper for Firestore operations.
 * Retries up to 3 times with exponential backoff.
 * Handles socket hang up and other transient errors.
 */
async function withRetry(fn, label = 'Firestore', retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isTransient =
        err.message?.includes('socket hang up') ||
        err.message?.includes('DEADLINE_EXCEEDED') ||
        err.message?.includes('UNAVAILABLE') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('EPIPE') ||
        err.message?.includes('write EPIPE') ||
        err.message?.includes('read ECONNRESET') ||
        err.message?.includes('network error') ||
        err.message?.includes('fetch failed') ||
        err.code === 'ECONNRESET' ||
        err.code === 'EPIPE' ||
        err.code === 14; // gRPC UNAVAILABLE

      if (isTransient && i < retries - 1) {
        const delay = Math.min((i + 1) * 1500, 4000); // 1.5s, 3s, 4s, 4s, 4s
        console.warn(`[firebase] ${label} attempt ${i + 1} failed (${err.message?.slice(0, 60)}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[firebase] ${label} failed after ${i + 1} attempt(s):`, err.message);
        throw err;
      }
    }
  }
}

const COLLECTION = 'processedFiles';

async function getRecord(fileId) {
  return withRetry(async () => {
    const db = getFirebase();
    const doc = await db.collection(COLLECTION).doc(fileId).get();
    return doc.exists ? doc.data() : null;
  }, `getRecord(${fileId})`);
}

async function createRecord(fileId, originalFileName) {
  return withRetry(async () => {
    const db = getFirebase();
    await db.collection(COLLECTION).doc(fileId).set({
      fileId, originalFileName, status: 'processing',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: null, totalPages: null, pagesReturned: 0,
      supplier: null, customerName: null, ref: null,
      pages: {}, renamedFiles: [],
      googleDriveFolderUrl: null, googleDriveFolderId: null,
      oneDriveProcessedFolderUrl: null,
    });
  }, `createRecord(${fileId})`);
}

async function updateRecord(fileId, data) {
  return withRetry(async () => {
    const db = getFirebase();
    await db.collection(COLLECTION).doc(fileId).update(data);
  }, `updateRecord(${fileId})`);
}

async function updatePageResult(fileId, pageNumber, pageData) {
  return withRetry(async () => {
    const db = getFirebase();
    await db.collection(COLLECTION).doc(fileId).update({
      [`pages.${pageNumber}`]: pageData,
      pagesReturned: admin.firestore.FieldValue.increment(1),
    });
  }, `updatePageResult(${fileId} p${pageNumber})`);
}

async function markCompleted(fileId, summary) {
  return withRetry(async () => {
    const db = getFirebase();
    await db.collection(COLLECTION).doc(fileId).update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...summary,
    });
  }, `markCompleted(${fileId})`);
}

async function markError(fileId, error) {
  return withRetry(async () => {
    const db = getFirebase();
    await db.collection(COLLECTION).doc(fileId).update({
      status: 'error',
      error: error.message || String(error),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }, `markError(${fileId})`);
}

async function getMode() {
  return withRetry(async () => {
    const db = getFirebase();
    const doc = await db.collection('settings').doc('processingMode').get();
    return doc.exists ? doc.data().mode : 'auto';
  }, 'getMode').catch(() => 'auto'); // safe default on failure
}

async function isAutoStopped() {
  return withRetry(async () => {
    const db = getFirebase();
    const doc = await db.collection('settings').doc('autoControl').get();
    return doc.exists ? doc.data().stopped === true : false;
  }, 'isAutoStopped').catch(() => false); // safe default on failure
}

async function setAutoStopped(stopped) {
  return withRetry(async () => {
    const db = getFirebase();
    await db.collection('settings').doc('autoControl').set({
      stopped, updatedAt: new Date().toISOString(),
    });
  }, 'setAutoStopped');
}

async function addWaitingFile(fileId, fileName, totalPages) {
  return withRetry(async () => {
    const db = getFirebase();
    await db.collection('settings').doc('waitingFiles').set({
      [`files.${fileId}`]: { fileId, fileName, totalPages, addedAt: new Date().toISOString(), status: 'waiting' },
    }, { merge: true });
  }, `addWaitingFile(${fileId})`);
}

async function removeWaitingFile(fileId) {
  return withRetry(async () => {
    const db = getFirebase();
    await db.collection('settings').doc('waitingFiles').update({
      [`files.${fileId}`]: admin.firestore.FieldValue.delete(),
    });
  }, `removeWaitingFile(${fileId})`);
}

async function getWaitingFiles() {
  return withRetry(async () => {
    const db = getFirebase();
    const doc = await db.collection('settings').doc('waitingFiles').get();
    if (!doc.exists) return [];
    return Object.values(doc.data()?.files || {});
  }, 'getWaitingFiles').catch(() => []);
}

/**
 * Warm up the Firestore connection with a lightweight ping.
 * Serverless functions start cold — this establishes the REST
 * connection before heavier queries run.
 */
async function warmup() {
  try {
    const db = getFirebase();
    // Fetch a single tiny document — just to open the connection
    await db.collection('settings').doc('processingMode').get();
    console.log('[firebase] Connection warmed up');
  } catch (err) {
    // Non-fatal — main query will retry anyway
    console.warn('[firebase] Warmup failed (non-fatal):', err.message?.slice(0, 60));
  }
}

async function getCompletedMissingGoogleDrive(limit = 50) {
  // Warm up connection before the main query
  await warmup();
  return withRetry(async () => {
    const db = getFirebase();
    // No orderBy — avoids needing a composite index
    // Sort in JS instead after fetching
    const snapshot = await db
      .collection(COLLECTION)
      .where('status', '==', 'completed')
      .limit(limit)
      .get();
    return snapshot.docs
      .map(doc => doc.data())
      .filter(record => !record.googleDriveFolderUrl)
      .sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() || new Date(a.createdAt || 0).getTime();
        const tb = b.createdAt?.toMillis?.() || new Date(b.createdAt || 0).getTime();
        return ta - tb; // oldest first
      });
  }, 'getCompletedMissingGoogleDrive');
}

module.exports = {
  getRecord, createRecord, updateRecord, updatePageResult,
  markCompleted, markError, getMode,
  isAutoStopped, setAutoStopped,
  addWaitingFile, removeWaitingFile, getWaitingFiles,
  getCompletedMissingGoogleDrive,
};
