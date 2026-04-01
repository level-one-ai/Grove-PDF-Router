/**
 * /api/retry-gdrive
 *
 * Finds completed records missing Google Drive URL and retries filing them.
 * Uses lib/firebase.js which has preferRest + retry logic to avoid socket hang up.
 */

const db = require('../lib/firebase');
const { getCustomerFolderName, getRefFolder, getSupplierLabel } = require('../lib/namingEngine');
const { fileDocuments } = require('../lib/googleDrive');
const axios = require('axios');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 300,
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.status(200).json({ status: 'checking' });

  try {
    await retryMissingGoogleDrive();
  } catch (err) {
    console.error('[retry-gdrive] Error:', err.message);
  }
};

async function retryMissingGoogleDrive() {
  // Use admin directly but only after lib/firebase ensures it's initialised
  // Trigger init via a db call
  await db.getMode().catch(() => {});

  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    console.error('[retry-gdrive] Firebase not initialised');
    return;
  }

  const firestore = admin.firestore();
  let snapshot;
  try {
    snapshot = await firestore
      .collection('processedFiles')
      .where('status', '==', 'completed')
      .orderBy('createdAt', 'asc')
      .limit(50)
      .get();
  } catch (err) {
    console.error('[retry-gdrive] Firestore query failed:', err.message);
    return;
  }

  // Filter to only records missing Google Drive URL
  const missing = snapshot.docs.filter(doc => !doc.data().googleDriveFolderUrl);
  console.log(`[retry-gdrive] ${snapshot.docs.length} completed records, ${missing.length} missing Google Drive`);

  let retried = 0;

  // Process ONE file at a time, oldest first
  for (const doc of missing) {
    const record = doc.data();
    const fileId = record.fileId;

    const pages = record.pages || {};
    const pageEntries = Object.entries(pages);
    if (!pageEntries.length) continue;

    console.log(`[retry-gdrive] Retrying Google Drive for "${record.originalFileName}"`);

    let lastGdResult = null;

    for (const [pageNum, pageData] of pageEntries) {
      if (!pageData.claudeJson || !pageData.finalFileName) continue;
      if (pageData.googleDrive?.folderUrl) {
        lastGdResult = pageData.googleDrive;
        continue;
      }

      try {
        const pageBuffer = await downloadFromProcessed(pageData.finalFileName);
        if (!pageBuffer) continue;

        const claudeJson = pageData.claudeJson;
        const customerFolderName = getCustomerFolderName(claudeJson);
        const refFolderName = getRefFolder(claudeJson);

        const gdResult = await fileDocuments(customerFolderName, refFolderName, [{
          pageNumber: parseInt(pageNum),
          finalFileName: pageData.finalFileName,
          buffer: pageBuffer,
        }]);

        lastGdResult = {
          folderId: gdResult.refFolderId,
          folderUrl: gdResult.refFolderUrl,
          customerFolderUrl: gdResult.customerFolderUrl,
        };

        await db.updateRecord(fileId, {
          [`pages.${pageNum}.googleDrive`]: lastGdResult,
        });

        console.log(`[retry-gdrive] Filed page ${pageNum} of "${record.originalFileName}" ✓`);
        retried++;

      } catch (pageErr) {
        console.error(`[retry-gdrive] Page ${pageNum} failed:`, pageErr.message);
      }
    }

    // Update top-level record
    if (lastGdResult?.folderUrl) {
      await db.updateRecord(fileId, {
        googleDriveFolderUrl: lastGdResult.folderUrl,
        googleDriveFolderId: lastGdResult.folderId,
        googleDriveCustomerFolderUrl: lastGdResult.customerFolderUrl || null,
      });
      console.log(`[retry-gdrive] Updated record for "${record.originalFileName}" ✓`);
    }

    // Brief pause between files to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[retry-gdrive] Done. Retried: ${retried} pages`);
}

async function downloadFromProcessed(fileName) {
  try {
    const token = await getToken();
    const userId = process.env.ONEDRIVE_USER_ID;
    const path = `Grove Group Scotland/Grove Bedding/Scans/Processed`;
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${path}/${encodeURIComponent(fileName)}:/content`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      timeout: 30000,
    });
    return Buffer.from(response.data);
  } catch (err) {
    console.warn(`[retry-gdrive] Could not download "${fileName}":`, err.message);
    return null;
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
