/**
 * logRead(source, count)
 *
 * Records a Firestore read event for monitoring purposes.
 * - Logs to console with [firestore-reads] prefix (visible in Vercel logs)
 * - Atomically increments the counter in Firestore settings/firestoreReadLog
 *   so the dashboard Logs panel can show aggregated totals
 *
 * Designed to be fire-and-forget — never throws, never blocks processing.
 */

function logRead(source, count = 1) {
  // Always log to console first — this works even if Firestore write fails
  console.log(`[firestore-reads] ${source}: ${count} read(s)`);

  // Write to Firestore asynchronously — don't await, don't block caller
  writeReadLog(source, count).catch(() => {}); // silently swallow errors
}

async function writeReadLog(source, count) {
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) return; // not initialised yet — skip
    const firestore = admin.firestore();

    const ref = firestore.collection('settings').doc('firestoreReadLog');
    await firestore.runTransaction(async tx => {
      const doc = await tx.get(ref);
      const now = new Date().toISOString();

      if (!doc.exists) {
        tx.set(ref, {
          sources: {
            [source]: { reads: count, invocations: 1, lastSeen: now },
          },
          windowMins: 60,
          updatedAt: now,
        });
      } else {
        const data = doc.data();
        const existing = data.sources?.[source] || { reads: 0, invocations: 0 };
        tx.update(ref, {
          [`sources.${source}.reads`]: (existing.reads || 0) + count,
          [`sources.${source}.invocations`]: (existing.invocations || 0) + 1,
          [`sources.${source}.lastSeen`]: now,
          updatedAt: now,
        });
      }
    });
  } catch (err) {
    // Non-fatal — logging should never break the system
  }
}

module.exports = { logRead };
