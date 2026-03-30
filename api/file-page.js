/**
 * /api/file-page
 *
 * Called directly by Make.com HTTP module.
 * Does ALL work BEFORE responding — Vercel terminates functions
 * after the response is sent so async work after res.send() is unreliable.
 *
 * Make.com waits up to 40s for a response — Vercel Pro allows 300s.
 *
 * 1. Receives Claude JSON from Make.com
 * 2. Saves to Firestore
 * 3. Downloads page from OneDrive /Temp
 * 4. Uploads to OneDrive /Processed + Google Drive (parallel)
 * 5. Updates Firestore
 * 6. Dispatches next page to Make.com
 * 7. Responds 200 when all done
 */

const db = require('../lib/firebase');
const { buildFilename, getSupplierLabel, getCustomerFolderName, getRefFolder } = require('../lib/namingEngine');
const { uploadFile: uploadToOneDrive } = require('../lib/graph');
const { fileDocuments } = require('../lib/googleDrive');
const axios = require('axios');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 300,
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  console.log('[file-page] Received keys:', Object.keys(body));
  console.log('[file-page] fileId:', body.fileId, '| page:', body.pageNumber, '| total:', body.totalPages);

  const fileId = body.fileId;
  const pageNumber = parseInt(body.pageNumber, 10);
  const totalPages = parseInt(body.totalPages, 10);

  if (!fileId || isNaN(pageNumber)) {
    return res.status(400).json({ error: 'Missing fileId or pageNumber' });
  }

  // Build claudeJson
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

  // Fix null string
  if (claudeJson?.document?.customer?.company_name === 'null' ||
      claudeJson?.document?.customer?.company_name === '') {
    claudeJson.document.customer.company_name = null;
  }

  const docTitle = claudeJson?.document?.header?.title || '';
  const docType = body.document_type || claudeJson?.document_type || '';
  console.log('[file-page] document_type:', docType, '| title:', docTitle,
    '| ref:', claudeJson?.document?.header?.ref,
    '| name:', claudeJson?.document?.customer?.name);

  // Check document type — only process Delivery Orders
  // Claude identifies "Delivery Order" text in the top right of the document
  const isOrderForm = docType === 'delivery_order' ||
    // Fallback if document_type not yet in Make.com payload:
    // only allow if document is not null
    (docType === '' && claudeJson?.document !== null && claudeJson?.document !== undefined);

  if (!isOrderForm) {
    const skipReason = docType
      ? `Document type is "${docType}" — not a customer order`
      : 'Document field is null — not a customer order';
    console.log(`[file-page] Non-order page ${pageNumber} — moving to Branch Transfers folder`);

    // Download the page from Temp
    try {
      const record = await db.getRecord(fileId);
      const ps = record?.pageStore || {};
      const td = ps[pageNumber] || ps[String(pageNumber)];
      if (td?.tempItemId) {
        const pageBuffer = await downloadTempPage(td.tempItemId);
        const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
        const zeroPadded = String(pageNumber).padStart(padWidth, '0');
        const branchFileName = `${record.originalFileName}_${zeroPadded}.pdf`;
        const nonOrderFolder = 'Grove Group Scotland/Grove Bedding/Scans/Non-Order Documents';
        await uploadToOneDrive(nonOrderFolder, branchFileName, pageBuffer);
        console.log(`[file-page] Moved "${branchFileName}" to Non-Order Documents folder`);

        // If this is the last page, delete the original from Scans
        if (pageNumber >= totalPages) {
          await deleteOriginalFromScans(fileId);
        }
      }
    } catch (moveErr) {
      console.error('[file-page] Failed to move to Non-Order Documents:', moveErr.message);
    }

    // Save skipped status to Firestore
    try {
      await db.updatePageResult(fileId, pageNumber, {
        status: 'skipped',
        skipReason,
      });
    } catch(e) { /* non-fatal */ }

    // Dispatch next page so pipeline continues
    if (pageNumber < totalPages) {
      const nextTempData = await waitForTempPage(fileId, pageNumber + 1, 20000);
      if (nextTempData) {
        const rec = await db.getRecord(fileId);
        await dispatchToMake(pageNumber + 1, nextTempData.zeroPadded, fileId, rec.originalFileName, totalPages, nextTempData.tempItemId);
      }
    }

    return res.status(200).json({ status: 'skipped', pageNumber, reason: skipReason });
  }

  // If Claude returned { document_type: "delivery_order", document: {...} }
  // unwrap to get just the document object in expected { document: {...} } structure
  if (claudeJson.document_type && claudeJson.document) {
    claudeJson = { document: claudeJson.document };
  }

  // Do ALL work before responding
  try {
    await processAndFile(fileId, pageNumber, totalPages, claudeJson);
    return res.status(200).json({ status: 'filed', pageNumber });
  } catch (err) {
    console.error(`[file-page] Error on page ${pageNumber}:`, err.message);
    console.error('[file-page] Stack:', err.stack);
    try {
      await db.updatePageResult(fileId, pageNumber, {
        status: 'error', error: err.message,
      });
    } catch (dbErr) {
      console.error('[file-page] Firestore update failed:', dbErr.message);
    }
    return res.status(500).json({ error: err.message, pageNumber });
  }
};

