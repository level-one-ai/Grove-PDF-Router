/**
 * /api/control
 * Stop or resume auto processing.
 * POST { action: 'stop' | 'resume' }
 * GET → returns current stopped state
 */
const { requireApiAuth } = require('../lib/auth');
const db = require('../lib/firebase');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!requireApiAuth(req, res)) return;

  if (req.method === 'GET') {
    try {
      const stopped = await db.isAutoStopped();
      return res.status(200).json({ success: true, stopped });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { action } = req.body;
    if (!['stop', 'resume'].includes(action)) {
      return res.status(400).json({ error: 'action must be stop or resume' });
    }
    try {
      await db.setAutoStopped(action === 'stop');
      console.log(`[control] Auto processing ${action}ped`);
      return res.status(200).json({ success: true, stopped: action === 'stop' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
