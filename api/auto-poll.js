/**
 * /api/auto-poll — RETIRED
 *
 * This endpoint is no longer used. File detection is handled entirely by:
 *   1. Make.com Watch Files → POST /api/scan-now  (primary trigger)
 *   2. file-page.js → POST /api/scan-now           (after each file completes)
 *
 * The Vercel every-minute cron that used to call this has also been removed.
 * This file is kept as a stub to prevent 404 errors from any lingering references.
 *
 * Firestore reads eliminated by retiring this:
 *   - autoPollLock reads:     ~176/hour → 0
 *   - batchGetRecords polls:  ~24/hour  → 0
 *   Total savings: ~200 reads/hour = ~4,800 reads/day = ~144,000 reads/month
 */

module.exports = async function handler(req, res) {
  return res.status(200).json({
    status: 'retired',
    message: 'auto-poll is no longer used. Detection is handled by Make.com Watch Files.',
  });
};
