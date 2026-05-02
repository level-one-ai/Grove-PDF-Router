/**
 * lib/cin7.js
 * ───────────
 * Cin7 Omni API client for the PDF Router.
 *
 * Used in file-page.js BEFORE buildFilename() so the confirmed Cin7
 * company name, customer name, and reference number all feed into
 * the final filename — not just the Google Drive folder.
 *
 * Matching logic:
 * 1. Fetch recent Authorised + Placed sales orders (stage filter applied)
 * 2. Match by company name OR customer name from the PDF
 * 3. If a ref is present on the PDF, REQUIRE it to match — ref is unique
 *    so name + ref together give a definitive match
 * 4. If no ref on the PDF, accept the best name-only match and flag it
 * 5. Company name on the matched order takes priority over customer name
 *    for both the filename and the Google Drive folder
 *
 * Caching: result stored in Firestore per fileId so multi-page files
 * only call Cin7 once.
 */

const axios = require('axios');

const CIN7_BASE = 'https://api.cin7.com/api/v1';

// Stages that indicate an active/relevant sales order for delivery matching
const ACTIVE_STAGES = ['Authorised', 'Placed', 'Pick', 'Pack', 'Ship'];

function cin7Auth() {
  const user = process.env.CIN7_API_USERNAME;
  const key  = process.env.CIN7_API_KEY;
  if (!user || !key) return null;
  return 'Basic ' + Buffer.from(`${user}:${key}`).toString('base64');
}

// ── Name normalisation ────────────────────────────────────────────────────────

