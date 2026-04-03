/**
 * /api/diag
 * Diagnostic endpoint — tests each step of the OneDrive connection chain.
 * Visit /api/diag in your browser to see exactly where the failure is.
 * DELETE THIS FILE once the issue is resolved.
 */

module.exports.config = { maxDuration: 30 };

module.exports = async function handler(req, res) {
  const results = [];
  const t = (label, ok, detail) => results.push({ label, ok, detail });

  // Step 1 — Env vars
  const userId   = process.env.ONEDRIVE_USER_ID;
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const secret   = process.env.MICROSOFT_CLIENT_SECRET;

  t('ONEDRIVE_USER_ID set',        !!userId,   userId   ? userId.slice(0,8)+'...'   : 'MISSING');
  t('MICROSOFT_TENANT_ID set',     !!tenantId, tenantId ? tenantId.slice(0,8)+'...' : 'MISSING');
  t('MICROSOFT_CLIENT_ID set',     !!clientId, clientId ? clientId.slice(0,8)+'...' : 'MISSING');
  t('MICROSOFT_CLIENT_SECRET set', !!secret,   secret   ? '(present)'               : 'MISSING');

  if (!userId || !tenantId || !clientId || !secret) {
    return respond(res, results, 'Env vars missing — cannot continue');
  }

  // Step 2 — Token fetch
  let token;
  try {
    const axios = require('axios');
    const start = Date.now();
    const r = await axios.post(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    token = r.data.access_token;
    t('Token fetch', true, `OK in ${Date.now()-start}ms — expires_in: ${r.data.expires_in}s`);
  } catch (err) {
    t('Token fetch', false, err.response?.data?.error_description || err.message);
    return respond(res, results, 'Token fetch failed — cannot continue');
  }

  // Step 3 — Graph API: list Scans folder
  try {
    const axios = require('axios');
    const folderPath = 'Grove Group Scotland/Grove Bedding/Scans';
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}:/children?$select=id,name,file,createdDateTime&$top=10`;
    const start = Date.now();
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    const items = r.data?.value || [];
    const pdfs = items.filter(i => (i.name||'').toLowerCase().endsWith('.pdf') || (i.file?.mimeType||'').includes('pdf'));
    t('Graph: list Scans folder', true, `OK in ${Date.now()-start}ms — ${items.length} item(s), ${pdfs.length} PDF(s). First: ${pdfs[0]?.name || '(none)'}`);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data?.error?.code || err.message;
    t('Graph: list Scans folder', false, detail);
  }

  // Step 4 — Graph API: list Processed folder
  try {
    const axios = require('axios');
    const folderPath = 'Grove Group Scotland/Grove Bedding/Scans/Processed';
    const url = `https://graph.microsoft.com/v1.0/users/${userId}/drive/root:/${folderPath}:/children?$select=id,name,file,createdDateTime&$top=10`;
    const start = Date.now();
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    const items = r.data?.value || [];
    const pdfs = items.filter(i => (i.name||'').toLowerCase().endsWith('.pdf') || (i.file?.mimeType||'').includes('pdf'));
    t('Graph: list Processed folder', true, `OK in ${Date.now()-start}ms — ${items.length} item(s), ${pdfs.length} PDF(s). First: ${pdfs[0]?.name || '(none)'}`);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data?.error?.code || err.message;
    t('Graph: list Processed folder', false, detail);
  }

  // Step 5 — Test via graphRequest (the helper scan-files.js actually uses)
  try {
    const { graphRequest } = require('../lib/graph');
    const userId2 = process.env.ONEDRIVE_USER_ID;
    const apiPath = `/users/${userId2}/drive/root:/Grove Group Scotland/Grove Bedding/Scans:/children?$select=id,name,file&$top=5`;
    const start = Date.now();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out after 8s')), 8000));
    const result = await Promise.race([graphRequest('GET', apiPath), timeoutPromise]);
    t('graphRequest() helper', true, `OK in ${Date.now()-start}ms — ${result?.value?.length ?? 0} item(s)`);
  } catch (err) {
    t('graphRequest() helper', false, err.message);
  }

  return respond(res, results, 'Done', req.query.format === 'json');
};

function respond(res, results, summary, asJson = false) {
  const allOk = results.every(r => r.ok);
  if (asJson) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({ ok: allOk, summary, results });
  }
  const html = `<!DOCTYPE html><html><head><title>Grove Diag</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#f0f0f0;padding:32px;max-width:800px}
  h1{font-size:18px;color:#f59e0b;margin-bottom:24px}
  .row{display:flex;gap:12px;align-items:flex-start;padding:10px 14px;border-radius:8px;margin-bottom:8px;background:#1a1a1a;border:1px solid #2e2e2e}
  .ok{border-color:#22c55e33;background:#0a180a}.fail{border-color:#ef444433;background:#1f0f0f}
  .ic{font-size:16px;flex-shrink:0;margin-top:1px}
  .label{font-size:13px;font-weight:600;min-width:220px;flex-shrink:0}
  .detail{font-size:12px;color:#888;word-break:break-all}
  .ok .detail{color:#4ade80}.fail .detail{color:#f87171}
  .summary{margin-top:24px;padding:12px 16px;border-radius:8px;font-size:13px;font-weight:600;background:#1a1a1a;border:1px solid #3a3a3a}
</style></head><body>
<h1>🔧 Grove PDF Router — Diagnostics</h1>
${results.map(r => `
  <div class="row ${r.ok?'ok':'fail'}">
    <div class="ic">${r.ok?'✅':'❌'}</div>
    <div class="label">${r.label}</div>
    <div class="detail">${r.detail}</div>
  </div>`).join('')}
<div class="summary">${summary} — ${allOk ? '✅ All checks passed' : '❌ One or more checks failed'}</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
}
