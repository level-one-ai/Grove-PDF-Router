/**
 * Queue Manager
 * Manages sequential page dispatch to Make.com.
 *
 * IMPORTANT: Vercel serverless functions share /tmp storage within
 * the same execution environment but NOT across cold starts.
 * To handle this reliably, page buffers are uploaded to OneDrive
 * in a temporary staging area and retrieved when needed.
 * Only lightweight metadata is stored in Firestore.
 */

const axios = require('axios');
const db = require('./firebase');
const { graphRequest } = require('./graph');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

/**
 * Upload a page buffer to OneDrive temp folder.
 * Returns the OneDrive item ID for later retrieval.
 */
async function uploadTempPage(buffer, fileName, userId) {
  const token = await getToken();
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${TEMP_FOLDER}/${fileName}:/content`;

  const response = await axios.put(url, buffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pdf',
    },
    maxBodyLength: Infinity,
  });

  return response.data.id;
}

/**
 * Download a page buffer from OneDrive temp folder by item ID.
 */
async function downloadTempPage(itemId, userId) {
  const token = await getToken();
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}/content`;

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
  });

  return Buffer.from(response.data);
}

/**
 * Delete a temp page from OneDrive after filing is complete.
 */
async function deleteTempPage(itemId, userId) {
  try {
    const token = await getToken();
    await axios.delete(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    // Non-fatal — log and continue
    console.warn(`[queue] Could not delete temp file ${itemId}:`, err.message);
  }
}

// Get a fresh access token
async function getToken() {
  const url = `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });
  const response = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return response.data.access_token;
}

/**
 * Dispatch a single page to Make.com as binary PDF.
 * Metadata sent as HTTP headers.
 */
async function dispatchPageToMake(buffer, pageNumber, zeroPadded, fileId, originalFileName, totalPages) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;

  await axios.post(webhookUrl, buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'X-File-Name': `${originalFileName}_${zeroPadded}.pdf`,
      'X-File-Id': fileId,
      'X-Page-Number': String(pageNumber),
      'X-Total-Pages': String(totalPages),
      'X-Original-File-Name': originalFileName,
      'X-Callback-Secret': process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
    },
    maxBodyLength: Infinity,
    timeout: 30000,
  });
}

/**
 * Start sequential dispatch.
 * Uploads all pages to OneDrive /Temp, stores only item IDs in Firestore,
 * then dispatches page 1 to Make.com.
 */
async function startDispatch(pages, fileId, originalFileName) {
  const userId = process.env.ONEDRIVE_USER_ID;
  const totalPages = pages.length;

  // Upload all pages to OneDrive /Temp and store only their item IDs
  console.log(`[queue] Uploading ${totalPages} page(s) to OneDrive temp folder`);
  const pageStore = {};

  for (const page of pages) {
    const tempFileName = `${fileId}_page_${page.zeroPadded}.pdf`;
    const itemId = await uploadTempPage(page.buffer, tempFileName, userId);
    pageStore[page.pageNumber] = {
      zeroPadded: page.zeroPadded,
      tempItemId: itemId,
      tempFileName,
    };
    console.log(`[queue] Stored page ${page.pageNumber} as temp item ${itemId}`);
  }

  // Save only metadata to Firestore — no binary data
  await db.updateRecord(fileId, {
    pageStore,
    totalPages,
    currentDispatchPage: 1,
    pagesReturned: 0,
  });

  // Dispatch page 1 to Make.com
  const page1Data = pageStore[1];
  const page1Buffer = await downloadTempPage(page1Data.tempItemId, userId);
  await dispatchPageToMake(page1Buffer, 1, page1Data.zeroPadded, fileId, originalFileName, totalPages);

  console.log(`[queue] Page 1/${totalPages} dispatched to Make.com`);
}

/**
 * Dispatch the next page for a fileId.
 * Called from /api/callback after each page's JSON is received.
 */
async function dispatchNextPage(fileId, nextPageNumber) {
  const record = await db.getRecord(fileId);
  if (!record) throw new Error(`No record found for fileId: ${fileId}`);

  const pageData = record.pageStore?.[nextPageNumber];
  if (!pageData) return false;

  const userId = process.env.ONEDRIVE_USER_ID;
  const buffer = await downloadTempPage(pageData.tempItemId, userId);

  await db.updateRecord(fileId, { currentDispatchPage: nextPageNumber });
  await dispatchPageToMake(
    buffer,
    nextPageNumber,
    pageData.zeroPadded,
    fileId,
    record.originalFileName,
    record.totalPages
  );

  return true;
}

/**
 * Retrieve a page buffer from OneDrive temp storage.
 */
async function getPageBuffer(fileId, pageNumber) {
  const record = await db.getRecord(fileId);
  const pageData = record?.pageStore?.[pageNumber];
  if (!pageData) return null;

  const userId = process.env.ONEDRIVE_USER_ID;
  return await downloadTempPage(pageData.tempItemId, userId);
}

/**
 * Clean up all temp pages for a fileId from OneDrive.
 * Called after filing is complete.
 */
async function cleanupTempPages(fileId) {
  const record = await db.getRecord(fileId);
  const pageStore = record?.pageStore || {};
  const userId = process.env.ONEDRIVE_USER_ID;

  for (const [pageNum, pageData] of Object.entries(pageStore)) {
    if (pageData.tempItemId) {
      await deleteTempPage(pageData.tempItemId, userId);
      console.log(`[queue] Deleted temp page ${pageNum} for ${fileId}`);
    }
  }
}

module.exports = {
  startDispatch,
  dispatchNextPage,
  getPageBuffer,
  cleanupTempPages,
};
