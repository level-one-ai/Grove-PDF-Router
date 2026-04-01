/**
 * /api/test-gdrive
 * Diagnostic endpoint — tests Google Drive connectivity end to end.
 * GET /api/test-gdrive
 */
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const results = {};

  // Check env vars
  results.envVars = {
    hasClientEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || 'NOT SET',
    hasPrivateKey: !!process.env.GOOGLE_PRIVATE_KEY,
    privateKeyLength: (process.env.GOOGLE_PRIVATE_KEY || '').length,
    privateKeyStart: (process.env.GOOGLE_PRIVATE_KEY || '').slice(0, 30),
    privateKeyHasNewlines: (process.env.GOOGLE_PRIVATE_KEY || '').includes('\n'),
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || 'NOT SET',
    hasRootFolderId: !!process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
  };

  // Test key parsing
  try {
    const { google } = require('googleapis');
    let key = process.env.GOOGLE_PRIVATE_KEY || '';
    key = key.replace(/\\n/g, '\n');
    results.keyParsed = {
      lines: key.split('\n').length,
      hasBegin: key.includes('-----BEGIN PRIVATE KEY-----'),
      hasEnd: key.includes('-----END PRIVATE KEY-----'),
      firstLine: key.split('\n')[0],
    };
  } catch(e) {
    results.keyParsed = { error: e.message };
  }

  // Test Google Drive auth
  try {
    const { google } = require('googleapis');
    let key = process.env.GOOGLE_PRIVATE_KEY || '';
    key = key.replace(/\\n/g, '\n');

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: key,
      },
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // Test 1: Get root folder info
    const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (rootId) {
      const folderRes = await drive.files.get({
        fileId: rootId,
        fields: 'id,name,mimeType',
      });
      results.rootFolder = {
        id: folderRes.data.id,
        name: folderRes.data.name,
        type: folderRes.data.mimeType,
        accessible: true,
      };

      // Test 2: List contents of root folder
      const listRes = await drive.files.list({
        q: `'${rootId}' in parents and trashed = false`,
        fields: 'files(id,name,mimeType)',
        pageSize: 5,
      });
      results.rootContents = listRes.data.files || [];

    } else {
      results.rootFolder = { error: 'GOOGLE_DRIVE_ROOT_FOLDER_ID not set' };
    }
    results.authStatus = 'SUCCESS';
  } catch(e) {
    results.authStatus = 'FAILED';
    results.authError = e.message;
  }

  return res.status(200).json(results);
};
