/**
 * api/firebase-diag.js
 *
 * Granular diagnostic for Firebase Admin SDK setup. Uses a NAMED app
 * (not the default), and explicitly deletes it before returning, so this
 * diagnostic never leaves residual state that breaks other endpoints.
 *
 * Usage:  GET /api/firebase-diag?secret=YOUR_CALLBACK_SECRET
 */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const expectedSecret = process.env.CALLBACK_SECRET;
  const providedSecret = req.query?.secret || req.headers['x-callback-secret'];
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorised — provide ?secret=<CALLBACK_SECRET>' });
  }

  const results = [];
  const t = (name, ok, details) => results.push({ name, ok, details });

  const projectId   = process.env.FIREBASE_PROJECT_ID   || '';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawKey      = process.env.FIREBASE_PRIVATE_KEY  || '';

  t('FIREBASE_PROJECT_ID present',   !!projectId.trim(),   projectId || 'MISSING');
  t('FIREBASE_CLIENT_EMAIL present', !!clientEmail.trim(), clientEmail || 'MISSING');
  t('FIREBASE_PRIVATE_KEY present',  !!rawKey.trim(),      rawKey ? `${rawKey.length} chars` : 'MISSING');

  if (!projectId.trim() || !clientEmail.trim() || !rawKey.trim()) {
    return res.status(200).json({ ok: false, summary: 'Missing env vars', results });
  }

  const normalisedKey = rawKey.replace(/\\n/g, '\n');
  t('PRIVATE_KEY starts with BEGIN', normalisedKey.startsWith('-----BEGIN PRIVATE KEY-----'), 'yes/no check');
  t('PRIVATE_KEY ends with END',     normalisedKey.trim().endsWith('-----END PRIVATE KEY-----'), 'yes/no check');

  // Use a uniquely-named app to avoid colliding with the default app.
  // We MUST clean it up afterwards or future requests on the same warm
  // Lambda instance will see admin.apps.length > 0 and skip their own init.
  const admin = require('firebase-admin');
  const appName = 'firebase-diag-' + Date.now();
  let app;

  try {
    app = admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey: normalisedKey }),
    }, appName);
    t('Firebase initializeApp()', true, 'OK');
  } catch (err) {
    t('Firebase initializeApp()', false, `THROWN: ${err.message}`);
    return res.status(200).json({ ok: false, summary: 'initializeApp() failed', results });
  }

  try {
    const firestore = admin.firestore(app);
    const start = Date.now();
    const snap = await firestore.collection('pdfRouterStatus').limit(1).get();
    t('Firestore read', true, `OK in ${Date.now()-start}ms — ${snap.empty ? '0' : '1+'} doc(s)`);
  } catch (err) {
    t('Firestore read', false, `failed: ${err.message}`);
  } finally {
    // Always clean up the named app so we don't leave residue in admin.apps
    try { await app.delete(); } catch (e) { /* swallow */ }
  }

  return res.status(200).json({
    ok: results.every(r => r.ok),
    summary: 'Firebase Admin tested — diagnostic app cleaned up after itself',
    results,
  });
};
