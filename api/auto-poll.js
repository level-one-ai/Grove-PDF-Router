const { logRead } = require('../lib/logRead');
/**
 * /api/auto-poll
 *
 * Server-side polling loop that checks the OneDrive Scans folder every 10 seconds
 * while in auto mode. Runs for up to ~270 seconds inside a single Vercel function
 * invocation, then chains a fresh instance of itself before exiting.
 *
 * Triggered by:
 *   - admin.js when switching to auto mode
 *   - Itself (self-chaining to stay alive beyond one invocation)
 *
 * Stops when:
 *   - Mode is switched to human
 *   - Auto-stop flag is set
 *   - Another poll instance is already running (duplicate guard)
 */

const db = require('../lib/firebase');
const { graphRequest } = require('../lib/graph');
const axios = require('axios');

const POLL_INTERVAL_MS = 30000; // 30 seconds — safety net between webhook and cron
const MAX_RUNTIME_MS = 270000;  // 4.5 minutes — stay under Vercel's 300s limit

module.exports.config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 300,
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Respond immediately — polling runs in background
  res.status(200).json({ status: 'polling', message: 'Auto-poll loop started' });

  try {
    await pollLoop();
  } catch (err) {
    console.error('[auto-poll] Fatal error:', err.message);
  }
};

async function pollLoop() {
  const startTime = Date.now();
  let knownIds = null; // Set of file IDs we already know about

  // Acquire the poll lock — prevents duplicate loops
  const locked = await acquirePollLock();
  if (!locked) {
    console.log('[auto-poll] Another poll instance is already running — exiting');
    return;
  }

  console.log('[auto-poll] Poll loop started');

  try {
    while (true) {
      const elapsed = Date.now() - startTime;

      // Time to chain a fresh instance before Vercel kills us
      if (elapsed > MAX_RUNTIME_MS) {
        console.log(`[auto-poll] Reached ${Math.round(elapsed / 1000)}s — chaining new instance`);
        await chainNewInstance();
        break;
      }

      // Check if we should still be polling (stop flag only — no mode check, always watching)

      // No stop flag check — system always watches

      // Refresh the lock heartbeat so it doesn't expire while we're alive
      await refreshPollLock();

      // Scan the folder
      try {
        const newFiles = await checkForNewFiles(knownIds);

        if (knownIds === null) {
          // First scan — seed knownIds with ONLY completed/processing files.
          // Unprocessed files (null status, reset, detected, waiting) are NOT seeded
          // so they are treated as new arrivals and trigger scan-now immediately.
          // This fixes the bug where files already in Scans when auto-poll chains
          // were silently skipped because they got seeded as "already known".
          knownIds = {};
          const allIds = newFiles.allIds;
          const unprocessedIds = {};
          newFiles.unprocessed.forEach(f => { unprocessedIds[f.id] = true; });
          // Seed only files that are NOT in the unprocessed list (i.e. completed/processing)
          Object.keys(allIds).forEach(id => {
            if (!unprocessedIds[id]) knownIds[id] = true;
          });
          console.log(`[auto-poll] Seeded ${Object.keys(knownIds).length} completed/processing file(s). ${newFiles.unprocessed.length} unprocessed file(s) will be treated as new.`);

          // Immediately trigger scan-now for any unprocessed files found on first scan
          if (newFiles.unprocessed.length > 0) {
            newFiles.unprocessed.forEach(f => { knownIds[f.id] = true; });
            const activelyProcessing = await isAnyFileProcessing();
            if (!activelyProcessing) {
              console.log(`[auto-poll] ${newFiles.unprocessed.length} unprocessed file(s) found on startup — triggering scan-now`);
              await triggerScanNow();
            } else {
              console.log(`[auto-poll] ${newFiles.unprocessed.length} unprocessed file(s) found but a file is already processing — will be picked up after current file completes`);
            }
          }
        } else {
          // Subsequent scans — detect new arrivals
          const arrivals = newFiles.unprocessed.filter(f => !knownIds[f.id]);
          if (arrivals.length > 0) {
            console.log(`[auto-poll] ${arrivals.length} new file(s) detected`);
            // Add to known set immediately so we don't retrigger
            arrivals.forEach(f => { knownIds[f.id] = true; });

            // Only trigger scan-now if nothing is currently being processed.
            // Triggering while a file is mid-processing causes scan-now to reset
            // the pageStore, wiping temp page references and breaking the page chain.
            const activelyProcessing = await isAnyFileProcessing();
            if (!activelyProcessing) {
              console.log('[auto-poll] No active processing — triggering scan-now');
              await triggerScanNow();
            } else {
              console.log('[auto-poll] A file is currently processing — new file queued, scan-now will pick it up when current file completes');
            }
          }
          // Also add any new IDs we see (even if already processed)
          newFiles.unprocessed.forEach(f => { knownIds[f.id] = true; });
        }
      } catch (scanErr) {
        console.warn('[auto-poll] Scan error (non-fatal):', scanErr.message);
      }

      // Wait 10 seconds before next scan
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await releasePollLock();
    console.log('[auto-poll] Poll loop ended');
  }
}

async function checkForNewFiles(knownIds) {
  const userId = process.env.ONEDRIVE_USER_ID;
  const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';

  const result = await graphRequest(
    'GET',
    `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,file,createdDateTime&$top=200`
  );

  const allPdfs = (result?.value || [])
    .filter(item => {
      const name = (item.name || '').toLowerCase();
      const mime = item.file?.mimeType || '';
      return name.endsWith('.pdf') || mime.includes('pdf');
    });

  // Build a set of all current IDs
  const allIds = {};
  allPdfs.forEach(f => { allIds[f.id] = true; });

  // Batch read all file records in a single Firestore call instead of one per file.
  // Reduces reads from N (one per PDF) to 1 regardless of how many files are in Scans.
  const records = await batchGetRecords(allPdfs.map(f => f.id));

  // Filter out already-completed and actively-processing files
  const unprocessed = [];
  for (const pdf of allPdfs) {
    const record = records[pdf.id];
    if (record && record.status === 'completed') continue;
    if (record && record.status === 'processing') continue;
    // detected and waiting are valid unprocessed states — include them
    unprocessed.push(pdf);
  }

  return { allIds, unprocessed };
}

async function triggerScanNow() {
  const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
  try {
    await axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log('[auto-poll] scan-now triggered');
  } catch (err) {
    // scan-now responds 200 immediately and processes async, so timeouts are expected
    console.warn('[auto-poll] scan-now trigger warning:', err.message);
  }
}

async function chainNewInstance() {
  const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
  try {
    await axios.post(`${baseUrl}/api/auto-poll`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });
    console.log('[auto-poll] Chained new instance');
  } catch (err) {
    // New instance responds 200 immediately, so timeout is expected
    console.warn('[auto-poll] Chain trigger warning (likely fine):', err.message);
  }
}

