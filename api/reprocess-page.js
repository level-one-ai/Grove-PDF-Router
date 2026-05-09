/**
 * /api/reprocess-page
 *
 * Reprocesses a single page that was previously processed.
 * Source: the renamed PDF already in OneDrive Processed.
 *
 * Flow:
 *   1. Look up the page in Firestore — get OneDrive ID + current name
 *   2. Download the PDF bytes from OneDrive
 *   3. Send to PDF Extractor (same flow as fresh processing)
 *   4. Run fresh Cin7 lookup (cache bypassed)
 *   5. Build new filename
 *   6. If new filename === current filename: no-op
 *   7. Otherwise:
 *      - Upload new file to OneDrive Processed
 *      - Move old OneDrive file to Recycle Bin
 *      - Upload new file to Google Drive (correct customer/ref folder)
 *      - Move old Google Drive file to Bin
 *      - Update Firestore with new filename + URLs
 *
 * Request body: { fileId: string, pageNumber: number, secret: string }
 */

const axios = require('axios');
const FormData = require('form-data');
const { downloadFile, uploadFile, graphRequest } = require('../lib/graph');
const { lookupCin7FolderName } = require('../lib/cin7');
const { fileDocuments } = require('../lib/googleDrive');
const {
  buildFilename, getCustomerFolderName, getRefFolder, isCompanyName,
} = require('../lib/namingEngine');