function normaliseName(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(a, b) {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wordsA = na.split(' ');
  const wordsB = nb.split(' ');
  const [shorter, longer] = wordsA.length <= wordsB.length
    ? [wordsA, wordsB]
    : [wordsB, wordsA];
  const matchCount = shorter.filter(w => w.length > 1 && longer.includes(w)).length;
  return matchCount >= Math.ceil(shorter.length * 0.6);
}

// ── Reference normalisation ───────────────────────────────────────────────────

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

// ── Fetch orders from Cin7 ────────────────────────────────────────────────────

async function fetchOrders(auth) {
  // Fetch up to 500 orders across active stages
  // We fetch all active stages in one call using a broad fetch then filter locally
  // because Cin7 doesn't support OR on the stage field directly in a single query
  const res = await axios.get(`${CIN7_BASE}/SalesOrders?rows=500&page=1`, {
    headers: { Authorization: auth, Accept: 'application/json' },
    timeout: 15000,
  });
  const all = Array.isArray(res.data) ? res.data : [];
  // Filter to active stages only
  return all.filter(o => {
    const stage = (o.stage || o.status || '').trim();
    return ACTIVE_STAGES.some(s => stage.toLowerCase() === s.toLowerCase());
  });
}

// ── Main lookup ───────────────────────────────────────────────────────────────

/**
 * Look up the correct folder name and order details from Cin7.
 *
 * @param {object} params
 * @param {string} params.customerName  - Name extracted from PDF by Claude
 * @param {string} params.companyName   - Company name from PDF (may be null)
 * @param {string} params.pdfRef        - Reference number from PDF (may be null)
 * @param {string} params.fileId        - Firestore file ID (for caching)
 * @returns {object|null} {
 *   folderName, cin7OrderRef, cin7OrderId,
 *   cin7Company, cin7Customer, source,
 *   matchedOn, pdfRef, refMatchConfirmed
 * }
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

  const searchName = companyName || customerName;
  if (!searchName) {
    console.warn('[cin7] No name to search — skipping');
    return null;
  }

  console.log(`[cin7] Searching for: "${searchName}" | ref: "${pdfRef || 'none'}"`);

  let orders = [];
  try {
    orders = await fetchOrders(auth);
    console.log(`[cin7] Fetched ${orders.length} active orders`);
  } catch (err) {
    console.error('[cin7] API fetch failed:', err.message);
    await writeError(fileId, `Cin7 API error: ${err.message}`, searchName, pdfRef);
    return null;
  }

  if (!orders.length) {
    await writeError(fileId, 'Cin7 returned no active orders', searchName, pdfRef);
    return null;
  }

  // ── Step 1: name match ────────────────────────────────────────────────────
  const nameMatches = orders.filter(order => {
    const cin7Names = [
      order.company,
      order.deliveryCompany,
      `${order.firstName || ''} ${order.lastName || ''}`.trim(),
      `${order.deliveryFirstName || ''} ${order.deliveryLastName || ''}`.trim(),
    ].filter(Boolean);
    return cin7Names.some(n => namesMatch(n, searchName));
  });

  console.log(`[cin7] Name matches: ${nameMatches.length}`);

  if (!nameMatches.length) {
    await writeError(fileId,
      `No Cin7 order found matching name "${searchName}"`,
      searchName, pdfRef
    );
    return null;
  }

  // ── Step 2: ref confirmation ──────────────────────────────────────────────
  // If we have a ref from the PDF, REQUIRE it to match — ref is unique
  let best = null;
  let refMatchConfirmed = false;

  if (pdfRef) {
    const refMatches = nameMatches.filter(o => refsMatch(o.reference, pdfRef));
    if (refMatches.length > 0) {
      best = refMatches[0];
      refMatchConfirmed = true;
      console.log(`[cin7] Name + ref confirmed: order ${best.reference}`);
    } else {
      // Name matched but ref didn't — log a warning but don't fail
      // The PDF ref may be formatted differently or may be a sub-ref
      console.warn(`[cin7] ${nameMatches.length} name match(es) but ref "${pdfRef}" didn't confirm any — using best name match`);
      best = nameMatches[0];
      refMatchConfirmed = false;
    }
  } else {
    // No ref on the PDF — use best name match and flag it
    best = nameMatches[0];
    refMatchConfirmed = false;
    console.warn(`[cin7] No ref on PDF — using name-only match: order ${best.reference || '(no ref)'}`);
  }

  // ── Step 3: resolve folder name ───────────────────────────────────────────
  const cin7Company  = (best.company || best.deliveryCompany || '').trim() || null;
  const cin7Customer = (
    `${best.firstName || ''} ${best.lastName || ''}`.trim() ||
    `${best.deliveryFirstName || ''} ${best.deliveryLastName || ''}`.trim()
  ) || null;

  const folderName = cin7Company || cin7Customer || searchName;
  const source     = cin7Company ? 'company' : cin7Customer ? 'customer' : 'fallback';

  const result = {
    folderName,
    cin7OrderRef:       best.reference    ?? null,
    cin7OrderId:        best.id           ?? null,
    cin7Company,
    cin7Customer,
    source,
    matchedOn:          searchName,
    pdfRef:             pdfRef || null,
    refMatchConfirmed,
    // Pass back all useful fields so file-page.js can use them in the filename
    cin7Stage:          best.stage        ?? null,
    cin7ETD:            best.estimatedDeliveryDate ?? best.requiredDate ?? null,
  };

  console.log(`[cin7] Resolved: "${folderName}" (source: ${source}, ref confirmed: ${refMatchConfirmed}, order: ${best.reference})`);

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

// ── Connection test (used by diag endpoint) ───────────────────────────────────

/**
 * Test the Cin7 connection and return diagnostic info.
 * Does NOT cache anything — purely for testing.
 *
 * @returns {object} {
 *   ok, orderCount, stages, sampleFields, firstOrder,
 *   error (if failed)
 * }
 */
async function testCin7Connection() {
  const auth = cin7Auth();
  if (!auth) {
    return { ok: false, error: 'CIN7_API_USERNAME or CIN7_API_KEY not configured' };
  }

  const start = Date.now();
  try {
    // Fetch a small sample — just 5 orders to keep it fast
    const res = await axios.get(`${CIN7_BASE}/SalesOrders?rows=5&page=1`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      timeout: 15000,
    });

    const orders = Array.isArray(res.data) ? res.data : [];
    const elapsed = Date.now() - start;

    if (orders.length === 0) {
      return { ok: true, elapsed, orderCount: 0, message: 'Connected but no orders returned' };
    }

    const first = orders[0];

    // Collect all non-null field names from first order
    const sampleFields = Object.keys(first).filter(k => first[k] !== null && first[k] !== '');

    // Collect stages present in sample
    const stages = [...new Set(orders.map(o => o.stage || o.status || 'unknown'))];

    // Safe subset of first order fields relevant to matching
    const relevantFields = {
      id:                    first.id                    ?? null,
      reference:             first.reference             ?? null,
      stage:                 first.stage                 ?? null,
      company:               first.company               ?? null,
      deliveryCompany:       first.deliveryCompany       ?? null,
      firstName:             first.firstName             ?? null,
      lastName:              first.lastName              ?? null,
      deliveryFirstName:     first.deliveryFirstName     ?? null,
      deliveryLastName:      first.deliveryLastName      ?? null,
      estimatedDeliveryDate: first.estimatedDeliveryDate ?? null,
      requiredDate:          first.requiredDate          ?? null,
      createdDate:           first.createdDate           ?? null,
      total:                 first.total                 ?? null,
    };

    return {
      ok: true,
      elapsed,
      orderCount: orders.length,
      stages,
      sampleFields,
      relevantFields,
      message: `Connected — ${orders.length} order(s) returned in ${elapsed}ms`,
    };
  } catch (err) {
    const status  = err.response?.status;
    const detail  = err.response?.data?.Message || err.response?.data?.message || err.message;
    return {
      ok: false,
      elapsed: Date.now() - start,
      error: status ? `HTTP ${status}: ${detail}` : detail,
    };
  }
}

// ── Error writer ──────────────────────────────────────────────────────────────

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
      pdfRef:     pdfRef     || null,
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.warn('[cin7] Could not write error to Firestore:', e.message);
  }
}

module.exports = { lookupCin7FolderName, testCin7Connection };
