/**
 * Subscription Manager
 *
 * Handles storing, retrieving, and checking the Microsoft Graph API
 * subscription state in Firestore.
 *
 * Firestore document: subscriptions/graphApi
 * Fields:
 *   subscriptionId  - the Graph API subscription ID
 *   expiresAt       - ISO timestamp of expiry
 *   createdAt       - ISO timestamp of creation
 *   renewedAt       - ISO timestamp of last renewal
 *   notificationUrl - the webhook URL registered
 *   status          - 'active' | 'expired' | 'unknown'
 */

const admin = require('firebase-admin');

let app;

function getFirestore() {
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

const COLLECTION = 'subscriptions';
const DOC_ID = 'graphApi';

/**
 * Save a new or renewed subscription to Firestore.
 */
async function saveSubscription(subscriptionId, expiresAt, notificationUrl) {
  const db = getFirestore();
  await db.collection(COLLECTION).doc(DOC_ID).set({
    subscriptionId,
    expiresAt,
    notificationUrl,
    status: 'active',
    createdAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
  });
}

/**
 * Update an existing subscription after renewal.
 */
async function updateSubscriptionAfterRenewal(subscriptionId, expiresAt) {
  const db = getFirestore();
  await db.collection(COLLECTION).doc(DOC_ID).update({
    subscriptionId,
    expiresAt,
    renewedAt: new Date().toISOString(),
    status: 'active',
  });
}

/**
 * Get the current subscription record from Firestore.
 * Returns null if no subscription exists.
 */
async function getSubscription() {
  const db = getFirestore();
  const doc = await db.collection(COLLECTION).doc(DOC_ID).get();
  return doc.exists ? doc.data() : null;
}

/**
 * Mark the subscription as expired in Firestore.
 */
async function markExpired() {
  const db = getFirestore();
  await db.collection(COLLECTION).doc(DOC_ID).update({
    status: 'expired',
  });
}

/**
 * Check if the current subscription needs renewal.
 * Returns true if expiry is within 24 hours or already passed.
 */
function needsRenewal(subscription) {
  if (!subscription || !subscription.expiresAt) return true;
  const expiresAt = new Date(subscription.expiresAt);
  const now = new Date();
  const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
  return hoursUntilExpiry < 24;
}

/**
 * Check if the subscription is currently active (not expired).
 */
function isActive(subscription) {
  if (!subscription || !subscription.expiresAt) return false;
  const expiresAt = new Date(subscription.expiresAt);
  return expiresAt > new Date();
}

/**
 * Get a human-readable status string for the dashboard.
 */
function getStatusSummary(subscription) {
  if (!subscription) {
    return { status: 'none', message: 'No subscription found', colour: 'red' };
  }

  if (!isActive(subscription)) {
    return { status: 'expired', message: 'Subscription has expired', colour: 'red' };
  }

  const expiresAt = new Date(subscription.expiresAt);
  const now = new Date();
  const hoursLeft = Math.floor((expiresAt - now) / (1000 * 60 * 60));
  const daysLeft = Math.floor(hoursLeft / 24);

  if (hoursLeft < 24) {
    return {
      status: 'expiring',
      message: `Expiring in ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} — renewing soon`,
      colour: 'yellow',
    };
  }

  return {
    status: 'active',
    message: `Active — expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    colour: 'green',
  };
}

module.exports = {
  saveSubscription,
  updateSubscriptionAfterRenewal,
  getSubscription,
  markExpired,
  needsRenewal,
  isActive,
  getStatusSummary,
};
