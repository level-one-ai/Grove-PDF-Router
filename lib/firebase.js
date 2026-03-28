const admin = require('firebase-admin');

let app;

function getFirebase() {
  if (!app) {
    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

const COLLECTION = 'processedFiles';

async function getRecord(fileId) {
  const db = getFirebase();
  const doc = await db.collection(COLLECTION).doc(fileId).get();
  return doc.exists ? doc.data() : null;
}

async function createRecord(fileId, originalFileName) {
  const db = getFirebase();
  await db.collection(COLLECTION).doc(fileId).set({
    fileId,
    originalFileName,
    status: 'processing',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    completedAt: null,
    totalPages: null,
    pagesReturned: 0,
    supplier: null,
    customerName: null,
    ref: null,
    pages: {},
    renamedFiles: [],
    googleDriveFolderUrl: null,
    googleDriveFolderId: null,
    oneDriveProcessedFolderUrl: null,
  });
}

async function updateRecord(fileId, data) {
  const db = getFirebase();
  await db.collection(COLLECTION).doc(fileId).update(data);
}

async function updatePageResult(fileId, pageNumber, pageData) {
  const db = getFirebase();
  const update = {
    [`pages.${pageNumber}`]: pageData,
    pagesReturned: admin.firestore.FieldValue.increment(1),
  };
  await db.collection(COLLECTION).doc(fileId).update(update);
}

async function markCompleted(fileId, summary) {
  const db = getFirebase();
  await db.collection(COLLECTION).doc(fileId).update({
    status: 'completed',
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...summary,
  });
}

async function markError(fileId, error) {
  const db = getFirebase();
  await db.collection(COLLECTION).doc(fileId).update({
    status: 'error',
    error: error.message || String(error),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = {
  getRecord,
  createRecord,
  updateRecord,
  updatePageResult,
  markCompleted,
  markError,
};

// ── MODE & WAITING FILES ──

async function getMode() {
  const db = getFirebase();
  const doc = await db.collection('settings').doc('processingMode').get();
  return doc.exists ? doc.data().mode : 'auto';
}

async function addWaitingFile(fileId, fileName, totalPages) {
  const db = getFirebase();
  await db.collection('settings').doc('waitingFiles').set({
    [`files.${fileId}`]: {
      fileId,
      fileName,
      totalPages,
      addedAt: new Date().toISOString(),
      status: 'waiting',
    },
  }, { merge: true });
}

async function removeWaitingFile(fileId) {
  const db = getFirebase();
  const admin = require('firebase-admin');
  await db.collection('settings').doc('waitingFiles').update({
    [`files.${fileId}`]: admin.firestore.FieldValue.delete(),
  });
}

async function getWaitingFiles() {
  const db = getFirebase();
  const doc = await db.collection('settings').doc('waitingFiles').get();
  if (!doc.exists) return [];
  const data = doc.data()?.files || {};
  return Object.values(data);
}

module.exports = {
  getRecord,
  createRecord,
  updateRecord,
  updatePageResult,
  markCompleted,
  markError,
  getMode,
  addWaitingFile,
  removeWaitingFile,
  getWaitingFiles,
};
