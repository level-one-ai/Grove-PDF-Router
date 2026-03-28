/**
 * /api/webhook
 *
 * Receives Microsoft Graph API change notifications when a file
 * is added to the watched OneDrive folder.
 *
 * Note: Graph API reports new files in a drive folder as 'updated'
 * events on the folder itself, not 'created' events on the file.
 * We handle this by listing recent files in the folder and processing
 * any new PDFs not already in Firestore.
 *
 * Flow:
 * 1. Validate clientState secret
 * 2. List recent files in Scans folder
 * 3. Check Firestore for each file — skip already processed ones
 * 4. Download, split and dispatch any new PDFs
 */

const db = require('../lib/firebase');
const { downloadFile, getFileMetadata, graphRequest } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const { startDispatch } = require('../lib/queue');

module.exports = async function handler(req, res) {
  // ── Graph API Validation Token Handshake ──
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[webhook] Validation token handshake');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Acknowledge immediately — Graph API requires 202 within 3 seconds
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
  // Validate client state
  const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
  if (notification.clientState !== expectedSecret) {
    console.warn('[webhook] Invalid clientState, ignoring notification');
    return;
  }

  console.log('[webhook] Valid notification received — scanning for new files');

  try {
    const userId = process.env.ONEDRIVE_USER_ID;
    const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';

    // List files in the Scans folder
    const result = await graphRequest(
      'GET',
      `/users/${userId}/drive/root:/${folderPath}:/children?$select=id,name,file,createdDateTime&$orderby=createdDateTime desc&$top=10`
    );

    const items = result?.value || [];

    // Filter to PDFs only
    const pdfFiles = items.filter((item) => {
      const name = (item.name || '').toLowerCase();
      const mime = item.file?.mimeType || '';
      return name.endsWith('.pdf') || mime.includes('pdf');
    });

    // Process each PDF that hasn't been seen before
    for (const file of pdfFiles) {
      const existing = await db.getRecord(file.id);
      if (existing) {
        console.log(`[webhook] Skipping ${file.name} — already processed (${existing.status})`);
        continue;
      }

      console.log(`[webhook] New file detected: ${file.name}`);
      await processFile(file.id, file.name);
    }

  } catch (err) {
    console.error('[webhook] Error scanning folder:', err.graphMessage || err.message);
  }
}

async function processFile(itemId, fileName) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');

  // Create Firestore record
  await db.createRecord(itemId, originalFileName);
  console.log(`[webhook] Created record for: ${originalFileName}`);

  // Download PDF
  let pdfBuffer;
  try {
    pdfBuffer = await downloadFile(itemId);
    console.log(`[webhook] Downloaded: ${originalFileName} (${pdfBuffer.length} bytes)`);
  } catch (err) {
    console.error(`[webhook] Download failed for ${itemId}:`, err.message);
    await db.markError(itemId, err);
    return;
  }

  // Split PDF
  let pages, totalPages;
  try {
    ({ pages, totalPages } = await splitPdf(pdfBuffer));
    console.log(`[webhook] Split into ${totalPages} page(s)`);
  } catch (err) {
    console.error(`[webhook] Split failed for ${itemId}:`, err.message);
    await db.markError(itemId, err);
    return;
  }

  // Dispatch page 1 to Make.com — remaining pages dispatched from /api/callback
  try {
    await startDispatch(pages, itemId, originalFileName);
    console.log(`[webhook] Dispatched page 1 of ${totalPages} to Make.com`);
  } catch (err) {
    console.error(`[webhook] Dispatch failed for ${itemId}:`, err.message);
    await db.markError(itemId, err);
  }
}
