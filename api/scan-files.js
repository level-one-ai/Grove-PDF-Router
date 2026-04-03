/**
 * /api/scan-files
 * Lists PDFs in OneDrive Scans or Processed folder.
 * GET /api/scan-files            → Scans folder
 * GET /api/scan-files?folder=Processed → Processed folder
 *
 * Paginates through all Graph API results (max 200 per page).
 */

module.exports.config = {
  maxDuration: 30, // Vercel Pro allows up to 300s; 30s is plenty for paginated OneDrive listing
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

    // Support ?folder=Processed to list the Processed folder
    const folderParam = req.query.folder || '';
    let folderPath;
    if (folderParam === 'Processed') {
      folderPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    } else {
      folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
    }

    console.log('[scan-files] Fetching folder:', folderPath);

    // Paginate through all results — Graph API returns max 200 per page
    const TIMEOUT_MS = 8000; // Stay well under Vercel default 10s limit
    const deadline = Date.now() + TIMEOUT_MS;
    let allItems = [];
    let nextPath = `/users/${userId}/drive/root:/${folderPath}:/children?$select=id,name,size,createdDateTime,webUrl,file&$top=200`;

    while (nextPath) {
      if (Date.now() > deadline) {
        console.warn('[scan-files] Pagination timeout — returning partial results');
        break;
      }
      const page = await graphRequest('GET', nextPath);
      allItems = allItems.concat(page?.value || []);
      const nextLink = page?.['@odata.nextLink'];
      nextPath = nextLink ? nextLink.replace('https://graph.microsoft.com/v1.0', '') : null;
    }

    const pdfFiles = allItems
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

    console.log(`[scan-files] Found ${pdfFiles.length} PDF(s) in ${folderParam || 'Scans'}`);

    return res.status(200).json({
      success: true,
      count: pdfFiles.length,
      files: pdfFiles,
    });

  } catch (err) {
    const graphError = err.response?.data?.error;
    console.error('[scan-files] Error:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
      graphErrorCode: graphError?.code || null,
      graphErrorMessage: graphError?.message || null,
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
