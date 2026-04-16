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
const { buildFilename, getSupplierLabel, getCustomerFolderName, getRefFolder, isCompanyName } = require('../lib/namingEngine');
const { uploadFile: uploadToOneDrive } = require('../lib/graph');
const { fileDocuments } = require('../lib/googleDrive');
const { checkOneDriveDuplicate, checkGoogleDriveDuplicate } = require('../lib/duplicateCheck');
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
    // If document_type is present but document fields are empty (e.g. non-order doc),
    // build a minimal claudeJson so the type check can still run
    if (body.document_type) {
      claudeJson = { document_type: body.document_type, document: null };
      console.log('[file-page] Built minimal claudeJson for non-order document');
    } else {
      // Fallback: callback.js may have already saved claudeJson to Firestore —
      // retrieve it so the processing chain continues when triggered via /api/callback
      try {
        const record = await db.getRecord(fileId);
        const savedPage = record?.pages?.[pageNumber] || record?.pages?.[String(pageNumber)];
        if (savedPage?.claudeJson) {
          claudeJson = savedPage.claudeJson;
          console.log('[file-page] Retrieved claudeJson from Firestore (saved by callback)');
        }
      } catch (lookupErr) {
        console.warn('[file-page] Firestore claudeJson lookup failed:', lookupErr.message);
      }

      if (!claudeJson) {
        return res.status(400).json({ error: 'Missing json field', keys: Object.keys(body) });
      }
    }
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
    console.log(`[file-page] Non-order page ${pageNumber} — moving to Non-Order Documents folder`);

    // Build a descriptive filename: <docType>_<YYYY-MM-DD>_<zeroPadded>.pdf
    // e.g. "branch_transfer_2026-04-06_01.pdf"
    // Falls back to "non_order_document" if Claude didn't return a document type.
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const typeSlug = docType
      ? docType.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      : 'non_order_document';

    // Download the page from Temp and store in Non-Order Documents with new name
    let nonOrderFileName = null;
    let record = null; // hoisted so it's accessible after the try block
    try {
      record = await db.getRecord(fileId);
      const ps = record?.pageStore || {};
      const td = ps[pageNumber] || ps[String(pageNumber)];
      if (td?.tempItemId) {
        const pageBuffer = await downloadTempPage(td.tempItemId);
        const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
        const zeroPadded = String(pageNumber).padStart(padWidth, '0');
        // Rename with document type and processed date
        nonOrderFileName = `${typeSlug}_${today}_${zeroPadded}.pdf`;
        const nonOrderFolder = 'Grove Group Scotland/Grove Bedding/Scans/Non-Order Documents';
        await uploadToOneDrive(nonOrderFolder, nonOrderFileName, pageBuffer);
        console.log(`[file-page] Stored non-order page as "${nonOrderFileName}" in Non-Order Documents`);
      }
    } catch (moveErr) {
      console.error('[file-page] Failed to move to Non-Order Documents:', moveErr.message);
    }

    // Save skipped status to Firestore — include the final filename so it shows on the dashboard
    try {
      await db.updateRecord(fileId, {
        [`pages.${pageNumber}`]: {
          status: 'skipped',
          skipReason,
          nonOrderFileName: nonOrderFileName || null,
          docType: typeSlug,
        },
        pagesReturned: require('firebase-admin').firestore.FieldValue.increment(1),
      });
    } catch(e) { /* non-fatal */ }

    // Dispatch next page or mark complete — non-order pages must NOT stop the chain
    await dispatchNextOrComplete(fileId, pageNumber, totalPages, record?.originalFileName);

    // Respond 200 AFTER all work — Make.com expects 200
    return res.status(200).json({ status: 'skipped', pageNumber, reason: skipReason, nonOrderFileName });
  }

  // If Claude returned { document_type: "delivery_order", document: {...} }
  // unwrap to get just the document object in expected { document: {...} } structure
  if (claudeJson.document_type && claudeJson.document) {
    claudeJson = { document: claudeJson.document };
  }

  // Do ALL work before responding — Make.com waits for our response
  try {
    await processAndFile(fileId, pageNumber, totalPages, claudeJson);
    return res.status(200).json({ status: 'filed', pageNumber });
  } catch (err) {
    console.error(`[file-page] Error on page ${pageNumber}:`, err.message);
    console.error('[file-page] Stack:', err.stack);
    try {
      await db.updateRecord(fileId, {
        [`pages.${pageNumber}`]: { status: 'error', error: err.message },
        pagesReturned: require('firebase-admin').firestore.FieldValue.increment(1),
      });
    } catch (dbErr) {
      console.error('[file-page] Firestore update failed:', dbErr.message);
    }

    // Even on error, dispatch the next page so the chain keeps going
    await dispatchNextOrComplete(fileId, pageNumber, totalPages);

    return res.status(200).json({ status: 'error', pageNumber, error: err.message });
  }
};

