/**
 * /api/scan-files
 *
 * Lists all PDF files currently in the OneDrive Scans folder.
 */

const { requireAuth } = require('../lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (!requireAuth(req, res)) return;
  } catch (authErr) {
    return res.status(500).json({
      success: false,
      error: 'Auth middleware failed',
      detail: authErr.message,
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check required env vars
  const userId = process.env.ONEDRIVE_USER_ID;
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  const missing = [];
  if (!userId) missing.push('ONEDRIVE_USER_ID');
  if (!tenantId) missing.push('MICROSOFT_TENANT_ID');
  if (!clientId) missing.push('MICROSOFT_CLIENT_ID');
  if (!clientSecret) missing.push('MICROSOFT_CLIENT_SECRET');

  if (missing.length > 0) {
    return res.status(500).json({
      success: false,
      error: `Missing environment variables: ${missing.join(', ')}`,
    });
  }

  try {
    const { graphRequest } = require('../lib/graph');

    const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
    const apiPath = `/users/${userId}/drive/root:/${folderPath}:/children?$select=id,name,size,createdDateTime,webUrl,file`;

    // Return the full API path so we can verify it looks correct
    console.log('[scan-files] Calling Graph API:', apiPath);

    const result = await graphRequest('GET', apiPath);
    const items = result?.value || [];

    const pdfFiles = items
      .filter((item) => {
        const name = (item.name || '').toLowerCase();
        const mime = item.file?.mimeType || '';
        return name.endsWith('.pdf') || mime.includes('pdf');
      })
      .map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        sizeFormatted: formatBytes(item.size),
        createdAt: item.createdDateTime,
        webUrl: item.webUrl,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      success: true,
      count: pdfFiles.length,
      files: pdfFiles,
    });

  } catch (err) {
    const graphError = err.response?.data?.error;
    const statusCode = err.response?.status;
    const graphMessage = err.response?.data;

    console.error('[scan-files] Graph API error:', JSON.stringify(graphMessage));

    return res.status(500).json({
      success: false,
      error: err.message,
      httpStatus: statusCode || null,
      graphErrorCode: graphError?.code || null,
      graphErrorMessage: graphError?.message || null,
      fullGraphResponse: graphMessage || null,
      userId: process.env.ONEDRIVE_USER_ID || 'NOT SET',
      folderPathUsed: `Grove Group Scotland/Grove Bedding/Scans`,
      fullApiPath: `/users/${process.env.ONEDRIVE_USER_ID}/drive/root:/Grove Group Scotland/Grove Bedding/Scans:/children`,
    });
  }
};

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
