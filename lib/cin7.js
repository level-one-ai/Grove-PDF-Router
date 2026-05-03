/**
 * lib/cin7.js
 * ───────────
 * Cin7 Omni API client for the PDF Router.
 *
 * TWO-STEP MATCHING FLOW:
 *
 * Step 1 — Search /v1/Contacts by name
 *   Uses the Contacts endpoint with a WHERE filter so we search directly
 *   rather than fetching 500 orders. Contacts persist even after orders
 *   are completed or archived, so a customer is always findable.
 *   Confirmed fields from live API docs:
 *     id, company, firstName, lastName, phone, mobile, postCode, isActive
 *
 * Step 2 — Fetch /v1/SalesOrders filtered by memberId
 *   Once we have the contact's id (= memberId on orders), we fetch only
 *   that customer's orders. If a ref was extracted from the PDF we narrow
 *   further to match the exact order.
 *
 * FALLBACK CASCADE (most to least reliable):
 *   1. Contact found by name + SalesOrder confirmed by ref → definitive
 *   2. Contact found by name + postcode confirms identity → confident
 *   3. Contact found by name + mobile confirms identity → confident
 *   4. Contact found by name only, one result → accepted with flag
 *   5. Contact found by name only, multiple results → use first + flag
 *   6. No contact found → return null, file under Claude-extracted name
 *
 * Called from file-page.js BEFORE buildFilename() so the confirmed
 * company/customer name and ref feed into the filename itself.
 */

const axios = require('axios');

const CIN7_BASE = 'https://api.cin7.com/api/v1';

// ── Auth ──────────────────────────────────────────────────────────────────────

function cin7Auth() {
  const user = process.env.CIN7_API_USERNAME;
  const key  = process.env.CIN7_API_KEY;
  if (!user || !key) return null;
  return 'Basic ' + Buffer.from(`${user}:${key}`).toString('base64');
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

function normaliseName(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
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
    ? [wordsA, wordsB] : [wordsB, wordsA];
  const matched = shorter.filter(w => w.length > 1 && longer.includes(w)).length;
  return matched >= Math.ceil(shorter.length * 0.6);
}

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

function normalisePostcode(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/\s+/g, '');
}

function postcodesMatch(a, b) {
  if (!a || !b) return false;
  return normalisePostcode(a) === normalisePostcode(b);
}

function normaliseMobile(str) {
  if (!str) return '';
  return str.replace(/^\+44/, '0').replace(/[^0-9]/g, '');
}

function mobilesMatch(a, b) {
  if (!a || !b) return false;
  return normaliseMobile(a) === normaliseMobile(b);
}

// ── Step 1: Search Contacts by name ──────────────────────────────────────────

/**
 * Search the Contacts endpoint directly by name using the WHERE filter.
 * Much faster than fetching 500 orders — returns only matching contacts.
 *
 * Tries three search strategies in order:
 *   1. Full name search (firstName + lastName together as company or split)
 *   2. Company name search
 *   3. Broader last-name-only search as fallback
 */
async function searchContacts(auth, searchName) {
  const parts    = searchName.trim().split(/\s+/);
  const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';

  const strategies = [];

  // Strategy 1: exact company name match
  strategies.push(
    `Company LIKE '${searchName.replace(/'/g, "''")}%'`
  );

  // Strategy 2: firstName + lastName match
  if (firstName && lastName) {
    strategies.push(
      `firstName LIKE '${firstName.replace(/'/g, "''")}%' AND lastName LIKE '${lastName.replace(/'/g, "''")}%'`
    );
  }

  // Strategy 3: lastName only (catches cases where name order differs)
  strategies.push(
    `lastName LIKE '${lastName.replace(/'/g, "''")}%'`
  );

  for (const where of strategies) {
    try {
      const url = `${CIN7_BASE}/Contacts`
        + `?where=${encodeURIComponent(where)}`
        + `&rows=10&page=1`
        + `&fields=id,company,firstName,lastName,phone,mobile,postCode,isActive,type`;

      const res = await axios.get(url, {
        headers: { Authorization: auth, Accept: 'application/json' },
        timeout: 10000,
      });

      const contacts = Array.isArray(res.data) ? res.data : [];
      // Filter to Customer type and active only
      const customers = contacts.filter(c =>
        c.isActive !== false &&
        (!c.type || c.type === 'Customer')
      );

      if (customers.length > 0) {
        console.log(`[cin7] Contacts search "${where}" → ${customers.length} result(s)`);
        return customers;
      }
    } catch (err) {
      console.warn(`[cin7] Contacts search strategy failed (non-fatal): ${err.message}`);
    }
  }

  return [];
}

// ── Step 2: Fetch SalesOrders for a specific contact ─────────────────────────

/**
 * Fetch sales orders for a specific contact using their memberId.
 * Optionally filter by reference number for an exact match.
 */
