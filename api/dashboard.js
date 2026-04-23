/**
 * /api/dashboard
 * Grove PDF Router — passive monitoring dashboard.
 *
 * Firestore reads:
 *   - 1 read on open (load all processed records)
 *   - 1 read each time a file completes (SSE triggers reload)
 *   - 0 reads while idle — no polling timers whatsoever
 */

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(HTML);
};

const HTML = `<!DOCTYPE html>
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
.pathbar{padding:5px 14px;background:var(--su);border-bottom:1px solid var(--bo);font-size:10px;color:var(--mu);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pathbar span{color:var(--or)}
.flist{overflow-y:auto;flex:1;padding:6px}
.flist::-webkit-scrollbar{width:4px}.flist::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
.fi{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;border:1px solid transparent;margin-bottom:3px;background:var(--su)}
.fi.done-f{border-color:#22c55e22;background:#0a180a;cursor:pointer}
.fi.done-f:hover{border-color:#22c55e55}
.fi.active-f{border-color:var(--or);background:#1f1500}
.fic{width:30px;height:30px;background:#180f00;border:1px solid #3a2000;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}
.fi.done-f .fic{background:#0a180a;border-color:#22c55e33}
.fi.active-f .fic{background:#2a1800;border-color:#d9770055}
.fin{flex:1;min-width:0}
.fnm{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fmeta{font-size:10px;color:var(--mu);margin-top:1px}
.fac{display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0}
.stmsg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 16px;color:var(--mu);text-align:center;height:100%}
.stmsg .ic{font-size:26px}.stmsg .ti{font-size:12px;font-weight:500;color:var(--tx)}.stmsg .de{font-size:11px;line-height:1.5}
.right{display:flex;flex-direction:column;overflow:hidden}
.act-hdr{padding:12px 14px;border-bottom:1px solid var(--bo);flex-shrink:0;min-height:60px;display:flex;flex-direction:column;justify-content:center}
.act-title{font-size:12px;font-weight:600;margin-bottom:3px;display:flex;align-items:center;gap:6px}
.act-sub{font-size:11px;color:var(--mu)}
.act-name{font-size:12px;font-weight:600;color:var(--or);word-break:break-all;margin-top:2px;display:none}
.progpanel{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:5px}
.progpanel::-webkit-scrollbar{width:4px}.progpanel::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
.progtitle{font-size:10px;font-weight:600;color:var(--mu);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.progidle{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 0;color:var(--mu);text-align:center}
.progidle .ic{font-size:28px}.progidle .de{font-size:11px;line-height:1.6}
.stepitem{display:flex;align-items:flex-start;gap:7px;padding:7px 9px;border-radius:6px;background:var(--su);border:1px solid var(--bo);transition:all .25s;margin-bottom:3px}
.stepitem.running{border-color:var(--or);background:#1f1500}
.stepitem.done{border-color:#22c55e33;background:#0f1f0f}
.stepitem.error{border-color:#ef444433;background:#1f0f0f}
.stepico{width:17px;height:17px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0;margin-top:1px}
.stepitem.pending .stepico{background:var(--s2);color:var(--mu)}
.stepitem.running .stepico{background:var(--or);color:#fff}
.stepitem.done .stepico{background:var(--gn);color:#fff}
.stepitem.error .stepico{background:var(--rd);color:#fff}
.steplabel{font-size:11px;font-weight:500}
.stepmsg{font-size:10px;color:var(--mu);line-height:1.4;margin-top:1px}
.stepitem.running .stepmsg{color:var(--or)}.stepitem.done .stepmsg{color:#4ade80}.stepitem.error .stepmsg{color:var(--rd)}
.rescard{background:#0f1f0f;border:1px solid #22c55e44;border-radius:7px;padding:10px;margin-top:4px}
.rescard.err{background:#1f0f0f;border-color:#ef444433}
.restitle{font-size:11px;font-weight:600;color:var(--gn);margin-bottom:7px}
.rescard.err .restitle{color:var(--rd)}
.resrow{display:flex;align-items:flex-start;gap:5px;margin-bottom:4px;font-size:10px}
.reslbl{color:var(--mu);min-width:64px;flex-shrink:0}.resval{color:var(--tx);word-break:break-all}
.reslink{color:var(--or);text-decoration:none}.reslink:hover{text-decoration:underline}
.fpill{background:var(--s2);border:1px solid var(--bo);border-radius:4px;padding:2px 5px;font-size:9px;color:var(--mu);font-family:monospace;margin-top:2px}
.proc-drop{display:none;margin-top:7px;padding-top:7px;border-top:1px solid var(--bo)}
.proc-drop.open{display:block}
.pd-row{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px}
.pd-lbl{color:var(--mu);min-width:60px;flex-shrink:0;font-size:10px}
.pd-val{color:var(--tx);flex:1;min-width:0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pd-link{color:var(--or);text-decoration:none;font-size:11px}
.pd-link:hover{text-decoration:underline}
.folder-tag{font-size:9px;padding:2px 6px;border-radius:5px;font-weight:600;white-space:nowrap}
.folder-tag.gd{background:#1a2f1a;color:#4ade80;border:1px solid #22c55e33}
.folder-tag.od{background:#1a1a2f;color:#818cf8;border:1px solid #6366f133}
.gd-send-btn{background:none;border:1px solid #22c55e44;color:var(--gn);border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-weight:600}
.gd-send-btn:hover{background:#1a2f1a}.gd-send-btn:disabled{opacity:.5;cursor:not-allowed}
.live{width:8px;height:8px;border-radius:50%;background:var(--mu);flex-shrink:0}
.live.on{background:var(--gn);box-shadow:0 0 6px var(--gn)}
.fi.sel-f{border-color:var(--or)!important;background:#1f1500!important;cursor:pointer}
.rstbtn{background:none;border:1px solid var(--bo);color:var(--mu);width:18px;height:18px;border-radius:4px;cursor:pointer;font-size:9px;transition:all .15s;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rstbtn:hover{border-color:var(--rd);color:var(--rd)}
.runbtn{width:100%;padding:8px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:none;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px;margin-top:6px}
.runbtn.go{background:var(--or);color:#fff}.runbtn.go:hover{background:var(--orl)}
.runbtn:disabled{background:var(--s2);color:var(--mu);cursor:not-allowed;border:1px solid var(--bo)}
.run-area{padding:8px 14px;border-top:1px solid var(--bo);flex-shrink:0;display:none}
.run-area.show{display:block}
.run-fname{font-size:11px;font-weight:600;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-fmeta{font-size:10px;color:var(--mu);margin-bottom:4px}
.gdpanel{border-top:1px solid var(--bo);flex-shrink:0;max-height:240px;display:none;flex-direction:column}
.gdpanel.open{display:flex}
.gdph{padding:7px 12px;border-bottom:1px solid var(--bo);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.gdph-title{font-size:11px;font-weight:600;color:var(--mu)}
.gdph-close{background:none;border:none;color:var(--mu);cursor:pointer;font-size:13px;line-height:1}
.gdph-close:hover{color:var(--tx)}
.gdpbody{overflow-y:auto;flex:1}
.gdrow{display:flex;align-items:flex-start;gap:7px;padding:5px 12px;border-bottom:1px solid var(--bo);font-size:11px}
.gdrow:last-child{border-bottom:none}
.gdrow-ic{width:14px;flex-shrink:0;margin-top:1px;text-align:center}
.gdrow-body{flex:1;min-width:0}
.gdrow-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdrow-detail{color:var(--mu);font-size:10px;margin-top:1px}
.gdrow-link{color:var(--or);text-decoration:none;font-size:10px}
.gdrow-link:hover{text-decoration:underline}
.gdrow.filing .gdrow-ic{color:var(--yl)}.gdrow.success .gdrow-ic{color:var(--gn)}.gdrow.failed .gdrow-ic{color:var(--rd)}.gdrow.skipped .gdrow-ic{color:var(--mu)}
@keyframes spin{to{transform:rotate(360deg)}}
.spin{width:10px;height:10px;border:2px solid rgba(255,255,255,.25);border-top-color:currentColor;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.pulse{animation:pulse 1.4s ease-in-out infinite}
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
  </div>
</header>

<div class="main">
  <!-- SCANS -->
  <div class="fcol">
    <div class="fhead">
      <div><div class="fht">&#128228; Scans</div><div class="fhm" id="scan-count">—</div></div>
      <button class="rfbtn" onclick="loadScans()">&#8635;</button>
    </div>
    <div class="pathbar">&#128193; Grove Bedding &rsaquo; <span>Scans</span></div>
    <div class="flist" id="scan-list">
      <div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading...</div></div>
    </div>
    <div class="run-area" id="run-area">
      <div class="run-fname" id="run-fname"></div>
      <div class="run-fmeta" id="run-fmeta"></div>
      <button class="runbtn go" id="runbtn" onclick="manualRun()">&#9654; Run this file</button>
    </div>
  </div>

  <!-- PROCESSED -->
  <div class="fcol">
    <div class="fhead">
      <div><div class="fht">&#9989; Processed</div><div class="fhm" id="proc-count">—</div></div>
      <div style="display:flex;gap:5px">
        <button class="rfbtn" id="gd-retry-btn" onclick="retryGD()" style="border-color:#22c55e44;color:var(--gn)" title="Re-file anything missing Google Drive">&#128230; GD</button>
        <button class="rfbtn" onclick="loadStatus().then(loadProcessed)">&#8635;</button>
      </div>
    </div>
    <div class="pathbar">&#128193; Grove Bedding &rsaquo; Scans &rsaquo; <span>Processed</span></div>
    <div class="gdpanel" id="gdpanel">
      <div class="gdph">
        <span class="gdph-title" id="gdp-title">Google Drive Filing</span>
        <button class="gdph-close" onclick="closeGDPanel()">&#10005;</button>
      </div>
      <div class="gdpbody" id="gdp-body"></div>
    </div>
    <div class="flist" id="proc-list">
      <div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading...</div></div>
    </div>
  </div>

  <!-- ACTIVITY -->
  <div class="right">
    <div class="act-hdr">
      <div class="act-title">
        <div class="live" id="live"></div>
        <span id="act-title-txt">Activity</span>
      </div>
      <div class="act-sub" id="act-sub">Waiting for automation to run...</div>
      <div class="act-name" id="act-name"></div>
    </div>
    <div class="progpanel">
      <div class="progtitle">Progress</div>
      <div class="progidle" id="progidle">
        <div class="ic">&#129514;</div>
        <div class="de">Activity cards will appear here<br>automatically when Make.com<br>processes a file</div>
      </div>
      <div id="steplist"></div>
      <div id="rescard"></div>
    </div>
  </div>
</div>

<script>
var STATUS_CACHE = [];
var PROCESSING = false;
var CURRENT_FILE = null;
var SELECTED_FILE = null;
var NOTIFY_ES = null;

var STEPS = [
  {id:1,l:'Initialise record'},
  {id:2,l:'Download from OneDrive'},
  {id:3,l:'Split PDF into pages'},
  {id:4,l:'Send page to Make.com'},
  {id:5,l:'AI extraction \u2014 Claude reads page'},
  {id:6,l:'File page to OneDrive & Google Drive'}
];

function esc(s){ return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
function fdate(iso){ if(!iso) return ''; var d=new Date(iso); return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
function fsize(b){ if(!b) return ''; var k=1024,i=Math.floor(Math.log(b)/Math.log(k)); return parseFloat((b/Math.pow(k,i)).toFixed(1))+['B','KB','MB','GB'][i]; }
function $(id){ return document.getElementById(id); }

async function api(url, opts) {
  try { var r=await fetch(url,opts||{}); return await r.json().catch(function(){return null;}); }
  catch(e){ return null; }
}

// ── Status: 1 Firestore read, with timeout so it never hangs forever ─────────
async function loadStatus() {
  try {
    // 8-second timeout — if Firestore is over quota it hangs, this prevents that
    var timeout = new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('timeout')); }, 8000); });
    var d = await Promise.race([api('/api/status?limit=200'), timeout]);
    if (d && d.records) STATUS_CACHE = d.records;
  } catch(e) {
    console.warn('[dashboard] loadStatus failed or timed out:', e.message);
  }
  return STATUS_CACHE;
}

// ── Scans: reads from OneDrive, zero Firestore cost ──────────────────────────
async function loadScans() {
  $('scan-list').innerHTML = '<div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading...</div></div>';
  $('scan-count').textContent = '—';
  var d = await api('/api/scan-files');
  if (!d || !d.success || !d.files) {
    $('scan-count').textContent = 'Error';
    $('scan-list').innerHTML = '<div class="stmsg"><div class="ic">&#10060;</div><div class="ti">Failed to load</div></div>';
    return;
  }
  var done = {};
  STATUS_CACHE.forEach(function(r){ if(r.status==='completed') done[r.fileId]=true; });
  var files = d.files.filter(function(f){ return !done[f.id]; });
  window.SCAN_FILES = files;
  $('scan-count').textContent = files.length + ' file' + (files.length===1?'':'s');
  if (!files.length) {
    $('scan-list').innerHTML = '<div class="stmsg"><div class="ic">&#10003;</div><div class="ti">All files processed</div></div>';
    hideRunArea();
    return;
  }
  $('scan-list').innerHTML = files.map(function(f){
    var active = CURRENT_FILE && CURRENT_FILE.id === f.id;
    var sel = SELECTED_FILE && SELECTED_FILE.id === f.id && !active;
    return '<div class="fi'+(active?' active-f':sel?' sel-f':'')+'" id="sf-'+esc(f.id)+'" onclick="selectFile('+JSON.stringify(f.id)+')">'
      +'<div class="fic">'+(active?'<span class="spin" style="color:var(--or)"></span>':'&#128196;')+'</div>'
      +'<div class="fin"><div class="fnm">'+esc(f.name)+'</div>'
      +'<div class="fmeta">'+fsize(f.size)+' &middot; '+fdate(f.createdAt)+(active?' &middot; <span style="color:var(--or)">Processing\u2026</span>':'')+'</div></div>'
      +'<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">'
      +'<button class="rstbtn" title="Reset file" onclick="event.stopPropagation();doReset('+JSON.stringify(f.id)+')">&#8635;</button>'
      +'</div>'
      +'</div>';
  }).join('');
}

function selectFile(fid) {
  if (PROCESSING) return;
  var files = window.SCAN_FILES || [];
  var f = files.find(function(x){ return x.id === fid; });
  if (!f) return;
  SELECTED_FILE = f;
  // Update highlight
  document.querySelectorAll('.fi.sel-f').forEach(function(el){ el.classList.remove('sel-f'); });
  var el = $('sf-' + fid);
  if (el) el.classList.add('sel-f');
  // Show run area
  $('run-fname').textContent = f.name;
  $('run-fmeta').textContent = fsize(f.size) + ' · ' + fdate(f.createdAt);
  var ra = $('run-area'); ra.classList.add('show');
  var btn = $('runbtn');
  btn.className = 'runbtn go'; btn.disabled = false; btn.innerHTML = '&#9654; Run this file';
}

function hideRunArea() {
  SELECTED_FILE = null;
  var ra = $('run-area'); if (ra) ra.classList.remove('show');
  document.querySelectorAll('.fi.sel-f').forEach(function(el){ el.classList.remove('sel-f'); });
}

async function manualRun() {
  if (!SELECTED_FILE || PROCESSING) return;
  var f = SELECTED_FILE;
  var btn = $('runbtn');
  btn.className = 'runbtn'; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Running\u2026';
  hideRunArea();
  await startWatching(f);
}

async function doReset(fid) {
  if (!confirm('Reset this file so it can be reprocessed?')) return;
  var d = await api('/api/admin?action=reset', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:fid})});
  if (d && d.success) { loadScans(); }
  else { alert('Reset failed: ' + (d && d.error ? d.error : 'Unknown error')); }
}

// ── Processed: reads from OneDrive Processed folder (zero Firestore cost) ─────
// Enriches with Firestore metadata (customer, ref, GD links) if available,
// but works and shows filenames even when Firestore is unavailable.
async function loadProcessed() {
  $('proc-list').innerHTML = '<div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading\u2026</div></div>';
  $('proc-count').textContent = '—';

  // Fetch the Processed folder from OneDrive — same API, different folder param
  var d = await api('/api/scan-files?folder=Processed');
  if (!d || !d.success) {
    $('proc-count').textContent = 'Error';
    $('proc-list').innerHTML = '<div class="stmsg"><div class="ic">&#10060;</div><div class="ti">Failed to load Processed folder</div></div>';
    return;
  }

  var processedFiles = d.files || [];
  $('proc-count').textContent = processedFiles.length + ' file' + (processedFiles.length===1?'':'s');

  if (!processedFiles.length) {
    $('proc-list').innerHTML = '<div class="stmsg"><div class="ic">&#128100;</div><div class="ti">No files yet</div><div class="de">Processed files will appear here</div></div>';
    return;
  }

  // Build a lookup from STATUS_CACHE for enrichment (customer, ref, GD links etc)
  // This works even if STATUS_CACHE is empty (Firestore unavailable)
  var metaByFileName = {};
  STATUS_CACHE.forEach(function(rec) {
    (rec.pageFiles || []).forEach(function(pg) {
      if (pg.finalFileName) metaByFileName[pg.finalFileName] = { rec: rec, pg: pg };
    });
    // Also index by renamed files array
    (rec.renamedFiles || []).forEach(function(fname) {
      if (!metaByFileName[fname]) metaByFileName[fname] = { rec: rec, pg: null };
    });
  });

  $('proc-list').innerHTML = processedFiles.map(function(f, idx) {
    var meta = metaByFileName[f.name] || null;
    var rec = meta ? meta.rec : null;
    var pg = meta ? meta.pg : null;
    var customer = (pg && pg.customerName) || (rec && rec.customerName) || '';
    var ref = (pg && pg.ref) || (rec && rec.ref) || '';
    var supplier = (pg && pg.supplier) || (rec && rec.supplier) || '';
    var gdFile = (pg && pg.googleDriveFileUrl) || '';
    var gdFolder = (pg && pg.googleDriveUrl) || (rec && rec.googleDriveFolderUrl) || '';
    var odUrl = (pg && pg.oneDriveUrl) || f.webUrl || '';
    var folder = customer ? (customer + (ref ? ' / ' + ref : '')) : '';
    var completedAt = rec && rec.completedAt ? rec.completedAt : null;

    // Tags
    var tags = '';
    if (gdFolder || gdFile) tags += '<span class="folder-tag gd">&#128230; GD</span>';
    if (odUrl) tags += (tags?' ':'') + '<span class="folder-tag od">&#128196; OD</span>';

    // Dropdown
    var did = 'pdrop-' + idx;
    var drop = '<div class="proc-drop" id="' + did + '">';
    if (supplier) drop += '<div class="pd-row"><div class="pd-lbl">Supplier</div><div class="pd-val">' + esc(supplier) + '</div></div>';
    if (folder)   drop += '<div class="pd-row"><div class="pd-lbl">Folder</div><div class="pd-val">' + esc(folder) + '</div></div>';
    if (odUrl)    drop += '<div class="pd-row"><div class="pd-lbl">OneDrive</div><a class="pd-link" href="' + esc(odUrl) + '" target="_blank" onclick="event.stopPropagation()">Open file &#8599;</a></div>';
    if (gdFile) {
      drop += '<div class="pd-row"><div class="pd-lbl">Google Drive</div>'
        + '<a class="pd-link" href="' + esc(gdFile) + '" target="_blank" onclick="event.stopPropagation()">Open file &#8599;</a>'
        + (gdFolder ? ' &nbsp;<a class="pd-link" style="opacity:.6;font-size:10px" href="' + esc(gdFolder) + '" target="_blank" onclick="event.stopPropagation()">folder &#8599;</a>' : '')
        + '</div>';
    } else if (gdFolder) {
      drop += '<div class="pd-row"><div class="pd-lbl">Google Drive</div><a class="pd-link" href="' + esc(gdFolder) + '" target="_blank" onclick="event.stopPropagation()">Open folder &#8599;</a></div>';
    } else if (rec && rec.fileId) {
      drop += '<div class="pd-row"><div class="pd-lbl">Google Drive</div>'
        + '<button class="gd-send-btn" data-fname="' + esc(rec.originalFileName||'') + '" data-fid="' + esc(rec.fileId||'') + '" '
        + 'onclick="event.stopPropagation();sendToGDrive(this)">&#128230; Send to GD</button></div>';
    }
    drop += '<div class="pd-row"><div class="pd-lbl">Size</div><div class="pd-val">' + esc(f.sizeFormatted||'') + '</div></div>';
    if (completedAt) drop += '<div class="pd-row"><div class="pd-lbl">Processed</div><div class="pd-val">' + fdate(completedAt) + '</div></div>';
    drop += '</div>';

    return '<div class="fi done-f" data-dropid="' + did + '" onclick="toggleDrop(this.dataset.dropid)" style="flex-direction:column;align-items:stretch">'
      + '<div style="display:flex;align-items:center;gap:8px">'
      + '<div class="fic">&#128196;</div>'
      + '<div class="fin"><div class="fnm">' + esc(f.name) + '</div>'
      + (folder ? '<div class="fmeta">' + esc(folder) + '</div>' : '<div class="fmeta" style="color:var(--mu)">' + esc(f.sizeFormatted||'') + '</div>')
      + '</div>'
      + '<div class="fac">' + tags + '</div>'
      + '</div>' + drop + '</div>';
  }).join('');
}

function toggleDrop(id) {
  var d=document.getElementById(id); if(!d) return;
  var open=d.classList.contains('open');
  document.querySelectorAll('.proc-drop.open').forEach(function(x){x.classList.remove('open');});
  if(!open) d.classList.add('open');
}

async function sendToGDrive(btn) {
  btn.disabled=true; btn.innerHTML='<span class="spin"></span>';
  var d=await api('/api/gdrive?action=file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileName:btn.dataset.fname,fileId:btn.dataset.fid})});
  if(d&&d.success){
    var row=btn.closest('.pd-row');
    if(row){ row.innerHTML='<div class="pd-lbl">Google Drive</div>'+(d.gdFileUrl?'<a class="pd-link" href="'+esc(d.gdFileUrl)+'" target="_blank">Open file &#8599;</a>':'<a class="pd-link" href="'+esc(d.gdFolderUrl)+'" target="_blank">Open folder &#8599;</a>')+' <span style="color:var(--gn);font-size:10px">&#10003; Filed</span>'; }
    setTimeout(function(){loadStatus().then(loadProcessed);},2000);
  } else {
    btn.disabled=false; btn.innerHTML='&#10007; Retry'; btn.style.color='var(--rd)';
    setTimeout(function(){btn.innerHTML='&#128230; Send to GD';btn.style.color='';},8000);
  }
}

// ── Activity cards ────────────────────────────────────────────────────────────
function setLive(on, label) {
  $('live').className='live'+(on?' on':'');
  $('stxt').textContent=label||(on?'Processing\u2026':'Watching for files\u2026');
  $('sdot').className='dot'+(on?' g':'');
}

function setActivityFile(name) {
  $('act-sub').textContent = name ? 'Currently processing:' : 'Waiting for automation to run\u2026';
  var n=$('act-name'); n.textContent=name||''; n.style.display=name?'':'none';
}

function resetSteps() {
  $('progidle').style.display='flex';
  $('steplist').innerHTML='';
  $('rescard').innerHTML='';
}

function mkStep(id,label,msg,st){
  var ico=st==='running'?'<span class="spin"></span>':st==='done'?'\u2713':st==='error'?'\u2715':String(id);
  return '<div class="stepitem '+st+'" id="st-'+id+'" data-status="'+st+'">'
    +'<div class="stepico">'+ico+'</div>'
    +'<div style="flex:1;min-width:0"><div class="steplabel">'+esc(label)+'</div>'
    +(msg?'<div class="stepmsg">'+esc(msg)+'</div>':'')
    +'</div></div>';
}

function updStep(n,msg,st){
  STEPS.forEach(function(s){
    if(s.id<n){var el=$('st-'+s.id);if(el&&(el.dataset.status==='pending'||el.dataset.status==='running'))el.outerHTML=mkStep(s.id,s.l,'','done');}
  });
  var ex=$('st-'+n), step=STEPS.find(function(s){return s.id===n;});
  if(!step) return;
  if(ex) ex.outerHTML=mkStep(n,step.l,msg,st);
  else $('steplist').insertAdjacentHTML('beforeend',mkStep(n,step.l,msg,st));
}

function showResult(d){
  var files=(d.renamedFiles||[]).map(function(f){return '<div class="fpill">'+esc(f)+'</div>';}).join('');
  $('rescard').innerHTML='<div class="rescard">'
    +'<div class="restitle">&#9989; Complete</div>'
    +'<div class="resrow"><div class="reslbl">Customer</div><div class="resval">'+esc(d.customerName||'\u2014')+'</div></div>'
    +'<div class="resrow"><div class="reslbl">Reference</div><div class="resval">'+esc(d.ref||'\u2014')+'</div></div>'
    +'<div class="resrow"><div class="reslbl">Pages</div><div class="resval">'+(d.totalPages||'\u2014')+'</div></div>'
    +(d.googleDriveFolderUrl?'<div class="resrow"><div class="reslbl">Google Drive</div><div class="resval"><a class="reslink" href="'+d.googleDriveFolderUrl+'" target="_blank">Open \u2197</a></div></div>':'')
    +(d.oneDriveProcessedFolderUrl?'<div class="resrow"><div class="reslbl">OneDrive</div><div class="resval"><a class="reslink" href="'+d.oneDriveProcessedFolderUrl+'" target="_blank">Open \u2197</a></div></div>':'')
    +(files?'<div class="resrow" style="flex-direction:column;gap:2px"><div class="reslbl">Files</div>'+files+'</div>':'')
    +'</div>';
}

function showError(msg){
  $('rescard').innerHTML='<div class="rescard err"><div class="restitle">&#10060; Failed</div>'
    +'<div class="resrow"><div class="reslbl">Error</div><div class="resval" style="color:var(--rd)">'+esc(msg)+'</div></div></div>';
}

function handleEvt(ev,d){
  if(ev==='progress'){
    if(d.status==='running'){requestAnimationFrame(function(){updStep(d.step,d.message,d.status);});}
    else{updStep(d.step,d.message,d.status);}
  } else if(ev==='complete'){
    updStep(4,'All '+(d.totalPages||'')+' page(s) sent to Make.com \u2713','done');
    updStep(5,'All '+(d.totalPages||'')+' page(s) extracted by Claude \u2713','done');
    updStep(6,'All '+(d.totalPages||'')+' page(s) filed \u2713','done');
    showResult(d);
    onDone();
  } else if(ev==='error'){
    showError(d.message);
    onError();
  }
}

function onDone(){
  PROCESSING=false; CURRENT_FILE=null;
  setLive(false);
  hideRunArea();
  loadStatus().then(function(){loadScans();loadProcessed();});
  setTimeout(function(){if(!PROCESSING)setActivityFile(null);},10000);
}
function onError(){
  PROCESSING=false; CURRENT_FILE=null;
  setLive(false,'Error \u2014 check Vercel logs');
  hideRunArea();
  loadStatus().then(function(){loadScans();loadProcessed();});
}

// ── GD Retry: re-files all processed pages missing a Google Drive URL ─────────
function closeGDPanel(){
  var p=$('gdpanel'); if(p) p.classList.remove('open');
}

async function retryGD(){
  var btn=$('gd-retry-btn');
  btn.disabled=true; btn.innerHTML='<span class="spin"></span>';
  var panel=$('gdpanel'), body=$('gdp-body'), title=$('gdp-title');
  panel.classList.add('open');
  body.innerHTML='<div class="gdrow"><div class="gdrow-ic"><span class="spin"></span></div><div class="gdrow-body"><div class="gdrow-name">Connecting\u2026</div></div></div>';
  title.textContent='Google Drive Filing';
  var total=0,succeeded=0;
  function addRow(id,cls,ic,name,detail,linkUrl,linkTxt){
    var ex=body.querySelector('[data-gdrow="'+id+'"]');
    var html='<div class="gdrow '+cls+'" data-gdrow="'+esc(id)+'">'
      +'<div class="gdrow-ic">'+ic+'</div>'
      +'<div class="gdrow-body"><div class="gdrow-name" title="'+esc(name)+'">'+esc(name)+'</div>'
      +(detail?'<div class="gdrow-detail">'+esc(detail)+'</div>':'')
      +(linkUrl?'<a class="gdrow-link" href="'+esc(linkUrl)+'" target="_blank">Open '+(linkTxt||'folder')+' &#8599;</a>':'')
      +'</div></div>';
    if(ex) ex.outerHTML=html; else { body.insertAdjacentHTML('beforeend',html); var c=body.querySelector('[data-gdrow="connecting"]'); if(c)c.remove(); }
    body.scrollTop=body.scrollHeight;
  }
  try {
    var resp=await fetch('/api/gdrive?action=retry',{method:'POST'});
    var reader=resp.body.getReader(),dec=new TextDecoder(),buf='';
    body.innerHTML='';
    while(true){
      var chunk=await reader.read(); if(chunk.done) break;
      buf+=dec.decode(chunk.value,{stream:true});
      var lines=buf.split('\n'); buf=lines.pop();
      for(var i=0;i<lines.length;i++){
        var line=lines[i].trim();
        if(!line||line.startsWith(': ')) continue;
        if(line.startsWith('data: ')){
          try{
            var ev=JSON.parse(line.slice(6));
            if(ev.type==='start'){total=ev.total;title.textContent='Filing '+total+' file'+(total===1?'':'s')+' to Google Drive';}
            else if(ev.type==='file'&&ev.status==='filing'){addRow('f-'+ev.name,'filing','&#9203;',ev.name,'Filing '+ev.pages+' page(s)\u2026',null,null);}
            else if(ev.type==='file'&&ev.status==='success'){succeeded++;addRow('f-'+ev.name,'success','&#10003;',ev.name,ev.pages+' page(s) filed',ev.gdFolderUrl,'folder');}
            else if(ev.type==='file'&&ev.status==='failed'){addRow('f-'+ev.name,'failed','&#10007;',ev.name,'Failed',null,null);}
            else if(ev.type==='file'&&ev.status==='skipped'){addRow('f-'+ev.name,'skipped','&#8212;',ev.name,ev.reason||'Skipped',null,null);}
            else if(ev.type==='page'&&ev.status==='success'){addRow('p-'+ev.name+'-'+ev.page,'success','&#128196;',ev.fileName,'Page '+ev.page+' \u2192 '+(ev.folder||''),ev.gdFileUrl||ev.gdFolderUrl,ev.gdFileUrl?'file':'folder');}
            else if(ev.type==='page'&&ev.status==='failed'){addRow('p-'+ev.name+'-'+ev.page,'failed','&#10007;',ev.fileName,'Page '+ev.page+': '+(ev.reason||'failed'),null,null);}
            else if(ev.type==='done'){
              title.textContent='Google Drive Filing Complete';
              if(ev.total===0) body.innerHTML='<div class="gdrow success"><div class="gdrow-ic">&#10003;</div><div class="gdrow-body"><div class="gdrow-name">All files already in Google Drive</div></div></div>';
              setTimeout(function(){loadStatus().then(loadProcessed);},1500);
            }
          }catch(ex){}
        }
      }
    }
  } catch(err){
    body.insertAdjacentHTML('beforeend','<div class="gdrow failed"><div class="gdrow-ic">&#10007;</div><div class="gdrow-body"><div class="gdrow-name">Connection error</div><div class="gdrow-detail">'+esc(err.message)+'</div></div></div>');
  }
  btn.disabled=false; btn.innerHTML='&#128230; GD'; btn.style.color='var(--gn)';
}

// ── Watch a file via test-run SSE stream ──────────────────────────────────────
async function startWatching(file){
  if(PROCESSING) return;
  PROCESSING=true; CURRENT_FILE=file;
  setLive(true,'Processing \u2022 '+file.name);
  setActivityFile(file.name);
  $('progidle').style.display='none';
  $('steplist').innerHTML=STEPS.map(function(s){return mkStep(s.id,s.l,'','pending');}).join('');
  $('rescard').innerHTML='';
  // Mark file as active in scans list
  var el=$('sf-'+file.id);
  if(el){el.className='fi active-f';var ic=el.querySelector('.fic');if(ic)ic.innerHTML='<span class="spin" style="color:var(--or)"></span>';}
  try {
    var resp=await fetch('/api/test-run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:file.id,fileName:file.name,runMode:'auto',runStep:1})});
    if(!resp.ok){showError('Server error '+resp.status);onError();return;}
    var reader=resp.body.getReader(),dec=new TextDecoder(),buf='',evt=null;
    while(true){
      var chunk=await reader.read(); if(chunk.done) break;
      buf+=dec.decode(chunk.value,{stream:true});
      var lines=buf.split('\n'); buf=lines.pop();
      lines.forEach(function(line){
        if(line.startsWith('event: ')) evt=line.slice(7).trim();
        else if(line.startsWith('data: ')){ try{handleEvt(evt,JSON.parse(line.slice(6)));}catch(e){} }
        else if(line==='') evt=null;
      });
    }
    // Stream ended — do one status check in case complete event was missed
    if(PROCESSING){
      var rec=await api('/api/status?fileId='+encodeURIComponent(file.id));
      if(rec&&rec.record&&rec.record.status==='completed'){
        updStep(4,'All page(s) sent \u2713','done');
        updStep(5,'All page(s) extracted \u2713','done');
        updStep(6,'All page(s) filed \u2713','done');
        showResult(rec.record); onDone();
      } else if(PROCESSING){ onError(); }
    }
  } catch(err){ showError(err.message); onError(); }
}

// ── SSE Notify — zero Firestore reads ─────────────────────────────────────────
function openNotifyStream(){
  if(NOTIFY_ES){NOTIFY_ES.close();NOTIFY_ES=null;}
  var es=new EventSource('/api/notify');
  NOTIFY_ES=es;
  es.addEventListener('connected',function(){console.log('[dashboard] Notify connected');});
  es.addEventListener('new-file',function(e){
    try{
      var d=JSON.parse(e.data);
      loadScans();
      if(!PROCESSING&&d.files&&d.files.length>0) startWatching(d.files[0]);
    }catch(ex){}
  });
  es.addEventListener('reconnect',function(){es.close();NOTIFY_ES=null;setTimeout(openNotifyStream,1000);});
  es.onerror=function(){es.close();NOTIFY_ES=null;setTimeout(openNotifyStream,5000);};
}

// ── Init — runs once, then everything is event-driven ─────────────────────────
// loadScans and loadProcessed fire immediately from OneDrive — no Firestore needed
// loadStatus (Firestore) runs in parallel and enriches the view when it resolves
// If Firestore is over quota it times out after 8s — columns still show from OneDrive
loadScans();      // OneDrive — works even when Firestore is unavailable
loadProcessed();  // OneDrive — works even when Firestore is unavailable
loadStatus().then(function() {
  // Re-render with Firestore metadata (customer, ref, GD links) if it loaded
  loadScans();
  loadProcessed();
});
openNotifyStream();
// NO setInterval calls — dashboard is completely passive when idle
</script>
</body></html>`;