// ── POLL LOCK ──
// Uses a Firestore document to prevent duplicate poll loops.
// The lock has a heartbeat timestamp — if it's stale (>60s old), another instance can take over.

const LOCK_STALE_MS = 90000; // 90 seconds — heartbeats every ~62s (60s sleep + scan time), 90s gives safe margin

async function acquirePollLock() {
  try {
    const admin = require('firebase-admin');
    const firestore = getFirestore();
    const lockRef = firestore.collection('settings').doc('autoPollLock');
    const doc = await lockRef.get();

    if (doc.exists) {
      const data = doc.data();
      const heartbeat = data.heartbeat ? new Date(data.heartbeat).getTime() : 0;
      const age = Date.now() - heartbeat;
      logRead('auto-poll lock check', 1);
      if (age < LOCK_STALE_MS) {
        // Lock is fresh — another instance is alive
        return false;
      }
      console.log(`[auto-poll] Stale lock found (${Math.round(age / 1000)}s old) — taking over`);
    }

    const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await lockRef.set({
      instanceId,
      heartbeat: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });

    // Store instance ID so we can verify it's still ours
    module.exports._instanceId = instanceId;
    return true;
  } catch (err) {
    console.warn('[auto-poll] Lock acquire error:', err.message);
    return true; // On error, proceed anyway — better to poll than not
  }
}

async function refreshPollLock() {
  try {
    const firestore = getFirestore();
    await firestore.collection('settings').doc('autoPollLock').update({
      heartbeat: new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal
  }
}

async function releasePollLock() {
  try {
    const firestore = getFirestore();
    const lockRef = firestore.collection('settings').doc('autoPollLock');
    const doc = await lockRef.get();
    if (doc.exists && doc.data().instanceId === module.exports._instanceId) {
      await lockRef.delete();
      console.log('[auto-poll] Lock released');
    }
  } catch (err) {
    // Non-fatal
  }
}

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

async function isAnyFileProcessing() {
  try {
    const firestore = getFirestore();
    // Collection is 'processedFiles' — same as used by firebase.js COLLECTION constant
    const snapshot = await firestore.collection('processedFiles')
      .where('status', '==', 'processing')
      .limit(1)
      .get();
    return !snapshot.empty;
  } catch (err) {
    console.warn('[auto-poll] isAnyFileProcessing check error (non-fatal):', err.message);
    return false; // fail safe — don't block scan-now if check fails
  }
}

/**
 * Fetch multiple Firestore records in a single batch call.
 * Returns a map of { fileId: recordData | null }.
 * Far cheaper than N individual getRecord() calls.
 */
async function batchGetRecords(fileIds) {
  if (!fileIds.length) return {};
  try {
    const admin = require('firebase-admin');
    const firestore = admin.firestore();
    const COLLECTION = 'processedFiles';
    const refs = fileIds.map(id => firestore.collection(COLLECTION).doc(id));
    const docs = await firestore.getAll(...refs);
    const result = {};
    docs.forEach(doc => {
      result[doc.id] = doc.exists ? doc.data() : null;
    });
    // Read counter log — used by dashboard Logs panel to track Firestore usage
    logRead('auto-poll batchGetRecords', fileIds.length);
    return result;
  } catch (err) {
    console.warn('[auto-poll] batchGetRecords error, falling back to individual reads:', err.message);
    const result = {};
    for (const id of fileIds) {
      try { result[id] = await db.getRecord(id); } catch (e) { result[id] = null; }
    }
    logRead('auto-poll fallback reads', fileIds.length);
    return result;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