async function processAndFile(fileId, pageNumber, totalPages, claudeJson) {
  const t0 = Date.now();
  const T = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;
  console.log(`[file-page] START page ${pageNumber}/${totalPages} for ${fileId}`);

  // Save JSON to Firestore
  await db.updatePageResult(fileId, pageNumber, { claudeJson, status: 'filing' });
  console.log(`[file-page] ${T()} Saved to Firestore`);

  // Get pageStore from Firestore
  const record = await db.getRecord(fileId);
  const pageStore = record?.pageStore || {};
  const tempData = pageStore[pageNumber] || pageStore[String(pageNumber)];
  console.log(`[file-page] ${T()} pageStore keys: [${Object.keys(pageStore).join(',')}]`);

  if (!tempData?.tempItemId) {
    throw new Error(`No tempItemId for page ${pageNumber}. pageStore keys: [${Object.keys(pageStore).join(',')}]`);
  }

  // Download from OneDrive Temp
  console.log(`[file-page] ${T()} Downloading from Temp: ${tempData.tempItemId}`);
  const pageBuffer = await downloadTempPage(tempData.tempItemId);
  console.log(`[file-page] ${T()} Downloaded ${pageBuffer.length} bytes`);

  // Build filename
  const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
  const zeroPadded = String(pageNumber).padStart(padWidth, '0');
  const finalFileName = buildFilename(claudeJson, zeroPadded);
  const supplierLabel = getSupplierLabel(claudeJson);
  const customerFolderName = getCustomerFolderName(claudeJson);
  const refFolderName = getRefFolder(claudeJson);
  console.log(`[file-page] ${T()} Filename: "${finalFileName}" | Customer: "${customerFolderName}" | Ref: "${refFolderName}"`);

  // Upload to OneDrive and Google Drive in parallel
  console.log(`[file-page] ${T()} Starting parallel uploads...`);
  const processedPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';

  const [oneDriveResult, googleDriveResult] = await Promise.all([
    uploadToOneDrive(processedPath, finalFileName, pageBuffer)
      .then(uploaded => {
        console.log(`[file-page] ${T()} OneDrive OK: "${finalFileName}"`);
        return { fileName: finalFileName, oneDriveId: uploaded.id, oneDriveUrl: uploaded.webUrl };
      })
      .catch(err => {
        console.error(`[file-page] ${T()} OneDrive FAILED:`, err.message);
        return null;
      }),
    fileDocuments(customerFolderName, refFolderName, [{ pageNumber, finalFileName, buffer: pageBuffer }])
      .then(result => {
        console.log(`[file-page] ${T()} Google Drive OK: "${customerFolderName}/${refFolderName}"`);
        return result;
      })
      .catch(err => {
        console.error(`[file-page] ${T()} Google Drive FAILED:`, err.message);
        return null;
      }),
  ]);

  console.log(`[file-page] ${T()} Uploads done. OneDrive: ${!!oneDriveResult} | Google: ${!!googleDriveResult}`);

  // Update Firestore
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
  console.log(`[file-page] ${T()} Firestore updated`);

  // Dispatch next page or mark complete
  const nextPage = pageNumber + 1;
  if (nextPage <= totalPages) {
    console.log(`[file-page] ${T()} Waiting for page ${nextPage} in Temp...`);
    const nextTempData = await waitForTempPage(fileId, nextPage, 20000);
    if (nextTempData) {
      const rec = await db.getRecord(fileId);
      await Promise.all([
        dispatchToMake(nextPage, nextTempData.zeroPadded, fileId, rec.originalFileName, totalPages, nextTempData.tempItemId),
        db.updateRecord(fileId, { currentDispatchPage: nextPage }),
      ]);
      console.log(`[file-page] ${T()} Dispatched page ${nextPage}/${totalPages}`);
    } else {
      throw new Error(`Timed out waiting for page ${nextPage} to appear in Temp`);
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
    googleDriveCustomerFolderUrl: googleDriveResult?.customerFolderUrl || null,
    oneDriveProcessedFolderUrl: 'https://grovebedding-my.sharepoint.com/personal/files_grovebedding_com/Documents/Grove%20Group%20Scotland/Grove%20Bedding/Scans/Processed',
  });

  // Delete original from Scans and clean up Temp — both in background
  Promise.all([
    deleteOriginalFromScans(fileId),
    cleanupTempPages(fileId, finalRecord?.pageStore || {}),
  ]).catch(err => console.warn('[file-page] Cleanup warning:', err.message));

  console.log(`[file-page] ${T()} ✅ Complete — all ${totalPages} pages filed`);
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
      console.warn(`[file-page] Temp cleanup warning:`, err.message);
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

async function deleteOriginalFromScans(fileId) {
  // The fileId IS the OneDrive item ID of the original file in Scans
  try {
    const token = await getToken();
    const userId = process.env.ONEDRIVE_USER_ID;
    // Check it still exists first
    await axios.get(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${fileId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    // Delete it
    await axios.delete(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${fileId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log(`[file-page] Deleted original file ${fileId} from Scans`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[file-page] Original file ${fileId} already gone from Scans`);
    } else {
      console.warn(`[file-page] Could not delete original from Scans:`, err.message);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
