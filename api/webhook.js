/**
 * /api/webhook
 *
 * Receives Microsoft Graph API change notifications.
 *
 * AUTO MODE:   New file → download → split → dispatch to Make.com → file → complete
 * HUMAN MODE:  New file → download → split → PAUSE → dashboard notification
 */

const db = require('../lib/firebase');
const { downloadFile, graphRequest } = require('../lib/graph');
const { splitPdf } = require('../lib/pdfSplitter');
const { startDispatch } = require('../lib/queue');
const axios = require('axios');

module.exports = async function handler(req, res) {
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[webhook] Validation token handshake');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.status(202).json({ status: 'accepted' });

  try {
    const notifications = req.body?.value || [];
    if (notifications.length === 0) return;

    const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
    const valid = notifications.find(n => n.clientState === expectedSecret);
    if (!valid) {
      console.warn('[webhook] Invalid clientState — ignoring');
      return;
    }

    console.log('[webhook] Valid notification — scanning folder');
    await scanForNewFiles();
  } catch (err) {
    console.error('[webhook] Error:', err.message);
  }
};

async function scanForNewFiles() {
  const userId = process.env.ONEDRIVE_USER_ID;
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';

  const result = await graphRequest(
    'GET',
    `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,file,createdDateTime&$orderby=createdDateTime desc&$top=20`
  );

  const pdfFiles = (result?.value || []).filter(item => {
    const name = (item.name || '').toLowerCase();
    const mime = item.file?.mimeType || '';
    return name.endsWith('.pdf') || mime.includes('pdf');
  });

  const mode = await db.getMode();
  console.log(`[webhook] Mode: ${mode} — ${pdfFiles.length} PDF(s) in folder`);

  for (const file of pdfFiles) {
    const existing = await db.getRecord(file.id);
    if (existing && existing.status !== 'reset') continue;
    console.log(`[webhook] New file: "${file.name}"`);
    await processFile(file.id, file.name, mode);
  }
}

async function processFile(itemId, fileName, mode) {
  const originalFileName = fileName.replace(/\.pdf$/i, '');

  // Create or reset record
  const existing = await db.getRecord(itemId);
  if (existing) {
    await db.updateRecord(itemId, {
      status: 'processing',
      pagesReturned: 0,
      totalPages: null,
      pages: {},
      renamedFiles: [],
      pageStore: {},
      completedAt: null,
      error: null,
    });
  } else {
    await db.createRecord(itemId, originalFileName);
  }

  // Download
  let pdfBuffer;
  try {
    pdfBuffer = await downloadFile(itemId);
    console.log(`[webhook] Downloaded "${originalFileName}" (${pdfBuffer.length} bytes)`);
  } catch (err) {
    await db.markError(itemId, err);
    return;
  }

  // Split
  let pages, totalPages;
  try {
    ({ pages, totalPages } = await splitPdf(pdfBuffer));
    console.log(`[webhook] Split into ${totalPages} page(s)`);
  } catch (err) {
    await db.markError(itemId, err);
    return;
  }

  // Upload pages to OneDrive /Temp (needed in both modes)
  const pageStore = await uploadPagesToTemp(pages, itemId);
  await db.updateRecord(itemId, {
    pageStore,
    totalPages,
    currentDispatchPage: 1,
    pagesReturned: 0,
  });

  if (mode === 'human') {
    // HUMAN MODE — pause here, notify dashboard
    await db.updateRecord(itemId, { status: 'waiting', totalPages, mode: 'human' });
    await db.addWaitingFile(itemId, fileName, totalPages);
    console.log(`[webhook] Human mode — "${originalFileName}" waiting for approval`);
  } else {
    // AUTO MODE — dispatch page 1 immediately
    try {
      await startDispatch(pages, itemId, originalFileName);
      console.log(`[webhook] Auto mode — page 1/${totalPages} dispatched`);
    } catch (err) {
      await db.markError(itemId, err);
    }
  }
}

async function uploadPagesToTemp(pages, fileId) {
  const userId = process.env.ONEDRIVE_USER_ID;
  const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

  // Get access token
  const tokenRes = await axios.post(
    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const token = tokenRes.data.access_token;

  const pageStore = {};
  for (const page of pages) {
    const tempFileName = `${fileId}_page_${page.zeroPadded}.pdf`;
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${TEMP_FOLDER}/${tempFileName}:/content`;
    const response = await axios.put(url, page.buffer, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
      maxBodyLength: Infinity,
    });
    pageStore[page.pageNumber] = {
      zeroPadded: page.zeroPadded,
      tempItemId: response.data.id,
      tempFileName,
    };
  }
  return pageStore;
}
