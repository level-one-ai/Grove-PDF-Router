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
      t('Cin7: Matching fields available', true,
        `reference: ${result.relevantFields?.reference ?? 'null'} | ` +
        `company: ${result.relevantFields?.company ?? 'null'} | ` +
        `deliveryCompany: ${result.relevantFields?.deliveryCompany ?? 'null'} | ` +
        `firstName: ${result.relevantFields?.firstName ?? 'null'} | ` +
        `lastName: ${result.relevantFields?.lastName ?? 'null'}`
      );
      t('Cin7: All fields on first order', true,
        (result.sampleFields || []).join(', ')
      );
    } else {
      t('Cin7: API connection', false, result.error || 'Unknown error');
    }
  } catch (err) {
    t('Cin7: API connection', false, err.message);
  }

  const allOk = results.every(r => r.ok);
  return res.status(200).json({
    ok: allOk,
    summary: allOk ? 'All checks passed' : 'One or more checks failed',
    results,
  });
};
