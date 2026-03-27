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

// ─────────────────────────────────────────────
// FOLDER SEARCH UTILITIES
// ─────────────────────────────────────────────

// Strip common titles from a name for fuzzy matching
function stripTitles(name) {
  return name
    .replace(/^(mr\.?|mrs\.?|ms\.?|dr\.?|miss\.?|prof\.?)\s+/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Search for ALL folders matching a name inside a parent (fuzzy).
 * Returns an array — may contain 0, 1, or multiple matches.
 */
async function findAllMatchingFolders(name, parentId) {
  const drive = getDriveClient();
  const coreName = stripTitles(name);

  const response = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 100,
  });

  const folders = response.data.files || [];
  const matches = [];

  for (const folder of folders) {
    const folderCore = stripTitles(folder.name);
    const isExactMatch = folder.name.toLowerCase().trim() === name.toLowerCase().trim();
    const isFuzzyMatch = folderCore.includes(coreName) || coreName.includes(folderCore);

    if (isExactMatch || isFuzzyMatch) {
      matches.push(folder);
    }
  }

  return matches;
}

/**
 * Search for a ref subfolder (exact match) inside a given parent folder.
 * Returns the folder object or null.
 */
async function findRefFolder(refName, parentId) {
  const drive = getDriveClient();

  const response = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '${refName.replace(/'/g, "\\'")}'`,
    fields: 'files(id, name, webViewLink)',
    pageSize: 10,
  });

  const folders = response.data.files || [];
  return folders.length > 0 ? folders[0] : null;
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

// Fetch full folder details (including webViewLink) by ID
async function getFolderDetails(folderId) {
  const drive = getDriveClient();
  const response = await drive.files.get({
    fileId: folderId,
    fields: 'id, name, webViewLink',
  });
  return response.data;
}

// ─────────────────────────────────────────────
// FILE COUNTING & NUMBERING
// ─────────────────────────────────────────────

/**
 * List all PDF files inside a folder.
 * Returns array of file objects { id, name }.
 */
async function listFilesInFolder(folderId) {
  const drive = getDriveClient();

  const response = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1000,
  });

  return response.data.files || [];
}

/**
 * Determine the next file number suffix for a given folder and base filename.
 *
 * Rules:
 * - 0 existing related files → null (no suffix — first upload)
 * - 1 existing file (the unnumbered one) → return 2
 * - N existing files where largest explicit number is X → return X+1
 *
 * The unnumbered file (e.g. "Acme Ltd-2026-03-26_01.pdf") implicitly counts as 1.
 *
 * @param {string} folderId - Google Drive folder ID to check
 * @param {string} baseFilename - filename WITHOUT .pdf extension
 * @returns {number|null} - null = no suffix needed, number = use -{number}
 */
async function getNextFileSuffix(folderId, baseFilename) {
  const existingFiles = await listFilesInFolder(folderId);

  if (existingFiles.length === 0) {
    return null;
  }

  // Escape special regex characters in the base filename
  const escapedBase = baseFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match the unnumbered version or any -{number} suffixed version
  const matchPattern = new RegExp(`^${escapedBase}(-\\d+)?\\.pdf$`, 'i');
  const relatedFiles = existingFiles.filter((f) => matchPattern.test(f.name));

  if (relatedFiles.length === 0) {
    // No files with this base name exist yet — first upload, no suffix
    return null;
  }

  // The unnumbered file implicitly = 1
  // Find the largest explicit -{number} among related files
  let largestNumber = 1;

  for (const file of relatedFiles) {
    const suffixMatch = file.name.match(/-(\d+)\.pdf$/i);
    if (suffixMatch) {
      const num = parseInt(suffixMatch[1], 10);
      if (num > largestNumber) {
        largestNumber = num;
      }
    }
  }

  // Next number is always largest + 1
  return largestNumber + 1;
}

// ─────────────────────────────────────────────
// DUPLICATE FOLDER DETECTION
// ─────────────────────────────────────────────

/**
 * Resolve the correct customer folder using duplicate detection.
 *
 * Logic:
 * - 0 matches → create new customer folder
 * - 1 match   → use it directly
 * - 2+ matches → cross-reference each folder's subfolders against refName
 *                → use the one containing a subfolder matching refName
 *                → if none match, fall back to exact name match or first result
 *
 * Returns resolved customer folder { id, name, webViewLink, wasCreated }
 */
