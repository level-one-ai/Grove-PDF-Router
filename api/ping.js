/**
 * /api/ping - No auth, no dependencies, just returns OK
 * Used to test if Vercel functions are working at all
 */
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
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
};
