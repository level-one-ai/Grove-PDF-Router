/**
 * /api/admin
 * Consolidates: mode, control, waiting, reset, ping, diagnose
 * Reduces serverless function count to stay within Vercel Hobby limit.
 *
 * Routes via ?action= query param:
 *   GET  ?action=ping          - health check
 *   GET  ?action=mode          - get current mode
 *   POST ?action=mode          - set mode { mode: 'auto'|'human' }
 *   GET  ?action=control       - get stop state
 *   POST ?action=control       - stop/resume { action: 'stop'|'resume' }
 *   GET  ?action=waiting       - get waiting files
 *   POST ?action=reset         - reset a file { fileId }
 */

const db = require('../lib/firebase');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const action = req.query.action;

  // ── PING ──
  if (action === 'ping') {
    return res.status(200).json({
      ok: true,
      time: new Date().toISOString(),
      env: {
        hasTenant: !!process.env.MICROSOFT_TENANT_ID,
        hasClient: !!process.env.MICROSOFT_CLIENT_ID,
        hasFirebase: !!process.env.FIREBASE_PROJECT_ID,
        hasOneDriveUser: !!process.env.ONEDRIVE_USER_ID,
        hasDashboardUser: !!process.env.DASHBOARD_USERNAME,
        hasCallbackSecret: !!process.env.CALLBACK_SECRET,
      }
    });
  }

  // ── MODE ──
  if (action === 'mode') {
    if (req.method === 'GET') {
      // Always auto — unified mode
      return res.status(200).json({ success: true, mode: 'auto' });
    }
    if (req.method === 'POST') {
      // System is always in unified auto-watch mode.
      // Accept mode param for backward compat but always store and return 'auto'.
      try {
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
        await admin.firestore().collection('settings').doc('processingMode').set({
          mode: 'auto', updatedAt: new Date().toISOString()
        });
        // Always trigger scan-now + auto-poll on startup
        const axios = require('axios');
        const baseUrl = process.env.WEBHOOK_NOTIFICATION_URL || 'https://grove-pdf-router.vercel.app';
        axios.post(`${baseUrl}/api/scan-now`, {}, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        }).catch(err => console.warn('[admin] scan-now trigger warning:', err.message));
        axios.post(`${baseUrl}/api/auto-poll`, {}, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000,
        }).catch(err => console.warn('[admin] auto-poll trigger warning:', err.message));
        console.log('[admin] Triggered scan-now + auto-poll');
        return res.status(200).json({ success: true, mode: 'auto' });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    }
  }

  // ── CONTROL (stop/resume) ──
  if (action === 'control') {
    if (req.method === 'GET') {
      try {
        const stopped = await db.isAutoStopped();
        return res.status(200).json({ success: true, stopped });
      } catch (err) {
        return res.status(200).json({ success: true, stopped: false });
      }
    }
    if (req.method === 'POST') {
      const { action: act } = req.body || {};
      if (!['stop', 'resume'].includes(act)) {
        return res.status(400).json({ error: 'action must be stop or resume' });
      }
      try {
        await db.setAutoStopped(act === 'stop');
        return res.status(200).json({ success: true, stopped: act === 'stop' });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    }
  }

  // ── WAITING FILES ──
  if (action === 'waiting') {
    try {
      const files = await db.getWaitingFiles();
      return res.status(200).json({ success: true, files });
    } catch (err) {
      return res.status(200).json({ success: true, files: [] });
    }
  }

  // ── RESET ──
  if (action === 'reset' && req.method === 'POST') {
    const { fileId } = req.body || {};
    if (!fileId) return res.status(400).json({ error: 'fileId required' });
    try {
      const existing = await db.getRecord(fileId);
      if (!existing) {
        return res.status(200).json({ success: true, message: 'No record found' });
      }
      await db.updateRecord(fileId, {
        status: 'reset', pagesReturned: 0, totalPages: null,
        pages: {}, renamedFiles: [], pageStore: {}, completedAt: null, error: null,
        resetAt: new Date().toISOString(),
      });
      return res.status(200).json({ success: true, message: 'Reset complete' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use ?action=ping|mode|control|waiting|reset' });
};
