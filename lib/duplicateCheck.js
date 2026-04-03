/**
 * lib/duplicateCheck.js
 *
 * Shared duplicate-detection utilities for OneDrive and Google Drive.
 *
 * STRATEGY
 * ─────────
 * Filename alone is not enough — different deliveries can produce the same
 * generated filename (same customer, same ref, same date).  We therefore use
 * a two-factor check:
 *
 *   1. Name match  — normalise and compare filenames (case-insensitive, ignoring
 *                    the -{number} suffix that Google Drive appends on re-uploads)
 *   2. Content match — compare file size in bytes.  If size also matches we treat
 *                      the file as a duplicate and skip the upload.
 *
 * For Google Drive we additionally compare the MD5 checksum that Google stores
 * natively on every file — this gives near-perfect accuracy at zero extra cost.
 *
 * WHY SIZE + MD5 AND NOT JUST NAME?
 * ───────────────────────────────────
 * A genuine re-delivery of the same order will produce a PDF of the same size
 * and identical content.  A coincidentally-named but different document (same
 * customer, different date, same page count) will almost certainly differ in
 * size.  The MD5 check provides the final guarantee.
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Compute the MD5 hash of a Buffer.
 * @param {Buffer} buf
 * @returns {string} hex digest
 */
function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

/**
 * Strip the -{number} suffix Google Drive appends to avoid clobbering.
 * e.g. "Acme Ltd-2026-03-26_01-2.pdf" → "Acme Ltd-2026-03-26_01.pdf"
 */
function stripGDriveSuffix(name) {
  return name.replace(/-\d+(\.pdf)$/i, '$1');
}

/**
 * Normalise a filename for loose comparison:
 * - lowercase
 * - strip leading/trailing whitespace
 */
function normaliseName(name) {
  return (name || '').toLowerCase().trim();
}

// ─────────────────────────────────────────────
// ONEDRIVE DUPLICATE CHECK
// ─────────────────────────────────────────────

/**
 * Check whether a file already exists in a OneDrive folder.
 *
 * Checks:
 *  1. Filename match (exact path lookup via Graph API)
 *  2. If found: file size comparison
 *
 * @param {string}   fileName       - the filename to look for
 * @param {Buffer}   fileBuffer     - the file content we are about to upload
 * @param {string}   folderPath     - OneDrive path, e.g. "Grove Group Scotland/Grove Bedding/Scans/Processed"
 * @param {Function} getTokenFn     - async function returning a valid Graph access token
 * @param {string}   userId         - OneDrive user ID from env
 * @returns {{ isDuplicate: boolean, reason: string }}
 */