async function fetchOrdersForContact(auth, memberId, pdfRef) {
  try {
    // If we have a ref, search for it directly — much faster
    let where = `memberId=${memberId}`;
    if (pdfRef) {
      const safeRef = normaliseRef(pdfRef);
      // Try exact ref match first
      const refUrl = `${CIN7_BASE}/SalesOrders`
        + `?where=${encodeURIComponent(`memberId=${memberId} AND reference LIKE '${pdfRef.replace(/'/g, "''")}%'`)}`
        + `&rows=10&page=1`
        + `&fields=id,reference,stage,memberId,firstName,lastName,company,deliveryPostalCode,billingPostalCode,estimatedDeliveryDate,requiredDate`;

      const refRes = await axios.get(refUrl, {
        headers: { Authorization: auth, Accept: 'application/json' },
        timeout: 10000,
      });

      const refOrders = Array.isArray(refRes.data) ? refRes.data : [];
      if (refOrders.length > 0) {
        console.log(`[cin7] Found ${refOrders.length} order(s) for memberId=${memberId} with ref like "${pdfRef}"`);
        return refOrders;
      }
    }

    // No ref or ref search returned nothing — get all orders for this contact
    const url = `${CIN7_BASE}/SalesOrders`
      + `?where=${encodeURIComponent(where)}`
      + `&rows=50&page=1&order=CreatedDate DESC`
      + `&fields=id,reference,stage,memberId,firstName,lastName,company,deliveryPostalCode,billingPostalCode,estimatedDeliveryDate,requiredDate`;

    const res = await axios.get(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      timeout: 10000,
    });

    const orders = Array.isArray(res.data) ? res.data : [];
    console.log(`[cin7] Found ${orders.length} order(s) for memberId=${memberId}`);
    return orders;

  } catch (err) {
    console.warn(`[cin7] fetchOrdersForContact error (non-fatal): ${err.message}`);
    return [];
  }
}

// ── Result builder ────────────────────────────────────────────────────────────

function buildResult(contact, order, searchName, pdfRef, matchMethod, fileId) {
  // Company name from contact takes priority — this is the master record
  const cin7Company  = (contact.company || '').trim() || null;
  const cin7Customer = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || null;

  // Folder name: company if present, otherwise customer name
  const folderName = cin7Company || cin7Customer || searchName;
  const source     = cin7Company ? 'company' : 'customer';

  const result = {
    folderName,
    cin7OrderRef:      order?.reference   ?? null,
    cin7OrderId:       order?.id          ?? null,
    cin7ContactId:     contact.id         ?? null,
    cin7Company,
    cin7Customer,
    source,
    matchedOn:         searchName,
    pdfRef:            pdfRef || null,
    matchMethod,
    refMatchConfirmed: matchMethod.includes('ref'),
    cin7Stage:         order?.stage       ?? null,
    cin7ETD:           order?.estimatedDeliveryDate ?? order?.requiredDate ?? null,
    cin7Postcode:      contact.postCode   ?? null,
  };

  console.log(`[cin7] ✓ Result: "${folderName}" | source: ${source} | method: ${matchMethod} | order: ${order?.reference ?? 'none'}`);

  // Cache in Firestore
  if (fileId) {
    try {
      const db = require('./firebase');
      db.updateRecord(fileId, { cin7Lookup: result }).catch(() => {});
    } catch (e) {
      console.warn('[cin7] Cache write failed (non-fatal):', e.message);
    }
  }

  return result;
}

// ── Main lookup ───────────────────────────────────────────────────────────────

/**
 * Main entry point — looks up the correct folder name and order details.
 *
 * @param {object} params
 * @param {string} params.customerName  - Customer name from PDF (Claude extraction)
 * @param {string} params.companyName   - Company name from PDF (null for individuals)
 * @param {string} params.pdfRef        - Reference number from PDF (may be null)
 * @param {string} params.pdfPostcode   - Delivery postcode from PDF (may be null)
 * @param {string} params.pdfMobile     - Mobile/phone from PDF (may be null)
 * @param {string} params.fileId        - Firestore file ID (for caching)
 * @returns {object|null}
 */