/**
 * Dispatch the next page to Make.com, or mark the file as complete if this was the last page.
 * Used after non-order skips and errors to keep the chain alive.
 */
async function dispatchNextOrComplete(fileId, pageNumber, totalPages, originalFileName) {
  const nextPage = pageNumber + 1;
  if (nextPage <= totalPages) {
    console.log(`[file-page] Dispatching next page ${nextPage} after page ${pageNumber}`);
    try {
      const nextTempData = await waitForTempPage(fileId, nextPage, 120000);
      if (nextTempData) {
        const rec = await db.getRecord(fileId);
        await Promise.all([
          dispatchToMake(nextPage, nextTempData.zeroPadded, fileId, rec.originalFileName, totalPages, nextTempData.tempItemId),
          db.updateRecord(fileId, { currentDispatchPage: nextPage }),
        ]);
        console.log(`[file-page] Dispatched page ${nextPage}/${totalPages}`);
      } else {
        console.error(`[file-page] Timed out waiting for page ${nextPage} in Temp`);
      }
    } catch (dispatchErr) {
      console.error(`[file-page] Failed to dispatch page ${nextPage}:`, dispatchErr.message);
    }
  } else {
    // This was the last page — mark the file as complete and clean up
    console.log(`[file-page] Page ${pageNumber} was the last page — marking complete`);
    try {
      const finalRecord = await db.getRecord(fileId);
      const pagesData = finalRecord?.pages || {};
      const renamedFiles = Object.values(pagesData).map(p => p.finalFileName).filter(Boolean);
      await db.markCompleted(fileId, { renamedFiles });
      Promise.all([
        deleteOriginalFromScans(fileId),
        cleanupTempPages(fileId, finalRecord?.pageStore || {}),
      ]).catch(err => console.warn('[file-page] Cleanup warning:', err.message));
    } catch (completeErr) {
      console.error('[file-page] Failed to mark complete:', completeErr.message);
    }

    // Always trigger scan-now to pick up the next file
    const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
    axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }).catch(err => console.warn('[file-page] scan-now trigger warning:', err.message));
  }
}

