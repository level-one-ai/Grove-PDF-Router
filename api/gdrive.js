/**
 * /api/gdrive
 *
 * Consolidated Google Drive endpoint.
 * Routes via ?action= query param:
 *
 *   GET  ?action=test          - diagnostic: test auth + root folder access
 *   POST ?action=retry         - bulk retry all completed records missing GD URL (SSE stream)
 *   POST ?action=file          - manually file a single processed PDF to Google Drive
 *                                body: { fileName, fileId? }
 */

const db = require('../lib/firebase');
const { getCustomerFolderName, getRefFolder, isCompanyName } = require('../lib/namingEngine');
const { fileDocuments } = require('../lib/googleDrive');
const axios = require('axios');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '2mb' }, responseLimit: false },
  maxDuration: 300,
};

module.exports = async function handler(req, res) {
  const action = req.query.action;

  if (action === 'test') return handleTest(req, res);
  if (action === 'retry' && req.method === 'POST') return handleRetry(req, res);
  if (action === 'file' && req.method === 'POST') return handleFile(req, res);

  return res.status(400).json({ error: 'Unknown action. Use ?action=test|retry|file' });
};

// ─────────────────────────────────────────────
// TEST — diagnostic
// ─────────────────────────────────────────────
async function handleTest(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const results = {};

  const hasOAuth = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
  results.envVars = {
    authMethod: hasOAuth ? 'OAuth (personal account)' : 'Service Account',
    hasClientEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || 'NOT SET',
    hasPrivateKey: !!process.env.GOOGLE_PRIVATE_KEY,
    privateKeyLength: (process.env.GOOGLE_PRIVATE_KEY || '').length,
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || 'NOT SET',
    hasRootFolderId: !!process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    ownerEmail: process.env.GOOGLE_DRIVE_OWNER_EMAIL || 'NOT SET',
    oauth: {
      hasClientId: !!process.env.GOOGLE_OAUTH_CLIENT_ID,
      hasClientSecret: !!process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      hasRefreshToken: !!process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      active: hasOAuth,
    },
  };

  try {
    const { google } = require('googleapis');
    let key = process.env.GOOGLE_PRIVATE_KEY || '';
    key = key.replace(/\\n/g, '\n');

    const keyLines = key.split('\n');
    results.keyParsed = {
      lines: keyLines.length,
      hasBegin: key.includes('-----BEGIN PRIVATE KEY-----'),
      hasEnd: key.includes('-----END PRIVATE KEY-----'),
      firstLine: keyLines[0],
    };

    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: key },
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (rootId) {
      const folderRes = await drive.files.get({ fileId: rootId, fields: 'id,name,mimeType', supportsAllDrives: true });
      results.rootFolder = { id: folderRes.data.id, name: folderRes.data.name, accessible: true };
      const listRes = await drive.files.list({
        q: `'${rootId}' in parents and trashed = false`,
        fields: 'files(id,name,mimeType)',
        pageSize: 5,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
      });
      results.rootContents = listRes.data.files || [];
    } else {
      results.rootFolder = { error: 'GOOGLE_DRIVE_ROOT_FOLDER_ID not set' };
    }
    results.authStatus = 'SUCCESS';
  } catch (e) {
    results.authStatus = 'FAILED';
    results.authError = e.message;
  }

  return res.status(200).json(results);
}

// ─────────────────────────────────────────────
// RETRY — bulk SSE stream
// ─────────────────────────────────────────────
async function handleRetry(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  }

  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(keepalive); }
  }, 15000);

  try {
    await retryMissingGoogleDrive(send);
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  clearInterval(keepalive);
  res.end();
}

