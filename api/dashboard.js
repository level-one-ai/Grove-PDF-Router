/**
 * /api/dashboard
 * Serves the test dashboard. Protected by Basic Auth on page load only.
 * All API calls from the dashboard JS go to unprotected endpoints.
 */

module.exports = async function handler(req, res) {
  // Basic auth on the page itself
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Grove PDF Router"');
    return res.status(401).send('Login required');
  }
  const [user, ...passParts] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  const pass = passParts.join(':');
  if (user !== process.env.DASHBOARD_USERNAME || pass !== process.env.DASHBOARD_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Grove PDF Router"');
    return res.status(401).send('Invalid credentials');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grove PDF Router</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--or:#d97700;--bg:#0a0a0a;--su:#1a1a1a;--s2:#242424;--bo:#2e2e2e;--tx:#f0f0f0;--mu:#888;--gn:#22c55e;--rd:#ef4444;--yl:#eab308}
body{background:var(--bg);color:var(--tx);font-family:system-ui,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
/* HEADER */
header{background:var(--su);border-bottom:1px solid var(--bo);padding:0 20px;height:54px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.logo{display:flex;align-items:center;gap:9px}
.li{width:30px;height:30px;background:var(--or);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px}
.lt{font-size:13px;font-weight:600}.ls{font-size:10px;color:var(--mu)}
/* MODE TOGGLE */
.mw{display:flex;align-items:center;gap:10px}
.ml{font-size:12px;font-weight:600;color:var(--mu);cursor:pointer;user-select:none;transition:color .2s}
.ml.on{color:var(--tx)}
.ts{position:relative;width:58px;height:27px;cursor:pointer}
.tt{position:absolute;inset:0;border-radius:14px;background:linear-gradient(135deg,#0a220a,#143018);border:2px solid #22c55e55;box-shadow:inset 0 2px 4px #0007;transition:all .3s}
.tt.h{background:linear-gradient(135deg,#220a00,#301800);border-color:#d9770055}
.tk{position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#ccc 45%,#999);box-shadow:0 1px 4px #0007;transition:left .3s cubic-bezier(.4,0,.2,1)}
.tk.h{left:34px}
/* SUB STATUS */
.sub-row{display:flex;align-items:center;gap:8px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--mu)}
.dot.g{background:var(--gn);box-shadow:0 0 4px var(--gn)}.dot.y{background:var(--yl)}.dot.r{background:var(--rd)}
.sub-txt{font-size:11px;color:var(--mu)}
.act-btn{background:var(--or);color:#fff;border:none;padding:3px 10px;border-radius:11px;font-size:11px;cursor:pointer;font-weight:600;display:none}
/* BELL */
.bell-wrap{position:relative}
.bell-btn{background:none;border:1px solid var(--bo);border-radius:6px;padding:4px 8px;cursor:pointer;color:var(--mu);font-size:13px;transition:all .15s}
.bell-btn:hover{border-color:var(--or);color:var(--or)}
.bell-num{position:absolute;top:-5px;right:-5px;background:var(--rd);color:#fff;font-size:9px;font-weight:700;border-radius:8px;padding:1px 4px;display:none}
/* NOTIF PANEL */
.np{display:none;position:absolute;top:58px;right:16px;width:280px;background:var(--su);border:1px solid var(--bo);border-radius:9px;box-shadow:0 6px 24px #000a;z-index:300;padding:12px}
.np.show{display:block}
/* MAIN */
.main{display:grid;grid-template-columns:1fr 380px;flex:1;overflow:hidden}
/* LEFT */
.left{border-right:1px solid var(--bo);display:flex;flex-direction:column;overflow:hidden}
.lhead{padding:12px 16px;border-bottom:1px solid var(--bo);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.lht{font-size:13px;font-weight:600}.lhm{font-size:11px;color:var(--mu)}
.rfbtn{background:none;border:1px solid var(--bo);color:var(--mu);padding:4px 9px;border-radius:5px;font-size:11px;cursor:pointer}
.rfbtn:hover{border-color:var(--or);color:var(--or)}
.pathbar{padding:6px 16px;background:var(--su);border-bottom:1px solid var(--bo);font-size:11px;color:var(--mu);flex-shrink:0}
.pathbar span{color:var(--or)}
.flist{overflow-y:auto;flex:1;padding:7px}
.flist::-webkit-scrollbar{width:4px}.flist::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
/* FILE ITEM */
.fi{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:8px;cursor:pointer;border:1px solid transparent;margin-bottom:4px;background:var(--su);transition:border-color .15s,background .15s}
.fi:hover{border-color:var(--bo);background:var(--s2)}
.fi.sel{border-color:var(--or)!important;background:#1f1500!important}
.fi.wt{border-color:#d9770033;background:#180f00}
.fic{width:34px;height:34px;background:#180f00;border:1px solid #3a2000;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.fin{flex:1;min-width:0}
.fnm{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fmeta{font-size:11px;color:var(--mu);margin-top:1px}
.fac{display:flex;align-items:center;gap:5px;flex-shrink:0}
.wbadge{background:#d9770022;color:var(--or);border:1px solid #d9770044;font-size:9px;padding:2px 5px;border-radius:6px;display:none}
.rstbtn{background:none;border:1px solid var(--bo);color:var(--mu);width:20px;height:20px;border-radius:4px;cursor:pointer;font-size:10px;transition:all .15s}
.rstbtn:hover{border-color:var(--rd);color:var(--rd)}
.chk{width:16px;height:16px;border-radius:50%;border:2px solid var(--bo);display:flex;align-items:center;justify-content:center;transition:all .15s;font-size:9px;color:transparent}
.fi.sel .chk{background:var(--or);border-color:var(--or);color:#fff}
/* STATE MSG */
.stmsg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:44px 20px;color:var(--mu);text-align:center;height:100%}
.stmsg .ic{font-size:30px}.stmsg .ti{font-size:13px;font-weight:500;color:var(--tx)}.stmsg .de{font-size:11px;line-height:1.5}
/* RIGHT */
.right{display:flex;flex-direction:column;overflow:hidden}
.rsel{padding:14px 16px;border-bottom:1px solid var(--bo);flex-shrink:0;min-height:110px;display:flex;flex-direction:column;justify-content:center}
.nosel{display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--mu);text-align:center}
.nosel .ic{font-size:22px}.nosel .ti{font-size:12px;color:var(--mu)}
.selname{font-size:13px;font-weight:600;margin-bottom:3px;word-break:break-all}
.selmeta{font-size:11px;color:var(--mu);margin-bottom:9px}
/* STEP SELECT */
.stepsel{display:none;margin-bottom:9px}
.steplbl{font-size:10px;color:var(--mu);margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.stepopts{display:flex;flex-direction:column;gap:3px}
.stopt{display:flex;align-items:center;gap:7px;padding:6px 9px;border-radius:6px;border:1px solid var(--bo);cursor:pointer;background:var(--s2);transition:all .15s}
.stopt:hover{border-color:var(--or)}.stopt.on{border-color:var(--or);background:#1f1500}
.stopt input{accent-color:var(--or)}
.stoptx strong{display:block;font-size:12px;color:var(--tx)}.stoptx span{font-size:11px;color:var(--mu)}
/* RUN BTN */
.runbtn{width:100%;padding:10px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px}
.runbtn:disabled{background:var(--s2);color:var(--mu);cursor:not-allowed;border:1px solid var(--bo)}
.runbtn.go{background:var(--or);color:#fff}.runbtn.go:hover{background:#f59e0b}
.runbtn.going{background:var(--s2);color:var(--mu);cursor:not-allowed;border:1px solid var(--bo)}
/* PROGRESS PANEL */
.progpanel{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:6px}
.progpanel::-webkit-scrollbar{width:4px}.progpanel::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
.progtitle{font-size:11px;font-weight:600;color:var(--mu);text-transform:uppercase;letter-spacing:.08em}
.progidle{display:flex;flex-direction:column;align-items:center;gap:7px;padding:24px 0;color:var(--mu);text-align:center}
.progidle .ic{font-size:26px}.progidle .de{font-size:12px;line-height:1.5}
/* STEPS */
.stepitem{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:6px;background:var(--su);border:1px solid var(--bo);transition:all .25s}
.stepitem.running{border-color:var(--or);background:#1f1500}
.stepitem.done{border-color:#22c55e33;background:#0f1f0f}
.stepitem.error{border-color:#ef444433;background:#1f0f0f}
.stepico{width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;margin-top:1px}
.stepitem.pending .stepico{background:var(--s2);color:var(--mu)}
.stepitem.running .stepico{background:var(--or);color:#fff}
.stepitem.done .stepico{background:var(--gn);color:#fff}
.stepitem.error .stepico{background:var(--rd);color:#fff}
.steplabel{font-size:12px;font-weight:500}.stepmsg{font-size:11px;color:var(--mu);line-height:1.4;margin-top:1px}
.stepitem.running .stepmsg{color:var(--or)}.stepitem.done .stepmsg{color:#4ade80}.stepitem.error .stepmsg{color:var(--rd)}
/* RESULT CARD */
.rescard{background:#0f1f0f;border:1px solid #22c55e44;border-radius:8px;padding:12px}
.rescard.err{background:#1f0f0f;border-color:#ef444433}
.restitle{font-size:12px;font-weight:600;color:var(--gn);margin-bottom:9px}
.rescard.err .restitle{color:var(--rd)}
.resrow{display:flex;align-items:flex-start;gap:6px;margin-bottom:5px;font-size:11px}
.reslbl{color:var(--mu);min-width:72px;flex-shrink:0}.resval{color:var(--tx);word-break:break-all}
.reslink{color:var(--or);text-decoration:none}.reslink:hover{text-decoration:underline}
.fpill{background:var(--s2);border:1px solid var(--bo);border-radius:4px;padding:2px 6px;font-size:10px;color:var(--mu);font-family:monospace;margin-top:2px}
/* STOP AREA */
.stoparea{padding:10px 16px;border-top:1px solid var(--bo);display:none;flex-shrink:0}
.stoparea.show{display:block}
.stopbtn{width:100%;padding:9px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px}
.stopbtn.stopping{background:#1f0f0f;color:var(--rd);border:1px solid #ef444444}
.stopbtn.stopping:hover{background:#2a0f0f;border-color:var(--rd)}
.stopbtn.resuming{background:#0f1f0f;color:var(--gn);border:1px solid #22c55e44}
.stopbtn.resuming:hover{background:#0f2a0f;border-color:var(--gn)}
/* SPINNER */
@keyframes spin{to{transform:rotate(360deg)}}
.spin{width:11px;height:11px;border:2px solid rgba(255,255,255,.25);border-top-color:currentColor;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.pulse{animation:pulse 1.4s ease-in-out infinite}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="li">&#128196;</div>
    <div><div class="lt">Grove PDF Router</div><div class="ls">Dashboard</div></div>
  </div>
  <div class="mw">
    <span class="ml on" id="lbl-a" onclick="toggleMode()">Auto</span>
    <div class="ts" onclick="toggleMode()">
      <div class="tt" id="tt"></div>
      <div class="tk" id="tk"></div>
    </div>
    <span class="ml" id="lbl-h" onclick="toggleMode()">Human</span>
  </div>
  <div style="display:flex;align-items:center;gap:8px;position:relative">
    <div class="sub-row">
      <div class="dot" id="sdot"></div>
      <span class="sub-txt" id="stxt">Loading...</span>
    </div>
    <button class="act-btn" id="actbtn" onclick="activateSub()">Activate</button>
    <div class="bell-wrap">
      <button class="bell-btn" onclick="toggleNotif()">&#128276;<span class="bell-num" id="bnum"></span></button>
      <div class="np" id="np">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">&#9203; Waiting Files</div>
        <div id="nlist"><div style="font-size:12px;color:var(--mu);text-align:center;padding:8px">None waiting</div></div>
      </div>
    </div>
  </div>
</header>

<div class="main">
  <div class="left">
    <div class="lhead">
      <div><div class="lht">OneDrive Scans Folder</div><div class="lhm" id="fcount">—</div></div>
      <button class="rfbtn" onclick="loadFiles()">&#8635; Refresh</button>
    </div>
    <div class="pathbar">&#128193; Grove Group Scotland &rsaquo; Grove Bedding &rsaquo; <span>Scans</span></div>
    <div class="flist" id="flist">
      <div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading files...</div></div>
    </div>
  </div>

  <div class="right">
    <div class="rsel">
      <div class="nosel" id="nosel"><div class="ic">&#9757;</div><div class="ti">Select a file to begin</div></div>
      <div id="seldet" style="display:none">
        <div class="selname" id="selname"></div>
        <div class="selmeta" id="selmeta"></div>
        <div class="stepsel" id="stepsel">
          <div class="steplbl">Run up to:</div>
          <div class="stepopts">
            <label class="stopt on" id="sopt1"><input type="radio" name="rs" value="1" checked onchange="setSt(1)"><div class="stoptx"><strong>Full run</strong><span>AI + file to Google Drive &amp; OneDrive</span></div></label>
            <label class="stopt" id="sopt2"><input type="radio" name="rs" value="2" onchange="setSt(2)"><div class="stoptx"><strong>AI extraction only</strong><span>Get JSON, skip filing</span></div></label>
            <label class="stopt" id="sopt3"><input type="radio" name="rs" value="3" onchange="setSt(3)"><div class="stoptx"><strong>Split only</strong><span>Download &amp; split, skip Make.com</span></div></label>
          </div>
        </div>
        <button class="runbtn" id="runbtn" onclick="startRun()" disabled>&#9654; Run</button>
      </div>
    </div>

    <div class="progpanel" id="progpanel">
      <div class="progtitle">Progress</div>
      <div class="progidle" id="progidle"><div class="ic">&#129514;</div><div class="de">Select a file and click <strong style="color:var(--tx)">Run</strong></div></div>
      <div id="steplist"></div>
      <div id="rescard"></div>
    </div>

    <div class="stoparea" id="stoparea">
      <button class="stopbtn stopping" id="stopbtn" onclick="doStop()">&#9632; Stop Processing</button>
    </div>
  </div>
</div>

<script>
// ── STATE ──
var SF = null, IR = false, CM = 'auto', ST = 1, WF = {}, STOPPED = false;
var STEPS = [
  {id:1,l:'Initialise record'},
  {id:2,l:'Download from OneDrive'},
  {id:3,l:'Split PDF pages'},
  {id:4,l:'Dispatch to Make.com'},
  {id:5,l:'AI extraction'},
  {id:6,l:'File to OneDrive & Google Drive'}
];

// ── UTILS ──
function esc(s){ return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
function fdate(iso){ if(!iso) return ''; var d=new Date(iso); return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
function $(id){ return document.getElementById(id); }

// ── API CALLS ── no auth needed on these endpoints
async function api(url, opts) {
  try {
    var r = await fetch(url, opts || {});
    if (!r.ok) { console.warn('API error', url, r.status); return null; }
    return await r.json();
  } catch(ex) {
    console.warn('API fail', url, ex.message);
    return null;
  }
}

// ── MODE ──
async function loadMode() {
  var d = await api('/api/admin?action=mode');
  CM = (d && d.mode) ? d.mode : 'auto';
  applyMode();
}
async function toggleMode() {
  CM = CM === 'auto' ? 'human' : 'auto';
  applyMode();
  await api('/api/admin?action=mode', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode:CM})});
}
function applyMode() {
  var h = CM === 'human';
  $('tt').className = 'tt' + (h ? ' h' : '');
  $('tk').className = 'tk' + (h ? ' h' : '');
  $('lbl-a').className = 'ml' + (h ? '' : ' on');
  $('lbl-h').className = 'ml' + (h ? ' on' : '');
  var ss = $('stepsel');
  if (ss) ss.style.display = h ? 'block' : 'none';
  if (h) { $('stoparea').className = 'stoparea'; }
  else { loadStopState(); }
}
function setSt(n) {
  ST = n;
  [1,2,3].forEach(function(i){
    var el = $('sopt'+i);
    if(el) el.className = 'stopt' + (i===n ? ' on' : '');
  });
}

// ── STOP/RESUME ──
async function loadStopState() {
  var d = await api('/api/admin?action=control');
  if (!d) return;
  STOPPED = d.stopped || false;
  updateStopBtn();
}
function updateStopBtn() {
  if (CM !== 'auto') { $('stoparea').className = 'stoparea'; return; }
  $('stoparea').className = 'stoparea show';
  var btn = $('stopbtn');
  if (STOPPED) {
    btn.className = 'stopbtn resuming';
    btn.innerHTML = '&#9654; Resume Processing';
  } else {
    btn.className = 'stopbtn stopping';
    btn.innerHTML = '&#9632; Stop Processing';
  }
}
async function doStop() {
  var action = STOPPED ? 'resume' : 'stop';
  var d = await api('/api/admin?action=control', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:action})});
  if (d) { STOPPED = d.stopped; updateStopBtn(); }
}

// ── SUBSCRIPTION ──
async function loadSub() {
  var d = await api('/api/subscribe?action=status');
  if (!d) { $('stxt').textContent = 'Status unavailable'; return; }
  $('sdot').className = 'dot ' + (d.colour==='green'?'g':d.colour==='yellow'?'y':d.colour==='red'?'r':'');
  $('stxt').textContent = d.message || '—';
  $('actbtn').style.display = (d.status==='none'||d.status==='expired') ? 'inline-block' : 'none';
}
async function activateSub() {
  $('actbtn').disabled = true;
  $('stxt').textContent = 'Activating...';
  var d = await api('/api/subscribe?action=create');
  if (d && d.success) {
    $('sdot').className = 'dot g';
    $('stxt').textContent = 'Activated!';
    $('actbtn').style.display = 'none';
  } else {
    $('stxt').textContent = 'Failed — check logs';
    $('actbtn').disabled = false;
  }
}

// ── WAITING FILES ──
async function loadWaiting() {
  var d = await api('/api/admin?action=waiting');
  var files = (d && d.files) ? d.files : [];
  WF = {};
  files.forEach(function(f){ WF[f.fileId] = f; });
  var bn = $('bnum');
  if (files.length) { bn.style.display='block'; bn.textContent=String(files.length); }
  else { bn.style.display='none'; }
  var nl = $('nlist');
  if (!files.length) {
    nl.innerHTML = '<div style="font-size:12px;color:var(--mu);text-align:center;padding:8px">None waiting</div>';
  } else {
    nl.innerHTML = files.map(function(f){
      return '<div style="display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;background:var(--s2);border:1px solid #d9770033;margin-bottom:5px;cursor:pointer" onclick="selWait(\'' + f.fileId + '\')">'
        + '<div style="font-size:16px">&#128196;</div>'
        + '<div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.fileName) + '</div>'
        + '<div style="font-size:10px;color:var(--mu)">' + (f.totalPages||'?') + ' pages &middot; Waiting</div></div>'
        + '<div style="color:var(--or);font-size:11px">&#9654;</div></div>';
    }).join('');
  }
  refreshBadges();
}
function selWait(fid) {
  closeNotif();
  var el = $('f-' + fid);
  if (el) el.click();
}
function toggleNotif() { $('np').classList.toggle('show'); }
function closeNotif() { $('np').classList.remove('show'); }
document.addEventListener('click', function(ev){
  if (!ev.target.closest('.bell-wrap')) closeNotif();
});
function refreshBadges() {
  document.querySelectorAll('.fi').forEach(function(el){
    var fid = el.dataset.fid;
    var wb = el.querySelector('.wbadge');
    if (!wb) return;
    if (WF[fid]) { el.classList.add('wt'); wb.style.display='inline-block'; }
    else { el.classList.remove('wt'); wb.style.display='none'; }
  });
}

// ── FILES ──
async function loadFiles() {
  $('flist').innerHTML = '<div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading...</div></div>';
  $('fcount').textContent = '—';

  var d = await api('/api/scan-files');

  if (!d) {
    $('flist').innerHTML = '<div class="stmsg"><div class="ic">&#9888;</div><div class="ti">Failed to load</div><div class="de">Check Vercel logs for details</div></div>';
    return;
  }
  if (!d.success || !d.files || !d.files.length) {
    $('fcount').textContent = 'No PDFs found';
    $('flist').innerHTML = '<div class="stmsg"><div class="ic">&#128589;</div><div class="ti">No PDFs found</div><div class="de">Upload a PDF to the Scans folder then refresh</div></div>';
    return;
  }

  $('fcount').textContent = d.files.length + ' file' + (d.files.length===1?'':'s');

  $('flist').innerHTML = d.files.map(function(f, idx){
    // Store file data safely using index — we keep a files array
    return '<div class="fi" id="f-' + f.id + '" data-fid="' + esc(f.id) + '" data-idx="' + idx + '" onclick="clickFile(' + idx + ')">'
      + '<div class="fic">&#128196;</div>'
      + '<div class="fin"><div class="fnm">' + esc(f.name) + '</div><div class="fmeta">' + esc(f.sizeFormatted) + ' &middot; ' + fdate(f.createdAt) + '</div></div>'
      + '<div class="fac"><span class="wbadge">&#9203;</span>'
      + '<button class="rstbtn" onclick="doReset(event,\'' + esc(f.id) + '\')" title="Reset">&#8635;</button>'
      + '<div class="chk">&#10003;</div></div>'
      + '</div>';
  }).join('');

  // Store files array globally so clickFile can access by index
  window.FILES = d.files;
  refreshBadges();
}

function clickFile(idx) {
  if (IR) return;
  var f = window.FILES && window.FILES[idx];
  if (!f) return;

  // Deselect all
  document.querySelectorAll('.fi').forEach(function(el){ el.classList.remove('sel'); });
  // Select this one
  var el = $('f-' + f.id);
  if (el) el.classList.add('sel');

  SF = f;
  $('nosel').style.display = 'none';
  $('seldet').style.display = 'block';
  $('selname').textContent = f.name;
  $('selmeta').textContent = f.sizeFormatted + ' \u00b7 ' + fdate(f.createdAt);

  // Show step selector only in human mode
  var ss = $('stepsel');
  if (ss) ss.style.display = CM==='human' ? 'block' : 'none';

  var btn = $('runbtn');
  btn.className = 'runbtn go';
  btn.disabled = false;
  btn.textContent = WF[f.id] ? '\u25b6 Run (Waiting)' : '\u25b6 Run';

  resetProg();
}

// ── RESET ──
async function doReset(ev, fid) {
  ev.stopPropagation();
  if (!confirm('Reset this file so it can be reprocessed?')) return;
  var d = await api('/api/admin?action=reset', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fileId:fid})});
  if (d && d.success) { alert('Reset \u2014 you can now run this file.'); loadWaiting(); }
  else { alert('Reset failed: ' + (d && d.error ? d.error : 'Unknown error')); }
}

// ── RUN ──
async function startRun() {
  if (!SF || IR) return;
  IR = true;
  var btn = $('runbtn');
  btn.className = 'runbtn going';
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Running...';

  $('progidle').style.display = 'none';
  $('rescard').innerHTML = '';
  $('steplist').innerHTML = STEPS.map(function(s){ return mkStep(s.id, s.l, '', 'pending'); }).join('');

  try {
    var body = {fileId:SF.id, fileName:SF.name, runMode:CM, runStep:ST, isWaiting:!!WF[SF.id]};
    var resp = await fetch('/api/test-run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (!resp.ok && resp.status !== 200) { finErr('unknown', 'Server error ' + resp.status); return; }

    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, {stream:true});
      var lines = buf.split('\\n'); buf = lines.pop();
      var evt = null;
      lines.forEach(function(line){
        if (line.startsWith('event: ')) evt = line.slice(7).trim();
        else if (line.startsWith('data: ')) {
          try { handleEvt(evt, JSON.parse(line.slice(6))); } catch(ex){}
        }
      });
    }
  } catch(err) { finErr('unknown', err.message); }
}

function handleEvt(ev, d) {
  if (ev==='progress') updStep(d.step, d.message, d.status);
  else if (ev==='complete') { updStep(6, 'Filed \u2713', 'done'); showRes(d); finRun(); }
  else if (ev==='error') finErr(d.step, d.message);
}

function updStep(n, msg, st) {
  // Mark earlier pending steps as done
  STEPS.forEach(function(s){
    if (s.id < n) { var el=$('st-'+s.id); if(el && el.dataset.status==='pending') el.outerHTML=mkStep(s.id,s.l,'','done'); }
  });
  var ex = $('st-'+n), step = STEPS.find(function(s){return s.id===n;});
  if (!step) return;
  if (ex) ex.outerHTML = mkStep(n, step.l, msg, st);
  else $('steplist').insertAdjacentHTML('beforeend', mkStep(n, step.l, msg, st));
}

function mkStep(id, label, msg, st) {
  var icons = {pending:String(id), running:'', done:'\u2713', error:'\u2715'};
  var ico = st==='running' ? '<span class="spin"></span>' : (icons[st]||String(id));
  return '<div class="stepitem ' + st + '" id="st-' + id + '" data-status="' + st + '">'
    + '<div class="stepico">' + ico + '</div>'
    + '<div style="flex:1;min-width:0"><div class="steplabel">' + esc(label) + '</div>'
    + (msg ? '<div class="stepmsg">' + esc(msg) + '</div>' : '')
    + '</div></div>';
}

function showRes(d) {
  var files = (d.renamedFiles||[]).map(function(f){ return '<div class="fpill">'+esc(f)+'</div>'; }).join('');
  $('rescard').innerHTML = '<div class="rescard">'
    + '<div class="restitle">\u2705 Complete</div>'
    + '<div class="resrow"><div class="reslbl">Supplier</div><div class="resval">' + esc(d.supplier||'\u2014') + '</div></div>'
    + '<div class="resrow"><div class="reslbl">Customer</div><div class="resval">' + esc(d.customerName||'\u2014') + '</div></div>'
    + '<div class="resrow"><div class="reslbl">Reference</div><div class="resval">' + esc(d.ref||'\u2014') + '</div></div>'
    + '<div class="resrow"><div class="reslbl">Pages</div><div class="resval">' + (d.totalPages||'\u2014') + '</div></div>'
    + (d.googleDriveFolderUrl ? '<div class="resrow"><div class="reslbl">Google Drive</div><div class="resval"><a class="reslink" href="'+d.googleDriveFolderUrl+'" target="_blank">Open \u2197</a></div></div>' : '')
    + (d.oneDriveProcessedFolderUrl ? '<div class="resrow"><div class="reslbl">OneDrive</div><div class="resval"><a class="reslink" href="'+d.oneDriveProcessedFolderUrl+'" target="_blank">Open \u2197</a></div></div>' : '')
    + (files ? '<div class="resrow" style="flex-direction:column;gap:3px"><div class="reslbl">Files</div>' + files + '</div>' : '')
    + '</div>';
}

function resetProg() {
  $('progidle').style.display = 'flex';
  $('steplist').innerHTML = '';
  $('rescard').innerHTML = '';
}
function finRun() {
  IR = false;
  var btn = $('runbtn');
  btn.className = 'runbtn go'; btn.disabled = false;
  btn.innerHTML = '\u21ba Run Again';
  loadWaiting();
}
function finErr(step, msg) {
  IR = false;
  if (step !== 'unknown') updStep(step, msg, 'error');
  $('rescard').innerHTML = '<div class="rescard err"><div class="restitle">\u274c Failed</div>'
    + '<div class="resrow"><div class="reslbl">Error</div><div class="resval" style="color:var(--rd)">' + esc(msg) + '</div></div></div>';
  var btn = $('runbtn');
  btn.className = 'runbtn go'; btn.disabled = false;
  btn.innerHTML = '\u21ba Try Again';
}

// ── INIT ──
// Remove auth from API calls — endpoints are now open (dashboard page is protected)
loadMode();
loadFiles();
loadSub();
loadWaiting();
setInterval(loadWaiting, 30000);
setInterval(function(){ if(CM==='auto') loadStopState(); }, 15000);
</script>
</body></html>`);
}
