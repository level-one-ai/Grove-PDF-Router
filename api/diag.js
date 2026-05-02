/**
 * /api/diag
 *
 * Diagnostic endpoint — tests OneDrive and Cin7 connections.
 * Called by the Grove Bedding Dashboard PDF Router page.
 *
 * Always returns JSON: { ok, summary, results }
 */

module.exports.config = { maxDuration: 30 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = [];
  const t = (label, ok, detail) => results.push({ label, ok, detail });

  // ── Step 1 — Microsoft env vars ───────────────────────────────────────────
  const userId   = process.env.ONEDRIVE_USER_ID;
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const secret   = process.env.MICROSOFT_CLIENT_SECRET;

  t('ONEDRIVE_USER_ID set',        !!userId,   userId   ? userId.slice(0,8)+'...'   : 'MISSING');
  t('MICROSOFT_TENANT_ID set',     !!tenantId, tenantId ? tenantId.slice(0,8)+'...' : 'MISSING');
  t('MICROSOFT_CLIENT_ID set',     !!clientId, clientId ? clientId.slice(0,8)+'...' : 'MISSING');
  t('MICROSOFT_CLIENT_SECRET set', !!secret,   secret   ? '(present)'               : 'MISSING');

  // ── Step 2 — Cin7 env vars ────────────────────────────────────────────────
  const cin7User = process.env.CIN7_API_USERNAME;
  const cin7Key  = process.env.CIN7_API_KEY;

  t('CIN7_API_USERNAME set', !!cin7User, cin7User ? cin7User : 'MISSING');
  t('CIN7_API_KEY set',      !!cin7Key,  cin7Key  ? '(present)' : 'MISSING');

  if (!userId || !tenantId || !clientId || !secret) {
    return res.status(200).json({
      ok: false,
      summary: 'Microsoft env vars missing — cannot test OneDrive',
      results,
    });
  }

  // ── Step 3 — Microsoft token ──────────────────────────────────────────────
  let token;
  try {
    const axios = require('axios');
    const start = Date.now();
    const r = await axios.post(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     clientId,
        client_secret: secret,
        scope:         'https://graph.microsoft.com/.default',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    token = r.data.access_token;
    t('Microsoft token fetch', true, `OK in ${Date.now()-start}ms — expires in ${r.data.expires_in}s`);
  } catch (err) {
    t('Microsoft token fetch', false, err.response?.data?.error_description || err.message);
    return res.status(200).json({
      ok: false,
      summary: 'Microsoft token fetch failed',
      results,
    });
  }

  // ── Step 4 — OneDrive: Scans folder ──────────────────────────────────────
  try {
    const axios = require('axios');
    const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}:/children?$select=id,name,file,createdDateTime&$top=10`;
    const start = Date.now();
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
    const items = r.data?.value || [];
    const pdfs = items.filter(i => (i.name||'').toLowerCase().endsWith('.pdf') || (i.file?.mimeType||'').includes('pdf'));
    t('OneDrive: Scans folder', true, `OK in ${Date.now()-start}ms — ${items.length} item(s), ${pdfs.length} PDF(s)${pdfs[0] ? `. First: ${pdfs[0].name}` : ''}`);
  } catch (err) {
    t('OneDrive: Scans folder', false, err.response?.data?.error?.message || err.message);
  }

  // ── Step 5 — OneDrive: Processed folder ──────────────────────────────────
  try {
    const axios = require('axios');
    const folderPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}:/children?$select=id,name,file,createdDateTime&$top=5`;
    const start = Date.now();
    const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 });
    const items = r.data?.value || [];
    t('OneDrive: Processed folder', true, `OK in ${Date.now()-start}ms — ${items.length} item(s)`);
  } catch (err) {
    t('OneDrive: Processed folder', false, err.response?.data?.error?.message || err.message);
  }

  // ── Step 6 — Cin7 connection test ─────────────────────────────────────────
  try {
    const { testCin7Connection } = require('../lib/cin7');
    const result = await testCin7Connection();

    if (result.ok) {
      t('Cin7: API connection', true,
        `${result.message} | Stages in sample: ${(result.stages || []).join(', ')}`
      );

      // Matching fields on a sample order
      const f = result.relevantFields || {};
      t('Cin7: Name fields available', true,
        `company: ${f.company ?? '(null)'} | ` +
        `deliveryCompany: ${f.deliveryCompany ?? '(null)'} | ` +
        `firstName: ${f.firstName ?? '(null)'} | ` +
        `lastName: ${f.lastName ?? '(null)'}`
      );
      t('Cin7: Confirmation fields available', true,
        `reference: ${f.reference ?? '(null)'} | ` +
        `deliveryPostalCode: ${f.deliveryPostalCode ?? '(null)'} | ` +
        `billingPostalCode: ${f.billingPostalCode ?? '(null)'} | ` +
        `mobile: ${f.mobile ?? '(null)'} | ` +
        `phone: ${f.phone ?? '(null)'}`
      );
      t('Cin7: All fields on first order', true,
        (result.sampleFields || []).join(', ')
      );

      // Specific order lookup — JTAI20130-1 (Jim Tait test order from scan4166.pdf)
      if (result.specificOrder) {
        const s = result.specificOrder;
        t('Cin7: Specific order JTAI20130-1 found', true,
          `id: ${s.id} | stage: ${s.stage} | ` +
          `name: ${s.firstName || ''} ${s.lastName || ''} | ` +
          `company: ${s.company ?? '(null)'} | ` +
          `deliveryPostalCode: ${s.deliveryPostalCode ?? '(null)'} | ` +
          `mobile: ${s.mobile ?? '(null)'} | ` +
          `phone: ${s.phone ?? '(null)'} | ` +
          `ETD: ${s.estimatedDeliveryDate ?? '(null)'}`
        );
      } else {
        t('Cin7: Specific order JTAI20130-1',
          false,
          result.specificOrderError
            ? `Lookup error: ${result.specificOrderError}`
            : 'Order JTAI20130-1 not found in first 250 orders — it may be completed/archived or the ref format differs'
        );
      }

    } else {
      t('Cin7: API connection', false, result.error || 'Unknown error');
    }
  } catch (err) {
    t('Cin7: API connection', false, err.message);
  }

  // ── Step 7 — Google Drive OAuth test ─────────────────────────────────────
  const hasOAuth = !!(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
  const hasServiceAccount = !!(
    process.env.GOOGLE_CLIENT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  );

  t('Google Drive: credentials configured',
    hasOAuth || hasServiceAccount,
    hasOAuth          ? 'OAuth credentials present'
    : hasServiceAccount ? 'Service account credentials present'
    : 'MISSING — set GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN or GOOGLE_CLIENT_EMAIL/PRIVATE_KEY'
  );

  if (hasOAuth || hasServiceAccount) {
    try {
      const { google } = require('googleapis');
      const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

      t('GOOGLE_DRIVE_ROOT_FOLDER_ID set',
        !!rootFolderId,
        rootFolderId ? rootFolderId.slice(0, 12) + '...' : 'MISSING'
      );

      // Build auth client
      let auth;
      if (hasOAuth) {
        const oauthClient = new google.auth.OAuth2(
          process.env.GOOGLE_OAUTH_CLIENT_ID,
          process.env.GOOGLE_OAUTH_CLIENT_SECRET
        );
        oauthClient.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
        auth = oauthClient;
      } else {
        let key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
        auth = new google.auth.GoogleAuth({
          credentials: { client_email: process.env.GOOGLE_CLIENT_EMAIL, private_key: key },
          scopes: ['https://www.googleapis.com/auth/drive'],
        });
      }

      const drive = google.drive({ version: 'v3', auth });
      const start = Date.now();

      if (rootFolderId) {
        // Try to list up to 3 folders inside the root Drive folder
        const res = await drive.files.list({
          q: `'${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id, name)',
          pageSize: 3,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        const folders = res.data.files || [];
        t('Google Drive: root folder accessible',
          true,
          `OK in ${Date.now()-start}ms — ${folders.length} subfolder(s) found${folders[0] ? `. First: "${folders[0].name}"` : ''}`
        );
      } else {
        // No root folder ID — just test that we can call the API at all
        const res = await drive.about.get({ fields: 'user' });
        t('Google Drive: API reachable',
          true,
          `OK in ${Date.now()-start}ms — logged in as ${res.data.user?.emailAddress || 'unknown'}`
        );
      }
    } catch (err) {
      const isInvalidGrant = err.message?.includes('invalid_grant') ||
                             err.response?.data?.error === 'invalid_grant';
      t('Google Drive: API connection',
        false,
        isInvalidGrant
          ? 'invalid_grant — OAuth refresh token has expired or been revoked. A new token must be generated.'
          : err.message?.slice(0, 200) || 'Unknown error'
      );
    }
  }

  const allOk = results.every(r => r.ok);
  return res.status(200).json({
    ok: allOk,
    summary: allOk ? 'All checks passed' : 'One or more checks failed',
    results,
  });
};
