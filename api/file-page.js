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
 *
 * CHANGES:
 *  - FIX: originalFileName fetched at top of non-order branch (fixes 500 error)
 *  - FIX: non-order pages now reliably file to Non-Order Documents folder
 *  - PERF: queue fetched once and cached for entire invocation (eliminates per-page reads)
 *  - PERF: pageStore passed through functions rather than re-read from Firestore
 *  - PERF: record data reused across the call rather than fetched multiple times
 */

const db = require('../lib/firebase');
const { buildFilename, getSupplierLabel, getCustomerFolderName, getRefFolder, isCompanyName } = require('../lib/namingEngine');
const { uploadFile: uploadToOneDrive } = require('../lib/graph');
const { fileDocuments } = require('../lib/googleDrive');
const { checkOneDriveDuplicate, checkGoogleDriveDuplicate } = require('../lib/duplicateCheck');
const { lookupCin7FolderName } = require('../lib/cin7');
const { pageComplete, fileComplete, fileError, cin7Matched, cin7NoMatch, writeFileStatus } = require('../lib/statusWriter');
const axios = require('axios');

const TEMP_FOLDER = 'Grove Group Scotland/Grove Bedding/Scans/Temp';

module.exports.config = {
  api: { bodyParser: false, sizeLimit: '10mb' },
  maxDuration: 300,
};

