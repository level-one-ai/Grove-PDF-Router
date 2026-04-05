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
    // If OAuth credentials are available, use personal account (avoids storage quota issues)
    if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
      const oauthClient = new google.auth.OAuth2(
        process.env.GOOGLE_OAUTH_CLIENT_ID,
        process.env.GOOGLE_OAUTH_CLIENT_SECRET
      );
      oauthClient.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
      driveClient = google.drive({ version: 'v3', auth: oauthClient });
      console.log('[googleDrive] Using OAuth personal account credentials');
    } else {
      // Fall back to service account
      const privateKey = parsePrivateKey(process.env.GOOGLE_PRIVATE_KEY);
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
      console.log('[googleDrive] Using service account credentials');
    }
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
    .replace(/[.,&()]/g, '')
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
 * Check whether a customer name on a delivery order matches a folder name,
 * accounting for middle names.
 *
 * Matching rules (in priority order):
 *   1. Exact match after normalisation            → e.g. "John Smith" = "John Smith"
 *   2. Folder name words all appear in order in   → e.g. folder "John Smith",
 *      the search name (subset match)                order "John Doe Smith" — MATCH
 *   3. Search name words all appear in order in   → e.g. folder "John Doe Smith",
 *      the folder name (superset match)              order "John Smith" — MATCH
 *
 * Returns: 'exact' | 'subset' | null
 */
function customerNameMatch(searchName, folderName) {
  const normSearch = normaliseCustomer(searchName);
  const normFolder = normaliseCustomer(folderName);

  // Rule 1: exact
  if (normSearch === normFolder) return 'exact';

  const searchWords = normSearch.split(' ');
  const folderWords = normFolder.split(' ');

  // Rule 2: folder name words all found in order within search name
  // e.g. folder = "john smith", search = "john doe smith"
  // checks: is every word of folderWords present as a subsequence in searchWords?
  if (folderWords.length >= 2 && isSubsequence(folderWords, searchWords)) return 'subset';

  // Rule 3: search name words all found in order within folder name
  // e.g. folder = "john doe smith", search = "john smith"
  if (searchWords.length >= 2 && isSubsequence(searchWords, folderWords)) return 'subset';

  return null;
}

/**
 * Check if all words in `needle` appear in `haystack` in order (subsequence check).
 * e.g. needle=['john','smith'], haystack=['john','doe','smith'] → true
 */
function isSubsequence(needle, haystack) {
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (haystack[hi] === needle[ni]) ni++;
  }
  return ni === needle.length;
}

/**
 * Check whether a company name on a delivery order matches a folder name.
 *
 * Matching rules (in priority order):
 *   1. Exact match after normalisation            → always preferred
 *   2. Full containment: one name fully contains  → e.g. "The Bed Shop Wells"
 *      the other as a complete normalised string     contained in "The Bed Shop Wells Ltd"
 *
 * Deliberately does NOT do partial word matching (e.g. "The Bed" matching
 * "The Bed Warehouse") — that caused wrong-folder filing.
 *
 * Returns: 'exact' | 'contained' | null
 */
function companyNameMatch(searchName, folderName) {
  const normSearch = normaliseCompany(searchName);
  const normFolder = normaliseCompany(folderName);

  // Rule 1: exact
  if (normSearch === normFolder) return 'exact';

  // Rule 2: full containment only — one must fully contain the other
  // Use word-boundary-aware containment to avoid partial word matches
  if (normFolder.length > 3 && normSearch.includes(normFolder)) return 'contained';
  if (normSearch.length > 3 && normFolder.includes(normSearch)) return 'contained';

  return null;
}

/**
 * Search for ALL folders matching a name inside a parent.
 *
 * For company names (isCompany = true):
 *   1. Exact match after normalisation
 *   2. Full containment match (one name contains the other)
 *   No partial/two-word matching — too ambiguous.
 *
 * For customer names (isCompany = false):
 *   1. Exact match after stripping titles
 *   2. Subset/superset match to handle middle names
 *
 * Returns an array of { id, name, matchType } — may contain 0, 1, or multiple matches.
 */