async function processAndFile(fileId, pageNumber, totalPages, claudeJson) {
  const t0 = Date.now();
  const T = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;
  console.log(`[file-page] START page ${pageNumber}/${totalPages} for ${fileId}`);

  // Save JSON to Firestore
  await db.updateRecord(fileId, {
    [`pages.${pageNumber}`]: { claudeJson, status: 'filing' },
  });
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
  const folderIsCompany = isCompanyName(claudeJson);
  console.log(`[file-page] ${T()} Filename: "${finalFileName}" | Customer: "${customerFolderName}" | Ref: "${refFolderName}"`);

  // ── DUPLICATE CHECKS ──
  // Run both checks concurrently before uploading to either destination.
  // Each check compares filename AND file size (+ MD5 for Google Drive) so that
  // files which coincidentally share a name but have different content are not
  // incorrectly skipped.
  console.log(`[file-page] ${T()} Running duplicate checks...`);
  const processedPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
  const userId = process.env.ONEDRIVE_USER_ID;

  const [odDupResult, gdDupResult] = await Promise.all([
    checkOneDriveDuplicate(finalFileName, pageBuffer, processedPath, getToken, userId),
    fileDocuments.checkBeforeUpload
      ? fileDocuments.checkBeforeUpload(customerFolderName, refFolderName, finalFileName, pageBuffer, folderIsCompany)
      : Promise.resolve({ isDuplicate: false, reason: 'pre-check not available' }),
  ]).catch(() => [{ isDuplicate: false }, { isDuplicate: false }]);

  if (odDupResult.isDuplicate) {
    console.warn(`[file-page] ${T()} ONEDRIVE DUPLICATE: "${finalFileName}" — ${odDupResult.reason}`);
  }
  if (gdDupResult && gdDupResult.isDuplicate) {
    console.warn(`[file-page] ${T()} GOOGLE DRIVE DUPLICATE: "${finalFileName}" — ${gdDupResult.reason}`);
  }

  // ── PARALLEL UPLOADS ──
  console.log(`[file-page] ${T()} Starting parallel uploads (OD skip: ${odDupResult.isDuplicate}, GD skip: ${gdDupResult?.isDuplicate})...`);

  const [oneDriveResult, googleDriveResult] = await Promise.all([
    odDupResult.isDuplicate
      ? Promise.resolve({ fileName: finalFileName, oneDriveId: null, oneDriveUrl: null, skipped: true, skipReason: odDupResult.reason })
      : uploadToOneDrive(processedPath, finalFileName, pageBuffer)
          .then(uploaded => {
            console.log(`[file-page] ${T()} OneDrive OK: "${finalFileName}"`);
            return { fileName: finalFileName, oneDriveId: uploaded.id, oneDriveUrl: uploaded.webUrl };
          })
          .catch(err => {
            console.error(`[file-page] ${T()} OneDrive FAILED:`, err.message);
            return null;
          }),
    fileDocuments(customerFolderName, refFolderName, [{ pageNumber, finalFileName, buffer: pageBuffer }], folderIsCompany, gdDupResult)
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
    // googleDriveFolderUrl already saved inline above if GD succeeded
  });
  console.log(`[file-page] ${T()} Firestore updated`);

  // Dispatch next page or mark complete
  const nextPage = pageNumber + 1;
  if (nextPage <= totalPages) {
    // ── PRIORITY CHECK ──
    // Before dispatching the next page of this (potentially old) file, check whether
    // a new higher-priority file has arrived. If so, pause here and let scan-now
    // pick up the new file first. We resume this file once new files are done.
    {
      const isOld = await db.isOldFile(fileId);
      if (isOld) {
        const newFileArrived = await checkForNewPriorityFile(fileId);
        if (newFileArrived) {
          console.log(`[file-page] ${T()} NEW FILE DETECTED — pausing old file after page ${pageNumber}, will resume from page ${nextPage}`);
          const rec = await db.getRecord(fileId);
          await Promise.all([
            db.setPausedFile(fileId, nextPage, totalPages, rec.originalFileName),
            db.updateRecord(fileId, { status: 'paused', pausedAtPage: pageNumber }),
          ]);
          // Trigger scan-now to pick up the new file immediately
          const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
          axios.post(`${baseUrl}/api/scan-now`, {}, {
            headers: { 'Content-Type': 'application/json' }, timeout: 5000,
          }).catch(err => console.warn('[file-page] scan-now trigger warning:', err.message));
          return; // Stop processing this file for now
        }
      }
    }

    console.log(`[file-page] ${T()} Waiting for page ${nextPage} in Temp (onSnapshot — 0 poll reads)...`);
    const nextTempData = await waitForTempPage(fileId, nextPage, 120000);
    if (nextTempData) {
      // If originalFileName not passed by caller, read from Firestore once
      if (!originalFileName) {
        const r = await db.getRecord(fileId);
        originalFileName = r?.originalFileName;
      }
      await Promise.all([
        dispatchToMake(nextPage, nextTempData.zeroPadded, fileId, originalFileName, totalPages, nextTempData.tempItemId),
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

  // Delete original from Scans and clean up Temp in background
  Promise.all([
    deleteOriginalFromScans(fileId),
    cleanupTempPages(fileId, finalRecord?.pageStore || {}),
  ]).catch(err => console.warn('[file-page] Cleanup warning:', err.message));

  console.log(`[file-page] ${T()} ✅ Complete — all ${totalPages} pages filed`);

  // In auto mode, trigger scan-now to pick up the next file in the queue
  { // Always auto — no mode check needed
    const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
    axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }).catch(err => console.warn('[file-page] scan-now trigger warning:', err.message));
    console.log('[file-page] Auto mode — triggered scan-now for next file');
  }
}

async function waitForTempPage(fileId, pageNumber, timeoutMs) {
  // Use a Firestore onSnapshot listener instead of polling.
  // Fires the instant scan-now writes the page's tempItemId — zero polling reads.
  // Falls back to a single direct read first in case the page is already there.
  const admin = require('firebase-admin');
  const firestore = admin.firestore();
  const COLLECTION = 'processedFiles';

  return new Promise((resolve) => {
    let resolved = false;
    const deadline = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (unsubscribe) unsubscribe();
        console.warn(`[file-page] waitForTempPage timed out for page ${pageNumber}`);
        resolve(null);
      }
    }, timeoutMs);

    let unsubscribe = null;

    unsubscribe = firestore.collection(COLLECTION).doc(fileId)
      .onSnapshot(snap => {
        if (resolved) return;
        if (!snap.exists) return;
        const data = snap.data();
        const ps = data?.pageStore || {};
        const td = ps[pageNumber] || ps[String(pageNumber)];
        if (td?.tempItemId) {
          resolved = true;
          clearTimeout(deadline);
          unsubscribe();
          resolve(td);
        }
      }, err => {
        // Snapshot error — fall back to single read
        console.warn(`[file-page] waitForTempPage snapshot error, falling back to poll:`, err.message);
        if (!resolved) {
          db.getRecord(fileId).then(record => {
            const ps = record?.pageStore || {};
            const td = ps[pageNumber] || ps[String(pageNumber)];
            if (td?.tempItemId && !resolved) {
              resolved = true;
              clearTimeout(deadline);
              resolve(td);
            }
          }).catch(() => {});
        }
      });
  });
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
  // Strip control characters (raw newlines, tabs, etc.) from all string fields
  // to prevent "Bad control character in JSON" errors in Make.com's HTTP module
  const clean = s => (typeof s === 'string' ? s.replace(/[\x00-\x1F\x7F]/g, '') : s);

  const payload = {
    fileName: clean(`${originalFileName}_${zeroPadded}.pdf`),
    fileId: clean(fileId),
    tempItemId: clean(tempItemId),
    pageNumber,
    totalPages,
    originalName: clean(originalFileName),
    zeroPadded: clean(zeroPadded),
    secret: clean(process.env.CALLBACK_SECRET || 'grove-pdf-router-secret'),
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
  // Always build if we have any document fields OR a document_type
  // Non-order documents have document_type but empty document fields
  if (!body.title && !body.customer_name && !body.document_type) return null;

  // Sanitise string: strip control characters (raw newlines, tabs etc.) that
  // are illegal inside JSON strings and cause Make.com's HTTP module to reject payloads.
  const s = v => (typeof v === 'string' ? v.replace(/[\x00-\x1F\x7F]/g, ' ').trim() : (v || ''));

  // Handle dynamic handwritten object — Claude now returns a key-value object
  // with variable keys depending on what annotations appear on each page.
  // If Make.com sends it as a nested object use it directly; otherwise fall back
  // to the legacy handwritten_notes flat string for backwards compatibility.
  let handwritten = {};
  if (body.handwritten && typeof body.handwritten === 'object') {
    // Sanitise every value in the dynamic handwritten object
    for (const [k, v] of Object.entries(body.handwritten)) {
      handwritten[k] = s(v);
    }
  } else if (body.handwritten_notes) {
    // Legacy flat field fallback
    handwritten = { notes: s(body.handwritten_notes) };
  }

  return {
    document: {
      header: {
        title: s(body.title),
        etd: s(body.etd),
        ref: s(body.ref),
        inv_no: s(body.inv_no),
        customer_po_no: s(body.customer_po_no),
      },
      customer: {
        company_name: (body.company_name && body.company_name !== 'null') ? s(body.company_name) : null,
        name: s(body.customer_name),
        address: {
          street: s(body.street),
          city: s(body.city),
          region: s(body.region),
          postcode: s(body.postcode),
          country: s(body.country),
        },
        phone: s(body.phone),
        mobile: s(body.mobile),
      },
      ship_to: {
        name: s(body.ship_to_name),
        address: { street: '', city: '', region: '', postcode: '', country: '' },
      },
      handwritten,
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

async function checkForNewPriorityFile(currentFileId) {
  // Returns true if there is a file in the Scans folder that is NOT marked as old
  // (i.e. it arrived after auto mode was switched on) and hasn't started processing yet.
  try {
    const userId = process.env.ONEDRIVE_USER_ID;
    const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
    const token = await getToken();
    const response = await axios.get(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}:/children` +
      `?=id,name,file,createdDateTime&=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const items = response.data?.value || [];
    const pdfs = items.filter(item => {
      const name = (item.name || '').toLowerCase();
      return name.endsWith('.pdf') || (item.file?.mimeType || '').includes('pdf');
    });

    for (const pdf of pdfs) {
      if (pdf.id === currentFileId) continue; // skip self
      const isOld = await db.isOldFile(pdf.id);
      if (isOld) continue; // skip other old files
      // This file is new — check it hasn't already started processing
      const existing = await db.getRecord(pdf.id);
      if (!existing || ['reset', null, undefined].includes(existing?.status)) {
        console.log(`[file-page] Priority check: new file found — ${pdf.name}`);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn('[file-page] Priority check error (non-fatal):', err.message);
    return false; // fail safe — don't pause if check fails
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
