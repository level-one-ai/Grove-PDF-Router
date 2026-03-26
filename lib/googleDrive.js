const { google } = require('googleapis');

let driveClient = null;

function getDriveClient() {
  if (!driveClient) {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    driveClient = google.drive({ version: 'v3', auth });
  }
  return driveClient;
}

// Strip common titles from a name for fuzzy matching
function stripTitles(name) {
  return name
    .replace(/^(mr\.?|mrs\.?|ms\.?|dr\.?|miss\.?|prof\.?)\s+/i, '')
    .trim()
    .toLowerCase();
}

// Search for a folder by name (with fuzzy matching) inside a parent folder
async function findFolder(name, parentId) {
  const drive = getDriveClient();
  const coreName = stripTitles(name);

  // Search for folders inside the parent
  const response = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 100,
  });

  const folders = response.data.files || [];

  // First try exact match
  const exactMatch = folders.find(
    (f) => f.name.toLowerCase().trim() === name.toLowerCase().trim()
  );
  if (exactMatch) return exactMatch;

  // Then try fuzzy match: strip titles and check if core name is contained
  const fuzzyMatch = folders.find((f) => {
    const folderCore = stripTitles(f.name);
    return (
      folderCore.includes(coreName) ||
      coreName.includes(folderCore)
    );
  });

  return fuzzyMatch || null;
}

// Create a folder inside a parent
async function createFolder(name, parentId) {
  const drive = getDriveClient();

  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id, name, webViewLink',
  });

  return response.data;
}

// Find or create a folder — returns { id, name, webViewLink, wasCreated }
async function findOrCreateFolder(name, parentId) {
  const existing = await findFolder(name, parentId);
  if (existing) {
    // Fetch webViewLink for existing folder
    const drive = getDriveClient();
    const details = await drive.files.get({
      fileId: existing.id,
      fields: 'id, name, webViewLink',
    });
    return { ...details.data, wasCreated: false };
  }

  const created = await createFolder(name, parentId);
  return { ...created, wasCreated: true };
}

// Upload a PDF file into a specific folder
async function uploadFile(fileName, fileBuffer, folderId) {
  const drive = getDriveClient();
  const { Readable } = require('stream');

  const stream = new Readable();
  stream.push(fileBuffer);
  stream.push(null);

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: 'application/pdf',
      body: stream,
    },
    fields: 'id, name, webViewLink',
  });

  return response.data;
}

/**
 * Full Google Drive filing flow for a batch of pages:
 * 1. Find/create top-level customer folder (fuzzy match)
 * 2. Find/create ref subfolder
 * 3. Upload all PDF pages into the subfolder
 * Returns: { folderId, folderUrl, subFolderId, uploadedFiles }
 */
async function fileDocuments(customerFolderName, refFolderName, pages) {
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  // Step 1: Top-level customer folder
  const customerFolder = await findOrCreateFolder(customerFolderName, rootFolderId);

  // Step 2: Ref subfolder inside customer folder
  const refFolder = await findOrCreateFolder(refFolderName, customerFolder.id);

  // Step 3: Upload all pages
  const uploadedFiles = [];
  for (const page of pages) {
    const uploaded = await uploadFile(page.finalFileName, page.buffer, refFolder.id);
    uploadedFiles.push({
      fileName: page.finalFileName,
      pageNumber: page.pageNumber,
      fileId: uploaded.id,
      webViewLink: uploaded.webViewLink,
    });
  }

  return {
    customerFolderId: customerFolder.id,
    customerFolderUrl: customerFolder.webViewLink,
    refFolderId: refFolder.id,
    refFolderUrl: refFolder.webViewLink,
    uploadedFiles,
  };
}

module.exports = {
  findOrCreateFolder,
  uploadFile,
  fileDocuments,
};
