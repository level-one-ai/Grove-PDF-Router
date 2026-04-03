/**
 * /api/callback
 *
 * Receiver for Claude JSON from Make.com.
 * Does THREE things:
 *   1. Validates the request
 *   2. Saves Claude JSON to Firestore
 *   3. Triggers /api/file-page (BEFORE responding — Vercel kills
 *      serverless functions after the response is sent, so any
 *      async work after res.send() is unreliable)
 *   4. Responds 200
 *
 * All slow work (OneDrive upload, Google Drive filing) happens
 * in /api/file-page.
 */

const db = require('../lib/firebase');
const axios = require('axios');

// Tell Vercel to parse JSON bodies up to 10MB
module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 60,
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

  // Trigger /api/file-page BEFORE responding.
  // We fire the request and wait a short moment to ensure the TCP connection
  // establishes, but we don't wait for file-page to finish its full processing.
  const filPageUrl = `${process.env.WEBHOOK_NOTIFICATION_URL}/api/file-page`;
  console.log(`[callback] Triggering file-page for page ${pageNumber}`);

  // Fire the request — don't await the full response, just ensure it's sent
  const triggerPromise = axios.post(filPageUrl, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 55000, // just under callback's 60s maxDuration
  }).then(() => {
    console.log(`[callback] file-page completed for page ${pageNumber}`);
  }).catch(err => {
    // file-page may still be running — timeout just means it took longer than expected
    console.warn('[callback] file-page trigger warning:', err.message);
  });

  // Wait for file-page to complete (or timeout). This keeps the callback function
  // alive so Vercel doesn't kill it before the outbound request is sent.
  await triggerPromise;

  // Respond AFTER the trigger has been sent
  return res.status(200).json({ status: 'received', pageNumber });
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
