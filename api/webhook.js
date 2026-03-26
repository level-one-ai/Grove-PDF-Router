/**
 * /api/webhook
 *
 * Receives Microsoft Graph API change notifications when a new file
 * is added to the watched OneDrive folder.
 *
 * Flow:
 * 1. Validate clientState secret
 * 2. Check Firestore for duplicate processing
 * 3. Download the PDF from OneDrive
 * 4. Split into single pages using pdf-lib
 * 5. Store page buffers in Firestore
 * 6. Dispatch page 1 to Make.com (sequential — next pages dispatched from /api/callback)
 */

const db = require('../lib/firebase');
const { downloadFile, getFileMetadata } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const { startDispatch } = require('../lib/queue');

module.exports = async function handler(req, res) {
  // -------------------------------------------------------
  // Graph API Validation Token Handshake
  // -------------------------------------------------------
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[webhook] Validation token handshake');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Acknowledge immediately — Graph API requires a 202 within 3 seconds
  res.status(202).json({ status: 'accepted' });

  try {
    const notifications = req.body?.value || [];

    for (const notification of notifications) {
      await processNotification(notification);
    }
  } catch (err) {
    console.error('[webhook] Error processing notifications:', err);
  }
};

async function processNotification(notification) {
  // -------------------------------------------------------
  // Validate client state (security check)
  // -------------------------------------------------------
  if (notification.clientState !== process.env.CALLBACK_SECRET) {
    console.warn('[webhook] Invalid clientState, ignoring notification');
    return;
  }

  const itemId = notification.resourceData?.id;
  if (!itemId) {
    console.warn('[webhook] No itemId in notification, skipping');
    return;
  }

  console.log(`[webhook] Processing notification for itemId: ${itemId}`);

  // -------------------------------------------------------
  // Loop prevention — check Firestore
  // -------------------------------------------------------
  const existing = await db.getRecord(itemId);
  if (existing) {
    console.log(`[webhook] fileId ${itemId} already exists with status: ${existing.status}. Skipping.`);
    return;
  }

  // -------------------------------------------------------
  // Get file metadata from OneDrive
  // -------------------------------------------------------
  let metadata;
  try {
    metadata = await getFileMetadata(itemId);
  } catch (err) {
    console.error(`[webhook] Failed to get metadata for ${itemId}:`, err.message);
    return;
  }

  const originalFileName = metadata.name?.replace(/\.pdf$/i, '') || 'unknown';
  const mimeType = metadata.file?.mimeType || '';

  // Only process PDF files
  if (!mimeType.includes('pdf') && !metadata.name?.toLowerCase().endsWith('.pdf')) {
    console.log(`[webhook] File ${metadata.name} is not a PDF, skipping`);
    return;
  }

  // -------------------------------------------------------
  // Create Firestore record
  // -------------------------------------------------------
  await db.createRecord(itemId, originalFileName);
  console.log(`[webhook] Created Firestore record for: ${originalFileName}`);

  // -------------------------------------------------------
  // Download PDF from OneDrive
  // -------------------------------------------------------
  let pdfBuffer;
  try {
    pdfBuffer = await downloadFile(itemId);
    console.log(`[webhook] Downloaded PDF: ${originalFileName} (${pdfBuffer.length} bytes)`);
  } catch (err) {
    console.error(`[webhook] Failed to download ${itemId}:`, err.message);
    await db.markError(itemId, err);
    return;
  }

  // -------------------------------------------------------
  // Split PDF into individual pages
  // -------------------------------------------------------
  let pages, totalPages;
  try {
    ({ pages, totalPages } = await splitPdf(pdfBuffer));
    console.log(`[webhook] Split ${originalFileName} into ${totalPages} page(s)`);
  } catch (err) {
    console.error(`[webhook] Failed to split PDF ${itemId}:`, err.message);
    await db.markError(itemId, err);
    return;
  }

  // -------------------------------------------------------
  // Start sequential dispatch — sends page 1 to Make.com
  // Remaining pages dispatched from /api/callback
  // -------------------------------------------------------
  try {
    await startDispatch(pages, itemId, originalFileName);
    console.log(`[webhook] Dispatched page 1 of ${totalPages} to Make.com for ${originalFileName}`);
  } catch (err) {
    console.error(`[webhook] Failed to dispatch page 1 for ${itemId}:`, err.message);
    await db.markError(itemId, err);
  }
}
