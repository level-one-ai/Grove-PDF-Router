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

  const response = await axios(config);
  return response.data;
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

// Upload a file to a specific OneDrive folder path
// folderPath should be just the path after drive/root:/ e.g. 'Grove Group Scotland/Grove Bedding/Scans/Processed'
async function uploadFile(folderPath, fileName, fileBuffer) {
  const token = await getAccessToken();
  const userId = process.env.ONEDRIVE_USER_ID;
  // Strip leading 'drive/root:/' if present for consistency
  const cleanPath = folderPath.replace(/^/drive/root://, '').replace(/^drive/root://, '');
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${cleanPath}/${fileName}:/content`;

  const response = await axios.put(url, fileBuffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
  });

  return response.data;
}

// Get file metadata by itemId
async function getFileMetadata(itemId) {
  const userId = process.env.ONEDRIVE_USER_ID;
  return await graphRequest('GET', `/users/${userId}/drive/items/${itemId}`);
}

// Create a Graph API subscription for folder changes
async function createSubscription(notificationUrl) {
  const userId = process.env.ONEDRIVE_USER_ID;
  const watchFolder = process.env.ONEDRIVE_WATCH_FOLDER;

  const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  return await graphRequest('POST', '/subscriptions', {
    changeType: 'created',
    notificationUrl: `${notificationUrl}/api/webhook`,
    resource: `/users/${userId}/drive/root:/Grove Group Scotland/Grove Bedding/Scans`,
    expirationDateTime: expiry,
    clientState: process.env.CALLBACK_SECRET,
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
