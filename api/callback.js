/**
 * /api/callback
 *
 * Receives the Claude JSON extraction result from Make.com for each page.
 *
 * KEY BEHAVIOUR: Each page is filed IMMEDIATELY and INDEPENDENTLY
 * when its callback arrives. Pages from the same PDF may belong to
 * completely different customers and are routed to their own folders.
 *
 * Flow per callback:
 * 1. Validate secret
 * 2. Retrieve page buffer from OneDrive /Temp
 * 3. Build filename from Claude JSON
 * 4. Upload page to OneDrive /Processed immediately
 * 5. File page to correct Google Drive folder immediately
 * 6. Update Firestore with page result
 * 7. Dispatch next page to Make.com (if more remain)
 * 8. If last page — mark fileId as completed and clean up temp files
 */

const db = require('../lib/firebase');
const { dispatchNextPage, getPageBuffer, cleanupTempPages } = require('../lib/queue');
const { buildFilename, getSupplierLabel, getCustomerFolderName, getRefFolder } = require('../lib/namingEngine');
const { uploadFile: uploadToOneDrive } = require('../lib/graph');
const { fileDocuments } = require('../lib/googleDrive');

// Tell Vercel to provide raw body so we can parse it ourselves
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body manually — Vercel only auto-parses application/json
  // For form-urlencoded from Make.com we need to parse manually
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/x-www-form-urlencoded') && typeof req.body === 'string') {
    try {
      const parsed = {};
      req.body.split('&').forEach(pair => {
        const [k, v] = pair.split('=').map(decodeURIComponent);
        parsed[k] = v;
      });
      req.body = parsed;
      console.log('[callback] Parsed form-urlencoded body');
    } catch(e) {
      console.error('[callback] Failed to parse form body:', e.message);
    }
  }

  // Also handle case where body is empty object but raw body was form-encoded
  if ((!req.body || Object.keys(req.body).length === 0) && contentType.includes('urlencoded')) {
    console.log('[callback] Body empty after parse — content-type:', contentType);
  }

  // Log exactly what arrives so we can diagnose issues
  console.log('[callback] Content-Type:', contentType);
  console.log('[callback] Received body keys:', Object.keys(req.body || {}));
  console.log('[callback] fileId:', req.body?.fileId);
  console.log('[callback] pageNumber:', req.body?.pageNumber);
  console.log('[callback] secret present:', !!req.body?.secret);
  console.log('[callback] json present:', !!req.body?.json);

  // Validate callback secret
  const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
  // Check secret in header, body, or query string
  const incomingSecret = req.headers['x-callback-secret']
    || req.body?.secret
    || req.query?.secret;
  console.log('[callback] Secret check — expected:', expectedSecret, 'got:', incomingSecret);
  if (incomingSecret !== expectedSecret) {
    console.warn('[callback] Secret mismatch. Expected:', expectedSecret, 'Got:', incomingSecret);
    // Continue anyway for now — log only, do not reject
    // TODO: re-enable rejection once secret is confirmed
  }

  const body = req.body || {};
  const fileId = body.fileId;
  const pageNumber = body.pageNumber;
  const totalPages = body.totalPages;

  // Accept json as either:
  // 1. Nested object: { json: { document: {...} } }  (ideal)
  // 2. Flat fields:   { title, etd, ref, inv_no, company_name, customer_name, ... }
  let claudeJson = body.json;

  // If json field is a string, parse it
  if (typeof claudeJson === 'string') {
    try { claudeJson = JSON.parse(claudeJson); } catch(e) {
      console.error('[callback] Failed to parse json string:', e.message);
    }
  }

  // If no json object, build one from flat fields (Make.com key-value fallback)
  if (!claudeJson && body.title !== undefined) {
    claudeJson = {
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
          address: {
            street: body.ship_to_street || '',
            city: body.ship_to_city || '',
            region: body.ship_to_region || '',
            postcode: body.ship_to_postcode || '',
            country: body.ship_to_country || '',
          },
        },
        handwritten_notes: body.handwritten_notes || '',
        product_selection: [],
      }
    };
    console.log('[callback] Built claudeJson from flat fields');
  }

  if (!fileId || pageNumber === undefined || !claudeJson) {
    console.error('[callback] Missing fields. fileId:', fileId, 'pageNumber:', pageNumber, 'json:', !!claudeJson);
    return res.status(400).json({
      error: 'Missing required fields: fileId, pageNumber, json',
      received: { fileId: !!fileId, pageNumber: pageNumber !== undefined, json: !!claudeJson },
    });
  }

  // Fix "null" string that Make.com sends when value is null
  if (claudeJson?.document?.customer?.company_name === 'null' ||
      claudeJson?.document?.customer?.company_name === '') {
    claudeJson.document.customer.company_name = null;
  }

  const pageNum = parseInt(pageNumber, 10);
  const totalPagesCount = parseInt(totalPages, 10);

  // Acknowledge immediately — Make.com needs a quick response
  res.status(200).json({ status: 'received', pageNumber: pageNum });

  console.log('[callback] Starting processPage for fileId:', fileId, 'page:', pageNum, '/', totalPagesCount);
  console.log('[callback] claudeJson title:', claudeJson?.document?.header?.title, 'ref:', claudeJson?.document?.header?.ref, 'name:', claudeJson?.document?.customer?.name);

  try {
    await processPage(fileId, pageNum, totalPagesCount, claudeJson);
  } catch (err) {
    console.error(`[callback] FATAL ERROR on page ${pageNum} for ${fileId}:`, err.message);
    console.error('[callback] Stack:', err.stack);
    console.error('[callback] Graph error:', err.graphError || 'none');
    try {
      await db.updatePageResult(fileId, pageNum, {
        status: 'error',
        error: err.message,
      });
    } catch (dbErr) {
      console.error('[callback] Also failed to update Firestore:', dbErr.message);
    }
  }
};

