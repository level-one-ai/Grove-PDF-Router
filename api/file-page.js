/**
 * /api/file-page
 *
 * Single endpoint called directly by Make.com HTTP module.
 * Replaces /api/callback entirely.
 *
 * Does everything in one call that stays under 60 seconds:
 * 1. Receives Claude JSON from Make.com
 * 2. Saves to Firestore
 * 3. Downloads page from OneDrive /Temp
 * 4. Uploads to OneDrive /Processed
 * 5. Files to Google Drive
 * 6. Dispatches next page to Make.com
 * 7. Marks complete when all pages done
 */

const db = require('../lib/firebase');
const { buildFilename, getSupplierLabel, getCustomerFolderName, getRefFolder } = require('../lib/namingEngine');
const { uploadFile: uploadToOneDrive } = require('../lib/graph');
const { fileDocuments } = require('../lib/googleDrive');
const axios = require('axios');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  console.log('[file-page] Received keys:', Object.keys(body));
  console.log('[file-page] fileId:', body.fileId, '| page:', body.pageNumber, '| total:', body.totalPages);

  // Extract fields
  const fileId = body.fileId;
  const pageNumber = parseInt(body.pageNumber, 10);
  const totalPages = parseInt(body.totalPages, 10);

  if (!fileId || isNaN(pageNumber)) {
    return res.status(400).json({ error: 'Missing fileId or pageNumber' });
  }

  // Build claudeJson from nested or flat fields
  let claudeJson = body.json;
  if (typeof claudeJson === 'string') {
    try { claudeJson = JSON.parse(claudeJson); } catch(e) {
      console.error('[file-page] Failed to parse json string:', e.message);
    }
  }
  if (!claudeJson) {
    claudeJson = buildFromFlatFields(body);
    if (claudeJson) console.log('[file-page] Built claudeJson from flat fields');
  }
  if (!claudeJson) {
    return res.status(400).json({ error: 'Missing json field', keys: Object.keys(body) });
  }

  // Fix null strings
  if (claudeJson?.document?.customer?.company_name === 'null' ||
      claudeJson?.document?.customer?.company_name === '') {
    claudeJson.document.customer.company_name = null;
  }

  console.log('[file-page] title:', claudeJson?.document?.header?.title,
    '| ref:', claudeJson?.document?.header?.ref,
    '| name:', claudeJson?.document?.customer?.name);

  // Respond immediately to Make.com
  res.status(200).json({ status: 'received', pageNumber });

  // Do all work after responding
  try {
    await processAndFile(fileId, pageNumber, totalPages, claudeJson);
  } catch (err) {
    console.error(`[file-page] Fatal error on page ${pageNumber}:`, err.message);
    console.error('[file-page] Stack:', err.stack);
    try {
      await db.updatePageResult(fileId, pageNumber, {
        status: 'error', error: err.message,
      });
    } catch (dbErr) {
      console.error('[file-page] Also failed Firestore update:', dbErr.message);
    }
  }
};

async function processAndFile(fileId, pageNumber, totalPages, claudeJson) {
  // Save JSON to Firestore first
  await db.updatePageResult(fileId, pageNumber, {
    claudeJson,
    status: 'filing',
  });
  console.log(`[file-page] Saved JSON for page ${pageNumber} to Firestore`);

  // Get temp page info from Firestore
  const record = await db.getRecord(fileId);
  const pageStore = record?.pageStore || {};
  const tempData = pageStore[pageNumber] || pageStore[String(pageNumber)];

  if (!tempData?.tempItemId) {
    throw new Error(`No tempItemId for page ${pageNumber} — pageStore keys: ${Object.keys(pageStore).join(',')}`);
  }

  // Download from OneDrive Temp
  console.log(`[file-page] Downloading page ${pageNumber} from Temp (${tempData.tempItemId})`);
  const pageBuffer = await downloadTempPage(tempData.tempItemId);
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
    const processedPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const uploaded = await uploadToOneDrive(processedPath, finalFileName, pageBuffer);
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
    claudeJson,
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

  // Dispatch next page or mark all complete
  const nextPage = pageNumber + 1;
  if (nextPage <= totalPages) {
    // Wait for next page temp upload (webhook uploads in background)
    const nextTempData = await waitForTempPage(fileId, nextPage, 25000);
    if (nextTempData) {
      const rec = await db.getRecord(fileId);
      await dispatchToMake(nextPage, nextTempData.zeroPadded, fileId, rec.originalFileName, totalPages, nextTempData.tempItemId);
      await db.updateRecord(fileId, { currentDispatchPage: nextPage });
      console.log(`[file-page] Dispatched page ${nextPage}/${totalPages}`);
    } else {
      console.error(`[file-page] Timed out waiting for page ${nextPage} in Temp`);
      await db.markError(fileId, new Error(`Timeout waiting for page ${nextPage} to upload to Temp`));
    }
    return;
  }

  // All pages done
  const finalRecord = await db.getRecord(fileId);
  const pagesData = finalRecord?.pages || {};
  const renamedFiles = Object.values(pagesData).map(p => p.finalFileName).filter(Boolean);

  await db.markCompleted(fileId, {
    renamedFiles,
    customerName: customerFolderName,
    ref: refFolderName,
    supplier: supplierLabel,
    googleDriveFolderId: googleDriveResult?.refFolderId || null,
    googleDriveFolderUrl: googleDriveResult?.refFolderUrl || null,
    oneDriveProcessedFolderUrl: 'https://grovebedding-my.sharepoint.com/personal/files_grovebedding_com/Documents/Grove%20Group%20Scotland/Grove%20Bedding/Scans/Processed',
  });

  // Clean up Temp files
  await cleanupTempPages(fileId, finalRecord?.pageStore || {});
  console.log(`[file-page] ✅ All ${totalPages} pages complete for ${fileId}`);
}

async function waitForTempPage(fileId, pageNumber, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const record = await db.getRecord(fileId);
    const ps = record?.pageStore || {};
    const td = ps[pageNumber] || ps[String(pageNumber)];
    if (td?.tempItemId) return td;
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
  for (const [, pd] of Object.entries(pageStore)) {
    if (!pd?.tempItemId) continue;
    try {
      await axios.delete(
        `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${pd.tempItemId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) {
      console.warn(`[file-page] Could not delete temp:`, err.message);
    }
  }
}

async function dispatchToMake(pageNumber, zeroPadded, fileId, originalFileName, totalPages, tempItemId) {
  const payload = {
    fileName: `${originalFileName}_${zeroPadded}.pdf`,
    fileId, tempItemId, pageNumber, totalPages,
    originalName: originalFileName, zeroPadded,
    secret: process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
  };
  await axios.post(process.env.MAKE_WEBHOOK_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });
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

function buildFromFlatFields(body) {
  if (!body.title && !body.customer_name) return null;
  return {
    document: {
      header: {
        title: body.title || '',
        etd: body.etd || '',
        ref: body.ref || '',
        inv_no: body.inv_no || '',
        customer_po_no: body.customer_po_no || '',
      },
      customer: {
        company_name: (body.company_name && body.company_name !== 'null') ? body.company_name : null,
        name: body.customer_name || '',
        address: {
          street: body.street || '',
          city: body.city || '',
          region: body.region || '',
          postcode: body.postcode || '',
          country: body.country || '',
        },
        phone: body.phone || '',
        mobile: body.mobile || '',
      },
      ship_to: {
        name: body.ship_to_name || '',
        address: { street: '', city: '', region: '', postcode: '', country: '' },
      },
      handwritten_notes: body.handwritten_notes || '',
      product_selection: [],
    }
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
