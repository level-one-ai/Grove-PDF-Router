/**
 * /api/scan-cron
 *
 * Runs every minute via Vercel cron.
 * Simply calls scan-now which scans OneDrive and processes any new files.
 * No Firestore reads — scan-now handles all state.
 *
 * auto-poll has been retired. Detection is handled by:
 *   1. Make.com Watch Files → POST /api/scan-now (on new file)
 *   2. This cron → GET /api/scan-now (every minute as backup)
 *
 * Schedule: every minute ("* * * * *" in vercel.json)
 */

const axios = require('axios');

module.exports.config = { maxDuration: 30 };

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorised' });
    }
  }

  const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';

  try {
    await axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
  } catch (err) {
    // scan-now responds 200 immediately and processes async, timeout is expected
  }

  return res.status(200).json({ ok: true, at: new Date().toISOString() });
};
