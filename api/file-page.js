/**
 * /api/file-page
 *
 * Handles the slow filing work for each page:
 * - Downloads PDF from OneDrive /Temp
 * - Uploads to OneDrive /Processed with correct filename
 * - Files to Google Drive in correct customer/ref folder
 * - Dispatches next page to Make.com
 * - Marks complete when all pages done
 *
 * Called by /api/callback after saving JSON to Firestore.
 * Runs as a separate function to stay under Vercel's 60s timeout.
 */

const db = require('../lib/firebase');
const { buildFilename, getSupplierLabel, getCustomerFolderName, getRefFolder } = require('../lib/namingEngine');
const { uploadFile: uploadToOneDrive } = require('../lib/graph');
const { fileDocuments } = require('../lib/googleDrive');
const axios = require('axios');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fileId, pageNumber, totalPages } = req.body || {};

  if (!fileId || pageNumber === undefined) {
    return res.status(400).json({ error: 'Missing fileId or pageNumber' });
  }

  // Respond immediately — the actual work happens below
  res.status(200).json({ status: 'filing', pageNumber });

  try {
    await filePage(fileId, parseInt(pageNumber), parseInt(totalPages));
  } catch (err) {
    console.error(`[file-page] Fatal error on page ${pageNumber} for ${fileId}:`, err.message);
    console.error('[file-page] Stack:', err.stack);
    try {
      await db.updatePageResult(fileId, parseInt(pageNumber), {
        status: 'error',
        error: err.message,
      });
    } catch (dbErr) {
      console.error('[file-page] Also failed to update Firestore:', dbErr.message);
    }
  }
};

async function filePage(fileId, pageNumber, totalPages) {
  console.log(`[file-page] Filing page ${pageNumber}/${totalPages} for ${fileId}`);

  // Get the record from Firestore
  const record = await db.getRecord(fileId);
  if (!record) throw new Error(`No record found for fileId: ${fileId}`);

  // Get Claude JSON for this page from Firestore
  const pageData = record.pages?.[pageNumber] || record.pages?.[String(pageNumber)];
  if (!pageData || !pageData.claudeJson) {
    throw new Error(`No Claude JSON found for page ${pageNumber} of ${fileId}`);
  }
  const claudeJson = pageData.claudeJson;

  // Get temp item ID
  const pageStore = record.pageStore || {};
  const tempData = pageStore[pageNumber] || pageStore[String(pageNumber)];
  if (!tempData?.tempItemId) {
    throw new Error(`No tempItemId found for page ${pageNumber} of ${fileId}`);
  }

  // Download page from OneDrive Temp
  console.log(`[file-page] Downloading page ${pageNumber} from Temp`);
  const pageBuffer = await downloadTempPage(tempData.tempItemId);
  if (!pageBuffer) throw new Error(`Failed to download page ${pageNumber} from Temp`);
  console.log(`[file-page] Downloaded ${pageBuffer.length} bytes`);

  // Build filename
  const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
  const zeroPadded = String(pageNumber).padStart(padWidth, '0');
  const finalFileName = buildFilename(claudeJson, zeroPadded);
  const supplierLabel = getSupplierLabel(claudeJson);
  const customerFolderName = getCustomerFolderName(claudeJson);
  const refFolderName = getRefFolder(claudeJson);

  console.log(`[file-page] Filename: "${finalFileName}" | Customer: "${customerFolderName}" | Ref: "${refFolderName}"`);

  // Upload to OneDrive /Processed
  let oneDriveResult = null;
  try {
    const processedFolderPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const uploaded = await uploadToOneDrive(processedFolderPath, finalFileName, pageBuffer);
    oneDriveResult = { fileName: finalFileName, oneDriveId: uploaded.id, oneDriveUrl: uploaded.webUrl };
    console.log(`[file-page] OneDrive upload OK: "${finalFileName}"`);
  } catch (err) {
    console.error(`[file-page] OneDrive upload failed:`, err.graphMessage || err.message);
  }

  // File to Google Drive
  let googleDriveResult = null;
  try {
    googleDriveResult = await fileDocuments(customerFolderName, refFolderName, [{
      pageNumber, finalFileName, buffer: pageBuffer,
    }]);
    console.log(`[file-page] Google Drive OK: "${customerFolderName}/${refFolderName}"`);
  } catch (err) {
    console.error(`[file-page] Google Drive failed:`, err.message);
  }

  // Update Firestore page result
  await db.updatePageResult(fileId, pageNumber, {
    finalFileName,
    supplier: supplierLabel,
    customerName: customerFolderName,
    ref: refFolderName,
    status: 'completed',
    oneDrive: oneDriveResult,
    googleDrive: googleDriveResult ? {
      folderId: googleDriveResult.refFolderId,
      folderUrl: googleDriveResult.refFolderUrl,
      uploadedFile: googleDriveResult.uploadedFiles?.[0] || null,
    } : null,
  });

  // Dispatch next page to Make.com if more remain
  const nextPage = pageNumber + 1;
  if (nextPage <= totalPages) {
    // Wait for next page to be available in Temp (may still be uploading)
    const nextTempData = await waitForTempPage(fileId, nextPage, 30000);
    if (nextTempData) {
      await dispatchToMake(nextPage, nextTempData.zeroPadded, fileId, record.originalFileName, totalPages, nextTempData.tempItemId);
      await db.updateRecord(fileId, { currentDispatchPage: nextPage });
      console.log(`[file-page] Dispatched page ${nextPage}/${totalPages}`);
    } else {
      console.error(`[file-page] Timed out waiting for page ${nextPage} in Temp`);
    }
    return;
  }

  // All pages done — mark completed
  const updatedRecord = await db.getRecord(fileId);
  const pagesData = updatedRecord?.pages || {};
  const renamedFiles = Object.values(pagesData).map(p => p.finalFileName).filter(Boolean);
  const lastPageData = pagesData[pageNumber] || pagesData[String(pageNumber)];

  await db.markCompleted(fileId, {
    renamedFiles,
    customerName: customerFolderName,
    ref: refFolderName,
    supplier: supplierLabel,
    googleDriveFolderId: lastPageData?.googleDrive?.folderId || null,
    googleDriveFolderUrl: lastPageData?.googleDrive?.folderUrl || null,
    oneDriveProcessedFolderUrl: 'https://grovebedding-my.sharepoint.com/personal/files_grovebedding_com/Documents/Grove%20Group%20Scotland/Grove%20Bedding/Scans/Processed',
  });

  // Clean up Temp files
  await cleanupTempPages(fileId, updatedRecord?.pageStore || {});
  console.log(`[file-page] Completed all ${totalPages} pages for ${fileId}`);
}

