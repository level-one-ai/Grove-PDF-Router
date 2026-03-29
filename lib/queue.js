/**
 * Queue Manager
 * Manages sequential page dispatch to Make.com.
 * Pages are stored in OneDrive /Temp between invocations.
 */

const axios = require('axios');
const db = require('./firebase');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

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

async function downloadTempPage(itemId, userId) {
  const token = await getToken();
  const response = await axios.get(
    `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}/content`,
    { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', maxContentLength: Infinity }
  );
  return Buffer.from(response.data);
}

async function deleteTempPage(itemId, userId) {
  try {
    const token = await getToken();
    await axios.delete(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.warn(`[queue] Could not delete temp file ${itemId}:`, err.message);
  }
}

async function dispatchPageToMake(pageNumber, zeroPadded, fileId, originalFileName, totalPages, tempItemId) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  const fileName = `${originalFileName}_${zeroPadded}.pdf`;

  // Send only metadata — no file data in the payload.
  // Make.com uses the tempItemId to fetch the file directly from OneDrive
  // via the OneDrive "Get a File" module, then passes it to Claude.
  // This avoids all payload size limits.
  const payload = {
    fileName,
    fileId,
    tempItemId,
    pageNumber,
    totalPages,
    originalName: originalFileName,
    zeroPadded,
    secret: process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
  };

  await axios.post(webhookUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}


async function startDispatch(pages, fileId, originalFileName) {
  const userId = process.env.ONEDRIVE_USER_ID;
  const record = await db.getRecord(fileId);
  let pageStore = record?.pageStore;
  const totalPages = pages ? pages.length : record?.totalPages;

  // If pages provided and no pageStore yet, upload them
  if (pages && (!pageStore || Object.keys(pageStore).length === 0)) {
    const token = await getToken();
    pageStore = {};
    for (const page of pages) {
      const tempFileName = `${fileId}_page_${page.zeroPadded}.pdf`;
      const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${TEMP_FOLDER}/${tempFileName}:/content`;
      const response = await axios.put(url, page.buffer, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
        maxBodyLength: Infinity,
      });
      pageStore[String(page.pageNumber)] = {
        zeroPadded: page.zeroPadded,
        tempItemId: response.data.id,
        tempFileName,
      };
    }
    await db.updateRecord(fileId, { pageStore, totalPages, currentDispatchPage: 1, pagesReturned: 0 });
  }

  // Dispatch page 1 — use String key as Firestore returns numeric keys as strings
  const page1 = pageStore[1] || pageStore['1'];
  if (!page1) throw new Error('No page 1 found in pageStore for fileId: ' + fileId);
  await dispatchPageToMake(1, page1.zeroPadded, fileId, originalFileName, totalPages, page1.tempItemId);
}

/**
 * Dispatch the next page — called from /api/callback.
 */
async function dispatchNextPage(fileId, nextPageNumber) {
  const record = await db.getRecord(fileId);
  if (!record) throw new Error(`No record for fileId: ${fileId}`);

  const pageData = record.pageStore?.[nextPageNumber] || record.pageStore?.[String(nextPageNumber)];
  if (!pageData) return false;

  await db.updateRecord(fileId, { currentDispatchPage: nextPageNumber });
  await dispatchPageToMake(nextPageNumber, pageData.zeroPadded, fileId, record.originalFileName, record.totalPages, pageData.tempItemId);
  return true;
}

/**
 * Get a page buffer from OneDrive /Temp.
 */
async function getPageBuffer(fileId, pageNumber) {
  const record = await db.getRecord(fileId);
  const pageData = record?.pageStore?.[pageNumber] || record?.pageStore?.[String(pageNumber)];
  if (!pageData) return null;
  const userId = process.env.ONEDRIVE_USER_ID;
  return await downloadTempPage(pageData.tempItemId, userId);
}

/**
 * Clean up all temp pages for a fileId.
 */
async function cleanupTempPages(fileId) {
  const record = await db.getRecord(fileId);
  const pageStore = record?.pageStore || {};
  const userId = process.env.ONEDRIVE_USER_ID;
  for (const [, pageData] of Object.entries(pageStore)) {
    if (pageData.tempItemId) {
      await deleteTempPage(pageData.tempItemId, userId);
    }
  }
}

module.exports = { startDispatch, dispatchNextPage, getPageBuffer, cleanupTempPages };