async function resolveCustomerFolder(customerName, refName, rootFolderId) {
  const matches = await findAllMatchingFolders(customerName, rootFolderId);

  // No matches — create fresh customer folder
  if (matches.length === 0) {
    console.log(`[googleDrive] No folder found for "${customerName}" — creating new`);
    const created = await createFolder(customerName, rootFolderId);
    return { ...created, wasCreated: true };
  }

  // Exactly one match — use it
  if (matches.length === 1) {
    console.log(`[googleDrive] Single folder match for "${customerName}"`);
    const details = await getFolderDetails(matches[0].id);
    return { ...details, wasCreated: false };
  }

  // Multiple matches — use ref number to identify the correct folder
  console.log(`[googleDrive] ${matches.length} folders match "${customerName}" — checking ref subfolders for "${refName}"`);

  for (const folder of matches) {
    const refSubfolder = await findRefFolder(refName, folder.id);
    if (refSubfolder) {
      console.log(`[googleDrive] Matched folder "${folder.name}" via ref subfolder "${refName}"`);
      const details = await getFolderDetails(folder.id);
      return { ...details, wasCreated: false };
    }
  }

  // No folder contained the matching ref subfolder
  // Fall back to exact name match, or first result if no exact match
  console.log(`[googleDrive] No ref match found across duplicate folders — falling back to best name match`);
  const exactMatch = matches.find(
    (f) => f.name.toLowerCase().trim() === customerName.toLowerCase().trim()
  );
  const best = exactMatch || matches[0];
  const details = await getFolderDetails(best.id);
  return { ...details, wasCreated: false };
}

// ─────────────────────────────────────────────
// FILE UPLOAD
// ─────────────────────────────────────────────

/**
 * Upload a single PDF file into a specific Google Drive folder.
 */
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

// ─────────────────────────────────────────────
// MAIN FILING FUNCTION
// ─────────────────────────────────────────────

/**
 * Full Google Drive filing flow:
 *
 * 1. Resolve customer folder (duplicate detection via ref number)
 * 2. Find or create ref subfolder
 * 3. For each page:
 *    a. Determine base filename (without .pdf)
 *    b. Check existing files in ref folder for this base name
 *    c. Apply -{number} suffix only if files already exist with this name
 *    d. Upload with the final resolved filename
 *
 * Naming rules:
 *   First file ever with this name → no suffix  e.g. "Acme Ltd-2026-03-26_01.pdf"
 *   Second file with same name     → -2         e.g. "Acme Ltd-2026-03-26_01-2.pdf"
 *   25th file with same name       → -25        e.g. "Acme Ltd-2026-03-26_01-25.pdf"
 *
 * Returns: { customerFolderId, customerFolderUrl, refFolderId, refFolderUrl, uploadedFiles }
 */
async function fileDocuments(customerFolderName, refFolderName, pages) {
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  // Step 1: Resolve customer folder with duplicate detection
  const customerFolder = await resolveCustomerFolder(
    customerFolderName,
    refFolderName,
    rootFolderId
  );

  // Step 2: Find or create ref subfolder
  let refFolder = await findRefFolder(refFolderName, customerFolder.id);
  if (!refFolder) {
    console.log(`[googleDrive] Ref folder "${refFolderName}" not found — creating`);
    const created = await createFolder(refFolderName, customerFolder.id);
    refFolder = await getFolderDetails(created.id);
  } else {
    console.log(`[googleDrive] Ref folder "${refFolderName}" found — using existing`);
    refFolder = await getFolderDetails(refFolder.id);
  }

  // Step 3: Upload each page with correct file numbering
  const uploadedFiles = [];

  for (const page of pages) {
    // Strip .pdf to get the base filename
    const baseFilename = page.finalFileName.replace(/\.pdf$/i, '');

    // Check existing files to determine the correct suffix
    const nextSuffix = await getNextFileSuffix(refFolder.id, baseFilename);

    // Build final filename
    const resolvedFileName = nextSuffix === null
      ? `${baseFilename}.pdf`           // First file — no suffix
      : `${baseFilename}-${nextSuffix}.pdf`; // Subsequent — add -{number}

    console.log(`[googleDrive] Uploading "${resolvedFileName}" (suffix: ${nextSuffix ?? 'none'})`);

    const uploaded = await uploadFile(resolvedFileName, page.buffer, refFolder.id);

    uploadedFiles.push({
      fileName: resolvedFileName,
      pageNumber: page.pageNumber,
      fileId: uploaded.id,
      webViewLink: uploaded.webViewLink,
      suffixApplied: nextSuffix,
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
  // Main filing function used by /api/callback
  fileDocuments,
  // Upload utility used by other modules
  uploadFile,
  // Legacy compatibility — wraps new logic
  findOrCreateFolder: async (name, parentId) => {
    const matches = await findAllMatchingFolders(name, parentId);
    if (matches.length > 0) {
      return { ...(await getFolderDetails(matches[0].id)), wasCreated: false };
    }
    const created = await createFolder(name, parentId);
    return { ...created, wasCreated: true };
  },
  // Exported for testing / future use
  resolveCustomerFolder,
  getNextFileSuffix,
  findAllMatchingFolders,
  findRefFolder,
};