async function findAllMatchingFolders(name, parentId, isCompany = false) {
  const drive = getDriveClient();

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
  const fuzzyMatches = [];

  if (isCompany) {
    console.log(`[googleDrive] Company search: "${name}" → normalised: "${normaliseCompany(name)}"`);

    for (const folder of folders) {
      const matchType = companyNameMatch(name, folder.name);
      if (matchType === 'exact') {
        exactMatches.push({ ...folder, matchType });
      } else if (matchType === 'contained') {
        fuzzyMatches.push({ ...folder, matchType });
      }
    }
  } else {
    console.log(`[googleDrive] Customer search: "${name}" → normalised: "${normaliseCustomer(name)}"`);

    for (const folder of folders) {
      const matchType = customerNameMatch(name, folder.name);
      if (matchType === 'exact') {
        exactMatches.push({ ...folder, matchType });
      } else if (matchType === 'subset') {
        fuzzyMatches.push({ ...folder, matchType });
      }
    }
  }

  if (exactMatches.length > 0) {
    console.log(`[googleDrive] Exact match(es) for "${name}": ${exactMatches.map(f=>f.name).join(', ')}`);
    return exactMatches;
  }
  if (fuzzyMatches.length > 0) {
    console.log(`[googleDrive] Fuzzy match(es) for "${name}": ${fuzzyMatches.map(f=>f.name).join(', ')}`);
    return fuzzyMatches;
  }
  console.log(`[googleDrive] No match for "${name}" — folders checked: ${folders.map(f=>f.name).join(', ') || 'none'}`);
  return [];
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
  // Skip if using OAuth — files are already owned by the personal account
  const isOAuth = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
  if (isOAuth) return;
  const ownerEmail = process.env.GOOGLE_DRIVE_OWNER_EMAIL;
  if (!ownerEmail) return;
  const drive = getDriveClient();
  try {
    // Step 1: Grant owner role — requires sendNotificationEmail:false and moveToNewOwnersRoot:true
    await drive.permissions.create({
      fileId,
      transferOwnership: true,
      sendNotificationEmail: false,
      moveToNewOwnersRoot: false,
      supportsAllDrives: true,
      requestBody: {
        role: 'owner',
        type: 'user',
        emailAddress: ownerEmail,
      },
    });
    console.log(`[googleDrive] Ownership transferred: ${fileId} → ${ownerEmail}`);
  } catch (err) {
    console.warn(`[googleDrive] Ownership transfer failed (non-fatal): ${err.message?.slice(0, 120)}`);
    // Fallback: try granting writer role so at least they can access it
    try {
      await drive.permissions.create({
        fileId,
        supportsAllDrives: true,
        sendNotificationEmail: false,
        requestBody: {
          role: 'writer',
          type: 'user',
          emailAddress: ownerEmail,
        },
      });
      console.log(`[googleDrive] Granted writer access to ${ownerEmail} for ${fileId}`);
    } catch (e2) {
      console.warn(`[googleDrive] Writer grant also failed: ${e2.message?.slice(0, 80)}`);
    }
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

  // ── STEP 1: NAME MATCHING ──
  // Find all folders whose name matches the customer/company name from the order.
  // Exact matches are preferred over fuzzy (middle name / suffix variations).
  const matches = await findAllMatchingFolders(customerName, rootFolderId, isCompany);

  // No name matches at all — create a fresh customer folder
  if (matches.length === 0) {
    console.log(`[googleDrive] No folder found for "${customerName}" — creating new`);
    const created = await createFolder(customerName, rootFolderId);
    await transferOwnership(created.id);
    return { ...created, wasCreated: true };
  }

  // Separate exact name matches from fuzzy (middle name / containment) matches
  const exactNameMatches = matches.filter(f => f.matchType === 'exact');
  const fuzzyNameMatches = matches.filter(f => f.matchType !== 'exact');

  // ── STEP 2: REF CONFIRMATION within name matches ──
  // For each tier (exact first, then fuzzy), check whether any candidate folder
  // already contains a subfolder with this ref number. If it does, that is
  // definitively the correct folder — name matched AND ref confirmed.
  const tiers = [
    { label: 'exact name', candidates: exactNameMatches },
    { label: 'fuzzy name', candidates: fuzzyNameMatches },
  ];

  for (const tier of tiers) {
    if (tier.candidates.length === 0) continue;

    console.log(`[googleDrive] Checking ref "${refName}" across ${tier.candidates.length} ${tier.label} match(es)`);

    for (const folder of tier.candidates) {
      const refSubfolder = await findRefFolder(refName, folder.id);
      if (refSubfolder) {
        console.log(`[googleDrive] ✓ ${tier.label} + ref confirmed: "${folder.name}" contains ref "${refName}"`);
        const details = await getFolderDetails(folder.id);
        return { ...details, wasCreated: false };
      }
    }
  }

  // ── STEP 3: NAME-ONLY FALLBACK ──
  // No folder contained this ref (it's a new order for this customer).
  // Use the best name match — exact preferred over fuzzy.
  // If there are multiple exact or multiple fuzzy matches with no ref to distinguish
  // them, pick the first (they are genuinely ambiguous at this point).
  const best = exactNameMatches[0] || fuzzyNameMatches[0];
  console.log(`[googleDrive] No ref match found — using best name match: "${best.name}" (matchType: ${best.matchType})`);
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
 *    c. If content-level duplicate found (name + size + MD5) → skip upload
 *    d. Otherwise apply -{number} suffix only if files already exist with this name
 *    e. Upload with the final resolved filename
 *
 * Naming rules:
 *   First file ever with this name → no suffix  e.g. "Acme Ltd-2026-03-26_01.pdf"
 *   Second file with same name     → -2         e.g. "Acme Ltd-2026-03-26_01-2.pdf"
 *   25th file with same name       → -25        e.g. "Acme Ltd-2026-03-26_01-25.pdf"
 *
 * @param {string}  customerFolderName
 * @param {string}  refFolderName
 * @param {Array}   pages
 * @param {boolean} isCompany
 * @param {object}  [preDupResult]  - result from checkBeforeUpload (optional).
 *                                    If isDuplicate is true the upload is skipped.
 * Returns: { customerFolderId, customerFolderUrl, refFolderId, refFolderUrl, uploadedFiles }
 */
async function fileDocuments(customerFolderName, refFolderName, pages, isCompany = false, preDupResult = null) {
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
  const { checkGoogleDriveDuplicate } = require('./duplicateCheck');

  for (const page of pages) {
    // Strip .pdf to get the base filename
    const baseFilename = page.finalFileName.replace(/\.pdf$/i, '');

    // ── CONTENT-LEVEL DUPLICATE CHECK ──
    // If a pre-check result was passed in and already confirmed a duplicate,
    // use it directly. Otherwise run the check now inside the ref folder.
    let dupResult = preDupResult;
    if (!dupResult || !dupResult.isDuplicate) {
      dupResult = await checkGoogleDriveDuplicate(
        page.finalFileName,
        page.buffer,
        refFolder.id,
        getDriveClient()
      );
    }

    if (dupResult && dupResult.isDuplicate) {
      console.warn(`[googleDrive] DUPLICATE SKIPPED: "${page.finalFileName}" — ${dupResult.reason}`);
      // Record the skip so the caller knows what happened
      uploadedFiles.push({
        fileName: page.finalFileName,
        pageNumber: page.pageNumber,
        fileId: dupResult.existingFileId || null,
        webViewLink: null,
        suffixApplied: null,
        skipped: true,
        skipReason: dupResult.reason,
      });
      continue;
    }

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
      skipped: false,
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
  // Main filing function used by /api/file-page
  fileDocuments,
  // Pre-flight duplicate check — resolves the ref folder then checks for a content-level duplicate
  checkBeforeUpload: async function(customerFolderName, refFolderName, fileName, fileBuffer, isCompany = false) {
    try {
      const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
      if (!rootFolderId) return { isDuplicate: false, reason: 'no root folder configured' };

      // Resolve the customer folder (read-only — does not create anything)
      const matches = await findAllMatchingFolders(customerFolderName, rootFolderId, isCompany);
      if (matches.length === 0) return { isDuplicate: false, reason: 'customer folder does not exist yet' };

      // Use the best customer folder match
      const bestCustomer = matches[0];

      // Check if ref subfolder exists
      const refFolder = await findRefFolder(refFolderName, bestCustomer.id);
      if (!refFolder) return { isDuplicate: false, reason: 'ref folder does not exist yet' };

      // Run the content-level duplicate check
      const { checkGoogleDriveDuplicate } = require('./duplicateCheck');
      return await checkGoogleDriveDuplicate(fileName, fileBuffer, refFolder.id, getDriveClient());
    } catch (err) {
      console.warn('[googleDrive] checkBeforeUpload error (non-fatal):', err.message);
      return { isDuplicate: false, reason: `pre-check error: ${err.message}` };
    }
  },
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
