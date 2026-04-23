/**
 * /api/dashboard
 *
 * Grove PDF Router — monitoring dashboard.
 *
 * On every page load (server-side):
 *   1. Fetches Scans folder from OneDrive       — shows unprocessed files
 *   2. Fetches Processed folder from OneDrive   — shows filed files
 *   3. ONE Firestore batch read of completed records (by renamed file name)
 *      — enriches processed files with GD link, customer, ref
 *
 * After page load (client-side):
 *   - SSE /api/notify stream held open
 *   - When Make.com fires scan-now → notify pushes "new-file" event
 *   - Dashboard refreshes Scans column via /api/scan-files (no Firebase)
 *   - Manual run: click file → "Process File" button → /api/test-run SSE
 *
 * Zero automatic polling. Zero Firebase reads after initial load.
 */

module.exports.config = { maxDuration: 60 };

const SCANS_PATH     = 'Grove Group Scotland/Grove Bedding/Scans';
const PROCESSED_PATH = 'Grove Group Scotland/Grove Bedding/Scans/Processed';

async function fetchODFolder(graphRequest, userId, folderPath) {
  const path = `/users/${userId}/drive/root:/${folderPath}:/children` +
    `?$select=id,name,size,createdDateTime,webUrl,file&$top=500`;
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('OneDrive timeout')), 25000));
  const result = await Promise.race([graphRequest('GET', path), timeout]);
  return (result?.value || [])
    .filter(f => {
      const n = (f.name || '').toLowerCase();
      return (n.endsWith('.pdf') || (f.file?.mimeType || '').includes('pdf')) && !n.startsWith('~');
    })
    .map(f => ({ id: f.id, name: f.name, size: f.size, createdAt: f.createdDateTime, webUrl: f.webUrl }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function fetchFirestoreRecords() {
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
      admin.firestore().settings({ preferRest: true });
    }
    const snap = await admin.firestore()
      .collection('processedFiles')
      .where('status', '==', 'completed')
      .limit(300)
      .get();

    // Build a map: renamedFile (lowercased) → { customerName, ref, gdUrl, odUrl }
    const byName = {};
    snap.docs.forEach(doc => {
      const d = doc.data();
      const gdUrl = d.googleDriveFolderUrl ||
        Object.values(d.pages || {}).map(p => p?.googleDrive?.folderUrl).find(u => !!u) || null;
      (d.renamedFiles || []).forEach(fname => {
        byName[fname.toLowerCase()] = {
          customerName: d.customerName || null,
          ref:          d.ref || null,
          gdUrl,
          odUrl: d.oneDriveProcessedFolderUrl || null,
        };
      });
    });
    console.log(`[dashboard] Firestore: ${snap.size} completed record(s) loaded`);
    return byName;
  } catch (err) {
    console.warn('[dashboard] Firestore fetch failed (non-fatal):', err.message);
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  let scanFiles = [], procFiles = [], fsRecords = {};
  let scanError = null, procError = null;

  try {
    const { graphRequest } = require('../lib/graph');
    const userId = process.env.ONEDRIVE_USER_ID;
    if (!userId) throw new Error('ONEDRIVE_USER_ID not set');

    // Fetch all three in parallel — OneDrive Scans, OneDrive Processed, Firestore
    const [sr, pr, fr] = await Promise.allSettled([
      fetchODFolder(graphRequest, userId, SCANS_PATH),
      fetchODFolder(graphRequest, userId, PROCESSED_PATH),
      fetchFirestoreRecords(),
    ]);

    console.log('[dashboard] OneDrive Scans status:', sr.status);
    console.log('[dashboard] OneDrive Processed status:', pr.status);
    if (sr.status === 'fulfilled') {
      scanFiles = sr.value;
      console.log(`[dashboard] Scans: ${scanFiles.length} file(s)`);
    } else {
      scanError = sr.reason?.graphMessage || sr.reason?.message || 'OneDrive error';
      console.error('[dashboard] Scans failed:', scanError);
    }
    if (pr.status === 'fulfilled') {
      procFiles = pr.value;
      console.log(`[dashboard] Processed: ${procFiles.length} file(s)`);
    } else {
      procError = pr.reason?.graphMessage || pr.reason?.message || 'OneDrive error';
      console.error('[dashboard] Processed failed:', procError);
    }
    if (fr.status === 'fulfilled') {
      fsRecords = fr.value;
    }

    // Enrich processed files with Firestore metadata
    procFiles = procFiles.map(f => {
      const meta = fsRecords[f.name.toLowerCase()] || {};
      return { ...f, customerName: meta.customerName || null, ref: meta.ref || null, gdUrl: meta.gdUrl || null };
    });

  } catch (err) {
    const msg = err.graphMessage || err.message;
    console.error('[dashboard] Fatal:', msg);
    scanError = msg; procError = msg;
  }

  function safeJson(v) {
    return JSON.stringify(v).replace(/<\/script>/gi, '<\\/script>');
  }

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grove PDF Router</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f8fafc;--card:#ffffff;--border:#e2e8f0;--border2:#cbd5e1;
  --tx:#1e293b;--mu:#64748b;--sm:#94a3b8;
  --sky:#0ea5e9;--sky2:#0284c7;--skyb:#e0f2fe;--skybr:#bae6fd;
  --em:#10b981;--emb:#ecfdf5;--embr:#a7f3d0;
  --rd:#ef4444;--rdb:#fef2f2;--rdbr:#fecaca;
  --am:#f59e0b;--amb:#fffbeb;--ambr:#fde68a;
  --sl:#475569;
  --or:#0ea5e9;
}
body{background:var(--bg);color:var(--tx);font-family:'Inter',system-ui,sans-serif;height:100vh;display:flex;flex-direction:column}
/* Header */
.hdr{background:var(--card);border-bottom:1px solid var(--border);padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.hdr-left{display:flex;align-items:center;gap:10px}
.hdr-logo{width:32px;height:32px;background:linear-gradient(135deg,#0ea5e9,#0284c7);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.hdr-title{font-size:14px;font-weight:700;color:var(--tx)}
.hdr-sub{font-size:11px;color:var(--mu);margin-top:1px}
.hdr-right{display:flex;align-items:center;gap:8px}
.hbtn{display:flex;align-items:center;gap:5px;padding:5px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--mu);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s}
.hbtn:hover{border-color:var(--sky);color:var(--sky)}
.hbtn.active{background:var(--skyb);border-color:var(--skybr);color:var(--sky2)}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--sm)}
.status-dot.live{background:var(--em);box-shadow:0 0 0 2px var(--embr)}
.status-txt{font-size:11px;color:var(--mu);font-weight:500}
/* Main grid */
.main{display:grid;grid-template-columns:1fr 1fr;gap:0;flex:1;overflow:hidden;min-height:0}
.col{display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--border);min-height:0}
.col:last-child{border-right:none}
.col-head{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:var(--card)}
.col-title{display:flex;align-items:center;gap:8px}
.col-icon{width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}
.col-icon.scan{background:#e0f2fe;color:#0ea5e9}
.col-icon.proc{background:#dcfce7;color:#16a34a}
.col-ht{font-size:13px;font-weight:700;color:var(--tx)}
.col-hm{font-size:10px;color:var(--mu);margin-top:1px;font-family:monospace}
.col-btn{width:28px;height:28px;border-radius:7px;border:1px solid var(--border);background:var(--card);color:var(--mu);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}
.col-btn:hover{border-color:var(--sky);color:var(--sky)}
/* File list */
.flist{overflow-y:auto;flex:1;padding:8px;min-height:0}
.flist::-webkit-scrollbar{width:4px}.flist::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.fi{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);margin-bottom:5px;background:var(--card);cursor:pointer;transition:all .15s}
.fi:hover{border-color:var(--border2);box-shadow:0 1px 4px rgba(0,0,0,.06)}
.fi.sel{border-color:var(--sky)!important;background:var(--skyb)!important;box-shadow:0 0 0 3px var(--skybr)}
.fi.active{border-color:var(--am);background:var(--amb)}
.fi-icon{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.fi-icon.scan{background:#e0f2fe}
.fi-icon.proc{background:#dcfce7}
.fi-icon.active{background:#fef3c7}
.fi-body{flex:1;min-width:0}
.fi-name{font-size:12px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fi-meta{font-size:10px;color:var(--mu);margin-top:2px;font-family:monospace}
.fi-tags{display:flex;gap:4px;margin-top:3px;flex-wrap:wrap}
.tag{font-size:9px;padding:1px 6px;border-radius:12px;font-weight:700;font-family:monospace}
.tag.gd{background:#dcfce7;border:1px solid #a7f3d0;color:#15803d}
.tag.od{background:#e0f2fe;border:1px solid #bae6fd;color:#0369a1}
.tag.pend{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
.fi-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.fi-radio{width:16px;height:16px;border-radius:50%;border:2px solid var(--border2);display:flex;align-items:center;justify-content:center;transition:all .15s}
.fi.sel .fi-radio{border-color:var(--sky);background:var(--sky)}
.fi-radio-dot{width:6px;height:6px;border-radius:50%;background:#fff}
.rstbtn{width:22px;height:22px;border-radius:6px;border:1px solid transparent;background:none;color:var(--sm);font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:all .15s}
.fi:hover .rstbtn{opacity:1}
.rstbtn:hover{border-color:var(--rd);color:var(--rd)}
/* Expanded proc row */
.proc-expand{padding:0 12px 10px 56px;border-top:1px solid var(--border);background:#fafafa;display:none}
.proc-expand.open{display:block}
.proc-row{display:flex;gap:8px;margin-top:7px;font-size:10px}
.proc-lbl{color:var(--mu);min-width:60px;flex-shrink:0;font-weight:600}
.proc-val{color:var(--tx);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.proc-link{color:var(--sky);text-decoration:none;font-size:10px}
.proc-link:hover{text-decoration:underline}
/* Run panel */
.run-panel{background:var(--card);border-top:2px solid var(--sky);padding:12px 16px;flex-shrink:0;display:none}
.run-panel.show{display:block}
.run-file{font-size:11px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.run-meta{font-size:10px;color:var(--mu);margin-bottom:10px;font-family:monospace}
.run-btn{width:100%;padding:10px;border-radius:10px;border:none;background:var(--sky);color:#fff;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;transition:background .15s}
.run-btn:hover{background:var(--sky2)}
.run-btn:disabled{background:#cbd5e1;color:#94a3b8;cursor:not-allowed}
/* Empty state */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:40px 20px;color:var(--sm);text-align:center;height:100%}
.empty-ic{font-size:32px;opacity:.5}
.empty-ti{font-size:13px;font-weight:600;color:var(--mu)}
.empty-de{font-size:11px;line-height:1.5}
.error-state{display:flex;flex-direction:column;align-items:center;gap:8px;padding:32px;text-align:center}
.error-ic{font-size:28px}
.error-ti{font-size:12px;font-weight:600;color:var(--rd)}
.error-de{font-size:10px;color:var(--mu);line-height:1.5}
/* Pipeline visualiser */
.pipe-wrap{background:var(--card);border-top:1px solid var(--border);padding:14px 20px;flex-shrink:0}
.pipe-status{display:flex;justify-content:flex-end;margin-bottom:6px}
.pill{display:flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;border:1px solid;font-size:10px;font-weight:700;font-family:monospace}
.pill.idle{background:#f8fafc;border-color:#e2e8f0;color:#94a3b8}
.pill.running{background:#e0f2fe;border-color:#bae6fd;color:#0369a1}
.pill.done{background:#dcfce7;border-color:#a7f3d0;color:#15803d}
.pill.error{background:#fef2f2;border-color:#fecaca;color:#991b1b}
.pill-dot{width:6px;height:6px;border-radius:50%}
.pipe-row{display:flex;align-items:flex-start;justify-content:center;overflow-x:auto;padding-bottom:4px}
.pipe-step{display:flex;flex-direction:column;align-items:center;width:76px;flex-shrink:0}
.pipe-circle{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:2.5px solid;transition:all .5s;position:relative;flex-shrink:0}
.pipe-label{font-size:10px;font-weight:700;text-align:center;margin-top:5px;transition:color .5s}
.pipe-sub{font-size:9px;color:var(--sm);text-align:center;line-height:1.2;padding:0 2px}
.pipe-badge{display:flex;align-items:center;gap:3px;margin-top:4px}
.pipe-bdot{width:5px;height:5px;border-radius:50%}
.pipe-btxt{font-size:8px;font-weight:700;font-family:monospace;text-transform:uppercase}
.pipe-ts{font-size:8px;color:var(--sm);margin-top:2px;font-family:monospace}
.pipe-arrow{display:flex;align-items:center;margin-top:20px;width:20px;flex-shrink:0}
.pipe-arrow-line{flex:1;height:1.5px;transition:background .5s}
.pipe-arrow-head{width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:6px solid;transition:border-left-color .5s}
/* spin */
@keyframes spin{to{transform:rotate(360deg)}}
.spin{display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,.3);border-top-color:currentColor;border-radius:50%;animation:spin .7s linear infinite}
.spin-ring{position:absolute;inset:-5px;border-radius:50%;border:2.5px solid transparent;border-top-color:var(--sky);animation:spin .8s linear infinite}
/* Result card */
.result-card{margin-top:10px;padding:10px 14px;border-radius:10px;background:#ecfdf5;border:1px solid #a7f3d0}
.result-card.err{background:#fef2f2;border-color:#fecaca}
.result-title{font-size:11px;font-weight:700;color:#15803d;margin-bottom:6px}
.result-card.err .result-title{color:#991b1b}
.result-row{display:flex;gap:6px;margin-bottom:3px;font-size:10px}
.result-lbl{color:var(--mu);min-width:70px;flex-shrink:0;font-weight:600}
.result-val{color:var(--tx);word-break:break-all}
.result-link{color:var(--sky);text-decoration:none}
.result-link:hover{text-decoration:underline}
/* Diag panel */
.panel{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:8px 12px 0}
.panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.panel-title{font-size:12px;font-weight:700;color:var(--tx);display:flex;align-items:center;gap:6px}
.panel-close{background:none;border:none;color:var(--sm);cursor:pointer;font-size:15px;line-height:1}
.panel-close:hover{color:var(--tx)}
.diag-row{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:8px;border:1px solid;margin-bottom:5px;font-size:11px}
.diag-row.ok{background:#ecfdf5;border-color:#a7f3d0}
.diag-row.fail{background:#fef2f2;border-color:#fecaca}
.diag-ic{flex-shrink:0;font-size:13px}
.diag-label{font-weight:700;color:var(--tx)}
.diag-detail{font-family:monospace;font-size:10px;margin-top:1px}
.diag-row.ok .diag-detail{color:#15803d}
.diag-row.fail .diag-detail{color:#991b1b}
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-left">
    <div class="hdr-logo">&#128196;</div>
    <div>
      <div class="hdr-title">Grove PDF Router</div>
      <div class="hdr-sub">OneDrive &middot; Make.com &middot; Google Drive</div>
    </div>
  </div>
  <div class="hdr-right">
    <div class="status-dot" id="status-dot"></div>
    <span class="status-txt" id="status-txt">Idle</span>
    <button class="hbtn" id="diag-btn" id="diag-btn-hdr">&#128269; Diag</button>
    <button class="hbtn" id="gd-btn" id="gd-btn-hdr">&#9729; GD Retry</button>
  </div>
</div>

<div id="diag-panel" style="display:none">
  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">&#128270; System Diagnostics</span>
      <button class="panel-close" id="diag-btn-hdr">&#10005;</button>
    </div>
    <div id="diag-body"><div style="color:var(--mu);font-size:11px">Running checks&#8230;</div></div>
  </div>
</div>

<div class="main">

  <!-- SCANS COLUMN -->
  <div class="col" id="scan-col">
    <div class="col-head">
      <div class="col-title">
        <div class="col-icon scan">&#128228;</div>
        <div>
          <div class="col-ht">Scans</div>
          <div class="col-hm" id="scan-count">Loading&#8230;</div>
        </div>
      </div>
      <button class="col-btn" title="Refresh" id="scan-refresh-btn">&#8635;</button>
    </div>
    <div class="flist" id="scan-list">
      <div class="empty"><div class="empty-ic">&#128194;</div><div class="empty-ti">Loading files&#8230;</div></div>
    </div>
    <div class="run-panel" id="run-panel">
      <div class="run-file" id="run-fname"></div>
      <div class="run-meta" id="run-fmeta"></div>
      <button class="run-btn" id="run-btn">&#9654;&#xFE0E; Process File</button>
    </div>
  </div>

  <!-- PROCESSED COLUMN -->
  <div class="col" id="proc-col">
    <div class="col-head">
      <div class="col-title">
        <div class="col-icon proc">&#9989;</div>
        <div>
          <div class="col-ht">Processed</div>
          <div class="col-hm" id="proc-count">Loading&#8230;</div>
        </div>
      </div>
      <button class="col-btn" title="Refresh" id="proc-refresh-btn">&#8635;</button>
    </div>
    <div class="flist" id="proc-list">
      <div class="empty"><div class="empty-ic">&#128194;</div><div class="empty-ti">Loading files&#8230;</div></div>
    </div>
  </div>

</div>

<!-- PIPELINE VISUALISER (full width, below the two columns) -->
<div class="pipe-wrap">
  <div class="pipe-status"><div class="pill idle" id="pipe-pill"><div class="pill-dot" style="background:#94a3b8"></div><span>Idle</span></div></div>
  <div class="pipe-row" id="pipe-row"></div>
  <div id="result-area"></div>
</div>

<script>
(function(){
'use strict';

// ── Server-injected data ──────────────────────────────────────────────────────
var SCAN_DATA  = ${safeJson(scanFiles)};
var PROC_DATA  = ${safeJson(procFiles)};
var SCAN_ERROR = ${safeJson(scanError)};
var PROC_ERROR = ${safeJson(procError)};

// ── State ─────────────────────────────────────────────────────────────────────
var PROCESSING  = false;
var SELECTED    = null;
var CURRENT     = null;
var NOTIFY_ES   = null;

var STEPS = [
  {id:1, icon:'☁️',  label:'OneDrive',      sub:'File detected'},
  {id:2, icon:'⬇️',  label:'Download',      sub:'Pull from OD'},
  {id:3, icon:'📄',  label:'Split PDF',     sub:'Separate pages'},
  {id:4, icon:'⚡',  label:'Make.com',      sub:'Send to webhook'},
  {id:5, icon:'🧠',  label:'Claude AI',     sub:'Extract data'},
  {id:6, icon:'📁',  label:'OneDrive',      sub:'Move to Processed'},
  {id:7, icon:'🟢',  label:'Google Drive',  sub:'Copy to GD'},
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s){ return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''; }
function el(id){ return document.getElementById(id); }
function fdate(iso){
  if(!iso) return '';
  try{
    var d=new Date(iso);
    return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})
      +' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }catch(e){return '';}
}
function fsize(b){
  if(!b) return '';
  var k=1024,s=['B','KB','MB','GB'],i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+' '+s[i];
}
function now(){ return new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
async function api(url,opts){
  try{
    var c=new AbortController(),t=setTimeout(function(){c.abort();},30000);
    var r=await fetch(url,Object.assign({signal:c.signal},opts||{}));
    clearTimeout(t);
    if(!r.ok){ var e=await r.json().catch(function(){return{error:'HTTP '+r.status};}); return e; }
    return await r.json().catch(function(){return null;});
  }catch(e){ console.error('[api]',url,e.message); return null; }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────
var stepState = {}; // id → {status:'idle'|'running'|'done'|'error', ts:''}
STEPS.forEach(function(s){ stepState[s.id]={status:'idle',ts:''}; });

function buildPipeline(){
  var row=el('pipe-row');
  row.innerHTML='';
  STEPS.forEach(function(s,idx){
    var st=stepState[s.id];
    var col={
      idle:   {border:'#e2e8f0',bg:'#f8fafc',txt:'#94a3b8',dot:'#cbd5e1'},
      running:{border:'#0ea5e9',bg:'#e0f2fe',txt:'#0369a1',dot:'#0ea5e9'},
      done:   {border:'#10b981',bg:'#dcfce7', txt:'#065f46',dot:'#10b981'},
      error:  {border:'#ef4444',bg:'#fef2f2', txt:'#991b1b',dot:'#ef4444'},
    }[st.status];

    // Circle
    var div=document.createElement('div');
    div.className='pipe-step';
    div.id='step-'+s.id;

    var circ=document.createElement('div');
    circ.className='pipe-circle';
    circ.style.borderColor=col.border;
    circ.style.background=col.bg;
    if(st.status==='running'){
      var ring=document.createElement('div');
      ring.className='spin-ring';
      circ.appendChild(ring);
    }
    var icon=document.createElement('span');
    icon.textContent=s.icon;
    icon.style.filter=st.status==='idle'?'grayscale(1) opacity(.35)':'none';
    icon.style.fontSize='18px';
    circ.appendChild(icon);
    div.appendChild(circ);

    // Label
    var lbl=document.createElement('p');
    lbl.className='pipe-label';
    lbl.textContent=s.label;
    lbl.style.color=col.txt;
    div.appendChild(lbl);

    // Sublabel
    var sub=document.createElement('p');
    sub.className='pipe-sub';
    sub.textContent=s.sub;
    div.appendChild(sub);

    // Badge
    var badge=document.createElement('div');
    badge.className='pipe-badge';
    var bdot=document.createElement('div');
    bdot.className='pipe-bdot';
    bdot.style.background=col.dot;
    var btxt=document.createElement('span');
    btxt.className='pipe-btxt';
    btxt.textContent=st.status;
    btxt.style.color=col.dot;
    badge.appendChild(bdot); badge.appendChild(btxt);
    div.appendChild(badge);

    // Timestamp
    if(st.ts){
      var ts=document.createElement('p');
      ts.className='pipe-ts';
      ts.textContent=st.ts;
      div.appendChild(ts);
    }

    row.appendChild(div);

    // Arrow between steps
    if(idx<STEPS.length-1){
      var next=stepState[s.id+1];
      var active=next.status!=='idle';
      var arr=document.createElement('div');
      arr.className='pipe-arrow';
      arr.style.marginTop='20px';
      var line=document.createElement('div');
      line.className='pipe-arrow-line';
      line.style.background=active?'#10b981':'#e2e8f0';
      var head=document.createElement('div');
      head.className='pipe-arrow-head';
      head.style.borderLeftColor=active?'#10b981':'#e2e8f0';
      arr.appendChild(line); arr.appendChild(head);
      row.appendChild(arr);
    }
  });
}

function updateStep(id, status, ts){
  // Mark all previous steps as done
  STEPS.forEach(function(s){
    if(s.id<id && (stepState[s.id].status==='idle'||stepState[s.id].status==='running')){
      stepState[s.id]={status:'done',ts:ts||now()};
    }
  });
  stepState[id]={status:status,ts:ts||now()};
  buildPipeline();
}

function resetPipeline(){
  STEPS.forEach(function(s){ stepState[s.id]={status:'idle',ts:''}; });
  buildPipeline();
  el('result-area').innerHTML='';
}

function setPillStatus(st){
  var pill=el('pipe-pill');
  var cfg={
    idle:   {cls:'idle',   dot:'#94a3b8',label:'Idle'},
    running:{cls:'running',dot:'#0ea5e9',label:'Running'},
    done:   {cls:'done',   dot:'#10b981',label:'Complete'},
    error:  {cls:'error',  dot:'#ef4444',label:'Failed'},
  }[st];
  pill.className='pill '+cfg.cls;
  pill.innerHTML='<div class="pill-dot" style="background:'+cfg.dot+'"></div><span>'+cfg.label+'</span>';
}

function setStatus(on,label){
  el('status-dot').className='status-dot'+(on?' live':'');
  el('status-txt').textContent=label||(on?'Processing\u2026':'Idle');
}

// ── Scans column ──────────────────────────────────────────────────────────────
function renderScans(files, error){
  var list=el('scan-list'), count=el('scan-count');
  if(error){
    count.textContent='Error';
    list.innerHTML='<div class="error-state"><div class="error-ic">&#10060;</div>'
      +'<div class="error-ti">Failed to load Scans</div>'
      +'<div class="error-de">'+esc(error)+'<br><a href="/api/diag" target="_blank" style="color:var(--sky)">Run diagnostics &#8599;</a></div></div>';
    return;
  }
  count.textContent=files.length+' file'+(files.length===1?'':'s')+' \u00b7 OneDrive Scans';
  list.innerHTML='';
  if(!files.length){
    list.innerHTML='<div class="empty"><div class="empty-ic">&#10003;</div><div class="empty-ti">Scans folder is empty</div><div class="empty-de">Files appear here when Make.com detects a new upload</div></div>';
    return;
  }
  files.forEach(function(f){
    var isActive=CURRENT&&CURRENT.id===f.id;
    var isSel=SELECTED&&SELECTED.id===f.id&&!isActive;
    var row=document.createElement('div');
    row.className='fi'+(isActive?' active':isSel?' sel':'');
    row.id='sf-'+f.id;

    var rst=document.createElement('button');
    rst.className='rstbtn'; rst.title='Reset file'; rst.innerHTML='&#8635;';
    rst.addEventListener('click',function(e){e.stopPropagation();doReset(f.id);});

    row.innerHTML=
      '<div class="fi-icon '+(isActive?'active':'scan')+'">'+(isActive?'&#9203;':'&#128196;')+'</div>'
      +'<div class="fi-body">'
        +'<div class="fi-name">'+esc(f.name)+'</div>'
        +'<div class="fi-meta">'+fsize(f.size)+(f.createdAt?' \u00b7 '+fdate(f.createdAt):'')+''+(isActive?' \u00b7 <span style="color:#f59e0b;font-weight:700">Processing\u2026</span>':'')+'</div>'
      +'</div>'
      +'<div class="fi-right"></div>';

    var right=row.querySelector('.fi-right');
    right.appendChild(rst);
    var radio=document.createElement('div');
    radio.className='fi-radio';
    if(isSel) radio.innerHTML='<div class="fi-radio-dot"></div>';
    right.appendChild(radio);

    row.addEventListener('click',function(){selectFile(f);});
    list.appendChild(row);
  });
}

function selectFile(f){
  if(PROCESSING) return;
  SELECTED=f;
  document.querySelectorAll('#scan-list .fi.sel').forEach(function(e){e.classList.remove('sel');});
  var row=el('sf-'+f.id); if(row) row.classList.add('sel');
  el('run-fname').textContent=f.name;
  el('run-fmeta').textContent=fsize(f.size)+(f.createdAt?' \u00b7 '+fdate(f.createdAt):'');
  el('run-panel').className='run-panel show';
  var btn=el('run-btn'); btn.disabled=false; btn.innerHTML='&#9654;&#xFE0E; Process File';
}

function hideRunPanel(){
  SELECTED=null;
  el('run-panel').className='run-panel';
  document.querySelectorAll('#scan-list .fi.sel').forEach(function(e){e.classList.remove('sel');});
}

async function refreshScans(){
  el('scan-list').innerHTML='<div class="empty"><div class="empty-ic">&#128194;</div><div class="empty-ti">Loading\u2026</div></div>';
  el('scan-count').textContent='\u2014';
  var d=await api('/api/scan-files');
  SCAN_DATA=(d&&d.success)?d.files||[]:[];
  renderScans(SCAN_DATA,(d&&d.success)?null:(d&&d.error?d.error:'Could not reach OneDrive'));
}

// ── Processed column ──────────────────────────────────────────────────────────
function renderProcessed(files, error){
  var list=el('proc-list'), count=el('proc-count');
  if(error){
    count.textContent='Error';
    list.innerHTML='<div class="error-state"><div class="error-ic">&#10060;</div>'
      +'<div class="error-ti">Failed to load Processed</div>'
      +'<div class="error-de">'+esc(error)+'</div></div>';
    return;
  }
  count.textContent=files.length+' file'+(files.length===1?'':'s')+' \u00b7 OneDrive Processed';
  list.innerHTML='';
  if(!files.length){
    list.innerHTML='<div class="empty"><div class="empty-ic">&#128100;</div><div class="empty-ti">No processed files yet</div><div class="empty-de">Files appear here after automation runs</div></div>';
    return;
  }
  files.forEach(function(f,idx){
    var wrap=document.createElement('div');
    wrap.style.marginBottom='5px';

    var row=document.createElement('div');
    row.className='fi';
    row.style.cursor='pointer';

    var hasGd=!!f.gdUrl, hasOd=!!f.webUrl;
    var tags='';
    if(hasGd) tags+='<span class="tag gd">GD &#10003;</span>';
    if(hasOd) tags+='<span class="tag od">OD &#10003;</span>';
    if(!hasGd&&f.customerName) tags+='<span class="tag pend">GD pending</span>';

    row.innerHTML=
      '<div class="fi-icon proc">&#9989;</div>'
      +'<div class="fi-body">'
        +'<div class="fi-name">'+esc(f.name)+'</div>'
        +'<div class="fi-meta">'+fsize(f.size)+(f.createdAt?' \u00b7 '+fdate(f.createdAt):'')+'</div>'
        +(tags?'<div class="fi-tags">'+tags+'</div>':'')
      +'</div>'
      +'<div class="fi-right"><span style="font-size:12px;color:var(--sm)">&#8964;</span></div>';

    var exp=document.createElement('div');
    exp.className='proc-expand';
    exp.id='pe-'+idx;

    var rows='';
    if(f.customerName) rows+='<div class="proc-row"><span class="proc-lbl">Customer</span><span class="proc-val">'+esc(f.customerName)+'</span></div>';
    if(f.ref) rows+='<div class="proc-row"><span class="proc-lbl">Reference</span><span class="proc-val">'+esc(f.ref)+'</span></div>';
    if(f.size) rows+='<div class="proc-row"><span class="proc-lbl">Size</span><span class="proc-val">'+esc(fsize(f.size))+'</span></div>';
    if(f.createdAt) rows+='<div class="proc-row"><span class="proc-lbl">Filed</span><span class="proc-val">'+esc(fdate(f.createdAt))+'</span></div>';
    if(f.webUrl) rows+='<div class="proc-row"><span class="proc-lbl">OneDrive</span><a class="proc-link" href="'+esc(f.webUrl)+'" target="_blank">Open file &#8599;</a></div>';
    if(f.gdUrl) rows+='<div class="proc-row"><span class="proc-lbl">Google Drive</span><a class="proc-link" href="'+esc(f.gdUrl)+'" target="_blank">Open folder &#8599;</a></div>';
    if(!rows) rows='<div class="proc-row"><span class="proc-lbl" style="color:var(--sm)">No metadata</span></div>';
    exp.innerHTML=rows;

    row.addEventListener('click',function(){
      var open=exp.classList.contains('open');
      document.querySelectorAll('.proc-expand.open').forEach(function(e){e.classList.remove('open');});
      if(!open) exp.classList.add('open');
    });

    wrap.appendChild(row); wrap.appendChild(exp);
    list.appendChild(wrap);
  });
}

async function refreshProcessed(){
  el('proc-list').innerHTML='<div class="empty"><div class="empty-ic">&#128194;</div><div class="empty-ti">Loading\u2026</div></div>';
  el('proc-count').textContent='\u2014';
  var d=await api('/api/scan-files?folder=Processed');
  PROC_DATA=(d&&d.success)?d.files||[]:[];
  // On refresh we lose the Firestore metadata (GD links) — show what OneDrive has
  renderProcessed(PROC_DATA,(d&&d.success)?null:(d&&d.error?d.error:'Could not reach OneDrive'));
}

// ── Reset ─────────────────────────────────────────────────────────────────────
async function doReset(fid){
  if(!confirm('Reset this file so it can be reprocessed?')) return;
  var d=await api('/api/admin?action=reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:fid})});
  if(d&&d.success) refreshScans();
  else alert('Reset failed: '+(d&&d.error?d.error:'Unknown'));
}

// ── Run a file via test-run SSE ───────────────────────────────────────────────
async function startWatching(file){
  if(PROCESSING) return;
  PROCESSING=true; CURRENT=file;
  SELECTED=null;
  setStatus(true,'Processing \u2022 '+file.name);
  setPillStatus('running');
  resetPipeline();
  el('result-area').innerHTML='';

  // Update the row visually
  var row=el('sf-'+file.id);
  if(row){ row.className='fi active'; }

  try{
    var resp=await fetch('/api/test-run',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({fileId:file.id,fileName:file.name,runMode:'auto',runStep:1})
    });
    if(!resp.ok){ showError('Server error '+resp.status,1); return; }

    var reader=resp.body.getReader(),dec=new TextDecoder(),buf='',evt=null;
    while(true){
      var chunk=await reader.read(); if(chunk.done) break;
      buf+=dec.decode(chunk.value,{stream:true});
      var lines=buf.split('\n'); buf=lines.pop();
      lines.forEach(function(line){
        if(line.startsWith('event: ')){ evt=line.slice(7).trim(); return; }
        if(line.startsWith('data: ')){
          try{
            var d=JSON.parse(line.slice(6));
            if(evt==='progress'){
              var ps=d.step||0;
              if(d.status==='running') updateStep(ps,'running');
              else if(d.status==='done') updateStep(ps,'done');
              else if(d.status==='error') updateStep(ps,'error');
            } else if(evt==='complete'){
              STEPS.forEach(function(s){ updateStep(s.id,'done'); });
              showResult(d); onDone();
            } else if(evt==='error'){
              updateStep(d.step||1,'error');
              showError(d.message||'Unknown error',d.step||1);
              onErr();
            }
          }catch(e){}
        }
        if(line==='') evt=null;
      });
    }
    // Stream ended without complete event — check status
    if(PROCESSING){
      var rec=await api('/api/status?fileId='+encodeURIComponent(file.id));
      if(rec&&rec.record&&rec.record.status==='completed'){
        STEPS.forEach(function(s){ updateStep(s.id,'done'); });
        showResult(rec.record); onDone();
      } else if(PROCESSING){ showError('Stream ended unexpectedly',0); onErr(); }
    }
  }catch(err){ showError(err.message,0); onErr(); }
}

function onDone(){
  PROCESSING=false; CURRENT=null;
  setStatus(false,'Idle'); setPillStatus('done');
  hideRunPanel();
  setTimeout(function(){
    if(!PROCESSING){
      setStatus(false,'Idle');
      refreshScans(); refreshProcessed();
    }
  },8000);
}

function onErr(){
  PROCESSING=false; CURRENT=null;
  setStatus(false,'Error'); setPillStatus('error');
  hideRunPanel();
  setTimeout(function(){ if(!PROCESSING) setStatus(false,'Idle'); },15000);
  refreshScans();
}

function showResult(d){
  var files=(d.renamedFiles||[]).map(function(f){
    return '<span style="font-family:monospace;font-size:9px;background:#e0f2fe;padding:1px 5px;border-radius:4px;margin:1px">'+esc(f)+'</span>';
  }).join(' ');
  el('result-area').innerHTML=
    '<div class="result-card">'
    +'<div class="result-title">&#9989; Processing Complete</div>'
    +(d.customerName?'<div class="result-row"><span class="result-lbl">Customer</span><span class="result-val">'+esc(d.customerName)+'</span></div>':'')
    +(d.ref?'<div class="result-row"><span class="result-lbl">Reference</span><span class="result-val">'+esc(d.ref)+'</span></div>':'')
    +(d.totalPages?'<div class="result-row"><span class="result-lbl">Pages</span><span class="result-val">'+d.totalPages+'</span></div>':'')
    +(d.googleDriveFolderUrl?'<div class="result-row"><span class="result-lbl">Google Drive</span><a class="result-link" href="'+esc(d.googleDriveFolderUrl)+'" target="_blank">Open folder &#8599;</a></div>':'')
    +(d.oneDriveProcessedFolderUrl?'<div class="result-row"><span class="result-lbl">OneDrive</span><a class="result-link" href="'+esc(d.oneDriveProcessedFolderUrl)+'" target="_blank">Open folder &#8599;</a></div>':'')
    +(files?'<div class="result-row"><span class="result-lbl">Files</span><div style="flex:1">'+files+'</div></div>':'')
    +'</div>';
}

function showError(msg,step){
  el('result-area').innerHTML=
    '<div class="result-card err">'
    +'<div class="result-title">&#10060; Processing Failed</div>'
    +'<div class="result-row"><span class="result-lbl">Error</span><span class="result-val" style="color:#991b1b">'+esc(msg)+'</span></div>'
    +(step?'<div class="result-row"><span class="result-lbl">Step</span><span class="result-val">'+step+'</span></div>':'')
    +'</div>';
}

// ── GD Retry ─────────────────────────────────────────────────────────────────
async function retryGD(){
  var btn=el('gd-btn'); btn.textContent='&#9729; Filing\u2026'; btn.disabled=true;
  try{
    var resp=await fetch('/api/gdrive?action=retry',{method:'POST'});
    var reader=resp.body.getReader(),dec=new TextDecoder(),buf='';
    while(true){
      var chunk=await reader.read(); if(chunk.done) break;
      buf+=dec.decode(chunk.value,{stream:true});
      buf.split('\n').forEach(function(line){
        if(line.startsWith('data: ')){
          try{
            var ev=JSON.parse(line.slice(6));
            if(ev.type==='done') refreshProcessed();
          }catch(e){}
        }
      });
    }
  }catch(e){}
  btn.textContent='&#9729; GD Retry'; btn.disabled=false;
  refreshProcessed();
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
var diagOpen=false;
function toggleDiag(){
  diagOpen=!diagOpen;
  el('diag-panel').style.display=diagOpen?'':'none';
  el('diag-btn').className='hbtn'+(diagOpen?' active':'');
  if(diagOpen) loadDiag();
}
async function loadDiag(){
  el('diag-body').innerHTML='<div style="color:var(--mu);font-size:11px">Running checks\u2026</div>';
  var d=await api('/api/diag?format=json');
  var items=d&&d.results?d.results:[];
  if(!items.length){ el('diag-body').innerHTML='<div style="color:var(--mu);font-size:11px">No results</div>'; return; }
  el('diag-body').innerHTML=items.map(function(item){
    return '<div class="diag-row '+(item.ok?'ok':'fail')+'">'
      +'<div class="diag-ic">'+(item.ok?'&#10003;':'&#10007;')+'</div>'
      +'<div><div class="diag-label">'+esc(item.label)+'</div>'
      +'<div class="diag-detail">'+esc(item.detail)+'</div></div>'
      +'</div>';
  }).join('');
}

// ── SSE Notify stream ─────────────────────────────────────────────────────────
function openNotifyStream(){
  if(NOTIFY_ES){ NOTIFY_ES.close(); NOTIFY_ES=null; }
  var es=new EventSource('/api/notify');
  NOTIFY_ES=es;
  es.addEventListener('connected',function(){ console.log('[dashboard] notify connected'); });
  es.addEventListener('new-file',async function(){
    // Make.com triggered scan-now → new file detected → refresh scans column
    try{
      await refreshScans();
      // Auto-start the first file if not already processing
      if(!PROCESSING&&SCAN_DATA.length>0) startWatching(SCAN_DATA[0]);
    }catch(ex){}
  });
  es.addEventListener('reconnect',function(){ es.close(); NOTIFY_ES=null; setTimeout(openNotifyStream,1000); });
  es.onerror=function(){ es.close(); NOTIFY_ES=null; setTimeout(openNotifyStream,5000); };
}

// ── Wire up buttons ───────────────────────────────────────────────────────────
el('run-btn').addEventListener('click',async function(){
  if(!SELECTED||PROCESSING) return;
  var f=SELECTED;
  this.disabled=true;
  this.innerHTML='<span class="spin"></span> Running\u2026';
  hideRunPanel();
  await startWatching(f);
});
// Header + column buttons (all wired here — functions are inside IIFE, not global)
var _dh=el('diag-btn-hdr');   if(_dh) _dh.addEventListener('click',toggleDiag);
var _gh=el('gd-btn-hdr');     if(_gh) _gh.addEventListener('click',retryGD);
var _pc=el('panel-close-btn');if(_pc) _pc.addEventListener('click',toggleDiag);
var _sr=el('scan-refresh-btn');if(_sr) _sr.addEventListener('click',refreshScans);
var _pr=el('proc-refresh-btn');if(_pr) _pr.addEventListener('click',refreshProcessed);

// ── Init ──────────────────────────────────────────────────────────────────────
buildPipeline();
try{
  renderScans(SCAN_DATA,SCAN_ERROR);
  renderProcessed(PROC_DATA,PROC_ERROR);
  console.log('[dashboard] Init \u2014 Scans:',SCAN_DATA.length,'Processed:',PROC_DATA.length);
}catch(err){
  console.error('[dashboard] Init error:',err);
}
openNotifyStream();

})();
</script>
</body></html>`);
};
