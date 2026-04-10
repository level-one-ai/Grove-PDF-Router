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
async function saveSubscription(subscriptionId, expiresAt, notificationUrl, changeType = 'created,updated') {
  const db = getFirestore();
  const renewAt = calculateRenewalTime(expiresAt);
  console.log(`[subscription] Saved. Expires: ${expiresAt} | Renewal scheduled: ${renewAt} | changeType: ${changeType}`);
  await db.collection(COLLECTION).doc(DOC_ID).set({
    subscriptionId,
    expiresAt,
    renewAt,
    notificationUrl,
    changeType,
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
  const renewAt = calculateRenewalTime(expiresAt);
  console.log(`[subscription] Renewed. Expires: ${expiresAt} | Next renewal scheduled: ${renewAt}`);
  await db.collection(COLLECTION).doc(DOC_ID).update({
    subscriptionId,
    expiresAt,
    renewAt,
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
 * Returns true if expiry is within 1 hour or already passed.
 * Cron runs every hour so this ensures renewal always happens in time.
 */
function needsRenewal(subscription) {
  if (!subscription || !subscription.expiresAt) return true;
  const expiresAt = new Date(subscription.expiresAt);
  const now = new Date();
  const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
  return hoursUntilExpiry < 1;
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

  if (hoursLeft < 2) {
    return {
      status: 'expiring',
      message: `Expiring in ${hoursLeft < 1 ? 'less than 1 hour' : hoursLeft + ' hour'} — renewing now`,
      colour: 'yellow',
    };
  }

  return {
    status: 'active',
    message: `Active — expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    colour: 'green',
  };
}

/**
 * Calculate the exact time the subscription should be renewed.
 * Set to 1 hour before expiry.
 * Returns an ISO string.
 */
function calculateRenewalTime(expiresAt) {
  const expiry = new Date(expiresAt);
  const renewAt = new Date(expiry.getTime() - 60 * 60 * 1000); // 1 hour before expiry
  return renewAt.toISOString();
}

/**
 * Check if it is time to renew based on the stored renewAt timestamp.
 * Returns true only if current time has passed the renewAt time.
 * This prevents the cron from renewing too early.
 */
function isTimeToRenew(subscription) {
  if (!subscription || !subscription.expiresAt) return true;
  // If no renewAt stored, fall back to 1-hour threshold
  if (!subscription.renewAt) {
    const hoursLeft = (new Date(subscription.expiresAt) - new Date()) / (1000 * 60 * 60);
    return hoursLeft < 1;
  }
  // Renew only if we've passed the scheduled renewal time
  return new Date() >= new Date(subscription.renewAt);
}

module.exports = {
  saveSubscription,
  updateSubscriptionAfterRenewal,
  getSubscription,
  markExpired,
  needsRenewal,
  isActive,
  isTimeToRenew,
  calculateRenewalTime,
  getStatusSummary,
};