async function retryMissingGoogleDrive(send) {
  let records;
  let attempts = 0;
  while (attempts < 3) {
    try {
      records = await db.getCompletedMissingGoogleDrive(100);
      break;
    } catch (err) {
      attempts++;
      if (attempts < 3) await sleep(3000);
    }
  }

  if (!records) {
    send({ type: 'done', total: 0, succeeded: 0, failed: 0, message: 'Could not load records' });
    return;
  }
  if (!records.length) {
    send({ type: 'done', total: 0, succeeded: 0, failed: 0, message: 'All files already in Google Drive' });
    return;
  }

  send({ type: 'start', total: records.length });

  const token = await getToken();
  let succeeded = 0;
  let failed = 0;

  for (const record of records) {
    const pages = record.pages || {};
    const pageEntries = Object.entries(pages)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .filter(([, pd]) => pd.claudeJson && pd.finalFileName && !pd.googleDrive?.folderUrl);

    if (!pageEntries.length) {
      send({ type: 'file', status: 'skipped', name: record.originalFileName, reason: 'No pages to file' });
      continue;
    }

    send({ type: 'file', status: 'filing', name: record.originalFileName, pages: pageEntries.length });

    let topLevelGdResult = null;
    let fileSucceeded = 0;
    let fileFailed = 0;
    const uploadedFiles = [];

    for (const [pageNum, pageData] of pageEntries) {
      try {
        const pageBuffer = await downloadFromProcessed(pageData.finalFileName, token);
        if (!pageBuffer) {
          send({ type: 'page', status: 'failed', name: record.originalFileName, page: parseInt(pageNum), fileName: pageData.finalFileName, reason: 'Could not download from OneDrive' });
          fileFailed++;
          continue;
        }

        const customerFolderName = getCustomerFolderName(pageData.claudeJson);
        const refFolderName = getRefFolder(pageData.claudeJson);
        const folderIsCompany = isCompanyName(pageData.claudeJson);

        const gdResult = await fileDocuments(
          customerFolderName, refFolderName,
          [{ pageNumber: parseInt(pageNum), finalFileName: pageData.finalFileName, buffer: pageBuffer }],
          folderIsCompany
        );

        topLevelGdResult = { folderId: gdResult.refFolderId, folderUrl: gdResult.refFolderUrl, customerFolderUrl: gdResult.customerFolderUrl };
        const uploadedFile = gdResult.uploadedFiles?.[0];
        uploadedFiles.push({ page: parseInt(pageNum), fileName: pageData.finalFileName, gdFileUrl: uploadedFile?.webViewLink || null, gdFolderUrl: gdResult.refFolderUrl });

        await db.updateRecord(record.fileId, {
          [`pages.${pageNum}.googleDrive`]: {
            ...topLevelGdResult,
            fileUrl: uploadedFile?.webViewLink || null,
            fileName: uploadedFile?.fileName || pageData.finalFileName,
          },
        });

        send({ type: 'page', status: 'success', name: record.originalFileName, page: parseInt(pageNum), fileName: pageData.finalFileName, gdFolderUrl: gdResult.refFolderUrl, gdFileUrl: uploadedFile?.webViewLink || null, folder: `${customerFolderName}/${refFolderName}` });
        fileSucceeded++;
        await sleep(300);

      } catch (err) {
        send({ type: 'page', status: 'failed', name: record.originalFileName, page: parseInt(pageNum), fileName: pageData.finalFileName, reason: err.message?.slice(0, 100) });
        fileFailed++;
      }
    }

    if (topLevelGdResult?.folderUrl) {
      await db.updateRecord(record.fileId, {
        googleDriveFolderUrl: topLevelGdResult.folderUrl,
        googleDriveFolderId: topLevelGdResult.folderId,
        googleDriveCustomerFolderUrl: topLevelGdResult.customerFolderUrl || null,
      });
    }

    if (fileSucceeded > 0) {
      succeeded++;
      send({ type: 'file', status: 'success', name: record.originalFileName, pages: fileSucceeded, gdFolderUrl: topLevelGdResult?.folderUrl || null, uploadedFiles });
    } else {
      failed++;
      send({ type: 'file', status: 'failed', name: record.originalFileName, pages: fileFailed });
    }

    await sleep(500);
  }

  send({ type: 'done', total: records.length, succeeded, failed });
}

// ─────────────────────────────────────────────
// FILE — single file manual send
// ─────────────────────────────────────────────
async function handleFile(req, res) {
  const { fileName, fileId } = req.body || {};
  if (!fileName) return res.status(400).json({ error: 'fileName required' });

  console.log(`[gdrive] Manual file: "${fileName}" (fileId: ${fileId || 'unknown'})`);

  try {
    const token = await getToken();
    const fileBuffer = await downloadFromProcessed(fileName, token);
    if (!fileBuffer) {
      return res.status(404).json({ error: `File "${fileName}" not found in OneDrive Processed` });
    }

    let claudeJson = null;
    if (fileId) {
      const record = await db.getRecord(fileId).catch(() => null);
      if (record?.pages) {
        const pageData = Object.values(record.pages).find(p => p.claudeJson);
        if (pageData) claudeJson = pageData.claudeJson;
      }
    }

    let customerFolderName, refFolderName, folderIsCompany;
    if (claudeJson) {
      customerFolderName = getCustomerFolderName(claudeJson);
      refFolderName = getRefFolder(claudeJson);
      folderIsCompany = isCompanyName(claudeJson);
    } else {
      const nameNoExt = fileName.replace(/\.pdf$/i, '').replace(/_\d+$/, '');
      const dashIdx = nameNoExt.lastIndexOf('-');
      customerFolderName = dashIdx > 0 ? nameNoExt.slice(0, dashIdx).trim() : nameNoExt;
      refFolderName = dashIdx > 0 ? nameNoExt.slice(dashIdx + 1).trim() : 'unknown-ref';
      folderIsCompany = !customerFolderName.includes(' ') || customerFolderName === customerFolderName.toUpperCase();
    }

    const pageMatch = fileName.match(/_(\d+)\.pdf$/i);
    const pageNumber = pageMatch ? parseInt(pageMatch[1]) : 1;

    console.log(`[gdrive] Filing "${fileName}" → "${customerFolderName}/${refFolderName}"`);

    const gdResult = await fileDocuments(
      customerFolderName, refFolderName,
      [{ pageNumber, finalFileName: fileName, buffer: fileBuffer }],
      folderIsCompany
    );

    const uploadedFile = gdResult.uploadedFiles?.[0];

    if (fileId) {
      await db.updateRecord(fileId, {
        googleDriveFolderUrl: gdResult.refFolderUrl,
        googleDriveFolderId: gdResult.refFolderId,
        googleDriveCustomerFolderUrl: gdResult.customerFolderUrl || null,
      }).catch(e => console.warn('[gdrive] Firestore update failed:', e.message));
    }

    console.log(`[gdrive] ✅ Filed "${fileName}"`);
    return res.status(200).json({
      success: true,
      gdFolderUrl: gdResult.refFolderUrl,
      gdFileUrl: uploadedFile?.webViewLink || null,
      folder: `${customerFolderName}/${refFolderName}`,
      fileName,
    });

  } catch (err) {
    console.error(`[gdrive] Failed:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────
// SHARED UTILITIES
// ─────────────────────────────────────────────
async function downloadFromProcessed(fileName, token) {
  try {
    const userId = process.env.ONEDRIVE_USER_ID;
    const folder = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folder}/${encodeURIComponent(fileName)}:/content`;
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      timeout: 30000,
    });
    return Buffer.from(r.data);
  } catch (err) {
    console.warn(`[gdrive] Download failed "${fileName}":`, err.response?.status || err.message);
    return null;
  }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
