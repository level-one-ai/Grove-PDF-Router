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
      const docRef = await firestore.collection('notifications').add({
        event,
        data,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtMs: Date.now(),
      });
      console.log(`[notify] Broadcast "${event}" event`);

      // Clean up notifications older than 30 seconds to keep the collection tiny
      // This prevents the snapshot listener from reading stale documents on reconnect
      const cutoffClean = Date.now() - 30000;
      firestore.collection('notifications')
        .where('createdAtMs', '<', cutoffClean)
        .limit(20)
        .get()
        .then(snap => {
          const batch = firestore.batch();
          snap.docs.forEach(d => batch.delete(d.ref));
          return batch.commit();
        })
        .catch(() => {}); // non-fatal

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
  let unsubscribe = null;

  // Clean up when client disconnects
  req.on('close', () => {
    running = false;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  });

  // Auto-reconnect signal before Vercel's 60s function limit
  const reconnectTimer = setTimeout(() => {
    if (!running) return;
    send('reconnect', { reason: 'keepalive' });
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    running = false;
    res.end();
  }, MAX_DURATION);

  // Use Firestore real-time listener instead of polling.
  // onSnapshot fires instantly when a document is written — zero polling reads.
  try {
    const firestore = getFirestore();
    const cutoff = Date.now() - 5000; // only care about very recent docs

    unsubscribe = firestore.collection('notifications')
      .where('createdAtMs', '>', cutoff)
      .orderBy('createdAtMs', 'asc')
      .onSnapshot(snapshot => {
        if (!running) return;
        snapshot.docChanges().forEach(change => {
          if (change.type !== 'added') return;
          const doc = change.doc;
          if (seen.has(doc.id)) return;
          seen.add(doc.id);
          const { event, data } = doc.data();
          send(event || 'new-file', data || {});
          console.log(`[notify] Pushed "${event}" to dashboard via snapshot`);
        });
      }, err => {
        // Listener error — fall back gracefully
        console.warn('[notify] Snapshot listener error:', err.message);
      });
  } catch (err) {
    console.warn('[notify] Could not set up snapshot listener:', err.message);
  }

  // Keep SSE connection alive with periodic pings (no Firestore reads)
  const keepalive = setInterval(() => {
    if (!running) { clearInterval(keepalive); return; }
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(keepalive); }
  }, 15000);

  // Clean up keepalive and reconnect timer when done
  req.on('close', () => {
    clearInterval(keepalive);
    clearTimeout(reconnectTimer);
  });
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