// Resilient raw body parser — handles malformed JSON from Make.com.
async function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => {

      function sanitiseObj(obj) {
        if (typeof obj === 'string') return obj.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
        if (Array.isArray(obj)) return obj.map(sanitiseObj);
        if (obj && typeof obj === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(obj)) out[k] = sanitiseObj(v);
          return out;
        }
        return obj;
      }

      try {
        resolve(sanitiseObj(JSON.parse(raw)));
        return;
      } catch (_) {}

      try {
        const cleaned = raw
          .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
          .replace(/\n/g, ' ')
          .replace(/\r/g, ' ');
        resolve(sanitiseObj(JSON.parse(cleaned)));
        return;
      } catch (_) {}

      try {
        let stripped = raw
          .replace(/"product_selection"\s*:\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*,?\s*/g, '')
          .replace(/"handwritten_notes"\s*:\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*,?\s*/g, '');
        stripped = stripped.replace(/[\x00-\x1F\x7F]/g, ' ');
        resolve(sanitiseObj(JSON.parse(stripped)));
        return;
      } catch (_) {}

      console.warn('[file-page] JSON body unparseable — using regex field extraction');
      const get = (key) => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`));
        return m ? m[1].replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/[\x00-\x1F\x7F]/g, ' ').trim() : '';
      };
      const getProdSelection = () => {
        const m = raw.match(/"product_selection"\s*:\s*"([\s\S]*?)(?<!\\)"\s*[,}]/);
        if (!m) return '';
        return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/[\x00-\x1F\x7F]/g, ' ').trim();
      };
      resolve({
        fileId: get('fileId'),
        pageNumber: get('pageNumber'),
        totalPages: get('totalPages'),
        secret: get('secret'),
        document_type: get('document_type'),
        title: get('title'),
        etd: get('etd'),
        ref: get('ref'),
        inv_no: get('inv_no'),
        customer_po_no: get('customer_po_no'),
        company_name: get('company_name'),
        customer_name: get('customer_name'),
        street: get('street'),
        city: get('city'),
        region: get('region'),
        postcode: get('postcode'),
        country: get('country'),
        phone: get('phone'),
        mobile: get('mobile'),
        ship_to_name: get('ship_to_name'),
        ship_to_street: get('ship_to_street'),
        ship_to_city: get('ship_to_city'),
        ship_to_postcode: get('ship_to_postcode'),
        handwritten_notes: get('handwritten_notes') || '',
        product_selection: getProdSelection(),
      });
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = await parseBody(req);
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
    if (body.document_type) {
      claudeJson = { document_type: body.document_type, document: null };
      console.log('[file-page] Built minimal claudeJson for non-order document');
    } else {
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

  // ── CACHE QUEUE once for entire invocation ──
  // Avoids repeated Firestore reads inside checkForNewPriorityFile
  let cachedQueue = null;
  try {
    cachedQueue = await db.getQueue();
  } catch (e) {
    console.warn('[file-page] Queue prefetch failed (non-fatal):', e.message);
    cachedQueue = { oldFiles: {}, pausedFile: null, autoEnabledAt: null };
  }

  const isOrderForm = docType === 'delivery_order' ||
    (docType === '' && claudeJson?.document !== null && claudeJson?.document !== undefined);

  if (!isOrderForm) {
    const skipReason = docType
      ? `Document type is "${docType}" — not a customer order`
      : 'Document field is null — not a customer order';
    console.log(`[file-page] Non-order page ${pageNumber} — moving to Non-Order Documents folder`);

    const today = new Date().toISOString().slice(0, 10);
    const typeSlug = docType
      ? docType.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      : 'non_order_document';

    // ── FIX: fetch record FIRST so originalFileName is available ──
    let nonOrderFileName = null;
    let record = null;
    let originalFileName = null;
    try {
      record = await db.getRecord(fileId);
      originalFileName = record?.originalFileName || fileId;
      const ps = record?.pageStore || {};
      const td = ps[pageNumber] || ps[String(pageNumber)];
      if (td?.tempItemId) {
        const pageBuffer = await downloadTempPage(td.tempItemId);
        const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
        const zeroPadded = String(pageNumber).padStart(padWidth, '0');
        nonOrderFileName = `${typeSlug}_${today}_${zeroPadded}.pdf`;
        const nonOrderFolder = 'Grove Group Scotland/Grove Bedding/Scans/Non-Order Documents';
        await uploadToOneDrive(nonOrderFolder, nonOrderFileName, pageBuffer);
        console.log(`[file-page] Stored non-order page as "${nonOrderFileName}" in Non-Order Documents`);
      } else {
        console.warn(`[file-page] No tempItemId for non-order page ${pageNumber} — cannot file to Non-Order Documents`);
      }
    } catch (moveErr) {
      console.error('[file-page] Failed to move to Non-Order Documents:', moveErr.message);
    }

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

    // Write page status to Firestore — dashboard reads this
    // Include clear message that this page went to Non-Order Documents
    pageComplete(fileId, pageNumber, totalPages, {
      status:           'non_order',
      docType:          docType || 'non_order',
      nonOrderFileName: nonOrderFileName || null,
      message:          nonOrderFileName
        ? `Filed to Non-Order Documents as "${nonOrderFileName}"`
        : 'Non-order document — could not file (no temp file)',
    }).catch(() => {});

    // Also write current stage so pipeline cards update
    writeFileStatus(fileId, {
      currentStage: 'non_order',
      currentPage:  pageNumber,
      [`page_${pageNumber}_type`]: 'non_order',
      [`page_${pageNumber}_fileName`]: nonOrderFileName || null,
    }).catch(() => {});

    // Continue the chain — dispatch next page regardless
    await dispatchNextOrComplete(fileId, pageNumber, totalPages, originalFileName, record?.pageStore || {}, cachedQueue);

    return res.status(200).json({ status: 'skipped', pageNumber, reason: skipReason, nonOrderFileName });
  }

  if (claudeJson.document_type && claudeJson.document) {
    claudeJson = { document: claudeJson.document };
  }

  try {
    await processAndFile(fileId, pageNumber, totalPages, claudeJson, cachedQueue);
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

    await dispatchNextOrComplete(fileId, pageNumber, totalPages, null, {}, cachedQueue);

    return res.status(200).json({ status: 'error', pageNumber, error: err.message });
  }
};

/**
 * Dispatch next page or mark file complete.
 * PERF: accepts pageStore and cachedQueue to avoid re-reading Firestore.
 */
async function dispatchNextOrComplete(fileId, pageNumber, totalPages, originalFileName, pageStore, cachedQueue) {
  const nextPage = pageNumber + 1;
  if (nextPage <= totalPages) {
    console.log(`[file-page] Dispatching next page ${nextPage} after page ${pageNumber}`);
    try {
      // Use passed-in pageStore first — only read Firestore if not found
      let nextTempData = (pageStore || {})[nextPage] || (pageStore || {})[String(nextPage)] || null;

      if (!nextTempData?.tempItemId) {
        // Not in passed pageStore — always re-read Firestore for the latest pageStore.
        // The passed pageStore may be stale (fetched before scan-now wrote the next
        // page's tempItemId), so we must check the live record regardless of whether
        // we already have originalFileName.
        const r = await db.getRecord(fileId);
        if (!originalFileName) originalFileName = r?.originalFileName;
        const ps = r?.pageStore || {};
        nextTempData = ps[nextPage] || ps[String(nextPage)] || null;
      }

      if (!nextTempData?.tempItemId) {
        // Still not there — wait up to 3 minutes for scan-now to write it
        nextTempData = await waitForTempPage(fileId, nextPage, 180000);
      }

      if (!nextTempData?.tempItemId) {
        // Final direct read fallback after wait
        const latestRecord = await db.getRecord(fileId);
        if (!originalFileName) originalFileName = latestRecord?.originalFileName;
        const latestPs = latestRecord?.pageStore || {};
        nextTempData = latestPs[nextPage] || latestPs[String(nextPage)] || null;
      }

      if (nextTempData?.tempItemId) {
        await Promise.all([
          dispatchToMake(nextPage, nextTempData.zeroPadded, fileId, originalFileName, totalPages, nextTempData.tempItemId),
          db.updateRecord(fileId, { currentDispatchPage: nextPage }),
        ]);
        console.log(`[file-page] Dispatched page ${nextPage}/${totalPages}`);
      } else {
        console.error(`[file-page] Timed out waiting for page ${nextPage} in Temp — chain may be broken`);
      }
    } catch (dispatchErr) {
      console.error(`[file-page] Failed to dispatch page ${nextPage}:`, dispatchErr.message);
    }
  } else {
    console.log(`[file-page] Page ${pageNumber} was the last page — marking complete`);
    try {
      const finalRecord = await db.getRecord(fileId);
      const pagesData = finalRecord?.pages || {};
      const renamedFiles = Object.values(pagesData).map(p => p.finalFileName).filter(Boolean);
      await db.markCompleted(fileId, { renamedFiles });
      Promise.all([
        deleteOriginalFromScans(fileId),
        cleanupTempPages(fileId, finalRecord?.pageStore || {}),
        // Trim heavy fields from processedFiles after completion
        db.updateRecord(fileId, { pageStore: {}, pages: {} }).catch(() => {}),
      ]).catch(err => console.warn('[file-page] Cleanup warning:', err.message));
    } catch (completeErr) {
      console.error('[file-page] Failed to mark complete:', completeErr.message);
    }

    // Write completion to Firestore
    fileComplete(fileId, { pageNumber, totalPages }).catch(() => {});

    const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
    axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }).catch(err => console.warn('[file-page] scan-now trigger warning:', err.message));
  }
}

async function processAndFile(fileId, pageNumber, totalPages, claudeJson, cachedQueue) {
  const t0 = Date.now();
  const T = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;
  console.log(`[file-page] START page ${pageNumber}/${totalPages} for ${fileId}`);

  // Write current stage to pdfRouterStatus so dashboard pipeline shows it
  writeFileStatus(fileId, {
    currentStage: 'extracting',
    currentPage:  pageNumber,
    totalPages,
    fileName: (await db.getRecord(fileId))?.originalFileName || fileId,
  }).catch(() => {});

  // Save JSON to Firestore
  await db.updateRecord(fileId, {
    [`pages.${pageNumber}`]: { claudeJson, status: 'filing' },
  });
  console.log(`[file-page] ${T()} Saved to Firestore`);

  // ── PERF: single record read — extract everything needed from it ──
  const record = await db.getRecord(fileId);
  let originalFileName = record?.originalFileName || fileId;
  const pageStore = record?.pageStore || {};
  const tempData = pageStore[pageNumber] || pageStore[String(pageNumber)];
  console.log(`[file-page] ${T()} pageStore keys: [${Object.keys(pageStore).join(',')}]`);

  if (!tempData?.tempItemId) {
    throw new Error(`No tempItemId for page ${pageNumber}. pageStore keys: [${Object.keys(pageStore).join(',')}]`);
  }

  console.log(`[file-page] ${T()} Downloading from Temp: ${tempData.tempItemId}`);
  const pageBuffer = await downloadTempPage(tempData.tempItemId);
  console.log(`[file-page] ${T()} Downloaded ${pageBuffer.length} bytes`);

  const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
  const zeroPadded = String(pageNumber).padStart(padWidth, '0');

  // ── Cin7 lookup FIRST — before naming the file ────────────────────────────
  writeFileStatus(fileId, { currentStage: 'cin7' }).catch(() => {});

  const claudeCustomerName = claudeJson?.document?.customer?.name         || null;
  const claudeCompanyName  = claudeJson?.document?.customer?.company_name || null;
  const pdfRef             = claudeJson?.document?.header?.ref            || null;
  const pdfPostcode        = claudeJson?.document?.customer?.address?.postcode ||
                             claudeJson?.document?.ship_to?.address?.postcode  || null;
  const pdfMobile          = claudeJson?.document?.customer?.mobile ||
                             claudeJson?.document?.customer?.phone  || null;

  let cin7Result = null;
  try {
    cin7Result = await lookupCin7FolderName({
      customerName: claudeCustomerName,
      companyName:  claudeCompanyName,
      pdfRef,
      pdfPostcode,
      pdfMobile,
      fileId,
    });
  } catch (cin7Err) {
    console.warn(`[file-page] ${T()} Cin7 lookup error (non-fatal): ${cin7Err.message}`);
  }

  if (cin7Result) {
    if (cin7Result.cin7Company && claudeJson?.document?.customer) {
      claudeJson.document.customer.company_name = cin7Result.cin7Company;
    } else if (cin7Result.cin7Customer && claudeJson?.document?.customer) {
      if (!claudeJson.document.customer.company_name) {
        claudeJson.document.customer.name = cin7Result.cin7Customer;
      }
    }
    if (cin7Result.cin7OrderRef && !pdfRef && claudeJson?.document?.header) {
      claudeJson.document.header.ref = cin7Result.cin7OrderRef;
    }
    console.log(`[file-page] ${T()} Cin7 confirmed — patched claudeJson: company="${cin7Result.cin7Company}", ref="${cin7Result.cin7OrderRef}"`);
    cin7Matched(fileId, cin7Result).catch(() => {});
  } else {
    const searchName = claudeCompanyName || claudeCustomerName;
    console.warn(`[file-page] ${T()} Cin7 no match — using Claude-extracted name: "${searchName}"`);
    cin7NoMatch(fileId, searchName, pdfRef,
      `No Cin7 order found for "${searchName}" — used Claude-extracted name`
    ).catch(() => {});
  }

  // ── Now build filename ────────────────────────────────────────────────────
  writeFileStatus(fileId, { currentStage: 'filing' }).catch(() => {});
  const finalFileName    = buildFilename(claudeJson, zeroPadded);
  const supplierLabel    = getSupplierLabel(claudeJson);
  let customerFolderName = cin7Result ? cin7Result.folderName : getCustomerFolderName(claudeJson);
  const refFolderName    = getRefFolder(claudeJson);
  let folderIsCompany    = cin7Result ? cin7Result.source === 'company' : isCompanyName(claudeJson);

  console.log(`[file-page] ${T()} Filename: "${finalFileName}" | Customer: "${customerFolderName}" | Ref: "${refFolderName}" | Cin7 ref confirmed: ${cin7Result?.refMatchConfirmed ?? false}`);

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

  console.log(`[file-page] ${T()} Starting parallel uploads (OD skip: ${odDupResult.isDuplicate}, GD skip: ${gdDupResult?.isDuplicate})...`);
  writeFileStatus(fileId, { currentStage: 'uploading' }).catch(() => {});

  const [oneDriveResult, googleDriveResult] = await Promise.all([
    odDupResult.isDuplicate
      ? Promise.resolve({ fileName: finalFileName, oneDriveId: null, oneDriveUrl: null, skipped: true, skipReason: odDupResult.reason })
      : uploadToOneDrive(processedPath, finalFileName, pageBuffer)
          .then(uploaded => {
            console.log(`[file-page] ${T()} OneDrive OK: "${finalFileName}" | webUrl: ${uploaded.webUrl}`);
            return { fileName: finalFileName, oneDriveId: uploaded.id, oneDriveUrl: uploaded.webUrl || null };
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
      fileUrl: googleDriveResult.uploadedFiles?.[0]?.webViewLink || null,
      uploadedFile: googleDriveResult.uploadedFiles?.[0] || null,
    } : null,
  });
  console.log(`[file-page] ${T()} Firestore updated`);

  // Write page status to Firestore
  pageComplete(fileId, pageNumber, totalPages, {
    finalFileName, customerName: customerFolderName, ref: refFolderName,
  }).catch(() => {});

  const nextPage = pageNumber + 1;
  if (nextPage <= totalPages) {
    // ── PERF: use cachedQueue instead of fetching queue again ──
    {
      const isOld = cachedQueue?.oldFiles?.[fileId] || false;
      if (isOld) {
        const newFileArrived = await checkForNewPriorityFile(fileId, cachedQueue);
        if (newFileArrived) {
          console.log(`[file-page] ${T()} NEW FILE DETECTED — pausing old file after page ${pageNumber}, will resume from page ${nextPage}`);
          await Promise.all([
            db.setPausedFile(fileId, nextPage, totalPages, originalFileName),
            db.updateRecord(fileId, { status: 'paused', pausedAtPage: pageNumber }),
          ]);
          const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
          axios.post(`${baseUrl}/api/scan-now`, {}, {
            headers: { 'Content-Type': 'application/json' }, timeout: 5000,
          }).catch(err => console.warn('[file-page] scan-now trigger warning:', err.message));
          return;
        }
      }
    }

    console.log(`[file-page] ${T()} Dispatching page ${nextPage}/${totalPages}...`);

    // ── PERF: use already-fetched pageStore — only poll if page not yet there ──
    let nextTempData = pageStore[nextPage] || pageStore[String(nextPage)] || null;

    if (!nextTempData?.tempItemId) {
      console.log(`[file-page] ${T()} Page ${nextPage} not in pageStore yet — waiting (max 3 min)...`);
      nextTempData = await waitForTempPage(fileId, nextPage, 180000);
    }

    if (!nextTempData?.tempItemId) {
      console.warn(`[file-page] ${T()} waitForTempPage timed out for page ${nextPage} — doing final direct read`);
      const latestRecord = await db.getRecord(fileId);
      const latestPs = latestRecord?.pageStore || {};
      nextTempData = latestPs[nextPage] || latestPs[String(nextPage)] || null;
    }

    if (nextTempData?.tempItemId) {
      await Promise.all([
        dispatchToMake(nextPage, nextTempData.zeroPadded, fileId, originalFileName, totalPages, nextTempData.tempItemId),
        db.updateRecord(fileId, { currentDispatchPage: nextPage }),
      ]);
      console.log(`[file-page] ${T()} Dispatched page ${nextPage}/${totalPages}`);
    } else {
      const errMsg = `Page ${nextPage} temp file never appeared in Firestore after 3+ minutes — chain broken`;
      console.error(`[file-page] ${T()} ${errMsg}`);
      await db.updateRecord(fileId, {
        [`pages.${nextPage}`]: { status: 'error', error: errMsg },
        error: errMsg,
      });
    }
    return;
  }

  // All pages done
  const finalRecord = await db.getRecord(fileId);
  const pagesData = finalRecord?.pages || {};
  const renamedFiles = Object.values(pagesData).map(p => p.finalFileName).filter(Boolean);

  const completeData = {
    renamedFiles,
    customerName: customerFolderName,
    ref: refFolderName,
    supplier: supplierLabel,
    googleDriveFolderId: googleDriveResult?.refFolderId || null,
    googleDriveFolderUrl: googleDriveResult?.refFolderUrl || null,
    googleDriveCustomerFolderUrl: googleDriveResult?.customerFolderUrl || null,
    oneDriveProcessedFolderUrl: 'https://grovebedding-my.sharepoint.com/personal/files_grovebedding_com/Documents/Grove%20Group%20Scotland/Grove%20Bedding/Scans/Processed',
  };
  await db.markCompleted(fileId, completeData);
  fileComplete(fileId, completeData).catch(() => {});

  Promise.all([
    deleteOriginalFromScans(fileId),
    cleanupTempPages(fileId, finalRecord?.pageStore || {}),
    // Trim heavy internal fields from processedFiles once complete
    // pageStore and pages can be large and are no longer needed after filing
    db.updateRecord(fileId, {
      pageStore: {},
      pages:     {},
    }).catch(() => {}),
  ]).catch(err => console.warn('[file-page] Cleanup warning:', err.message));

  console.log(`[file-page] ${T()} ✅ Complete — all ${totalPages} pages filed`);

  const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
  axios.post(`${baseUrl}/api/scan-now`, {}, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 5000,
  }).catch(err => console.warn('[file-page] scan-now trigger warning:', err.message));
  console.log('[file-page] Auto mode — triggered scan-now for next file');
}

async function waitForTempPage(fileId, pageNumber, timeoutMs) {
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
  if (!body.title && !body.customer_name && !body.document_type) return null;

  const s = v => (typeof v === 'string' ? v.replace(/[\x00-\x1F\x7F]/g, ' ').trim() : (v || ''));

  let handwritten = {};
  if (body.handwritten && typeof body.handwritten === 'object') {
    for (const [k, v] of Object.entries(body.handwritten)) {
      handwritten[k] = s(v);
    }
  } else if (body.handwritten_notes) {
    handwritten = { notes: s(body.handwritten_notes) };
  }

  let product_selection = [];
  const rawProds = body.product_selection;
  if (Array.isArray(rawProds)) {
    product_selection = rawProds.map(p => ({
      item: s(p.item || ''),
      options: s(p.options || ''),
      qty: s(p.qty || ''),
    }));
  } else if (typeof rawProds === 'string' && rawProds.trim()) {
    try {
      const cleaned = rawProds.replace(/[\x00-\x1F\x7F]/g, ' ');
      let parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) parsed = [parsed];
      product_selection = parsed.map(p => ({
        item: s(p.item || ''),
        options: s(p.options || ''),
        qty: s(p.qty || ''),
      }));
    } catch (_) {
      console.warn('[file-page] Could not parse product_selection:', rawProds.slice(0, 100));
    }
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
      product_selection,
    }
  };
}

async function deleteOriginalFromScans(fileId) {
  try {
    const token = await getToken();
    const userId = process.env.ONEDRIVE_USER_ID;
    await axios.get(
      `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${fileId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
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

/**
 * PERF: accepts cachedQueue so we don't re-fetch it per PDF in the Scans folder.
 */
async function checkForNewPriorityFile(currentFileId, cachedQueue) {
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
      if (pdf.id === currentFileId) continue;
      // ── PERF: use cached queue instead of calling db.isOldFile (which fetches queue each time) ──
      const isOld = !!(cachedQueue?.oldFiles?.[pdf.id]);
      if (isOld) continue;
      const existing = await db.getRecord(pdf.id);
      if (!existing || ['reset', null, undefined].includes(existing?.status)) {
        console.log(`[file-page] Priority check: new file found — ${pdf.name}`);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn('[file-page] Priority check error (non-fatal):', err.message);
    return false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
