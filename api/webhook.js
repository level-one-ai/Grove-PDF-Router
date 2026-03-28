/**
 * /api/webhook
 *
 * Receives Microsoft Graph API change notifications.
 *
 * Because the subscription watches the drive root (required for
 * OneDrive for Business / SharePoint accounts), we receive notifications
 * for ALL drive changes. We filter by checking only the Scans folder
 * for new PDFs not yet in Firestore.
 *
 * Flow:
 * 1. Validate clientState secret
 * 2. Scan the Scans folder for recent PDFs
 * 3. Skip any already in Firestore
 * 4. Download, split and dispatch new ones to Make.com
 */

const db = require('../lib/firebase');
const { downloadFile, graphRequest } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const { startDispatch } = require('../lib/queue');

module.exports = async function handler(req, res) {
  // ── Graph API Validation Token Handshake ──
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[webhook] Validation token handshake received');
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
    if (notifications.length === 0) return;

    // Validate at least one notification has the correct clientState
    const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
    const validNotification = notifications.find(
      n => n.clientState === expectedSecret
    );

    if (!validNotification) {
      console.warn('[webhook] No valid clientState found in notifications — ignoring');
      return;
    }

    console.log(`[webhook] Received ${notifications.length} notification(s) — scanning Scans folder`);
    await scanForNewFiles();

  } catch (err) {
    console.error('[webhook] Error:', err.graphMessage || err.message);
  }
};

/**
 * Scan the Scans folder for PDFs not yet in Firestore.
 * Process any new ones through the full pipeline.
 */
async function scanForNewFiles() {
  const userId = process.env.ONEDRIVE_USER_ID;
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';

  // List the 20 most recently created files in the Scans folder
  const result = await graphRequest(
    'GET',
    `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,file,createdDateTime` +
    `&$orderby=createdDateTime desc` +
    `&$top=20`
  );

  const items = result?.value || [];

  // Filter to PDFs only
  const pdfFiles = items.filter(item => {
    const name = (item.name || '').toLowerCase();
    const mime = item.file?.mimeType || '';
    return name.endsWith('.pdf') || mime.includes('pdf');
  });

  console.log(`[webhook] Found ${pdfFiles.length} PDF(s) in Scans folder`);

  // Process each PDF not already in Firestore
  for (const file of pdfFiles) {
    const existing = await db.getRecord(file.id);
    if (existing) {
      console.log(`[webhook] Skipping "${file.name}" — already ${existing.status}`);
      continue;
    }

    console.log(`[webhook] New file: "${file.name}" — starting processing`);
    await processFile(file.id, file.name);
  }
}

async function processFile(itemId, fileName) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');

  // Create Firestore record immediately to prevent duplicate processing
  await db.createRecord(itemId, originalFileName);

  // Download PDF from OneDrive
  let pdfBuffer;
  try {
    pdfBuffer = await downloadFile(itemId);
    console.log(`[webhook] Downloaded "${originalFileName}" — ${pdfBuffer.length} bytes`);
  } catch (err) {
    console.error(`[webhook] Download failed for "${originalFileName}":`, err.message);
    await db.markError(itemId, err);
    return;
  }

  // Split into individual pages
  let pages, totalPages;
  try {
    ({ pages, totalPages } = await splitPdf(pdfBuffer));
    console.log(`[webhook] Split "${originalFileName}" into ${totalPages} page(s)`);
  } catch (err) {
    console.error(`[webhook] Split failed for "${originalFileName}":`, err.message);
    await db.markError(itemId, err);
    return;
  }

  // Dispatch page 1 to Make.com
  // Remaining pages dispatched sequentially from /api/callback
  try {
    await startDispatch(pages, itemId, originalFileName);
    console.log(`[webhook] Page 1/${totalPages} dispatched to Make.com for "${originalFileName}"`);
  } catch (err) {
    console.error(`[webhook] Dispatch failed for "${originalFileName}":`, err.message);
    await db.markError(itemId, err);
  }
}