async function lookupCin7FolderName({ customerName, companyName, pdfRef, pdfPostcode, pdfMobile, fileId }) {
  const auth = cin7Auth();
  if (!auth) {
    console.warn('[cin7] Credentials not set — skipping lookup');
    return null;
  }

  // Check Firestore cache
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

  // Use company name if present (business customer), otherwise personal name
  const searchName = companyName || customerName;
  if (!searchName) {
    console.warn('[cin7] No name to search — skipping');
    return null;
  }

  console.log(`[cin7] Looking up — name: "${searchName}" | ref: "${pdfRef || 'none'}" | postcode: "${pdfPostcode || 'none'}" | mobile: "${pdfMobile || 'none'}"`);

  // ── Step 1: Find the contact ──────────────────────────────────────────────
  let contacts = [];
  try {
    contacts = await searchContacts(auth, searchName);
  } catch (err) {
    console.error('[cin7] Contact search error:', err.message);
    await writeError(fileId, `Cin7 Contacts API error: ${err.message}`, searchName, pdfRef);
    return null;
  }

  if (!contacts.length) {
    console.warn(`[cin7] No contact found for "${searchName}"`);
    await writeError(fileId, `No Cin7 contact found for "${searchName}"`, searchName, pdfRef);
    return null;
  }

  // ── Step 2: Narrow to the right contact ──────────────────────────────────
  let contact = null;

  if (contacts.length === 1) {
    contact = contacts[0];
    console.log(`[cin7] Single contact match: ${contact.firstName} ${contact.lastName} | company: ${contact.company || 'none'}`);
  } else {
    // Multiple contacts — use postcode or mobile to narrow
    console.log(`[cin7] ${contacts.length} contacts match "${searchName}" — using confirmers`);

    if (pdfPostcode) {
      const byPostcode = contacts.filter(c => postcodesMatch(c.postCode, pdfPostcode));
      if (byPostcode.length === 1) {
        contact = byPostcode[0];
        console.log(`[cin7] Narrowed by postcode "${pdfPostcode}"`);
      }
    }

    if (!contact && pdfMobile) {
      const byMobile = contacts.filter(c =>
        mobilesMatch(c.mobile, pdfMobile) || mobilesMatch(c.phone, pdfMobile)
      );
      if (byMobile.length >= 1) {
        contact = byMobile[0];
        console.log(`[cin7] Narrowed by mobile`);
      }
    }

    if (!contact) {
      // Could not narrow — use first result with a flag
      contact = contacts[0];
      console.warn(`[cin7] Could not narrow ${contacts.length} contacts — using first result (unconfirmed)`);
    }
  }

  // ── Step 3: Fetch orders for this contact ─────────────────────────────────
  const orders = await fetchOrdersForContact(auth, contact.id, pdfRef);

  // ── Step 4: Match the right order ────────────────────────────────────────
  let matchedOrder = null;
  let matchMethod  = 'contact-name';

  if (orders.length > 0) {
    if (pdfRef) {
      // Try to find the exact order by ref
      const refMatch = orders.find(o => refsMatch(o.reference, pdfRef));
      if (refMatch) {
        matchedOrder = refMatch;
        matchMethod  = contacts.length === 1 ? 'contact-name+ref' : 'contact-confirmed+ref';
        console.log(`[cin7] Order confirmed by ref: ${matchedOrder.reference}`);
      } else {
        // Ref didn't match any of this contact's orders — use most recent
        matchedOrder = orders[0];
        matchMethod  = 'contact-name+no-ref-match';
        console.warn(`[cin7] Ref "${pdfRef}" not found in ${orders.length} orders for this contact — using most recent`);
      }
    } else {
      // No ref on PDF — use most recent order for this contact
      matchedOrder = orders[0];
      matchMethod  = contacts.length === 1 ? 'contact-name+most-recent-order' : 'contact-confirmed+most-recent-order';
      console.warn(`[cin7] No ref on PDF — using most recent order: ${matchedOrder?.reference}`);
    }
  } else {
    // Contact found but no orders — still use the contact for folder naming
    matchMethod = 'contact-name-only-no-orders';
    console.warn(`[cin7] Contact found but no orders — will use contact name for folder only`);
  }

  // Add postcode/mobile confirmation to method label if they helped
  if (contacts.length > 1) {
    if (pdfPostcode && contact && postcodesMatch(contact.postCode, pdfPostcode)) {
      matchMethod = matchMethod.replace('contact-', 'contact-postcode-confirmed-');
    } else if (pdfMobile && contact && (mobilesMatch(contact.mobile, pdfMobile) || mobilesMatch(contact.phone, pdfMobile))) {
      matchMethod = matchMethod.replace('contact-', 'contact-mobile-confirmed-');
    }
  }

  return buildResult(contact, matchedOrder, searchName, pdfRef, matchMethod, fileId);
}

// ── Connection test (used by diag endpoint) ───────────────────────────────────

