/**
 * /api/callback
 *
 * Lightweight receiver for Claude JSON from Make.com.
 * Does THREE things only:
 *   1. Validates the request
 *   2. Saves Claude JSON to Firestore
 *   3. Triggers /api/file-page in background
 *   4. Responds 200 immediately
 *
 * All slow work (OneDrive upload, Google Drive filing) happens
 * in /api/file-page to stay under Vercel's 60s timeout.
 */

const db = require('../lib/firebase');
const axios = require('axios');

// Tell Vercel to parse JSON bodies up to 10MB
module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  console.log('[callback] Received keys:', Object.keys(body));
  console.log('[callback] fileId:', body.fileId, '| page:', body.pageNumber, '| total:', body.totalPages);

  // Validate secret
  const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
  const incomingSecret = req.headers['x-callback-secret'] || body.secret;
  if (incomingSecret !== expectedSecret) {
    console.warn('[callback] Secret mismatch — expected:', expectedSecret, 'got:', incomingSecret);
    // Log but don't reject during testing
  }

  // Extract fields — supports both nested JSON and flat fields from Make.com
  const fileId = body.fileId;
  const pageNumber = parseInt(body.pageNumber, 10);
  const totalPages = parseInt(body.totalPages, 10);

  if (!fileId || isNaN(pageNumber)) {
    console.error('[callback] Missing fileId or pageNumber');
    return res.status(400).json({
      error: 'Missing required fields',
      received: { fileId: !!fileId, pageNumber: body.pageNumber },
    });
  }

  // Build claudeJson from either nested or flat fields
  let claudeJson = body.json;

  // If string, parse it
  if (typeof claudeJson === 'string') {
    try { claudeJson = JSON.parse(claudeJson); } catch(e) {
      console.error('[callback] Failed to parse json string:', e.message);
    }
  }

  // Build from flat fields if no nested json
  if (!claudeJson) {
    claudeJson = buildFromFlatFields(body);
    if (claudeJson) {
      console.log('[callback] Built claudeJson from flat fields');
    }
  }

  if (!claudeJson) {
    console.error('[callback] Could not build claudeJson from body');
    return res.status(400).json({ error: 'Missing json field', body: Object.keys(body) });
  }

  // Fix null strings
  if (claudeJson?.document?.customer?.company_name === 'null' ||
      claudeJson?.document?.customer?.company_name === '') {
    claudeJson.document.customer.company_name = null;
  }

  console.log('[callback] title:', claudeJson?.document?.header?.title,
    '| ref:', claudeJson?.document?.header?.ref,
    '| name:', claudeJson?.document?.customer?.name);

  // Save Claude JSON to Firestore for this page
  try {
    await db.updatePageResult(fileId, pageNumber, {
      claudeJson,
      status: 'pending-filing',
    });
    console.log(`[callback] Saved JSON for page ${pageNumber} to Firestore`);
  } catch (err) {
    console.error('[callback] Failed to save to Firestore:', err.message);
    return res.status(500).json({ error: 'Firestore save failed', detail: err.message });
  }

  // Respond immediately before triggering file-page
  res.status(200).json({ status: 'received', pageNumber });

  // Trigger /api/file-page in background — non-blocking
  // Forward the full payload so file-page has claudeJson and document_type
  const filPageUrl = `${process.env.WEBHOOK_NOTIFICATION_URL}/api/file-page`;
  console.log(`[callback] Triggering file-page for page ${pageNumber}`);

  axios.post(filPageUrl, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 5000, // just need to trigger it, not wait
  }).catch(err => {
    // Non-fatal — file-page may still run even if this times out
    console.warn('[callback] file-page trigger warning:', err.message);
  });
};

function buildFromFlatFields(body) {
  // Only build if we have at least a title or customer name
  if (!body.title && !body.customer_name) return null;

  return {
    document: {
      header: {
        title: body.title || '',
        etd: body.etd || '',
        ref: body.ref || '',
        inv_no: body.inv_no || '',
        customer_po_no: body.customer_po_no || '',
      },
      customer: {
        company_name: (body.company_name && body.company_name !== 'null') ? body.company_name : null,
        name: body.customer_name || '',
        address: {
          street: body.street || '',
          city: body.city || '',
          region: body.region || '',
          postcode: body.postcode || '',
          country: body.country || '',
        },
        phone: body.phone || '',
        mobile: body.mobile || '',
      },
      ship_to: {
        name: body.ship_to_name || '',
        address: {
          street: body.ship_to_street || '',
          city: body.ship_to_city || '',
          region: body.ship_to_region || '',
          postcode: body.ship_to_postcode || '',
          country: body.ship_to_country || '',
        },
      },
      handwritten_notes: body.handwritten_notes || '',
      product_selection: [],
    }
  };
}
