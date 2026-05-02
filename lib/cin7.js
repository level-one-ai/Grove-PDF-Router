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

// Stages that indicate an active/relevant sales order for delivery matching.
// These match the actual stages returned by Cin7 for Grove Bedding.
const ACTIVE_STAGES = ['New', 'Processing', 'Authorised', 'Placed', 'Pick', 'Pack', 'Ship'];

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

// ── Postcode normalisation ────────────────────────────────────────────────────
// Strips spaces and lowercases — "EH18 1DL" and "eh181dl" both normalise to "eh181dl"

function normalisePostcode(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\s+/g, '');
}

function postcodesMatch(cin7Postcode, pdfPostcode) {
  if (!cin7Postcode || !pdfPostcode) return false;
  return normalisePostcode(cin7Postcode) === normalisePostcode(pdfPostcode);
}

// ── Mobile normalisation ──────────────────────────────────────────────────────
// Strips all non-digits — "01316631179" and "+44 131 663 1179" both normalise

function normaliseMobile(str) {
  if (!str) return '';
  // Strip leading +44 country code → replace with 0
  let s = str.replace(/^\+44/, '0').replace(/\s+/g, '').replace(/[^0-9]/g, '');
  return s;
}

function mobilesMatch(cin7Mobile, pdfMobile) {
  if (!cin7Mobile || !pdfMobile) return false;
  return normaliseMobile(cin7Mobile) === normaliseMobile(pdfMobile);
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
 * Matching cascade (most reliable first):
 *   1. Ref alone         — ref is unique, definitive on its own
 *   2. Name + ref        — name confirms the right customer, ref confirms the right order
 *   3. Name + postcode   — postcode is highly specific, good fallback when ref missing
 *   4. Name + mobile     — mobile is unique per customer
 *   5. Name only         — accepted with a warning flag when no confirmers available
 *
 * @param {object} params
 * @param {string} params.customerName  - Customer name from PDF (Claude extraction)
 * @param {string} params.companyName   - Company name from PDF (null for individuals)
 * @param {string} params.pdfRef        - Reference number from PDF (may be null)
 * @param {string} params.pdfPostcode   - Delivery postcode from PDF (may be null)
 * @param {string} params.pdfMobile     - Mobile/phone number from PDF (may be null)
 * @param {string} params.fileId        - Firestore file ID (for caching)
 * @returns {object|null}
 */
async function lookupCin7FolderName({ customerName, companyName, pdfRef, pdfPostcode, pdfMobile, fileId }) {
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

  // Use company name if Claude extracted one, otherwise customer name
  // This is driven entirely by what's on the delivery order — not a default
  const searchName = companyName || customerName;
  if (!searchName) {
    console.warn('[cin7] No name to search — skipping');
    return null;
  }

  console.log(`[cin7] Searching — name: "${searchName}" | ref: "${pdfRef || 'none'}" | postcode: "${pdfPostcode || 'none'}" | mobile: "${pdfMobile || 'none'}"`);

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

  // ── Step 1: ref-only match ────────────────────────────────────────────────
  // Try ref first — it's unique so a ref match alone is definitive
  if (pdfRef) {
    const refOnlyMatch = orders.find(o => refsMatch(o.reference, pdfRef));
    if (refOnlyMatch) {
      console.log(`[cin7] Ref-only match: order ${refOnlyMatch.reference}`);
      return buildResult(refOnlyMatch, searchName, pdfRef, 'ref', fileId);
    }
  }

  // ── Step 2: name match ────────────────────────────────────────────────────
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

  // Single name match — no need for further confirmation
  if (nameMatches.length === 1) {
    const single = nameMatches[0];
    // Still try to confirm with ref/postcode/mobile for logging purposes
    const confirmed = confirmMatch(single, pdfRef, pdfPostcode, pdfMobile);
    console.log(`[cin7] Single name match: order ${single.reference} (${confirmed})`);
    return buildResult(single, searchName, pdfRef, confirmed, fileId);
  }

  // Multiple name matches — use additional fields to narrow to one
  console.log(`[cin7] Multiple name matches (${nameMatches.length}) — using confirmers to narrow`);

  // ── Step 3: name + ref confirmation ──────────────────────────────────────
  if (pdfRef) {
    const refConfirmed = nameMatches.filter(o => refsMatch(o.reference, pdfRef));
    if (refConfirmed.length === 1) {
      console.log(`[cin7] Narrowed by ref "${pdfRef}": order ${refConfirmed[0].reference}`);
      return buildResult(refConfirmed[0], searchName, pdfRef, 'name+ref', fileId);
    }
  }

  // ── Step 4: name + postcode confirmation ─────────────────────────────────
  if (pdfPostcode) {
    const postcodeConfirmed = nameMatches.filter(o =>
      postcodesMatch(o.deliveryPostalCode, pdfPostcode) ||
      postcodesMatch(o.billingPostalCode,  pdfPostcode)
    );
    if (postcodeConfirmed.length === 1) {
      console.log(`[cin7] Narrowed by postcode "${pdfPostcode}": order ${postcodeConfirmed[0].reference}`);
      return buildResult(postcodeConfirmed[0], searchName, pdfRef, 'name+postcode', fileId);
    }
    if (postcodeConfirmed.length > 1) {
      // Postcode narrowed but still multiple — try mobile too
      if (pdfMobile) {
        const mobileConfirmed = postcodeConfirmed.filter(o =>
          mobilesMatch(o.mobile, pdfMobile) || mobilesMatch(o.phone, pdfMobile)
        );
        if (mobileConfirmed.length >= 1) {
          console.log(`[cin7] Narrowed by postcode + mobile: order ${mobileConfirmed[0].reference}`);
          return buildResult(mobileConfirmed[0], searchName, pdfRef, 'name+postcode+mobile', fileId);
        }
      }
      // Still use postcode-confirmed first result — better than nothing
      console.warn(`[cin7] Postcode matched ${postcodeConfirmed.length} orders — using first`);
      return buildResult(postcodeConfirmed[0], searchName, pdfRef, 'name+postcode', fileId);
    }
  }

  // ── Step 5: name + mobile confirmation ───────────────────────────────────
  if (pdfMobile) {
    const mobileConfirmed = nameMatches.filter(o =>
      mobilesMatch(o.mobile, pdfMobile) || mobilesMatch(o.phone, pdfMobile)
    );
    if (mobileConfirmed.length >= 1) {
      console.log(`[cin7] Narrowed by mobile "${pdfMobile}": order ${mobileConfirmed[0].reference}`);
      return buildResult(mobileConfirmed[0], searchName, pdfRef, 'name+mobile', fileId);
    }
  }

  // ── Step 6: name-only fallback ────────────────────────────────────────────
  // Multiple name matches but no confirmer could narrow to one.
  // Use the first match with a warning flag — the dashboard will show this.
  console.warn(`[cin7] Could not narrow ${nameMatches.length} name matches — using first (name-only, unconfirmed)`);
  return buildResult(nameMatches[0], searchName, pdfRef, 'name-only-unconfirmed', fileId);
}

// ── Result builder ────────────────────────────────────────────────────────────

/**
 * Build the standard result object from a matched Cin7 order.
 * Also caches it in Firestore and logs the outcome.
 */
async function buildResult(order, searchName, pdfRef, matchMethod, fileId) {
  const cin7Company  = (order.company || order.deliveryCompany || '').trim() || null;
  const cin7Customer = (
    `${order.firstName || ''} ${order.lastName || ''}`.trim() ||
    `${order.deliveryFirstName || ''} ${order.deliveryLastName || ''}`.trim()
  ) || null;

  // Company name always takes priority if it exists on the order
  const folderName = cin7Company || cin7Customer || searchName;
  const source     = cin7Company ? 'company' : cin7Customer ? 'customer' : 'fallback';

  const result = {
    folderName,
    cin7OrderRef:      order.reference    ?? null,
    cin7OrderId:       order.id           ?? null,
    cin7Company,
    cin7Customer,
    source,
    matchedOn:         searchName,
    pdfRef:            pdfRef || null,
    matchMethod,                              // e.g. 'ref', 'name+ref', 'name+postcode', etc.
    refMatchConfirmed: matchMethod.includes('ref') && !matchMethod.includes('unconfirmed'),
    cin7Stage:         order.stage        ?? null,
    cin7ETD:           order.estimatedDeliveryDate ?? order.requiredDate ?? null,
    cin7Postcode:      order.deliveryPostalCode    ?? order.billingPostalCode ?? null,
  };

  console.log(`[cin7] Result: "${folderName}" | source: ${source} | method: ${matchMethod} | order: ${order.reference}`);

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
 * Describe which confirmers matched (for logging on single-match cases).
 */
function confirmMatch(order, pdfRef, pdfPostcode, pdfMobile) {
  const parts = ['name'];
  if (pdfRef      && refsMatch(order.reference, pdfRef))                                       parts.push('ref');
  if (pdfPostcode && (postcodesMatch(order.deliveryPostalCode, pdfPostcode) || postcodesMatch(order.billingPostalCode, pdfPostcode))) parts.push('postcode');
  if (pdfMobile   && (mobilesMatch(order.mobile, pdfMobile) || mobilesMatch(order.phone, pdfMobile))) parts.push('mobile');
  return parts.join('+');
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
    const sampleFields   = Object.keys(first).filter(k => first[k] !== null && first[k] !== '');
    const stages         = [...new Set(orders.map(o => o.stage || o.status || 'unknown'))];
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
      mobile:                first.mobile                ?? null,
      phone:                 first.phone                 ?? null,
      deliveryPostalCode:    first.deliveryPostalCode    ?? null,
      billingPostalCode:     first.billingPostalCode     ?? null,
      estimatedDeliveryDate: first.estimatedDeliveryDate ?? null,
      requiredDate:          first.requiredDate          ?? null,
      createdDate:           first.createdDate           ?? null,
      total:                 first.total                 ?? null,
    };

    // ── Specific order lookup — JTAI20130-1 (Jim Tait test order) ──
    // Fetches up to 50 orders to find this specific one by ref
    let specificOrder = null;
    let specificError = null;
    try {
      const specRes = await axios.get(`${CIN7_BASE}/SalesOrders?rows=50&page=1`, {
        headers: { Authorization: auth, Accept: 'application/json' },
        timeout: 15000,
      });
      const specOrders = Array.isArray(specRes.data) ? specRes.data : [];
      specificOrder = specOrders.find(o =>
        normaliseRef(o.reference || '') === normaliseRef('JTAI20130-1')
      ) || null;
      if (!specificOrder) {
        // Try broader search across more pages
        const specRes2 = await axios.get(`${CIN7_BASE}/SalesOrders?rows=250&page=1`, {
          headers: { Authorization: auth, Accept: 'application/json' },
          timeout: 15000,
        });
        const specOrders2 = Array.isArray(specRes2.data) ? specRes2.data : [];
        specificOrder = specOrders2.find(o =>
          normaliseRef(o.reference || '') === normaliseRef('JTAI20130-1')
        ) || null;
      }
    } catch (e) {
      specificError = e.message;
    }

    return {
      ok: true,
      elapsed,
      orderCount: orders.length,
      stages,
      sampleFields,
      relevantFields,
      specificOrderRef:   'JTAI20130-1',
      specificOrder:      specificOrder
        ? {
            id:                    specificOrder.id,
            reference:             specificOrder.reference,
            stage:                 specificOrder.stage,
            company:               specificOrder.company               ?? null,
            deliveryCompany:       specificOrder.deliveryCompany       ?? null,
            firstName:             specificOrder.firstName             ?? null,
            lastName:              specificOrder.lastName              ?? null,
            deliveryFirstName:     specificOrder.deliveryFirstName     ?? null,
            deliveryLastName:      specificOrder.deliveryLastName      ?? null,
            mobile:                specificOrder.mobile                ?? null,
            phone:                 specificOrder.phone                 ?? null,
            deliveryPostalCode:    specificOrder.deliveryPostalCode    ?? null,
            billingPostalCode:     specificOrder.billingPostalCode     ?? null,
            deliveryAddress1:      specificOrder.deliveryAddress1      ?? null,
            deliveryCity:          specificOrder.deliveryCity          ?? null,
            estimatedDeliveryDate: specificOrder.estimatedDeliveryDate ?? null,
            total:                 specificOrder.total                 ?? null,
          }
        : null,
      specificOrderError: specificError,
      message: `Connected — ${orders.length} order(s) returned in ${elapsed}ms`,
    };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.Message || err.response?.data?.message || err.message;
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
