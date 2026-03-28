/**
 * /api/callback
 *
 * Receives the Claude JSON extraction result from Make.com for each page.
 *
 * Flow per callback:
 * 1. Validate secret header
 * 2. Store page result in Firestore
 * 3. Apply naming convention logic
 * 4. If more pages remain → dispatch next page to Make.com
 * 5. If all pages received → file to OneDrive + Google Drive, mark complete
 */

const db = require('../lib/firebase');
const { dispatchNextPage, getPageBuffer, cleanupTempPages } = require('../lib/queue');
const { buildFilename, getSupplierLabel, getCustomerFolderName, getRefFolder } = require('../lib/namingEngine');
const { uploadFile: uploadToOneDrive } = require('../lib/graph');
const { fileDocuments } = require('../lib/googleDrive');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // -------------------------------------------------------
  // Validate callback secret
  // -------------------------------------------------------
  const incomingSecret = req.headers['x-callback-secret'];
  if (incomingSecret !== process.env.CALLBACK_SECRET) {
    console.warn('[callback] Invalid secret, rejecting request');
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const { fileId, pageNumber, totalPages, json: claudeJson } = req.body;

  if (!fileId || !pageNumber || !claudeJson) {
    return res.status(400).json({ error: 'Missing required fields: fileId, pageNumber, json' });
  }

  // Acknowledge immediately
  res.status(200).json({ status: 'received', pageNumber });

  try {
    await processCallback(fileId, pageNumber, totalPages, claudeJson);
  } catch (err) {
    console.error(`[callback] Error processing callback for ${fileId} page ${pageNumber}:`, err);
    await db.markError(fileId, err);
  }
};

async function processCallback(fileId, pageNumber, totalPages, claudeJson) {
  console.log(`[callback] Received page ${pageNumber}/${totalPages} for fileId: ${fileId}`);

  // -------------------------------------------------------
  // Retrieve the PDF buffer for this page from Firestore
  // -------------------------------------------------------
  const pageBuffer = await getPageBuffer(fileId, pageNumber);
  if (!pageBuffer) {
    throw new Error(`No buffer found for fileId: ${fileId}, page: ${pageNumber}`);
  }

  // -------------------------------------------------------
  // Build the final filename using naming engine
  // -------------------------------------------------------
  const record = await db.getRecord(fileId);
  const totalPagesCount = record?.totalPages || totalPages;
  const padWidth = String(totalPagesCount).length > 1 ? String(totalPagesCount).length : 2;
  const zeroPadded = String(pageNumber).padStart(padWidth, '0');

  const finalFileName = buildFilename(claudeJson, zeroPadded);
  const supplierLabel = getSupplierLabel(claudeJson);

  console.log(`[callback] Page ${pageNumber} → ${finalFileName} (${supplierLabel})`);

  // -------------------------------------------------------
  // Store page result in Firestore
  // -------------------------------------------------------
  await db.updatePageResult(fileId, pageNumber, {
    finalFileName,
    supplier: supplierLabel,
    claudeJson,
    status: 'pending-filing',
  });

  // -------------------------------------------------------
  // Dispatch next page if more remain
  // -------------------------------------------------------
  const nextPage = pageNumber + 1;
  if (nextPage <= totalPagesCount) {
    console.log(`[callback] Dispatching page ${nextPage}/${totalPagesCount} for ${fileId}`);
    await dispatchNextPage(fileId, nextPage);
    return; // Wait for next callback
  }

  // -------------------------------------------------------
  // All pages received — begin filing
  // -------------------------------------------------------
  console.log(`[callback] All ${totalPagesCount} pages received for ${fileId}. Beginning filing...`);
  await db.updateRecord(fileId, { status: 'filing' });

  await fileAllPages(fileId, totalPagesCount, claudeJson);
}

async function fileAllPages(fileId, totalPages, lastPageJson) {
  // -------------------------------------------------------
  // Collect all pages from Firestore
  // -------------------------------------------------------
  const record = await db.getRecord(fileId);
  const pagesData = record?.pages || {};

  const pagesToFile = [];
  for (let i = 1; i <= totalPages; i++) {
    const pageData = pagesData[i];
    if (!pageData) {
      console.error(`[callback] Missing page data for page ${i} of fileId ${fileId}`);
      continue;
    }

    const buffer = await getPageBuffer(fileId, i);
    if (!buffer) {
      console.error(`[callback] Missing buffer for page ${i} of fileId ${fileId}`);
      continue;
    }

    pagesToFile.push({
      pageNumber: i,
      finalFileName: pageData.finalFileName,
      buffer,
      claudeJson: pageData.claudeJson,
    });
  }

  // -------------------------------------------------------
  // Upload all pages to OneDrive /Scans/Processed
  // -------------------------------------------------------
  const processedFolder = process.env.ONEDRIVE_PROCESSED_FOLDER;
  const oneDriveResults = [];

  for (const page of pagesToFile) {
    try {
      const uploaded = await uploadToOneDrive(processedFolder, page.finalFileName, page.buffer);
      oneDriveResults.push({
        pageNumber: page.pageNumber,
        fileName: page.finalFileName,
        oneDriveId: uploaded.id,
        oneDriveUrl: uploaded.webUrl,
      });
      console.log(`[callback] Uploaded to OneDrive: ${page.finalFileName}`);
    } catch (err) {
      console.error(`[callback] OneDrive upload failed for ${page.finalFileName}:`, err.message);
    }
  }

  // -------------------------------------------------------
  // Upload all pages to Google Drive
  // Use the last page's JSON to determine folder structure
  // (all pages in same document share same customer/ref)
  // -------------------------------------------------------
  const customerFolderName = getCustomerFolderName(lastPageJson);
  const refFolderName = getRefFolder(lastPageJson);

  let googleDriveResult = null;
  try {
    googleDriveResult = await fileDocuments(customerFolderName, refFolderName, pagesToFile);
    console.log(`[callback] Filed to Google Drive: ${customerFolderName}/${refFolderName}`);
  } catch (err) {
    console.error(`[callback] Google Drive filing failed:`, err.message);
  }

  // -------------------------------------------------------
  // Mark as completed in Firestore
  // -------------------------------------------------------
  const renamedFiles = pagesToFile.map((p) => p.finalFileName);

  await db.markCompleted(fileId, {
    renamedFiles,
    customerName: customerFolderName,
    ref: refFolderName,
    supplier: getSupplierLabel(lastPageJson),
    googleDriveFolderId: googleDriveResult?.refFolderId || null,
    googleDriveFolderUrl: googleDriveResult?.refFolderUrl || null,
    oneDriveProcessedFolderUrl: `https://onedrive.live.com/?path=${encodeURIComponent('/Grove Group Scotland/Grove Bedding/Scans/Processed')}`,
    oneDriveFiles: oneDriveResults,
  });

  // Clean up temp pages from OneDrive
  try {
    await cleanupTempPages(fileId);
    console.log(`[callback] Temp pages cleaned up for ${fileId}`);
  } catch (err) {
    console.warn(`[callback] Temp cleanup warning for ${fileId}:`, err.message);
  }

  console.log(`[callback] ✅ Completed processing for fileId: ${fileId} — ${renamedFiles.length} files filed.`);
}
