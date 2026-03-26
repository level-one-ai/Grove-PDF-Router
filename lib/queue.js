/**
 * Queue Manager
 * Manages sequential page dispatch to Make.com.
 * Stores pending pages in memory per fileId.
 * In production on Vercel (serverless), state is managed via Firestore
 * to survive cold starts between invocations.
 */

const axios = require('axios');
const db = require('./firebase');

/**
 * Dispatch a single page to Make.com as binary PDF.
 * Metadata is sent as HTTP headers.
 */
async function dispatchPageToMake(page, fileId, originalFileName, totalPages) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;

  await axios.post(webhookUrl, page.buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'X-File-Name': `${originalFileName}_${page.zeroPadded}.pdf`,
      'X-File-Id': fileId,
      'X-Page-Number': String(page.pageNumber),
      'X-Total-Pages': String(totalPages),
      'X-Original-File-Name': originalFileName,
      'X-Callback-Secret': process.env.CALLBACK_SECRET,
    },
    maxBodyLength: Infinity,
    timeout: 30000,
  });
}

/**
 * Start sequential dispatch.
 * Sends page 1 to Make.com. 
 * Subsequent pages are triggered by /api/callback after each page's JSON returns.
 */
async function startDispatch(pages, fileId, originalFileName) {
  // Store all page buffers as base64 in Firestore for retrieval between invocations
  const pageStore = {};
  for (const page of pages) {
    pageStore[page.pageNumber] = {
      zeroPadded: page.zeroPadded,
      bufferB64: page.buffer.toString('base64'),
    };
  }

  await db.updateRecord(fileId, {
    pageStore,
    totalPages: pages.length,
    currentDispatchPage: 1,
    pagesReturned: 0,
  });

  // Send page 1
  await dispatchPageToMake(pages[0], fileId, originalFileName, pages.length);
}

/**
 * Dispatch the next page for a fileId.
 * Called from /api/callback after each page's JSON is received.
 * Returns true if there are more pages, false if all dispatched.
 */
async function dispatchNextPage(fileId, nextPageNumber) {
  const record = await db.getRecord(fileId);
  if (!record) throw new Error(`No record found for fileId: ${fileId}`);

  const pageData = record.pageStore?.[nextPageNumber];
  if (!pageData) return false; // No more pages

  const buffer = Buffer.from(pageData.bufferB64, 'base64');
  const page = {
    pageNumber: nextPageNumber,
    zeroPadded: pageData.zeroPadded,
    buffer,
  };

  await db.updateRecord(fileId, { currentDispatchPage: nextPageNumber });
  await dispatchPageToMake(page, fileId, record.originalFileName, record.totalPages);
  return true;
}

/**
 * Retrieve a stored page buffer from Firestore by fileId and pageNumber.
 */
async function getPageBuffer(fileId, pageNumber) {
  const record = await db.getRecord(fileId);
  const pageData = record?.pageStore?.[pageNumber];
  if (!pageData) return null;
  return Buffer.from(pageData.bufferB64, 'base64');
}

module.exports = {
  startDispatch,
  dispatchNextPage,
  getPageBuffer,
};
