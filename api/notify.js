/**
 * /api/notify
 *
 * Server-Sent Events (SSE) endpoint.
 * The dashboard connects to this on page load and holds the connection open.
 * When webhook.js detects a new file it calls POST /api/notify to broadcast
 * a "new-file" event to all open dashboard connections.
 *
 * GET  /api/notify  → open SSE stream (dashboard listens here)
 * POST /api/notify  → broadcast event to all open streams (called by webhook.js)
 *
 * Because Vercel runs each function invocation in isolation, connections cannot
 * be shared in memory across invocations. Instead we use Firestore as a simple
 * message bus:
 *
 *   - POST writes a notification document to Firestore with a timestamp
 *   - GET polls Firestore every 2 seconds for documents newer than connection open time
 *   - When a new document is found, it is pushed down the SSE stream
 *   - The GET connection runs for up to 55 seconds then sends a "reconnect" event
 *     so the dashboard re-establishes cleanly before Vercel's timeout
 *
 * This gives near-instant notification (≤2 second lag) without requiring
 * in-process shared state.
 */

const db = require('../lib/firebase');

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
    responseLimit: false,
  },
  maxDuration: 60,
};

module.exports = async function handler(req, res) {

  // ── POST: broadcast a notification (called by webhook.js) ──
  if (req.method === 'POST') {
    const secret = req.headers['x-notify-secret'] || req.body?.secret;
    const expected = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
    if (secret !== expected) {
      return res.status(401).json({ error: 'Unauthorised' });
    }

    const { event = 'new-file', data = {} } = req.body || {};

    try {
      const admin = require('firebase-admin');
      const firestore = getFirestore();
      await firestore.collection('notifications').add({
        event,
        data,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtMs: Date.now(),
      });
      console.log(`[notify] Broadcast "${event}" event`);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[notify] Broadcast error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── GET: open SSE stream (dashboard connects here) ──
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const connectedAt = Date.now();
  const MAX_DURATION = 55000; // reconnect before Vercel's 60s limit
  const POLL_INTERVAL = 2000; // check Firestore every 2 seconds

  function send(event, data) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) { /* client disconnected */ }
  }

  // Send initial connected event so dashboard knows the stream is live
  send('connected', { connectedAt });

  const seen = new Set();
  let running = true;

  // Clean up when client disconnects
  req.on('close', () => { running = false; });

  // Poll Firestore for new notification documents
  const interval = setInterval(async () => {
    if (!running) { clearInterval(interval); return; }

    // Time to reconnect — send signal so dashboard re-establishes
    if (Date.now() - connectedAt > MAX_DURATION) {
      send('reconnect', { reason: 'keepalive' });
      clearInterval(interval);
      res.end();
      return;
    }

    try {
      const firestore = getFirestore();
      // Fetch notifications created in the last 10 seconds
      const cutoff = Date.now() - 10000;
      const snap = await firestore.collection('notifications')
        .where('createdAtMs', '>', cutoff)
        .orderBy('createdAtMs', 'asc')
        .limit(10)
        .get();

      snap.forEach(doc => {
        if (seen.has(doc.id)) return;
        seen.add(doc.id);
        const { event, data } = doc.data();
        send(event || 'new-file', data || {});
        console.log(`[notify] Pushed "${event}" to dashboard`);
      });
    } catch (err) {
      // Non-fatal — just skip this poll cycle
    }
  }, POLL_INTERVAL);

  // Keep connection alive with periodic pings
  const keepalive = setInterval(() => {
    if (!running) { clearInterval(keepalive); return; }
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(keepalive); }
  }, 15000);
};

function getFirestore() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}