async function checkOneDriveDuplicate(fileName, fileBuffer, folderPath, getTokenFn, userId) {
  const axios = require('axios');

  try {
    const token = await getTokenFn();
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}/${encodeURIComponent(fileName)}`;

    let existing;
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params: { $select: 'id,name,size' },
      });
      existing = response.data;
    } catch (err) {
      // 404 = file does not exist → not a duplicate
      if (err.response?.status === 404) {
        return { isDuplicate: false, reason: 'not found' };
      }
      // Any other error — fail safe, allow the upload
      console.warn(`[duplicateCheck] OneDrive lookup error for "${fileName}":`, err.message);
      return { isDuplicate: false, reason: `lookup error: ${err.message}` };
    }

    // File exists by name — now check size
    const existingSize = existing.size;
    const incomingSize = fileBuffer ? fileBuffer.length : 0;

    console.log(`[duplicateCheck] OneDrive name match "${fileName}" — existing size: ${existingSize}, incoming size: ${incomingSize}`);

    if (existingSize === incomingSize) {
      return {
        isDuplicate: true,
        reason: `name + size match (${incomingSize} bytes) — file id: ${existing.id}`,
      };
    }

    // Same name but different size → treat as a new version, not a duplicate
    return {
      isDuplicate: false,
      reason: `name match but size differs (existing: ${existingSize}, incoming: ${incomingSize}) — allowing upload`,
    };

  } catch (err) {
    console.warn(`[duplicateCheck] Unexpected OneDrive check error for "${fileName}":`, err.message);
    return { isDuplicate: false, reason: `unexpected error: ${err.message}` };
  }
}

// ─────────────────────────────────────────────
// GOOGLE DRIVE DUPLICATE CHECK
// ─────────────────────────────────────────────

/**
 * Check whether a file already exists in a specific Google Drive folder.
 *
 * Checks (in order of strictness):
 *  1. Name match — exact AND with -{number} suffix stripped
 *  2. If name matches: size comparison
 *  3. If size matches: MD5 checksum comparison (stored by Google, no download needed)
 *
 * All three must agree for a positive duplicate result.
 *
 * @param {string}   fileName    - the filename we intend to upload
 * @param {Buffer}   fileBuffer  - the file content we are about to upload
 * @param {string}   folderId    - Google Drive folder ID to search within
 * @param {object}   driveClient - googleapis drive v3 client
 * @returns {{ isDuplicate: boolean, reason: string, existingFileId?: string }}
 */
async function checkGoogleDriveDuplicate(fileName, fileBuffer, folderId, driveClient) {
  try {
    // List all PDF files in the target folder including size and md5Checksum
    const response = await driveClient.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
      fields: 'files(id, name, size, md5Checksum)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const existingFiles = response.data.files || [];
    if (existingFiles.length === 0) {
      return { isDuplicate: false, reason: 'folder is empty' };
    }

    const normIncoming = normaliseName(fileName);
    const incomingSize = fileBuffer ? fileBuffer.length : 0;
    const incomingMd5 = fileBuffer ? md5(fileBuffer) : null;

    for (const file of existingFiles) {
      // Step 1: name comparison — try exact and suffix-stripped
      const normExisting = normaliseName(file.name);
      const normStripped  = normaliseName(stripGDriveSuffix(file.name));

      const nameMatches = normExisting === normIncoming || normStripped === normIncoming;
      if (!nameMatches) continue;

      // Step 2: size comparison
      // Google Drive stores size as a string
      const existingSize = file.size ? parseInt(file.size, 10) : 0;
      console.log(`[duplicateCheck] GDrive name match "${file.name}" — existing size: ${existingSize}, incoming size: ${incomingSize}`);

      if (existingSize !== incomingSize) {
        // Same name but different size → not the same file
        console.log(`[duplicateCheck] GDrive size mismatch for "${file.name}" — not a duplicate`);
        continue;
      }

      // Step 3: MD5 comparison (definitive)
      if (file.md5Checksum && incomingMd5) {
        if (file.md5Checksum === incomingMd5) {
          return {
            isDuplicate: true,
            reason: `name + size + MD5 match (${incomingSize} bytes, md5: ${incomingMd5}) — existing file id: ${file.id}`,
            existingFileId: file.id,
          };
        } else {
          // Same name, same size, different MD5 — almost certainly a coincidence
          // (e.g. two invoices that happen to be the same byte length)
          console.log(`[duplicateCheck] GDrive MD5 mismatch for "${file.name}" (${file.md5Checksum} vs ${incomingMd5}) — not a duplicate`);
          continue;
        }
      }

      // MD5 not available (e.g. Shared Drive) — fall back to name + size only
      return {
        isDuplicate: true,
        reason: `name + size match (${incomingSize} bytes) — MD5 unavailable — existing file id: ${file.id}`,
        existingFileId: file.id,
      };
    }

    return { isDuplicate: false, reason: 'no matching file found' };

  } catch (err) {
    console.warn(`[duplicateCheck] GDrive check error for "${fileName}":`, err.message);
    // Fail safe — allow the upload if the check itself errors
    return { isDuplicate: false, reason: `check error: ${err.message}` };
  }
}

module.exports = {
  checkOneDriveDuplicate,
  checkGoogleDriveDuplicate,
  md5,
};
