/**
 * /api/retry-gdrive
 *
 * Iterates through all completed records missing Google Drive URL.
 * Downloads each PDF from OneDrive Processed and files to Google Drive.
 * Processes one file at a time, oldest first.
 * All Firestore calls go through lib/firebase.js which has retry logic.
 */

const db = require('../lib/firebase');
const { getCustomerFolderName, getRefFolder } = require('../lib/namingEngine');
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
    console.error('[retry-gdrive] Fatal error:', err.message);
  }
};

async function retryMissingGoogleDrive() {
  // Get all completed records missing Google Drive — uses withRetry internally
  let records;
  try {
    records = await db.getCompletedMissingGoogleDrive(50);
  } catch (err) {
    console.error('[retry-gdrive] Could not load records:', err.message);
    return;
  }

  if (!records.length) {
    console.log('[retry-gdrive] No records missing Google Drive');
    return;
  }

  console.log(`[retry-gdrive] ${records.length} file(s) need Google Drive filing`);
  const token = await getToken();

  for (const record of records) {
    await processRecord(record, token);
    await sleep(500); // avoid rate limiting between files
  }

  console.log('[retry-gdrive] Complete');
}

async function processRecord(record, token) {
  const fileId = record.fileId;
  const pages = record.pages || {};
  const pageEntries = Object.entries(pages).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

  if (!pageEntries.length) {
    console.log(`[retry-gdrive] "${record.originalFileName}" has no pages — skipping`);
    return;
  }

  console.log(`[retry-gdrive] Processing "${record.originalFileName}" (${pageEntries.length} page(s))`);

  let lastGdResult = null;

  for (const [pageNum, pageData] of pageEntries) {
    // Page already filed to Google Drive
    if (pageData.googleDrive?.folderUrl) {
      lastGdResult = pageData.googleDrive;
      console.log(`[retry-gdrive] Page ${pageNum} already in Google Drive — skipping`);
      continue;
    }

    // Need claudeJson and filename to file
    if (!pageData.claudeJson || !pageData.finalFileName) {
      console.warn(`[retry-gdrive] Page ${pageNum} missing claudeJson or fileName — skipping`);
      continue;
    }

    try {
      // Download from OneDrive Processed
      const pageBuffer = await downloadFromProcessed(pageData.finalFileName, token);
      if (!pageBuffer) {
        console.warn(`[retry-gdrive] Could not download "${pageData.finalFileName}" — skipping`);
        continue;
      }

      // Determine folder names from Claude JSON
      const customerFolderName = getCustomerFolderName(pageData.claudeJson);
      const refFolderName = getRefFolder(pageData.claudeJson);

      if (!customerFolderName || !refFolderName) {
        console.warn(`[retry-gdrive] Missing customer/ref for page ${pageNum} — skipping`);
        continue;
      }

      // File to Google Drive
      console.log(`[retry-gdrive] Filing page ${pageNum} → "${customerFolderName}/${refFolderName}"`);
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

      // Save page-level result
      await db.updateRecord(fileId, {
        [`pages.${pageNum}.googleDrive`]: lastGdResult,
      });

      console.log(`[retry-gdrive] Page ${pageNum} filed ✓`);

    } catch (err) {
      console.error(`[retry-gdrive] Page ${pageNum} failed:`, err.message);
    }
  }

  // Save Google Drive URL at top level of record
  if (lastGdResult?.folderUrl) {
    await db.updateRecord(fileId, {
      googleDriveFolderUrl: lastGdResult.folderUrl,
      googleDriveFolderId: lastGdResult.folderId,
      googleDriveCustomerFolderUrl: lastGdResult.customerFolderUrl || null,
    });
    console.log(`[retry-gdrive] ✅ "${record.originalFileName}" → ${lastGdResult.folderUrl}`);
  } else {
    console.warn(`[retry-gdrive] No Google Drive result saved for "${record.originalFileName}"`);
  }
}

async function downloadFromProcessed(fileName, token) {
  try {
    const userId = process.env.ONEDRIVE_USER_ID;
    const folder = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folder}/${encodeURIComponent(fileName)}:/content`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      timeout: 30000,
    });
    return Buffer.from(response.data);
  } catch (err) {
    console.warn(`[retry-gdrive] Download failed for "${fileName}":`, err.response?.status || err.message);
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
