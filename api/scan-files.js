/**
 * /api/scan-files
 *
 * Lists all PDF files currently in the OneDrive Scans folder.
 * Used by the test dashboard to populate the file browser.
 *
 * GET /api/scan-files
 * Returns: { files: [{ id, name, size, createdAt, webUrl }] }
 */

const { requireAuth } = require('../lib/auth');
const { graphRequest } = require('../lib/graph');

module.exports = async function handler(req, res) {
  if (!requireAuth(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const userId = process.env.ONEDRIVE_USER_ID;

    // Build correct Graph API path for listing folder children
    // Format: /users/{id}/drive/root:/{folder path}:/children
    const folderPath = encodeURIComponent('Grove Group Scotland/Grove Bedding/Scans').replace(/%2F/g, '/');

    const result = await graphRequest(
      'GET',
      `/users/${userId}/drive/root:/${folderPath}:/children?$select=id,name,size,createdDateTime,webUrl,file`
    );

    const items = result?.value || [];

    // Filter to PDFs only
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
    console.error('[scan-files] Error:', err.response?.data || err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
