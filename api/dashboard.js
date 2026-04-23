/**
 * /api/dashboard
 * Grove PDF Router — monitoring dashboard.
 *
 * Server fetches both OneDrive folders and injects raw JSON into the page.
 * Client JS renders everything. No server/client HTML mixing.
 * Zero Firestore reads.
 */

module.exports.config = { maxDuration: 30 };

async function fetchFolder(graphRequest, userId, folderPath) {
  const path = `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,size,createdDateTime,webUrl,file&$top=500`;
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('OneDrive timeout')), 20000));
  const result = await Promise.race([graphRequest('GET', path), timeout]);
  return (result?.value || [])
    .filter(f => {
      const n = (f.name || '').toLowerCase();
      return (n.endsWith('.pdf') || (f.file?.mimeType || '').includes('pdf')) && !n.startsWith('~');
    })
    .map(f => ({ id: f.id, name: f.name, size: f.size, createdAt: f.createdDateTime, webUrl: f.webUrl }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  // Files are loaded client-side via /api/scan-files on page load.
  // This avoids cold-start timeouts and ensures the dashboard always shows fresh data.

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grove PDF Router</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--or:#d97700;--orl:#f59e0b;--bg:#0a0a0a;--su:#1a1a1a;--s2:#242424;--bo:#2e2e2e;--tx:#f0f0f0;--mu:#888;--gn:#22c55e;--rd:#ef4444;--yl:#eab308}
body{background:var(--bg);color:var(--tx);font-family:system-ui,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{background:var(--su);border-bottom:1px solid var(--bo);padding:0 16px;height:52px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.logo{display:flex;align-items:center;gap:8px}
.li{width:28px;height:28px;background:var(--or);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px}
.lt{font-size:13px;font-weight:600}.ls{font-size:10px;color:var(--mu)}
.sub-row{display:flex;align-items:center;gap:7px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--mu)}
.dot.g{background:var(--gn);box-shadow:0 0 5px var(--gn)}
.sub-txt{font-size:11px;color:var(--mu)}
.main{display:grid;grid-template-columns:1fr 1fr 360px;flex:1;overflow:hidden}
.fcol{display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--bo)}
.fcol:last-child{border-right:none}
.fhead{padding:10px 14px;border-bottom:1px solid var(--bo);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;min-height:46px}
.fht{font-size:12px;font-weight:600}.fhm{font-size:11px;color:var(--mu)}
.rfbtn{background:none;border:1px solid var(--bo);color:var(--mu);padding:3px 8px;border-radius:5px;font-size:11px;cursor:pointer;transition:all .15s}
.rfbtn:hover{border-color:var(--or);color:var(--or)}
.pathbar{padding:5px 14px;background:var(--su);border-bottom:1px solid var(--bo);font-size:10px;color:var(--mu);flex-shrink:0}
.pathbar span{color:var(--or)}
.flist{overflow-y:auto;flex:1;padding:6px;min-height:0}
.flist::-webkit-scrollbar{width:4px}.flist::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
.fi{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;border:1px solid transparent;margin-bottom:3px;background:var(--su);cursor:pointer;transition:border-color .15s,background .15s}
.fi:hover{border-color:var(--bo)}
.fi.sel{border-color:var(--or)!important;background:#1f1500!important}
.fi.active{border-color:var(--or);background:#1f1500}
.fi.done{border-color:#22c55e22;background:#0a180a}
.fi.done:hover{border-color:#22c55e55}
.fic{width:30px;height:30px;background:#180f00;border:1px solid #3a2000;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}
.fi.done .fic{background:#0a180a;border-color:#22c55e33}
.fi.active .fic{background:#2a1800;border-color:#d9770055}
.fin{flex:1;min-width:0;pointer-events:none}
.fnm{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fmeta{font-size:10px;color:var(--mu);margin-top:1px}
.fac{display:flex;gap:3px;flex-shrink:0;pointer-events:none}
.stmsg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 16px;color:var(--mu);text-align:center;height:100%}
.stmsg .ic{font-size:26px}.stmsg .ti{font-size:12px;font-weight:500;color:var(--tx)}.stmsg .de{font-size:11px;line-height:1.5}
.rstbtn{background:none;border:1px solid var(--bo);color:var(--mu);width:20px;height:20px;border-radius:4px;cursor:pointer;font-size:10px;transition:all .15s;flex-shrink:0}
.rstbtn:hover{border-color:var(--rd);color:var(--rd)}
.run-panel{background:var(--su);border-top:2px solid var(--or);padding:10px 14px;flex-shrink:0;display:none}
.run-panel.show{display:block}
.run-fname{font-size:12px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.run-fmeta{font-size:10px;color:var(--mu);margin-bottom:8px}
.runbtn{width:100%;padding:9px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;border:none;background:var(--or);color:#fff;transition:background .15s}
.runbtn:hover{background:var(--orl)}
.runbtn:disabled{background:var(--s2);color:var(--mu);cursor:not-allowed}
.folder-tag{font-size:9px;padding:2px 5px;border-radius:4px;font-weight:600}
.folder-tag.od{background:#1a1a2f;color:#818cf8;border:1px solid #6366f133}
.proc-drop{display:none;padding:8px 10px;background:var(--s2);border-top:1px solid var(--bo)}
.proc-drop.open{display:block}
.pd-row{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:10px}
.pd-row:last-child{margin-bottom:0}
.pd-lbl{color:var(--mu);min-width:64px;flex-shrink:0}
.pd-val{color:var(--tx);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pd-link{color:var(--or);text-decoration:none}
.pd-link:hover{text-decoration:underline}
.gd-btn{background:none;border:1px solid #22c55e44;color:var(--gn);border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-weight:600}
.gd-btn:hover{background:#1a2f1a}.gd-btn:disabled{opacity:.5;cursor:not-allowed}
.gdpanel{border-top:1px solid var(--bo);flex-shrink:0;max-height:200px;display:none;flex-direction:column}
.gdpanel.open{display:flex}
.gdph{padding:7px 12px;border-bottom:1px solid var(--bo);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.gdph-title{font-size:11px;font-weight:600;color:var(--mu)}
.gdph-close{background:none;border:none;color:var(--mu);cursor:pointer;font-size:14px;line-height:1}
.gdpbody{overflow-y:auto;flex:1;padding:4px 0}
.gdrow{display:flex;align-items:flex-start;gap:7px;padding:5px 12px;border-bottom:1px solid var(--bo);font-size:11px}
.gdrow:last-child{border-bottom:none}
.gdrow-ic{width:14px;flex-shrink:0;margin-top:1px}
.gdrow-body{flex:1;min-width:0}
.gdrow-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdrow-detail{color:var(--mu);font-size:10px}
.gdrow-link{color:var(--or);text-decoration:none;font-size:10px}
.gdrow.s .gdrow-ic{color:var(--gn)}.gdrow.f .gdrow-ic{color:var(--rd)}.gdrow.p .gdrow-ic{color:var(--yl)}
.right{display:flex;flex-direction:column;overflow:hidden}
.act-hdr{padding:12px 14px;border-bottom:1px solid var(--bo);flex-shrink:0;display:flex;flex-direction:column;justify-content:center;min-height:60px}
.act-title{font-size:12px;font-weight:600;margin-bottom:3px;display:flex;align-items:center;gap:6px}
.act-sub{font-size:11px;color:var(--mu)}
.act-name{font-size:12px;font-weight:600;color:var(--or);word-break:break-all;margin-top:2px;display:none}
.progpanel{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:5px;min-height:0}
.progtitle{font-size:10px;font-weight:600;color:var(--mu);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.progidle{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 0;color:var(--mu);text-align:center}
.progidle .ic{font-size:28px}.progidle .de{font-size:11px;line-height:1.6}
.step{display:flex;align-items:flex-start;gap:7px;padding:7px 9px;border-radius:6px;background:var(--su);border:1px solid var(--bo);margin-bottom:3px;transition:all .25s}
.step.running{border-color:var(--or);background:#1f1500}
.step.done{border-color:#22c55e33;background:#0f1f0f}
.step.error{border-color:#ef444433;background:#1f0f0f}
.stepico{width:17px;height:17px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0;margin-top:1px}
.step.pending .stepico{background:var(--s2);color:var(--mu)}
.step.running .stepico{background:var(--or);color:#fff}
.step.done .stepico{background:var(--gn);color:#fff}
.step.error .stepico{background:var(--rd);color:#fff}
.steplabel{font-size:11px;font-weight:500}
.stepmsg{font-size:10px;color:var(--mu);line-height:1.4;margin-top:1px}
.step.running .stepmsg{color:var(--or)}.step.done .stepmsg{color:#4ade80}.step.error .stepmsg{color:var(--rd)}
.rescard{background:#0f1f0f;border:1px solid #22c55e44;border-radius:7px;padding:10px;margin-top:4px}
.rescard.err{background:#1f0f0f;border-color:#ef444433}
.restitle{font-size:11px;font-weight:600;color:var(--gn);margin-bottom:7px}
.rescard.err .restitle{color:var(--rd)}
.resrow{display:flex;align-items:flex-start;gap:5px;margin-bottom:4px;font-size:10px}
.reslbl{color:var(--mu);min-width:64px;flex-shrink:0}.resval{color:var(--tx);word-break:break-all}
.reslink{color:var(--or);text-decoration:none}.reslink:hover{text-decoration:underline}
.fpill{background:var(--s2);border:1px solid var(--bo);border-radius:4px;padding:2px 5px;font-size:9px;color:var(--mu);font-family:monospace;margin-top:2px}
.live{width:8px;height:8px;border-radius:50%;background:var(--mu);flex-shrink:0}
.live.on{background:var(--gn);box-shadow:0 0 6px var(--gn)}
@keyframes spin{to{transform:rotate(360deg)}}
.spin{width:10px;height:10px;border:2px solid rgba(255,255,255,.25);border-top-color:currentColor;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="li">&#128196;</div>
    <div><div class="lt">Grove PDF Router</div><div class="ls">Monitoring Dashboard</div></div>
  </div>
  <div class="sub-row">
    <div class="dot" id="sdot"></div>
    <span class="sub-txt" id="stxt">Watching for files...</span>
    <a href="/api/diag" target="_blank" style="margin-left:8px;font-size:10px;color:var(--mu);text-decoration:none;border:1px solid var(--bo);padding:2px 7px;border-radius:4px">&#128269; Diag</a>
  </div>
</header>
<div class="main">
  <div class="fcol">
    <div class="fhead">
      <div><div class="fht">&#128228; Scans</div><div class="fhm" id="scan-count"></div></div>
      <button class="rfbtn" id="scan-refresh">&#8635;</button>
    </div>
    <div class="pathbar">&#128193; Grove Bedding &rsaquo; <span>Scans</span></div>
    <div class="flist" id="scan-list"></div>
    <div class="run-panel" id="run-panel">
      <div class="run-fname" id="run-fname"></div>
      <div class="run-fmeta" id="run-fmeta"></div>
      <button class="runbtn" id="runbtn">&#9654; Run this file</button>
    </div>
  </div>
  <div class="fcol">
    <div class="fhead">
      <div><div class="fht">&#9989; Processed</div><div class="fhm" id="proc-count"></div></div>
      <div style="display:flex;gap:5px">
        <button class="rfbtn" id="gd-retry-btn" style="border-color:#22c55e44;color:var(--gn)">&#128230; GD</button>
        <button class="rfbtn" id="proc-refresh">&#8635;</button>
      </div>
    </div>
    <div class="pathbar">&#128193; Grove Bedding &rsaquo; Scans &rsaquo; <span>Processed</span></div>
    <div class="gdpanel" id="gdpanel">
      <div class="gdph">
        <span class="gdph-title" id="gdp-title">Google Drive Filing</span>
        <button class="gdph-close" id="gdp-close">&#10005;</button>
      </div>
      <div class="gdpbody" id="gdp-body"></div>
    </div>
    <div class="flist" id="proc-list"></div>
  </div>
  <div class="right">
    <div class="act-hdr">
      <div class="act-title"><div class="live" id="live"></div><span>Activity</span></div>
      <div class="act-sub" id="act-sub">Waiting for automation...</div>
      <div class="act-name" id="act-name"></div>
    </div>
    <div class="progpanel">
      <div class="progtitle">Progress</div>
      <div class="progidle" id="progidle">
        <div class="ic">&#129514;</div>
        <div class="de">Activity cards appear here<br>when a file is processing</div>
      </div>
      <div id="steplist"></div>
      <div id="rescard"></div>
    </div>
  </div>
</div>
<script>
(function() {
'use strict';

// ── Data — populated on load via /api/scan-files ──────────────────────────────
var SCAN_DATA  = [];
var PROC_DATA  = [];
var SCAN_ERROR = null;
var PROC_ERROR = null;

// ── State ─────────────────────────────────────────────────────────────────────
var PROCESSING    = false;
var SELECTED      = null;   // currently selected scan file object
var CURRENT       = null;   // file currently being processed
var NOTIFY_ES     = null;

var STEPS = [
  {id:1, l:'Initialise record'},
  {id:2, l:'Download from OneDrive'},
  {id:3, l:'Split PDF into pages'},
  {id:4, l:'Send page to Make.com'},
  {id:5, l:'AI extraction \u2014 Claude reads page'},
  {id:6, l:'File page to OneDrive & Google Drive'}
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s){ return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''; }
function fmtDate(iso){ if(!iso)return ''; try{ var d=new Date(iso); return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }catch(e){return '';} }
function fmtSize(b){ if(!b)return ''; var k=1024,s=['B','KB','MB','GB'],i=Math.floor(Math.log(b)/Math.log(k)); return parseFloat((b/Math.pow(k,i)).toFixed(1))+' '+s[i]; }
function el(id){ return document.getElementById(id); }

async function apiCall(url, opts) {
  try {
    var c = new AbortController();
    var t = setTimeout(function(){ c.abort(); }, 20000);
    var r = await fetch(url, Object.assign({ signal: c.signal }, opts || {}));
    clearTimeout(t);
    return await r.json().catch(function(){ return null; });
  } catch(e) { return null; }
}

// ── Scans column ──────────────────────────────────────────────────────────────
function renderScans(files, error) {
  var list = el('scan-list');
  var count = el('scan-count');
  if (error) {
    count.textContent = 'Error';
    list.innerHTML = '<div class="stmsg"><div class="ic">&#10060;</div><div class="ti">Failed to load Scans</div><div class="de">'+esc(error)+'</div></div>';
    return;
  }
  count.textContent = files.length + ' file' + (files.length === 1 ? '' : 's');
  if (!files.length) {
    list.innerHTML = '<div class="stmsg"><div class="ic">&#10003;</div><div class="ti">Scans folder is empty</div><div class="de">Drop PDFs into OneDrive Scans to begin</div></div>';
    return;
  }
  list.innerHTML = '';
  files.forEach(function(f) {
    var isActive  = CURRENT   && CURRENT.id   === f.id;
    var isSelected = SELECTED && SELECTED.id  === f.id && !isActive;

    var row = document.createElement('div');
    row.className = 'fi' + (isActive ? ' active' : isSelected ? ' sel' : '');
    row.id = 'sf-' + f.id;

    // rstbtn — separate element, stop propagation
    var rst = document.createElement('button');
    rst.className = 'rstbtn';
    rst.title = 'Reset file';
    rst.innerHTML = '&#8635;';
    rst.addEventListener('click', function(e) {
      e.stopPropagation();
      doReset(f.id);
    });

    row.innerHTML =
      '<div class="fic">' + (isActive ? '<span class="spin" style="color:var(--or)"></span>' : '&#128196;') + '</div>'
      + '<div class="fin"><div class="fnm">' + esc(f.name) + '</div>'
      + '<div class="fmeta">' + fmtSize(f.size) + ' &middot; ' + fmtDate(f.createdAt)
      + (isActive ? ' &middot; <span style="color:var(--or)">Processing\u2026</span>' : '') + '</div></div>';

    row.appendChild(rst);

    // Click handler on the row itself — NOT via onclick attribute
    row.addEventListener('click', function() {
      selectFile(f);
    });

    list.appendChild(row);
  });
}

function selectFile(f) {
  if (PROCESSING) return;
  SELECTED = f;

  // Update visual selection
  document.querySelectorAll('#scan-list .fi.sel').forEach(function(e) { e.classList.remove('sel'); });
  var row = el('sf-' + f.id);
  if (row) row.classList.add('sel');

  // Show run panel
  el('run-fname').textContent = f.name;
  el('run-fmeta').textContent = fmtSize(f.size) + ' \u00b7 ' + fmtDate(f.createdAt);
  el('run-panel').className = 'run-panel show';
  var btn = el('runbtn');
  btn.disabled = false;
  btn.textContent = '\u25b6 Run this file';
}

function hideRunPanel() {
  SELECTED = null;
  el('run-panel').className = 'run-panel';
  document.querySelectorAll('#scan-list .fi.sel').forEach(function(e) { e.classList.remove('sel'); });
}

async function refreshScans() {
  el('scan-list').innerHTML = '<div class="stmsg"><div class="ic">&#128194;</div><div class="ti">Loading\u2026</div></div>';
  el('scan-count').textContent = '\u2014';
  var d = await apiCall('/api/scan-files');
  SCAN_DATA = (d && d.success) ? (d.files || []) : [];
  renderScans(SCAN_DATA, (d && d.success) ? null : (d && d.error ? d.error : 'Could not reach OneDrive'));
}

// ── Processed column ──────────────────────────────────────────────────────────
function renderProcessed(files, error) {
  var list = el('proc-list');
  var count = el('proc-count');
  if (error) {
    count.textContent = 'Error';
    list.innerHTML = '<div class="stmsg"><div class="ic">&#10060;</div><div class="ti">Failed to load Processed</div><div class="de">'+esc(error)+'</div></div>';
    return;
  }
  count.textContent = files.length + ' file' + (files.length === 1 ? '' : 's');
  if (!files.length) {
    list.innerHTML = '<div class="stmsg"><div class="ic">&#128100;</div><div class="ti">No files yet</div><div class="de">Processed files appear here</div></div>';
    return;
  }
  list.innerHTML = '';
  files.forEach(function(f, idx) {
    var odUrl = f.webUrl || '';

    // Outer row — click toggles dropdown
    var row = document.createElement('div');
    row.className = 'fi done';
    row.style.flexDirection = 'column';
    row.style.alignItems = 'stretch';

    // Top part
    var top = document.createElement('div');
    top.style.display = 'flex';
    top.style.alignItems = 'center';
    top.style.gap = '8px';
    top.style.pointerEvents = 'none';  // let row handle click
    top.innerHTML =
      '<div class="fic">&#128196;</div>'
      + '<div class="fin"><div class="fnm">' + esc(f.name) + '</div>'
      + '<div class="fmeta">' + fmtSize(f.size) + ' &middot; ' + fmtDate(f.createdAt) + '</div></div>'
      + '<div class="fac"><span class="folder-tag od">&#128196; OD</span></div>';

    // Dropdown
    var drop = document.createElement('div');
    drop.className = 'proc-drop';
    drop.id = 'pd-' + idx;

    var dropHtml =
      '<div class="pd-row"><div class="pd-lbl">Size</div><div class="pd-val">' + esc(fmtSize(f.size)) + '</div></div>'
      + '<div class="pd-row"><div class="pd-lbl">Filed</div><div class="pd-val">' + esc(fmtDate(f.createdAt)) + '</div></div>';
    if (odUrl) {
      dropHtml += '<div class="pd-row"><div class="pd-lbl">OneDrive</div><a class="pd-link" href="' + esc(odUrl) + '" target="_blank">Open in OneDrive &#8599;</a></div>';
    }
    dropHtml += '<div class="pd-row"><div class="pd-lbl">Google Drive</div><button class="gd-btn" id="gdb-' + idx + '">&#128230; Send to GD</button></div>';
    drop.innerHTML = dropHtml;

    row.appendChild(top);
    row.appendChild(drop);

    // Click handler
    row.addEventListener('click', function() {
      var isOpen = drop.classList.contains('open');
      document.querySelectorAll('.proc-drop.open').forEach(function(d) { d.classList.remove('open'); });
      if (!isOpen) drop.classList.add('open');
    });

    // GD button — must add after row is in DOM would cause issue, so use closure
    var gdBtn = drop.querySelector('.gd-btn');
    if (gdBtn) {
      gdBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        sendToGDrive(gdBtn, f.name, f.id);
      });
    }

    list.appendChild(row);
  });
}

async function refreshProcessed() {
  el('proc-list').innerHTML = '<div class="stmsg"><div class="ic">&#128194;</div><div class="ti">Loading\u2026</div></div>';
  el('proc-count').textContent = '\u2014';
  var d = await apiCall('/api/scan-files?folder=Processed');
  PROC_DATA = (d && d.success) ? (d.files || []) : [];
  renderProcessed(PROC_DATA, (d && d.success) ? null : (d && d.error ? d.error : 'Could not reach OneDrive'));
}

// ── File run ──────────────────────────────────────────────────────────────────
async function doReset(fid) {
  if (!confirm('Reset this file so it can be reprocessed?')) return;
  var d = await apiCall('/api/admin?action=reset', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fileId:fid}) });
  if (d && d.success) refreshScans();
  else alert('Reset failed: ' + (d && d.error ? d.error : 'Unknown error'));
}

// ── GD filing ─────────────────────────────────────────────────────────────────
async function sendToGDrive(btn, fname, fid) {
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  var d = await apiCall('/api/gdrive?action=file', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fileName:fname, fileId:fid}) });
  if (d && d.success) {
    var url = d.gdFileUrl || d.gdFolderUrl || '';
    btn.parentElement.innerHTML = '<div class="pd-lbl">Google Drive</div>'
      + (url ? '<a class="pd-link" href="' + esc(url) + '" target="_blank">Open &#8599;</a>' : 'Filed &#10003;');
  } else {
    btn.disabled = false; btn.innerHTML = '&#10007; Retry'; btn.style.color = 'var(--rd)';
    setTimeout(function(){ btn.innerHTML = '&#128230; Send to GD'; btn.style.color = ''; }, 6000);
  }
}

// ── GD Retry panel ────────────────────────────────────────────────────────────
async function retryGD() {
  var btn = el('gd-retry-btn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  var panel = el('gdpanel'), body = el('gdp-body'), title = el('gdp-title');
  panel.classList.add('open'); body.innerHTML = ''; title.textContent = 'Google Drive Filing';
  function addRow(id, cls, ic, name, detail, link, linkTxt) {
    var ex = body.querySelector('[data-rid="'+id+'"]');
    var html = '<div class="gdrow '+cls+'" data-rid="'+esc(id)+'">'
      +'<div class="gdrow-ic">'+ic+'</div>'
      +'<div class="gdrow-body"><div class="gdrow-name">'+esc(name)+'</div>'
      +(detail?'<div class="gdrow-detail">'+esc(detail)+'</div>':'')
      +(link?'<a class="gdrow-link" href="'+esc(link)+'" target="_blank">Open '+(linkTxt||'folder')+' &#8599;</a>':'')
      +'</div></div>';
    if (ex) ex.outerHTML = html; else body.insertAdjacentHTML('beforeend', html);
    body.scrollTop = body.scrollHeight;
  }
  try {
    var resp = await fetch('/api/gdrive?action=retry', { method:'POST' });
    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '';
    while (true) {
      var chunk = await reader.read(); if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var lines = buf.split('\n'); buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.startsWith(': ')) continue;
        if (line.startsWith('data: ')) {
          try {
            var ev = JSON.parse(line.slice(6));
            if (ev.type==='start') title.textContent = 'Filing '+ev.total+' file'+(ev.total===1?'':'s')+' to Google Drive';
            else if (ev.type==='file'&&ev.status==='filing') addRow('f-'+ev.name,'p','&#9203;',ev.name,'Filing\u2026',null,null);
            else if (ev.type==='file'&&ev.status==='success') addRow('f-'+ev.name,'s','&#10003;',ev.name,ev.pages+' page(s)',ev.gdFolderUrl,'folder');
            else if (ev.type==='file'&&ev.status==='failed') addRow('f-'+ev.name,'f','&#10007;',ev.name,'Failed',null,null);
            else if (ev.type==='page'&&ev.status==='success') addRow('p-'+ev.name+'-'+ev.page,'s','&#128196;',ev.fileName,'Page '+ev.page,ev.gdFileUrl||ev.gdFolderUrl,ev.gdFileUrl?'file':'folder');
            else if (ev.type==='done') { title.textContent='Complete'; if(ev.total===0) body.innerHTML='<div class="gdrow s"><div class="gdrow-ic">&#10003;</div><div class="gdrow-body"><div class="gdrow-name">All files already filed</div></div></div>'; }
          } catch(ex) {}
        }
      }
    }
  } catch(err) {
    body.insertAdjacentHTML('beforeend','<div class="gdrow f"><div class="gdrow-ic">&#10007;</div><div class="gdrow-body"><div class="gdrow-name">Error: '+esc(err.message)+'</div></div></div>');
  }
  btn.disabled = false; btn.innerHTML = '&#128230; GD'; btn.style.color = 'var(--gn)';
}

// ── Activity cards ────────────────────────────────────────────────────────────
function setLive(on, label) {
  el('live').className = 'live' + (on ? ' on' : '');
  el('stxt').textContent = label || (on ? 'Processing\u2026' : 'Watching for files\u2026');
  el('sdot').className = 'dot' + (on ? ' g' : '');
}

function setActivityName(name) {
  el('act-sub').textContent = name ? 'Currently processing:' : 'Waiting for automation\u2026';
  var n = el('act-name'); n.textContent = name || ''; n.style.display = name ? '' : 'none';
}

function mkStep(id, label, msg, st) {
  var ico = st==='running' ? '<span class="spin"></span>' : st==='done' ? '\u2713' : st==='error' ? '\u2715' : String(id);
  return '<div class="step '+st+'" id="st-'+id+'" data-st="'+st+'">'
    +'<div class="stepico">'+ico+'</div>'
    +'<div style="flex:1;min-width:0"><div class="steplabel">'+esc(label)+'</div>'
    +(msg?'<div class="stepmsg">'+esc(msg)+'</div>':'')+'</div></div>';
}

function updStep(n, msg, st) {
  STEPS.forEach(function(s) {
    if (s.id < n) { var e=el('st-'+s.id); if(e&&(e.dataset.st==='pending'||e.dataset.st==='running'))e.outerHTML=mkStep(s.id,s.l,'','done'); }
  });
  var ex = el('st-'+n), step = STEPS.find(function(s){ return s.id===n; });
  if (!step) return;
  if (ex) ex.outerHTML = mkStep(n, step.l, msg, st);
  else el('steplist').insertAdjacentHTML('beforeend', mkStep(n, step.l, msg, st));
}

function showResult(d) {
  var files = (d.renamedFiles||[]).map(function(f){ return '<div class="fpill">'+esc(f)+'</div>'; }).join('');
  el('rescard').innerHTML = '<div class="rescard">'
    +'<div class="restitle">&#9989; Complete</div>'
    +'<div class="resrow"><div class="reslbl">Customer</div><div class="resval">'+esc(d.customerName||'\u2014')+'</div></div>'
    +'<div class="resrow"><div class="reslbl">Reference</div><div class="resval">'+esc(d.ref||'\u2014')+'</div></div>'
    +'<div class="resrow"><div class="reslbl">Pages</div><div class="resval">'+(d.totalPages||'\u2014')+'</div></div>'
    +(d.googleDriveFolderUrl?'<div class="resrow"><div class="reslbl">Google Drive</div><div class="resval"><a class="reslink" href="'+d.googleDriveFolderUrl+'" target="_blank">Open &#8599;</a></div></div>':'')
    +(d.oneDriveProcessedFolderUrl?'<div class="resrow"><div class="reslbl">OneDrive</div><div class="resval"><a class="reslink" href="'+d.oneDriveProcessedFolderUrl+'" target="_blank">Open &#8599;</a></div></div>':'')
    +(files?'<div class="resrow" style="flex-direction:column;gap:2px"><div class="reslbl">Files</div>'+files+'</div>':'')
    +'</div>';
}

function showError(msg) {
  el('rescard').innerHTML = '<div class="rescard err"><div class="restitle">&#10060; Failed</div>'
    +'<div class="resrow"><div class="reslbl">Error</div><div class="resval" style="color:var(--rd)">'+esc(msg)+'</div></div></div>';
}

function handleEvt(ev, d) {
  if (ev==='progress') {
    if (d.status==='running') requestAnimationFrame(function(){ updStep(d.step,d.message,d.status); });
    else updStep(d.step, d.message, d.status);
  } else if (ev==='complete') {
    updStep(4,'All '+(d.totalPages||'')+' page(s) sent to Make.com \u2713','done');
    updStep(5,'All '+(d.totalPages||'')+' page(s) extracted by Claude \u2713','done');
    updStep(6,'All '+(d.totalPages||'')+' page(s) filed \u2713','done');
    showResult(d); onDone();
  } else if (ev==='error') { showError(d.message); onErr(); }
}

function onDone() {
  PROCESSING = false; CURRENT = null;
  setLive(false); hideRunPanel();
  setTimeout(function(){ if(!PROCESSING) setActivityName(null); }, 10000);
  refreshScans(); refreshProcessed();
}
function onErr() {
  PROCESSING = false; CURRENT = null;
  setLive(false, 'Error \u2014 check Vercel logs'); hideRunPanel();
  refreshScans();
}

// ── Start watching a file via test-run SSE ────────────────────────────────────
async function startWatching(file) {
  if (PROCESSING) return;
  PROCESSING = true; CURRENT = file;
  setLive(true, 'Processing \u2022 ' + file.name);
  setActivityName(file.name);
  el('progidle').style.display = 'none';
  el('steplist').innerHTML = STEPS.map(function(s){ return mkStep(s.id,s.l,'','pending'); }).join('');
  el('rescard').innerHTML = '';
  var row = el('sf-' + file.id);
  if (row) { row.className = 'fi active'; row.querySelector('.fic').innerHTML = '<span class="spin" style="color:var(--or)"></span>'; }
  try {
    var resp = await fetch('/api/test-run', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fileId:file.id, fileName:file.name, runMode:'auto', runStep:1}) });
    if (!resp.ok) { showError('Server error ' + resp.status); onErr(); return; }
    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '', evt = null;
    while (true) {
      var chunk = await reader.read(); if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var lines = buf.split('\n'); buf = lines.pop();
      lines.forEach(function(line) {
        if (line.startsWith('event: ')) evt = line.slice(7).trim();
        else if (line.startsWith('data: ')) { try{ handleEvt(evt, JSON.parse(line.slice(6))); }catch(e){} }
        else if (line === '') evt = null;
      });
    }
    if (PROCESSING) {
      var rec = await apiCall('/api/status?fileId=' + encodeURIComponent(file.id));
      if (rec && rec.record && rec.record.status === 'completed') {
        updStep(4,'All page(s) sent \u2713','done');
        updStep(5,'All page(s) extracted \u2713','done');
        updStep(6,'All page(s) filed \u2713','done');
        showResult(rec.record); onDone();
      } else if (PROCESSING) onErr();
    }
  } catch(err) { showError(err.message); onErr(); }
}

// ── SSE Notify ────────────────────────────────────────────────────────────────
function openNotifyStream() {
  if (NOTIFY_ES) { NOTIFY_ES.close(); NOTIFY_ES = null; }
  var es = new EventSource('/api/notify');
  NOTIFY_ES = es;
  es.addEventListener('connected', function(){ console.log('[dashboard] notify connected'); });
  es.addEventListener('new-file', async function(e) {
    try {
      await refreshScans();
      if (!PROCESSING && SCAN_DATA.length > 0) startWatching(SCAN_DATA[0]);
    } catch(ex) {}
  });
  es.addEventListener('reconnect', function(){ es.close(); NOTIFY_ES=null; setTimeout(openNotifyStream,1000); });
  es.onerror = function(){ es.close(); NOTIFY_ES=null; setTimeout(openNotifyStream,5000); };
}

// ── Wire up buttons ───────────────────────────────────────────────────────────
el('runbtn').addEventListener('click', async function() {
  if (!SELECTED || PROCESSING) return;
  var f = SELECTED;
  this.disabled = true;
  this.innerHTML = '<span class="spin"></span> Running\u2026';
  hideRunPanel();
  await startWatching(f);
});
el('scan-refresh').addEventListener('click', refreshScans);
el('proc-refresh').addEventListener('click', refreshProcessed);
el('gd-retry-btn').addEventListener('click', retryGD);
el('gdp-close').addEventListener('click', function(){ el('gdpanel').classList.remove('open'); });

// ── Init — fetch both columns fresh from OneDrive ─────────────────────────────
try {
  openNotifyStream();
  // Always fetch live from /api/scan-files — avoids cold-start race conditions
  Promise.all([refreshScans(), refreshProcessed()]).then(function() {
    console.log('[dashboard] Init OK — Scans:', SCAN_DATA.length, 'Processed:', PROC_DATA.length);
  });
} catch(initErr) {
  console.error('[dashboard] Init error:', initErr);
  var errDiv = document.createElement('div');
  errDiv.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#1f0f0f;border:1px solid #ef4444;color:#f87171;padding:12px 20px;border-radius:8px;font-size:12px;z-index:999;max-width:80%';
  errDiv.textContent = 'Dashboard JS error: ' + initErr.message;
  document.body.appendChild(errDiv);
}

})(); // end IIFE
</script>
</body></html>`);
};
