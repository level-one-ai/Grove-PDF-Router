const { google } = require('googleapis');

let driveClient = null;

function parsePrivateKey(raw) {
  if (!raw) return null;
  // Handle all formats Vercel might store the key in:
  // 1. Literal \n (escaped)  → replace with real newline
  // 2. Already has real newlines → leave as-is
  // 3. Missing newlines entirely → add them around header/footer
  let key = raw;
  // Replace escaped newlines
  key = key.replace(/\\n/g, '\n').replace(/\n/g, '\n');
  // If still no real newlines, the key is on one line — fix it
  if (!key.includes('\n')) {
    key = key
      .replace('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----\n')
      .replace('-----END RSA PRIVATE KEY-----', '\n-----END RSA PRIVATE KEY-----')
      .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----\n')
      .replace('-----END PRIVATE KEY-----', '\n-----END PRIVATE KEY-----');
  }
  return key;
}

function getDriveClient() {
  if (!driveClient) {
    const rawKey = process.env.GOOGLE_PRIVATE_KEY;
    const privateKey = parsePrivateKey(rawKey);

    // Log key details to diagnose format issues
    const keyLines = privateKey ? privateKey.split('\n') : [];
    console.log('[googleDrive] Key lines:', keyLines.length);
    console.log('[googleDrive] Key header:', keyLines[0]);
    console.log('[googleDrive] Key footer:', keyLines[keyLines.length - 1]);
    console.log('[googleDrive] Key body length:', privateKey ? privateKey.length : 0);

    if (!privateKey || !privateKey.includes('-----BEGIN')) {
      throw new Error('GOOGLE_PRIVATE_KEY is missing or malformed — check Vercel environment variables');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: privateKey,
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

// Business suffixes to strip before comparing company names
const BUSINESS_SUFFIXES = /\b(ltd\.?|limited|plc\.?|inc\.?|llc\.?|co\.?|corp\.?|group|holdings|& co\.?)$/i;

// Title prefixes to strip before comparing customer names
const TITLE_PREFIXES = /^(mr\.?|mrs\.?|ms\.?|dr\.?|miss\.?|prof\.?)\s+/i;

/**
 * Normalise a company name for comparison:
 * - Lowercase
 * - Strip business suffixes (Ltd, Limited, PLC etc.)
 * - Strip punctuation
 * - Trim
 */
function normaliseCompany(name) {
  return name
    .toLowerCase()
    .replace(BUSINESS_SUFFIXES, '')
    .replace(/[.,&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise a customer name for comparison:
 * - Lowercase
 * - Strip title prefixes (Mr, Mrs, Dr etc.)
 * - Trim
 */
function normaliseCustomer(name) {
  return name
    .toLowerCase()
    .replace(TITLE_PREFIXES, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get the first two words of a normalised name.
 * Used for the fallback two-word match.
 */
function firstTwoWords(name) {
  return name.split(' ').slice(0, 2).join(' ');
}

/**
 * Search for ALL folders matching a name inside a parent.
 *
 * For company names (isCompany = true):
 *   1. Exact match after normalisation
 *   2. First two words match after normalisation
 *
 * For customer names (isCompany = false):
 *   1. Exact match after stripping titles (case-insensitive)
 *
 * Returns an array — may contain 0, 1, or multiple matches.
 */
async function findAllMatchingFolders(name, parentId, isCompany = false) {
  const drive = getDriveClient();

  // Fetch ALL folders inside the parent — using corpora: allDrives ensures
  // we see folders owned by other accounts that are accessible to the service account
  const response = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 500,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });

  const folders = response.data.files || [];
  console.log(`[googleDrive] Found ${folders.length} folders in parent ${parentId}`);

  const exactMatches = [];
  const twoWordMatches = [];

  if (isCompany) {
    const normSearch = normaliseCompany(name);
    const twoWordSearch = firstTwoWords(normSearch);
    console.log(`[googleDrive] Company search: "${name}" → normalised: "${normSearch}" | two-word: "${twoWordSearch}"`);

    for (const folder of folders) {
      const normFolder = normaliseCompany(folder.name);
      if (normFolder === normSearch) {
        exactMatches.push(folder);
      } else if (twoWordSearch.length > 0 && firstTwoWords(normFolder) === twoWordSearch) {
        twoWordMatches.push(folder);
      }
    }

    if (exactMatches.length > 0) {
      console.log(`[googleDrive] Exact company match for "${name}": ${exactMatches.map(f=>f.name).join(', ')}`);
      return exactMatches;
    }
    if (twoWordMatches.length > 0) {
      console.log(`[googleDrive] Two-word company match for "${name}": ${twoWordMatches.map(f=>f.name).join(', ')}`);
      return twoWordMatches;
    }
    console.log(`[googleDrive] No match for company "${name}" — folders checked: ${folders.map(f=>f.name).join(', ') || 'none'}`);
    return [];

  } else {
    const normSearch = normaliseCustomer(name);
    console.log(`[googleDrive] Customer search: "${name}" → normalised: "${normSearch}"`);

    for (const folder of folders) {
      const normFolder = normaliseCustomer(folder.name);
      if (normFolder === normSearch) {
        exactMatches.push(folder);
      }
    }

    if (exactMatches.length > 0) {
      console.log(`[googleDrive] Exact customer match for "${name}": ${exactMatches.map(f=>f.name).join(', ')}`);
    } else {
      console.log(`[googleDrive] No match for customer "${name}" — folders checked: ${folders.map(f=>f.name).join(', ') || 'none'}`);
    }
    return exactMatches;
  }
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
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
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
    supportsAllDrives: true,
  });

  return response.data;
}

/**
 * Transfer ownership of a file/folder to the root folder owner's account.
 * This ensures folders are accessible and have full storage quota.
 * The owner email is the Google account that owns the root folder.
 */
async function transferOwnership(fileId) {
  const ownerEmail = process.env.GOOGLE_DRIVE_OWNER_EMAIL;
  if (!ownerEmail) {
    // No owner email configured — skip transfer
    return;
  }
  const drive = getDriveClient();
  try {
    await drive.permissions.create({
      fileId,
      transferOwnership: true,
      supportsAllDrives: true,
      requestBody: {
        role: 'owner',
        type: 'user',
        emailAddress: ownerEmail,
      },
    });
    console.log(`[googleDrive] Transferred ownership of ${fileId} to ${ownerEmail}`);
  } catch (err) {
    // Non-fatal — folder still works, just owned by service account
    console.warn(`[googleDrive] Could not transfer ownership: ${err.message?.slice(0, 80)}`);
  }
}

// Fetch full folder details (including webViewLink) by ID
async function getFolderDetails(folderId) {
  const drive = getDriveClient();
  const response = await drive.files.get({
    fileId: folderId,
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
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
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
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
async function resolveCustomerFolder(customerName, refName, rootFolderId, isCompany = false) {
  const matches = await findAllMatchingFolders(customerName, rootFolderId, isCompany);

  // No matches — create fresh customer folder
  if (matches.length === 0) {
    console.log(`[googleDrive] No folder found for "${customerName}" — creating new`);
    const created = await createFolder(customerName, rootFolderId);
    await transferOwnership(created.id);
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
    supportsAllDrives: true,
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
async function fileDocuments(customerFolderName, refFolderName, pages, isCompany = false) {
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  if (!rootFolderId || rootFolderId.trim() === '') {
    throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is not set in Vercel environment variables');
  }

  console.log('[googleDrive] Root folder ID:', rootFolderId);
  console.log(`[googleDrive] Folder type: ${isCompany ? 'company' : 'customer'} | Name: "${customerFolderName}"`);

  // Step 1: Resolve customer folder with duplicate detection
  const customerFolder = await resolveCustomerFolder(
    customerFolderName,
    refFolderName,
    rootFolderId,
    isCompany
  );

  // Step 2: Find or create ref subfolder
  let refFolder = await findRefFolder(refFolderName, customerFolder.id);
  if (!refFolder) {
    console.log(`[googleDrive] Ref folder "${refFolderName}" not found — creating`);
    const created = await createFolder(refFolderName, customerFolder.id);
    await transferOwnership(created.id);
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

    // Transfer file ownership so it uses the owner's storage quota, not the service account's
    await transferOwnership(uploaded.id);

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
