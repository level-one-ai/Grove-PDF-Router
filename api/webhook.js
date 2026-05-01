/**
 * /api/webhook
 *
 * Receives HTTP POST from Make.com when a new file lands in OneDrive Scans.
 * Also handles Microsoft Graph API change notification validation handshake.
 *
 * Responds immediately then triggers scan-now in background.
 * No dashboard calls — status is written to Firestore instead.
 */

const { graphRequest } = require('../lib/graph');
const { fileDetected } = require('../lib/statusWriter');
const axios = require('axios');

module.exports = async function handler(req, res) {
  // Microsoft Graph validation handshake
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[webhook] Validation token handshake');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Respond immediately — Make.com and Graph both require fast response
  try {
    res.status(202).json({ status: 'accepted' });
  } catch (connErr) {
    console.warn('[webhook] Could not send 202 (connection dropped early — harmless):', connErr.message);
  }

  try {
    // Handle both Make.com direct calls and Graph API notifications
    const notifications = req.body?.value || [];
    if (notifications.length) {
      const expectedSecret = process.env.CALLBACK_SECRET || 'grove-pdf-router-secret';
      const valid = notifications.find(n => n.clientState === expectedSecret);
      if (!valid) {
        console.warn('[webhook] Invalid clientState — ignoring');
        return;
      }
    }

    await scanAndProcess();
  } catch (err) {
    console.error('[webhook] Error:', err.message);
  }
};

async function scanAndProcess() {
  const userId  = process.env.ONEDRIVE_USER_ID;
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://grove-pdf-router.vercel.app';

  // List Scans folder to write status to Firestore
  let newFiles = [];
  try {
    const result = await graphRequest(
      'GET',
      `/users/${userId}/drive/root:/Grove Group Scotland/Grove Bedding/Scans:/children` +
      `?$select=id,name,size,createdDateTime,file&$top=100`
    );
    newFiles = (result?.value || [])
      .filter(item => {
        const name = (item.name || '').toLowerCase();
        const mime = item.file?.mimeType || '';
        return name.endsWith('.pdf') || mime.includes('pdf');
      })
      .sort((a, b) => new Date(b.createdDateTime) - new Date(a.createdDateTime));
    console.log(`[webhook] ${newFiles.length} PDF(s) in Scans`);
  } catch (err) {
    console.warn('[webhook] Could not list Scans (non-fatal):', err.message);
  }

  // Write detected files to Firestore — dashboard reads this
  for (const file of newFiles) {
    fileDetected(file.id, file.name, newFiles.length).catch(() => {});
  }

  // Trigger scan-now to do the actual processing
  try {
    await axios.post(`${baseUrl}/api/scan-now`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log('[webhook] Triggered scan-now');
  } catch (err) {
    console.warn('[webhook] scan-now trigger warning:', err.message);
  }
}
