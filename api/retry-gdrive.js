/**
 * /api/retry-gdrive
 *
 * Finds all completed Firestore records that are missing a Google Drive URL
 * and retries filing them to Google Drive.
 *
 * Called automatically when the processed panel loads,
 * and can be triggered manually from the dashboard.
 *
 * POST /api/retry-gdrive
 */

const db = require('../lib/firebase');
const { buildFilename, getSupplierLabel, getCustomerFolderName, getRefFolder } = require('../lib/namingEngine');
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

  // Respond immediately — work happens async
  res.status(200).json({ status: 'checking', message: 'Checking for missing Google Drive uploads' });

  try {
    await retryMissingGoogleDrive();
  } catch (err) {
    console.error('[retry-gdrive] Error:', err.message);
  }
};

async function retryMissingGoogleDrive() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    admin.firestore().settings({ preferRest: true });
  }

  const snapshot = await admin.firestore()
    .collection('processedFiles')
    .where('status', '==', 'completed')
    .limit(50)
    .get();

  let retried = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const record = doc.data();
    const fileId = record.fileId;

    // Skip if already has Google Drive URL
    if (record.googleDriveFolderUrl) {
      skipped++;
      continue;
    }

    // Skip if no pages with claudeJson
    const pages = record.pages || {};
    const pageEntries = Object.entries(pages);
    if (!pageEntries.length) continue;

    console.log(`[retry-gdrive] Retrying Google Drive for "${record.originalFileName}" (${fileId})`);

    // Try to download from OneDrive Processed and refile to Google Drive
    let anySuccess = false;
    let lastGdResult = null;

    for (const [pageNum, pageData] of pageEntries) {
      if (!pageData.claudeJson || !pageData.finalFileName) continue;
      if (pageData.googleDrive?.folderUrl) {
        lastGdResult = pageData.googleDrive;
        continue; // already filed
      }

      try {
        // Download from OneDrive Processed
        const pageBuffer = await downloadFromProcessed(pageData.finalFileName);
        if (!pageBuffer) {
          console.warn(`[retry-gdrive] Could not download "${pageData.finalFileName}" from Processed`);
          continue;
        }

        const claudeJson = pageData.claudeJson;
        const customerFolderName = getCustomerFolderName(claudeJson);
        const refFolderName = getRefFolder(claudeJson);
        const supplierLabel = getSupplierLabel(claudeJson);

        // File to Google Drive
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

        // Update page record
        await db.updateRecord(fileId, {
          [`pages.${pageNum}.googleDrive`]: lastGdResult,
        });

        console.log(`[retry-gdrive] Filed page ${pageNum} of "${record.originalFileName}" to Google Drive ✓`);
        anySuccess = true;
        retried++;

      } catch (pageErr) {
        console.error(`[retry-gdrive] Failed page ${pageNum} of "${record.originalFileName}":`, pageErr.message);
      }
    }

    // Update top-level record with Google Drive URL
    if (lastGdResult?.folderUrl) {
      await db.updateRecord(fileId, {
        googleDriveFolderUrl: lastGdResult.folderUrl,
        googleDriveFolderId: lastGdResult.folderId,
        googleDriveCustomerFolderUrl: lastGdResult.customerFolderUrl || null,
      });
      console.log(`[retry-gdrive] Updated record for "${record.originalFileName}" ✓`);
    }
  }

  console.log(`[retry-gdrive] Done. Retried: ${retried}, already had GD: ${skipped}`);
}

async function downloadFromProcessed(fileName) {
  try {
    const token = await getToken();
    const userId = process.env.ONEDRIVE_USER_ID;
    const processedPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${processedPath}/${encodeURIComponent(fileName)}:/content`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
    });
    return Buffer.from(response.data);
  } catch (err) {
    console.warn(`[retry-gdrive] Download failed for "${fileName}":`, err.message);
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
