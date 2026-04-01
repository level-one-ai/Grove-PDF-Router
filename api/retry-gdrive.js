/**
 * /api/retry-gdrive
 *
 * Files processed PDFs to Google Drive for records missing a GD URL.
 * Downloads each PDF from OneDrive Processed and files to Google Drive.
 * Processes one file at a time, oldest first.
 *
 * Deliberately simple — no warmup tricks, just retry logic built in.
 */

const db = require('../lib/firebase');
const { getCustomerFolderName, getRefFolder, isCompanyName } = require('../lib/namingEngine');
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

  // Respond immediately — work runs after
  res.status(200).json({ status: 'started' });

  // Small delay to let Firestore connection settle after cold start
  await sleep(2000);

  try {
    await retryMissingGoogleDrive();
  } catch (err) {
    console.error('[retry-gdrive] Fatal error:', err.message);
  }
};

async function retryMissingGoogleDrive() {
  // Load all completed records using the retry-wrapped function
  let records;
  let attempts = 0;
  while (attempts < 3) {
    try {
      records = await db.getCompletedMissingGoogleDrive(50);
      break;
    } catch (err) {
      attempts++;
      console.warn(`[retry-gdrive] Load attempt ${attempts} failed: ${err.message?.slice(0, 80)}`);
      if (attempts < 3) await sleep(3000);
    }
  }

  if (!records) {
    console.error('[retry-gdrive] Could not load records after 3 attempts');
    return;
  }

  if (!records.length) {
    console.log('[retry-gdrive] No records missing Google Drive — nothing to do');
    return;
  }

  console.log(`[retry-gdrive] ${records.length} file(s) to file to Google Drive`);

  // Get OneDrive token once
  const token = await getToken();

  // Process one file at a time
  for (const record of records) {
    try {
      await processRecord(record, token);
    } catch (err) {
      console.error(`[retry-gdrive] Failed "${record.originalFileName}": ${err.message}`);
    }
    await sleep(1000);
  }

  console.log('[retry-gdrive] All done');
}

async function processRecord(record, token) {
  const fileId = record.fileId;
  const pages = record.pages || {};
  const pageEntries = Object.entries(pages)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

  if (!pageEntries.length) {
    console.log(`[retry-gdrive] "${record.originalFileName}" — no pages, skipping`);
    return;
  }

  console.log(`[retry-gdrive] Filing "${record.originalFileName}" (${pageEntries.length} page(s))`);

  let topLevelGdResult = null;

  for (const [pageNum, pageData] of pageEntries) {
    // Already filed
    if (pageData.googleDrive?.folderUrl) {
      topLevelGdResult = pageData.googleDrive;
      continue;
    }

    if (!pageData.claudeJson || !pageData.finalFileName) continue;

    // Download from OneDrive Processed
    const pageBuffer = await downloadFromProcessed(pageData.finalFileName, token);
    if (!pageBuffer) {
      console.warn(`[retry-gdrive] Could not download "${pageData.finalFileName}"`);
      continue;
    }

    const customerFolderName = getCustomerFolderName(pageData.claudeJson);
    const refFolderName = getRefFolder(pageData.claudeJson);

    if (!customerFolderName || !refFolderName) {
      console.warn(`[retry-gdrive] Missing folder names for page ${pageNum}`);
      continue;
    }

    console.log(`[retry-gdrive] Page ${pageNum} → "${customerFolderName}/${refFolderName}"`);

    const gdResult = await fileDocuments(customerFolderName, refFolderName, [{
      pageNumber: parseInt(pageNum),
      finalFileName: pageData.finalFileName,
      buffer: pageBuffer,
    }]);

    topLevelGdResult = {
      folderId: gdResult.refFolderId,
      folderUrl: gdResult.refFolderUrl,
      customerFolderUrl: gdResult.customerFolderUrl,
    };

    await db.updateRecord(fileId, {
      [`pages.${pageNum}.googleDrive`]: topLevelGdResult,
    });

    console.log(`[retry-gdrive] Page ${pageNum} filed ✓`);
    await sleep(500);
  }

  // Save top-level Google Drive URL
  if (topLevelGdResult?.folderUrl) {
    await db.updateRecord(fileId, {
      googleDriveFolderUrl: topLevelGdResult.folderUrl,
      googleDriveFolderId: topLevelGdResult.folderId,
      googleDriveCustomerFolderUrl: topLevelGdResult.customerFolderUrl || null,
    });
    console.log(`[retry-gdrive] ✅ "${record.originalFileName}" → ${topLevelGdResult.folderUrl}`);
  }
}

async function downloadFromProcessed(fileName, token) {
  try {
    const userId = process.env.ONEDRIVE_USER_ID;
    const folder = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folder}/${encodeURIComponent(fileName)}:/content`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      timeout: 30000,
    });
    return Buffer.from(r.data);
  } catch (err) {
    console.warn(`[retry-gdrive] Download failed "${fileName}": ${err.response?.status || err.message}`);
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
