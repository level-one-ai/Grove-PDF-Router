/**
 * /api/subscribe
 *
 * Handles two things:
 * 1. GET /api/subscribe?action=create  — creates a new Graph API webhook subscription
 * 2. GET /api/subscribe?action=renew&subscriptionId=xxx — renews an existing subscription
 *
 * Also handles the Microsoft Graph validation token handshake automatically
 * when Graph API sends a POST with validationToken query param.
 */

const { createSubscription, renewSubscription } = require('../lib/graph');

module.exports = async function handler(req, res) {
  // -------------------------------------------------------
  // Microsoft Graph Validation Token Handshake
  // Graph API sends this POST to verify your endpoint exists
  // Must respond with the token as plain text within 10 seconds
  // -------------------------------------------------------
  if (req.method === 'POST' && req.query.validationToken) {
    console.log('[subscribe] Validation token handshake received');
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }

  // -------------------------------------------------------
  // Create a new subscription
  // -------------------------------------------------------
  if (req.method === 'GET' && req.query.action === 'create') {
    try {
      const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;
      const subscription = await createSubscription(notificationUrl);

      console.log('[subscribe] Subscription created:', subscription.id);
      return res.status(200).json({
        success: true,
        subscriptionId: subscription.id,
        expiresAt: subscription.expirationDateTime,
        message: 'Subscription created. Save the subscriptionId to renew before expiry.',
      });
    } catch (err) {
      console.error('[subscribe] Create error:', err.response?.data || err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // -------------------------------------------------------
  // Renew an existing subscription
  // -------------------------------------------------------
  if (req.method === 'GET' && req.query.action === 'renew') {
    const { subscriptionId } = req.query;
    if (!subscriptionId) {
      return res.status(400).json({ error: 'subscriptionId query param required' });
    }

    try {
      const updated = await renewSubscription(subscriptionId);
      console.log('[subscribe] Subscription renewed:', subscriptionId);
      return res.status(200).json({
        success: true,
        subscriptionId: updated.id,
        expiresAt: updated.expirationDateTime,
      });
    } catch (err) {
      console.error('[subscribe] Renew error:', err.response?.data || err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