/**
 * Wait for a temp page to appear in Firestore pageStore.
 * The webhook uploads pages in background so we may need to wait briefly.
 */
async function waitForTempPage(fileId, pageNumber, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const record = await db.getRecord(fileId);
    const pageStore = record?.pageStore || {};
    const tempData = pageStore[pageNumber] || pageStore[String(pageNumber)];
    if (tempData?.tempItemId) return tempData;
    await sleep(2000);
  }
  return null;
}

async function downloadTempPage(tempItemId) {
  const token = await getToken();
  const userId = process.env.ONEDRIVE_USER_ID;
  const response = await axios.get(
    `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${tempItemId}/content`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', maxContentLength: Infinity }
  );
  return Buffer.from(response.data);
}

async function cleanupTempPages(fileId, pageStore) {
  const token = await getToken();
  const userId = process.env.ONEDRIVE_USER_ID;
  for (const [, pageData] of Object.entries(pageStore)) {
    if (!pageData?.tempItemId) continue;
    try {
      await axios.delete(
        `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${pageData.tempItemId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) {
      console.warn(`[file-page] Could not delete temp file:`, err.message);
    }
  }
}

async function dispatchToMake(pageNumber, zeroPadded, fileId, originalFileName, totalPages, tempItemId) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  const fileName = `${originalFileName}_${zeroPadded}.pdf`;
  const payload = {
    fileName, fileId, tempItemId,
    pageNumber, totalPages,
    originalName: originalFileName,
    zeroPadded,
    secret: process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
  };
  await axios.post(webhookUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

async function getToken() {
  const url = `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });
  const r = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return r.data.access_token;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
