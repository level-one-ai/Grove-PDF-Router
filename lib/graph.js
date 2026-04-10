const axios = require('axios');

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.token;
  }

  const url = `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  tokenCache = {
    token: response.data.access_token,
    expiresAt: Date.now() + response.data.expires_in * 1000,
  };

  return tokenCache.token;
}

async function graphRequest(method, path, data = null, responseType = 'json') {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;

  const config = {
    method,
    url,
    headers: { Authorization: `Bearer ${token}` },
    responseType,
  };

  if (data) {
    if (Buffer.isBuffer(data)) {
      config.data = data;
      config.headers['Content-Type'] = 'application/octet-stream';
    } else {
      config.data = data;
      config.headers['Content-Type'] = 'application/json';
    }
  }

  try {
    const response = await axios(config);
    return response.data;
  } catch (err) {
    // Attach full Graph API error detail to the thrown error
    if (err.response?.data) {
      const graphErr = err.response.data.error || err.response.data;
      err.graphError = graphErr;
      err.graphMessage = graphErr.message || JSON.stringify(graphErr);
      err.graphCode = graphErr.code;
    }
    throw err;
  }
}

// Download a file from OneDrive by itemId
async function downloadFile(itemId) {
  const token = await getAccessToken();
  const userId = process.env.ONEDRIVE_USER_ID;
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/items/${itemId}/content`;

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
  });

  return Buffer.from(response.data);
}

// Upload a file to OneDrive
async function uploadFile(folderPath, fileName, fileBuffer) {
  const token = await getAccessToken();
  const userId = process.env.ONEDRIVE_USER_ID;
  const cleanPath = folderPath.replace(/^\//, '');
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${cleanPath}/${encodeURIComponent(fileName)}:/content`;

  console.log(`[graph] Uploading "${fileName}" to ${cleanPath} (${fileBuffer ? fileBuffer.length : 0} bytes)`);

  const response = await axios.put(url, fileBuffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 60000,
  });

  console.log(`[graph] Upload OK: "${fileName}" → id: ${response.data?.id}`);
  return response.data;
}

// Get file metadata by itemId
async function getFileMetadata(itemId) {
  const userId = process.env.ONEDRIVE_USER_ID;
  return await graphRequest('GET', `/users/${userId}/drive/items/${itemId}`);
}

// Create a Graph API subscription for folder changes
// For OneDrive for Business (SharePoint), the supported resource is the drive root
async function createSubscription(notificationUrl) {
  const userId = process.env.ONEDRIVE_USER_ID;

  // OneDrive for Business max subscription expiry is 4230 minutes (~3 days)
  const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  // For SharePoint/OneDrive for Business accounts the correct resource
  // is /users/{id}/drive/root — not a specific folder item
  return await graphRequest('POST', '/subscriptions', {
    changeType: 'created,updated',
    notificationUrl: `${notificationUrl}/api/webhook`,
    resource: `/users/${userId}/drive/root`,
    expirationDateTime: expiry,
    clientState: process.env.CALLBACK_SECRET || 'grove-pdf-router-secret',
  });
}

// Renew an existing subscription
async function renewSubscription(subscriptionId) {
  const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  return await graphRequest('PATCH', `/subscriptions/${subscriptionId}`, {
    expirationDateTime: expiry,
  });
}

// Get a shareable link for a OneDrive item
async function getShareableLink(itemId) {
  const userId = process.env.ONEDRIVE_USER_ID;
  const result = await graphRequest(
    'POST',
    `/users/${userId}/drive/items/${itemId}/createLink`,
    { type: 'view', scope: 'organization' }
  );
  return result?.link?.webUrl || null;
}

module.exports = {
  downloadFile,
  uploadFile,
  getFileMetadata,
  createSubscription,
  renewSubscription,
  getShareableLink,
  graphRequest,
};