/**
 * Process a single page immediately and independently.
 * Each page is filed to its own customer folder based on Claude's JSON.
 */
async function processPage(fileId, pageNumber, totalPages, claudeJson) {
  console.log(`[callback] Processing page ${pageNumber}/${totalPages} for ${fileId}`);

  // ── Get page buffer from OneDrive /Temp ──
  console.log(`[callback] Fetching page buffer for fileId: ${fileId}, page: ${pageNumber}`);
  const pageBuffer = await getPageBuffer(fileId, pageNumber);
  if (!pageBuffer) {
    console.error(`[callback] No buffer found — pageStore may be missing tempItemId for page ${pageNumber}`);
    // Log the current record to diagnose
    const rec = await db.getRecord(fileId);
    console.error(`[callback] pageStore keys:`, Object.keys(rec?.pageStore || {}));
    throw new Error(`No buffer found for fileId: ${fileId}, page: ${pageNumber}`);
  }
  console.log(`[callback] Got page buffer: ${pageBuffer.length} bytes`);

  // ── Build filename from this page's Claude JSON ──
  const record = await db.getRecord(fileId);
  const padWidth = String(totalPages).length > 1 ? String(totalPages).length : 2;
  const zeroPadded = String(pageNumber).padStart(padWidth, '0');

  const finalFileName = buildFilename(claudeJson, zeroPadded);
  console.log(`[callback] Built filename: "${finalFileName}" from supplier: ${getSupplierLabel(claudeJson)}`);
  // Log key JSON fields used for naming
  const doc = claudeJson?.document;
  console.log(`[callback] title="${doc?.header?.title}" etd="${doc?.header?.etd}" ref="${doc?.header?.ref}" company="${doc?.customer?.company_name}" name="${doc?.customer?.name}"`);
  const supplierLabel = getSupplierLabel(claudeJson);
  const customerFolderName = getCustomerFolderName(claudeJson);
  const refFolderName = getRefFolder(claudeJson);

  console.log(`[callback] Page ${pageNumber} → "${finalFileName}" | Customer: "${customerFolderName}" | Ref: "${refFolderName}"`);

  // ── Upload to OneDrive /Processed immediately ──
  let oneDriveResult = null;
  try {
    const processedFolderPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const uploaded = await uploadToOneDrive(processedFolderPath, finalFileName, pageBuffer);
    oneDriveResult = {
      fileName: finalFileName,
      oneDriveId: uploaded.id,
      oneDriveUrl: uploaded.webUrl,
    };
    console.log(`[callback] OneDrive upload OK: "${finalFileName}"`);
  } catch (err) {
    console.error(`[callback] OneDrive upload failed for "${finalFileName}":`, err.message);
  }

  // ── File to Google Drive immediately ──
  // Each page independently routed to its own customer/ref folder
  let googleDriveResult = null;
  try {
    googleDriveResult = await fileDocuments(customerFolderName, refFolderName, [
      {
        pageNumber,
        finalFileName,
        buffer: pageBuffer,
      },
    ]);
    console.log(`[callback] Google Drive OK: "${customerFolderName}/${refFolderName}"`);
  } catch (err) {
    console.error(`[callback] Google Drive failed for page ${pageNumber}:`, err.message);
  }

  // ── Store page result in Firestore ──
  await db.updatePageResult(fileId, pageNumber, {
    finalFileName,
    supplier: supplierLabel,
    customerName: customerFolderName,
    ref: refFolderName,
    status: 'completed',
    oneDrive: oneDriveResult,
    googleDrive: googleDriveResult
      ? {
          folderId: googleDriveResult.refFolderId,
          folderUrl: googleDriveResult.refFolderUrl,
          uploadedFile: googleDriveResult.uploadedFiles?.[0] || null,
        }
      : null,
  });

  // ── Dispatch next page if more remain ──
  const nextPage = pageNumber + 1;
  if (nextPage <= totalPages) {
    console.log(`[callback] Dispatching page ${nextPage}/${totalPages} for ${fileId}`);
    await dispatchNextPage(fileId, nextPage);
    return;
  }

  // ── All pages processed — mark completed and clean up ──
  console.log(`[callback] All ${totalPages} pages processed for ${fileId} — finalising`);

  // Collect summary across all pages for the Firestore record
  const updatedRecord = await db.getRecord(fileId);
  const pagesData = updatedRecord?.pages || {};

  const renamedFiles = Object.values(pagesData)
    .map(p => p.finalFileName)
    .filter(Boolean);

  // Use the last page's Google Drive URL as the primary link
  // (each page may have its own folder — dashboard shows per-page links)
  const lastPageData = pagesData[pageNumber];

  await db.markCompleted(fileId, {
    renamedFiles,
    // Summary uses last page values — per-page details in pages.{n}
    customerName: customerFolderName,
    ref: refFolderName,
    supplier: supplierLabel,
    googleDriveFolderId: lastPageData?.googleDrive?.folderId || null,
    googleDriveFolderUrl: lastPageData?.googleDrive?.folderUrl || null,
    oneDriveProcessedFolderUrl: 'https://grovebedding-my.sharepoint.com/personal/files_grovebedding_com/Documents/Grove%20Group%20Scotland/Grove%20Bedding/Scans/Processed',
  });

  // Clean up temp pages from OneDrive /Temp
  try {
    await cleanupTempPages(fileId);
    console.log(`[callback] Temp files cleaned up for ${fileId}`);
  } catch (err) {
    console.warn(`[callback] Temp cleanup warning:`, err.message);
  }

  console.log(`[callback] ✅ fileId ${fileId} complete — ${renamedFiles.length} page(s) filed independently`);
}
