/**
 * /api/waiting
 * Returns files currently waiting for human approval.
 */
const { requireAuth } = require('../lib/auth');
const db = require('../lib/firebase');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const files = await db.getWaitingFiles();
    return res.status(200).json({ success: true, files });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