async function testCin7Connection() {
  const auth = cin7Auth();
  if (!auth) {
    return { ok: false, error: 'CIN7_API_USERNAME or CIN7_API_KEY not configured' };
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const start = Date.now();

  try {
    // Test 1: SalesOrders sample
    const ordersRes = await axios.get(`${CIN7_BASE}/SalesOrders?rows=5&page=1`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      timeout: 15000,
    });
    const orders  = Array.isArray(ordersRes.data) ? ordersRes.data : [];
    const elapsed = Date.now() - start;

    // Small delay before next call to avoid 429 rate limit
    await sleep(600);

    // Test 2: Contacts sample
    const contactsRes = await axios.get(
      `${CIN7_BASE}/Contacts?rows=3&page=1&fields=id,company,firstName,lastName,phone,mobile,postCode,isActive,type`,
      { headers: { Authorization: auth, Accept: 'application/json' }, timeout: 15000 }
    );
    const contacts = Array.isArray(contactsRes.data) ? contactsRes.data : [];

    await sleep(600);

    // Test 3a: Specific order lookup by ref
    let specificOrder   = null;
    let specificContact = null;
    let specificError   = null;

    try {
      const specRes = await axios.get(
        `${CIN7_BASE}/SalesOrders?where=${encodeURIComponent("reference LIKE 'JTAI20130%'")}&rows=10&page=1`,
        { headers: { Authorization: auth, Accept: 'application/json' }, timeout: 15000 }
      );
      const specOrders = Array.isArray(specRes.data) ? specRes.data : [];
      specificOrder = specOrders[0] || null;
    } catch (e) {
      specificError = e.message;
    }

    // Delay before contact lookup
    await sleep(600);

    // Test 3b: Contact lookup for Jim Tait
    try {
      const contactRes = await axios.get(
        `${CIN7_BASE}/Contacts?where=${encodeURIComponent("firstName LIKE 'Jim%' AND lastName LIKE 'Tait%'")}&rows=5&page=1`,
        { headers: { Authorization: auth, Accept: 'application/json' }, timeout: 15000 }
      );
      const specContacts = Array.isArray(contactRes.data) ? contactRes.data : [];
      specificContact = specContacts[0] || null;
    } catch (e) {
      if (!specificError) specificError = e.message;
    }

    const firstOrder   = orders[0]   || {};
    const firstContact = contacts[0] || {};
    const sampleFields = Object.keys(firstOrder).filter(k => firstOrder[k] !== null && firstOrder[k] !== '');

    return {
      ok:           true,
      elapsed,
      orderCount:   orders.length,
      contactCount: contacts.length,
      stages:       [...new Set(orders.map(o => o.stage || 'unknown'))],
      // Order fields
      relevantFields: {
        reference:          firstOrder.reference          ?? null,
        stage:              firstOrder.stage              ?? null,
        company:            firstOrder.company            ?? null,
        firstName:          firstOrder.firstName          ?? null,
        lastName:           firstOrder.lastName           ?? null,
        deliveryPostalCode: firstOrder.deliveryPostalCode ?? null,
        mobile:             firstOrder.mobile             ?? null,
        phone:              firstOrder.phone              ?? null,
      },
      // Contact fields — these are now the primary matching source
      sampleContact: {
        id:        firstContact.id        ?? null,
        company:   firstContact.company   ?? null,
        firstName: firstContact.firstName ?? null,
        lastName:  firstContact.lastName  ?? null,
        phone:     firstContact.phone     ?? null,
        mobile:    firstContact.mobile    ?? null,
        postCode:  firstContact.postCode  ?? null,
        isActive:  firstContact.isActive  ?? null,
        type:      firstContact.type      ?? null,
      },
      sampleFields,
      // Specific lookups
      specificOrderRef:    'JTAI20130-1',
      specificOrder:       specificOrder ? {
        id:        specificOrder.id,
        reference: specificOrder.reference,
        stage:     specificOrder.stage,
        firstName: specificOrder.firstName ?? null,
        lastName:  specificOrder.lastName  ?? null,
        company:   specificOrder.company   ?? null,
        deliveryPostalCode: specificOrder.deliveryPostalCode ?? null,
      } : null,
      specificContact:     specificContact ? {
        id:        specificContact.id,
        company:   specificContact.company   ?? null,
        firstName: specificContact.firstName ?? null,
        lastName:  specificContact.lastName  ?? null,
        phone:     specificContact.phone     ?? null,
        mobile:    specificContact.mobile    ?? null,
        postCode:  specificContact.postCode  ?? null,
      } : null,
      specificOrderError:   specificError,
      message: `Connected — ${orders.length} order(s), ${contacts.length} contact(s) in ${elapsed}ms`,
    };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.Message || err.response?.data?.message || err.message;
    return {
      ok:      false,
      elapsed: Date.now() - start,
      error:   status ? `HTTP ${status}: ${detail}` : detail,
    };
  }
}

// ── Error writer ──────────────────────────────────────────────────────────────

async function writeError(fileId, message, searchName, pdfRef) {
  console.error(`[cin7] ${message}`);
  if (!fileId) return;
  try {
    const admin     = require('firebase-admin');
    const firestore = admin.firestore();
    await firestore.collection('pdfRouterErrors').doc(fileId).set({
      fileId,
      type:       'cin7_no_match',
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