const PROCESSED_PATH = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
const EXTRACTOR_URL  = process.env.EXTRACTOR_URL || 'https://grove-pdf-extractor.vercel.app/api/index';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const providedSecret = body.secret || req.headers['x-callback-secret'];
  const expectedSecret = process.env.CALLBACK_SECRET || 'abc123xyz';
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { fileId, pageNumber } = body;
  if (!fileId || !pageNumber) {
    return res.status(400).json({ error: 'fileId and pageNumber required' });
  }

  console.log(`[reprocess-page] Starting reprocess for ${fileId} page ${pageNumber}`);

  try {
    // ── 1. Look up dashboard status to find page details ────────────────
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }

    const dashSnapshot = await admin.firestore().collection('pdfRouterStatus').doc(fileId).get();
    if (!dashSnapshot.exists) {
      return res.status(404).json({ error: 'File not found in dashboard records' });
    }
    const dashData = dashSnapshot.data();
    const pageData = dashData[`page_${pageNumber}`];
    if (!pageData) {
      return res.status(404).json({ error: `Page ${pageNumber} not found for this file` });
    }

    const oldOneDriveId       = pageData.oneDriveId;
    const oldGoogleDriveFileId = pageData.googleDriveFileId;
    const oldFileName         = pageData.finalFileName;

    if (!oldOneDriveId) {
      return res.status(400).json({
        error: 'OneDrive file ID missing — this page was processed before reprocess support was added. Please upload the original PDF to Scans again.',
      });
    }

    console.log(`[reprocess-page] Source: ${oldFileName} (OneDrive ID: ${oldOneDriveId})`);

    // ── 2. Download from OneDrive ─────────────────────────────────────────
    const pdfBuffer = await downloadFile(oldOneDriveId);
    console.log(`[reprocess-page] Downloaded ${pdfBuffer.length} bytes`);

    // ── 3. Send to PDF Extractor ──────────────────────────────────────────
    const form = new FormData();
    form.append('file', pdfBuffer, { filename: 'page.pdf', contentType: 'application/pdf' });

    const extractRes = await axios.post(EXTRACTOR_URL, form, {
      headers: form.getHeaders(),
      timeout: 50000,
      maxBodyLength: Infinity,
    });
    const claudeJson = extractRes.data;
    console.log(`[reprocess-page] Extractor returned document_type=${claudeJson?.document_type}`);

    if (claudeJson?.document_type !== 'delivery_order') {
      // Not a delivery order — move it to Non-Order Documents instead of erroring.
      // This lets reprocess clean up mis-classified files (e.g. Sealy delivery
      // returns that an older, less strict gatekeeper wrongly accepted).
      const NON_ORDER_PATH = 'Grove Group Scotland/Grove Bedding/Scans/Non-Order Documents';
      const nonOrderName   = `other_${new Date().toISOString().slice(0, 10)}_${String(pageNumber).padStart(2, '0')}.pdf`;

      console.log(`[reprocess-page] Not a delivery order — moving to Non-Order Documents as "${nonOrderName}"`);

      // Upload to Non-Order Documents folder
      let nonOrderUpload = null;
      try {
        nonOrderUpload = await uploadFile(NON_ORDER_PATH, nonOrderName, pdfBuffer);
        console.log(`[reprocess-page] Non-order upload OK → ${nonOrderUpload.id}`);
      } catch (err) {
        console.error(`[reprocess-page] Non-order upload FAILED: ${err.message}`);
        return res.status(500).json({
          error: 'Could not move file to Non-Order Documents: ' + err.message,
        });
      }

      // Move old OneDrive file (in Processed) to Recycle Bin
      try {
        const userId = process.env.ONEDRIVE_USER_ID;
        await graphRequest('DELETE', `/users/${userId}/drive/items/${oldOneDriveId}`);
        console.log(`[reprocess-page] Old Processed file moved to bin: "${oldFileName}"`);
      } catch (err) {
        console.warn(`[reprocess-page] Could not move old OneDrive file to bin: ${err.message}`);
      }

      // Move old Google Drive file (if any) to Bin
      if (oldGoogleDriveFileId) {
        try {
          const { google } = require('googleapis');
          const oAuth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_OAUTH_CLIENT_ID,
            process.env.GOOGLE_OAUTH_CLIENT_SECRET
          );
          oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
          const drive = google.drive({ version: 'v3', auth: oAuth2Client });
          await drive.files.update({
            fileId: oldGoogleDriveFileId,
            requestBody: { trashed: true },
            supportsAllDrives: true,
          });
          console.log(`[reprocess-page] Old Drive file moved to bin`);
        } catch (err) {
          console.warn(`[reprocess-page] Could not move old Drive file to bin: ${err.message}`);
        }
      }

      // Update Firestore — mark page as routed to non-order folder
      await admin.firestore().collection('pdfRouterStatus').doc(fileId).update({
        [`page_${pageNumber}`]: {
          ...pageData,
          finalFileName:     nonOrderName,
          customerName:      'Non-Order Documents',
          ref:               '',
          oneDriveId:        nonOrderUpload.id,
          oneDriveUrl:       nonOrderUpload.webUrl || null,
          googleDriveFileId: null,
          googleDriveUrl:    null,
          reprocessedAt:     new Date().toISOString(),
        },
      });

      return res.status(200).json({
        status: 'moved_to_non_order',
        message: 'File reclassified as non-delivery-order and moved to Non-Order Documents',
        oldFileName,
        newFileName:    nonOrderName,
        newOneDriveUrl: nonOrderUpload.webUrl,
      });
    }

    // ── 4. Fresh Cin7 lookup with Ship-To fallback ────────────────────────
    const claudeCustomerName = claudeJson?.document?.customer?.name || null;
    const claudeCompanyName  = claudeJson?.document?.customer?.company_name || null;
    const pdfRef             = claudeJson?.document?.header?.ref || null;
    const pdfPostcode        = claudeJson?.document?.customer?.address?.postcode ||
                               claudeJson?.document?.ship_to?.address?.postcode || null;
    const pdfMobile          = claudeJson?.document?.customer?.mobile || claudeJson?.document?.customer?.phone || null;
    const shipToName         = claudeJson?.document?.ship_to?.name || null;
    const shipToPostcode     = claudeJson?.document?.ship_to?.address?.postcode || null;

    let cin7Result = await lookupCin7FolderName({
      customerName: claudeCustomerName,
      companyName:  claudeCompanyName,
      pdfRef, pdfPostcode, pdfMobile,
      fileId: null, pageNumber: null,    // bypass cache
    });

    const looksUnusable = !claudeCustomerName || claudeCustomerName.trim().length < 3 ||
                          /^[\w.+-]+@[\w.-]+$/.test(claudeCustomerName.trim());
    if (!cin7Result && shipToName && shipToName !== claudeCustomerName && looksUnusable) {
      console.log(`[reprocess-page] Primary Cin7 missed — Ship-To fallback: "${shipToName}"`);
      cin7Result = await lookupCin7FolderName({
        customerName: shipToName,
        companyName:  null,
        pdfRef, pdfPostcode: shipToPostcode || pdfPostcode, pdfMobile,
        fileId: null, pageNumber: null,
      });
    }

    console.log(`[reprocess-page] Cin7: ${cin7Result ? 'matched ' + cin7Result.folderName : 'no match'}`);

    if (cin7Result) {
      if (cin7Result.cin7Company && claudeJson?.document?.customer) {
        claudeJson.document.customer.company_name = cin7Result.cin7Company;
      }
      if (cin7Result.cin7OrderRef && claudeJson?.document?.header) {
        claudeJson.document.header.ref = cin7Result.cin7OrderRef;
      }
    }

    // ── 5. Build new filename ─────────────────────────────────────────────
    const zeroPadded = String(pageNumber).padStart(2, '0');
    const newFileName = buildFilename(claudeJson, zeroPadded, cin7Result);
    const customerFolderName = cin7Result ? cin7Result.folderName : getCustomerFolderName(claudeJson);
    const refFolderName      = getRefFolder(claudeJson);
    const folderIsCompany    = cin7Result ? cin7Result.source === 'company' : isCompanyName(claudeJson);

    console.log(`[reprocess-page] New: "${newFileName}" | Old: "${oldFileName}"`);

    // ── 6. No-op if filename unchanged ────────────────────────────────────
    if (newFileName === oldFileName) {
      return res.status(200).json({
        status: 'no_change',
        message: 'File is already correctly named — no changes made',
        currentFileName: oldFileName,
      });
    }

    // ── 7. Upload new + move old to Bin ───────────────────────────────────
    const newUpload = await uploadFile(PROCESSED_PATH, newFileName, pdfBuffer);
    console.log(`[reprocess-page] New OneDrive upload: "${newFileName}" → ${newUpload.id}`);

    // Move old OneDrive file to Recycle Bin (DELETE moves to bin, not permanent)
    try {
      const userId = process.env.ONEDRIVE_USER_ID;
      await graphRequest('DELETE', `/users/${userId}/drive/items/${oldOneDriveId}`);
      console.log(`[reprocess-page] Old OneDrive file moved to bin: "${oldFileName}"`);
    } catch (err) {
      console.warn(`[reprocess-page] Could not move old OneDrive file to bin: ${err.message}`);
    }

    // Upload to Google Drive in correct customer/ref folder
    let googleDriveResult = null;
    try {
      googleDriveResult = await fileDocuments(
        customerFolderName, refFolderName,
        [{ pageNumber, finalFileName: newFileName, buffer: pdfBuffer }],
        folderIsCompany,
        { isDuplicate: false }
      );
      console.log(`[reprocess-page] Google Drive upload OK: "${customerFolderName}/${refFolderName}"`);
    } catch (err) {
      console.error(`[reprocess-page] Google Drive upload FAILED: ${err.message}`);
    }

    // Move old Google Drive file to Bin
    if (oldGoogleDriveFileId) {
      try {
        const { google } = require('googleapis');
        const oAuth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_OAUTH_CLIENT_ID,
          process.env.GOOGLE_OAUTH_CLIENT_SECRET
        );
        oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
        const drive = google.drive({ version: 'v3', auth: oAuth2Client });
        await drive.files.update({
          fileId: oldGoogleDriveFileId,
          requestBody: { trashed: true },
          supportsAllDrives: true,
        });
        console.log(`[reprocess-page] Old Drive file moved to bin`);
      } catch (err) {
        console.warn(`[reprocess-page] Could not move old Drive file to bin: ${err.message}`);
      }
    }

    // ── 8. Update Firestore ───────────────────────────────────────────────
    const newPageData = {
      ...pageData,
      finalFileName:    newFileName,
      customerName:     customerFolderName,
      ref:              refFolderName,
      oneDriveId:       newUpload.id,
      oneDriveUrl:      newUpload.webUrl || null,
      googleDriveFileId: googleDriveResult?.uploadedFiles?.[0]?.id || null,
      googleDriveUrl:    googleDriveResult?.uploadedFiles?.[0]?.webViewLink || null,
      reprocessedAt:    new Date().toISOString(),
    };
    await admin.firestore().collection('pdfRouterStatus').doc(fileId).update({
      [`page_${pageNumber}`]: newPageData,
    });

    return res.status(200).json({
      status: 'reprocessed',
      message: `Page ${pageNumber} reprocessed successfully`,
      oldFileName,
      newFileName,
      newOneDriveUrl: newUpload.webUrl,
      newGoogleDriveUrl: googleDriveResult?.uploadedFiles?.[0]?.webViewLink || null,
    });

  } catch (err) {
    console.error(`[reprocess-page] FATAL: ${err.message}`);
    console.error(err.stack);
    return res.status(500).json({ error: err.message });
  }
};
