/**
 * /api/scan-cron — RETIRED
 *
 * The every-minute Vercel cron has been removed from vercel.json.
 * scan-now is now triggered only by Make.com and file-page (event-driven).
 *
 * This stub is kept to prevent 404 errors from any lingering references.
 */

module.exports = async function handler(req, res) {
  return res.status(200).json({
    status: 'retired',
    message: 'scan-cron is no longer used. Use Make.com Watch Files to trigger scan-now.',
  });
};
