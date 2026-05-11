/**
 * api/firebase-diag.js
 *
 * Granular diagnostic for the Firebase Admin SDK setup.
 * Tests what's set, whether it parses, and whether Firestore is actually reachable.
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

  // ── Step 1: Presence ────────────────────────────────────────────────────────
  const projectId   = process.env.FIREBASE_PROJECT_ID   || '';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawKey      = process.env.FIREBASE_PRIVATE_KEY  || '';

  t('FIREBASE_PROJECT_ID present',   !!projectId.trim(),
    projectId || 'MISSING — set this in Vercel env vars');
  t('FIREBASE_CLIENT_EMAIL present', !!clientEmail.trim(),
    clientEmail || 'MISSING');
  t('FIREBASE_PRIVATE_KEY present',  !!rawKey.trim(),
    rawKey ? `${rawKey.length} chars` : 'MISSING — most common cause of the "default Firebase app does not exist" error');

  if (!projectId.trim() || !clientEmail.trim() || !rawKey.trim()) {
    return res.status(200).json({
      ok: false,
      summary: 'One or more Firebase Admin env vars are missing on the router.',
      hint: 'Go to Vercel → grove-pdf-router → Settings → Environment Variables and add the missing values from your Firebase Admin service account JSON.',
      results,
    });
  }

  // ── Step 2: Key format detection ────────────────────────────────────────────
  // Vercel can store the key in two styles:
  //  (A) Multi-line — real newlines preserved
  //  (B) Single-line — newlines encoded as the two characters '\n'
  // The replace() call should handle both.
  const hasLiteralNewlines = /\n/.test(rawKey);
  const hasEscapedNewlines = /\\n/.test(rawKey);
  t('PRIVATE_KEY format detection',
    true,
    `literal newlines: ${hasLiteralNewlines}, escaped \\n: ${hasEscapedNewlines}`
  );

  const normalisedKey = rawKey.replace(/\\n/g, '\n');
  t('PRIVATE_KEY begins with BEGIN PRIVATE KEY',
    normalisedKey.startsWith('-----BEGIN PRIVATE KEY-----'),
    normalisedKey.startsWith('-----BEGIN PRIVATE KEY-----')
      ? 'yes'
      : `no — starts with "${normalisedKey.slice(0, 30)}"`
  );
  t('PRIVATE_KEY ends with END PRIVATE KEY',
    normalisedKey.trim().endsWith('-----END PRIVATE KEY-----'),
    normalisedKey.trim().endsWith('-----END PRIVATE KEY-----')
      ? 'yes'
      : `no — last 30 chars: "${normalisedKey.trim().slice(-30)}"`
  );

  // ── Step 3: Try initializing Firebase Admin ─────────────────────────────────
  let admin, app;
  try {
    admin = require('firebase-admin');
    // Use a unique name so we don't collide with whatever's already on the default instance
    const appName = 'diag-' + Date.now();
    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: normalisedKey,
      }),
    }, appName);
    t('Firebase initializeApp()', true, 'OK — credential parsed and app created');
  } catch (err) {
    t('Firebase initializeApp()', false, `THROWN: ${err.message}`);
    return res.status(200).json({
      ok: false,
      summary: 'initializeApp() failed — credentials are malformed',
      hint: 'The most likely cause is that FIREBASE_PRIVATE_KEY in Vercel has the wrong format. Re-paste it from your Firebase service-account JSON exactly as it appears in the file.',
      results,
    });
  }

  // ── Step 4: Try a real Firestore read ───────────────────────────────────────
  try {
    const firestore = admin.firestore(app);
    const start = Date.now();
    const snap = await firestore.collection('pdfRouterStatus').limit(1).get();
    const elapsed = Date.now() - start;
    t('Firestore — read pdfRouterStatus collection',
      true,
      `OK in ${elapsed}ms — collection has ${snap.empty ? '0' : snap.size + (snap.size === 1 ? '+' : '+')} document(s) reachable`
    );
  } catch (err) {
    t('Firestore — read pdfRouterStatus collection', false, `failed: ${err.message}`);
    return res.status(200).json({
      ok: false,
      summary: 'Firestore read failed even though initializeApp() succeeded',
      results,
    });
  }

  // ── Cleanup so we don't leak app instances ──────────────────────────────────
  try { await app.delete(); } catch (e) { /* swallow */ }

  return res.status(200).json({
    ok: true,
    summary: 'Firebase Admin is fully working on the router',
    results,
  });
};
