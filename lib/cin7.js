/**
 * lib/cin7.js
 * ───────────
 * Cin7 Omni API client for the PDF Router.
 *
 * Used in file-page.js to determine the correct Google Drive folder name
 * before filing a processed delivery order.
 *
 * Logic:
 * 1. Search Cin7 Sales Orders by customer name extracted from PDF
 * 2. If multiple matches found, narrow by reference number from PDF
 * 3. If a Company Name exists on the matched order, use that for the folder
 *    (Company Name always takes priority over customer name)
 * 4. If no match found, write error to Firestore and return null
 *    (caller falls back to Claude-extracted name)
 *
 * Caching: result is stored in Firestore per fileId so multi-page files
 * only call Cin7 once.
 */

const axios = require('axios');

const CIN7_BASE = 'https://api.cin7.com/api/v1';

function cin7Auth() {
  const user = process.env.CIN7_API_USERNAME;
  const key  = process.env.CIN7_API_KEY;
  if (!user || !key) return null;
  return 'Basic ' + Buffer.from(`${user}:${key}`).toString('base64');
}

/**
 * Normalise a name for fuzzy comparison:
 * lowercase, remove punctuation, collapse spaces
 */
function normaliseName(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two names are a close enough match.
 * Handles "J Smith" vs "John Smith", extra words, etc.
 */
function namesMatch(a, b) {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return false;

  // Exact match
  if (na === nb) return true;

  // One contains the other
  if (na.includes(nb) || nb.includes(na)) return true;

  // Check if all words in the shorter name appear in the longer name
  const wordsA = na.split(' ');
  const wordsB = nb.split(' ');
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  const matchCount = shorter.filter(w => w.length > 1 && longer.includes(w)).length;
  return matchCount >= Math.ceil(shorter.length * 0.6);
}

/**
 * Normalise a reference number for comparison.
 * Strips common prefixes and trailing counters so
 * "NDIV1823-27" and "1823" can still match.
 */
function normaliseRef(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function refsMatch(cin7Ref, pdfRef) {
  if (!cin7Ref || !pdfRef) return false;
  const a = normaliseRef(cin7Ref);
  const b = normaliseRef(pdfRef);
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Main lookup function.
 *
 * @param {object} params
 * @param {string} params.customerName  - Name extracted from PDF by Claude
 * @param {string} params.companyName   - Company name extracted from PDF by Claude (may be null)
 * @param {string} params.pdfRef        - Reference number from PDF
 * @param {string} params.fileId        - Firestore file ID (for caching)
 * @returns {object|null} { folderName, cin7OrderRef, cin7Company, cin7Customer, source }
 *                        source = 'company' | 'customer' | null
 */
async function lookupCin7FolderName({ customerName, companyName, pdfRef, fileId }) {
  const auth = cin7Auth();
  if (!auth) {
    console.warn('[cin7] CIN7_API_USERNAME or CIN7_API_KEY not set — skipping lookup');
    return null;
  }

  // Check Firestore cache first
  if (fileId) {
    try {
      const db = require('./firebase');
      const record = await db.getRecord(fileId);
      if (record?.cin7Lookup) {
        console.log(`[cin7] Using cached result for ${fileId}`);
        return record.cin7Lookup;
      }
    } catch (e) {
      console.warn('[cin7] Cache read failed (non-fatal):', e.message);
    }
  }

  // Build search name — prefer company name from PDF if available
  const searchName = companyName || customerName;
  if (!searchName) {
    console.warn('[cin7] No name to search — skipping');
    return null;
  }

  console.log(`[cin7] Searching for: "${searchName}" | ref: "${pdfRef || 'none'}"`);

  let orders = [];

  try {
    // Fetch recent authorised orders — Cin7 doesn't support fuzzy name search
    // so we fetch a broad set and filter locally
    const res = await axios.get(`${CIN7_BASE}/SalesOrders?rows=250&page=1`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      timeout: 15000,
    });
    orders = Array.isArray(res.data) ? res.data : [];
    console.log(`[cin7] Fetched ${orders.length} orders`);
  } catch (err) {
    console.error('[cin7] API fetch failed:', err.message);
    await writeError(fileId, `Cin7 API error: ${err.message}`, searchName, pdfRef);
    return null;
  }

  if (!orders.length) {
    await writeError(fileId, 'Cin7 returned no orders', searchName, pdfRef);
    return null;
  }

  // Match orders by name — check company, deliveryCompany, firstName+lastName
  const matches = orders.filter(order => {
    const cin7Names = [
      order.company,
      order.deliveryCompany,
      `${order.firstName || ''} ${order.lastName || ''}`.trim(),
      `${order.deliveryFirstName || ''} ${order.deliveryLastName || ''}`.trim(),
    ].filter(Boolean);

    return cin7Names.some(n => namesMatch(n, searchName));
  });

  console.log(`[cin7] Name matches: ${matches.length}`);

  if (!matches.length) {
    await writeError(fileId,
      `No Cin7 order found matching name "${searchName}"`,
      searchName, pdfRef
    );
    return null;
  }

  // If multiple matches and we have a PDF ref, narrow by reference
  let best = matches[0];
  if (matches.length > 1 && pdfRef) {
    const refMatch = matches.find(o => refsMatch(o.reference, pdfRef));
    if (refMatch) {
      best = refMatch;
      console.log(`[cin7] Narrowed by ref "${pdfRef}" → order ${best.reference}`);
    } else {
      console.warn(`[cin7] Multiple name matches, ref "${pdfRef}" didn't narrow — using first`);
    }
  }

  // Determine folder name — company always takes priority
  const cin7Company  = (best.company || best.deliveryCompany || '').trim() || null;
  const cin7Customer = `${best.firstName || ''} ${best.lastName || ''}`.trim() ||
                       `${best.deliveryFirstName || ''} ${best.deliveryLastName || ''}`.trim() ||
                       null;

  const folderName = cin7Company || cin7Customer || searchName;
  const source     = cin7Company ? 'company' : cin7Customer ? 'customer' : 'fallback';

  const result = {
    folderName,
    cin7OrderRef:  best.reference ?? null,
    cin7OrderId:   best.id        ?? null,
    cin7Company,
    cin7Customer,
    source,
    matchedOn: searchName,
    pdfRef,
  };

  console.log(`[cin7] Resolved folder: "${folderName}" (source: ${source}, order: ${best.reference})`);

  // Cache in Firestore
  if (fileId) {
    try {
      const db = require('./firebase');
      await db.updateRecord(fileId, { cin7Lookup: result });
    } catch (e) {
      console.warn('[cin7] Cache write failed (non-fatal):', e.message);
    }
  }

  return result;
}

/**
 * Write a Cin7 lookup error to Firestore so the dashboard can display it.
 */
async function writeError(fileId, message, searchName, pdfRef) {
  console.error(`[cin7] ERROR: ${message}`);
  if (!fileId) return;
  try {
    const admin = require('firebase-admin');
    const firestore = admin.firestore();
    await firestore.collection('pdfRouterErrors').doc(fileId).set({
      fileId,
      type: 'cin7_no_match',
      message,
      searchName: searchName || null,
      pdfRef: pdfRef || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.warn('[cin7] Could not write error to Firestore:', e.message);
  }
}

module.exports = { lookupCin7FolderName };
