/**
 * /api/dashboard
 * Grove PDF Router dashboard.
 * 3-column layout: Scans | Processed | Run Panel
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

/* HEADER */
header{background:var(--su);border-bottom:1px solid var(--bo);padding:0 16px;height:52px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:12px}
.logo{display:flex;align-items:center;gap:8px;flex-shrink:0}
.li{width:28px;height:28px;background:var(--or);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px}
.lt{font-size:13px;font-weight:600}.ls{font-size:10px;color:var(--mu)}
.mw{display:flex;align-items:center;gap:9px}
.ml{font-size:12px;font-weight:600;color:var(--mu);cursor:pointer;user-select:none;transition:color .2s}
.ml.on{color:var(--tx)}
.ts{position:relative;width:54px;height:26px;cursor:pointer}
.tt{position:absolute;inset:0;border-radius:14px;background:linear-gradient(135deg,#0a220a,#143018);border:2px solid #22c55e55;box-shadow:inset 0 2px 4px #0007;transition:all .3s}
.tt.h{background:linear-gradient(135deg,#220a00,#301800);border-color:#d9770055}
.tk{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#ccc 45%,#999);box-shadow:0 1px 4px #0007;transition:left .3s cubic-bezier(.4,0,.2,1)}
.tk.h{left:31px}
.sub-row{display:flex;align-items:center;gap:7px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--mu)}
.dot.g{background:var(--gn);box-shadow:0 0 4px var(--gn)}.dot.y{background:var(--yl)}.dot.r{background:var(--rd)}
.sub-txt{font-size:11px;color:var(--mu)}
.act-btn{background:var(--or);color:#fff;border:none;padding:3px 9px;border-radius:11px;font-size:11px;cursor:pointer;font-weight:600;display:none}
.hbtn{background:none;border:1px solid var(--bo);border-radius:6px;padding:3px 8px;cursor:pointer;color:var(--mu);font-size:12px;transition:all .15s;white-space:nowrap}
.hbtn:hover{border-color:var(--or);color:var(--or)}
.bell-wrap{position:relative}
.bell-btn{background:none;border:1px solid var(--bo);border-radius:6px;padding:3px 8px;cursor:pointer;color:var(--mu);font-size:13px;transition:all .15s}
.bell-btn:hover{border-color:var(--or);color:var(--or)}
.bell-num{position:absolute;top:-5px;right:-5px;background:var(--rd);color:#fff;font-size:9px;font-weight:700;border-radius:8px;padding:1px 4px;display:none}
.np{display:none;position:absolute;top:50px;right:0;width:270px;background:var(--su);border:1px solid var(--bo);border-radius:9px;box-shadow:0 6px 24px #000a;z-index:300;padding:11px}
.np.show{display:block}

/* 3-COLUMN MAIN */
.main{display:grid;grid-template-columns:1fr 1fr 360px;flex:1;overflow:hidden}

/* FILE COLUMNS — shared styles */
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

/* FILE ITEMS */
.fi{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;cursor:pointer;border:1px solid transparent;margin-bottom:3px;background:var(--su);transition:border-color .15s,background .15s}
.fi:hover{border-color:var(--bo);background:var(--s2)}
.fi.sel{border-color:var(--or)!important;background:#1f1500!important}
.fi.wt{border-color:#d9770033;background:#180f00}
.fi.done-f{border-color:#22c55e22;background:#0a180a;cursor:default;opacity:.7}
.fic{width:30px;height:30px;background:#180f00;border:1px solid #3a2000;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}
.fi.done-f .fic{background:#0a180a;border-color:#22c55e33}
.fin{flex:1;min-width:0}
.fnm{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fmeta{font-size:10px;color:var(--mu);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fac{display:flex;align-items:center;gap:4px;flex-shrink:0}
.wbadge{background:#d9770022;color:var(--or);border:1px solid #d9770044;font-size:9px;padding:1px 5px;border-radius:6px;display:none}
.rstbtn{background:none;border:1px solid var(--bo);color:var(--mu);width:18px;height:18px;border-radius:4px;cursor:pointer;font-size:9px;transition:all .15s;display:flex;align-items:center;justify-content:center}
.rstbtn:hover{border-color:var(--rd);color:var(--rd)}
.chk{width:14px;height:14px;border-radius:50%;border:2px solid var(--bo);display:flex;align-items:center;justify-content:center;transition:all .15s;font-size:8px;color:transparent}
.fi.sel .chk{background:var(--or);border-color:var(--or);color:#fff}
.done-f .chk{background:var(--gn);border-color:var(--gn);color:#fff}
.proc-tag{font-size:9px;color:var(--gn);font-weight:600;white-space:nowrap}

/* STATE MSG */
.stmsg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 16px;color:var(--mu);text-align:center;height:100%}
.stmsg .ic{font-size:26px}.stmsg .ti{font-size:12px;font-weight:500;color:var(--tx)}.stmsg .de{font-size:11px;line-height:1.5}

/* RIGHT PANEL */
.right{display:flex;flex-direction:column;overflow:hidden}
.rsel{padding:12px 14px;border-bottom:1px solid var(--bo);flex-shrink:0;min-height:100px;display:flex;flex-direction:column;justify-content:center}
.nosel{display:flex;flex-direction:column;align-items:center;gap:5px;color:var(--mu);text-align:center}
.nosel .ic{font-size:20px}.nosel .ti{font-size:11px;color:var(--mu)}
.selname{font-size:13px;font-weight:600;margin-bottom:2px;word-break:break-all}
.selmeta{font-size:11px;color:var(--mu);margin-bottom:8px}
.stepsel{display:none;margin-bottom:8px}
.steplbl{font-size:10px;color:var(--mu);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.stepopts{display:flex;flex-direction:column;gap:3px}
.stopt{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;border:1px solid var(--bo);cursor:pointer;background:var(--s2);transition:all .15s}
.stopt:hover{border-color:var(--or)}.stopt.on{border-color:var(--or);background:#1f1500}
.stopt input{accent-color:var(--or)}
.stoptx strong{display:block;font-size:11px;color:var(--tx)}.stoptx span{font-size:10px;color:var(--mu)}
.runbtn{width:100%;padding:9px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px}
.runbtn:disabled{background:var(--s2);color:var(--mu);cursor:not-allowed;border:1px solid var(--bo)}
.runbtn.go{background:var(--or);color:#fff}.runbtn.go:hover{background:var(--orl)}
.runbtn.going{background:var(--s2);color:var(--mu);cursor:not-allowed;border:1px solid var(--bo)}

/* PROGRESS */
.progpanel{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:5px}
.progpanel::-webkit-scrollbar{width:4px}.progpanel::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
.progtitle{font-size:10px;font-weight:600;color:var(--mu);text-transform:uppercase;letter-spacing:.08em}
.progidle{display:flex;flex-direction:column;align-items:center;gap:6px;padding:20px 0;color:var(--mu);text-align:center}
.progidle .ic{font-size:24px}.progidle .de{font-size:11px;line-height:1.5}
.stepitem{display:flex;align-items:flex-start;gap:7px;padding:7px 9px;border-radius:6px;background:var(--su);border:1px solid var(--bo);transition:all .25s}
.stepitem.running{border-color:var(--or);background:#1f1500}
.stepitem.done{border-color:#22c55e33;background:#0f1f0f}
.stepitem.error{border-color:#ef444433;background:#1f0f0f}
.stepico{width:17px;height:17px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0;margin-top:1px}
.stepitem.pending .stepico{background:var(--s2);color:var(--mu)}
.stepitem.running .stepico{background:var(--or);color:#fff}
.stepitem.done .stepico{background:var(--gn);color:#fff}
.stepitem.error .stepico{background:var(--rd);color:#fff}
.steplabel{font-size:11px;font-weight:500}.stepmsg{font-size:10px;color:var(--mu);line-height:1.4;margin-top:1px}
.stepitem.running .stepmsg{color:var(--or)}.stepitem.done .stepmsg{color:#4ade80}.stepitem.error .stepmsg{color:var(--rd)}

/* RESULT */
.rescard{background:#0f1f0f;border:1px solid #22c55e44;border-radius:7px;padding:10px}
.rescard.err{background:#1f0f0f;border-color:#ef444433}
.restitle{font-size:11px;font-weight:600;color:var(--gn);margin-bottom:7px}
.rescard.err .restitle{color:var(--rd)}
.resrow{display:flex;align-items:flex-start;gap:5px;margin-bottom:4px;font-size:10px}
.reslbl{color:var(--mu);min-width:64px;flex-shrink:0}.resval{color:var(--tx);word-break:break-all}
.reslink{color:var(--or);text-decoration:none}.reslink:hover{text-decoration:underline}
.fpill{background:var(--s2);border:1px solid var(--bo);border-radius:4px;padding:2px 5px;font-size:9px;color:var(--mu);font-family:monospace;margin-top:2px}

/* STOP AREA */
.stoparea{padding:9px 14px;border-top:1px solid var(--bo);display:none;flex-shrink:0}
.stoparea.show{display:block}
.stopbtn{width:100%;padding:8px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:none;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:5px}
.stopbtn.stopping{background:#1f0f0f;color:var(--rd);border:1px solid #ef444444}
.stopbtn.stopping:hover{background:#2a0f0f;border-color:var(--rd)}
.stopbtn.resuming{background:#0f1f0f;color:var(--gn);border:1px solid #22c55e44}
.stopbtn.resuming:hover{background:#0f2a0f;border-color:var(--gn)}

/* GD RETRY PANEL */
.gdpanel{margin-top:10px;border:1px solid var(--bo);border-radius:8px;overflow:hidden;display:none}
.gdpanel.open{display:block}
.gdph{background:var(--s2);padding:8px 12px;font-size:11px;font-weight:600;color:var(--mu);display:flex;align-items:center;justify-content:space-between}
.gdpbody{max-height:280px;overflow-y:auto;padding:6px 0}
.gdrow{display:flex;align-items:flex-start;gap:8px;padding:5px 12px;border-bottom:1px solid var(--bo);font-size:11px}
.gdrow:last-child{border-bottom:none}
.gdrow-ic{width:14px;flex-shrink:0;margin-top:1px;text-align:center}
.gdrow-body{flex:1;min-width:0}
.gdrow-name{font-weight:500;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gdrow-detail{color:var(--mu);font-size:10px;margin-top:2px}
.gdrow-link{color:var(--or);text-decoration:none;font-size:10px}
.gdrow-link:hover{text-decoration:underline}
.gdrow.filing .gdrow-ic{color:var(--yl)}
.gdrow.success .gdrow-ic{color:var(--gn)}
.gdrow.failed .gdrow-ic{color:var(--rd)}
.gdrow.skipped .gdrow-ic{color:var(--mu)}
.gd-send-btn{background:none;border:1px solid #22c55e44;color:var(--gn);border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-weight:600}
.gd-send-btn:hover{background:#1a2f1a}
.gd-send-btn:disabled{opacity:0.5;cursor:not-allowed}
/* PROCESSED ITEM DROPDOWN */
.proc-drop{display:none;margin-top:7px;padding-top:7px;border-top:1px solid var(--bo)}
.proc-drop.open{display:block}
.pd-row{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px}
.pd-lbl{color:var(--mu);min-width:60px;flex-shrink:0;font-size:10px}
.pd-val{color:var(--tx);word-break:break-all;flex:1;min-width:0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pd-link{color:var(--or);text-decoration:none;font-size:11px;white-space:nowrap}
.pd-link:hover{text-decoration:underline}
.folder-tag{font-size:9px;padding:2px 6px;border-radius:5px;font-weight:600;white-space:nowrap}
.folder-tag.gd{background:#1a2f1a;color:#4ade80;border:1px solid #22c55e33}
.folder-tag.od{background:#1a1a2f;color:#818cf8;border:1px solid #6366f133}
/* SPINNER */
@keyframes spin{to{transform:rotate(360deg)}}
.spin{width:10px;height:10px;border:2px solid rgba(255,255,255,.25);border-top-color:currentColor;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.pulse{animation:pulse 1.4s ease-in-out infinite}

/* DIAGNOSTIC PANEL */
.diagpanel{display:none;flex-direction:column;flex-shrink:0;border-bottom:1px solid var(--bo);background:var(--su);overflow:hidden}
.diagpanel.open{display:flex}
.diagph{padding:7px 14px;border-bottom:1px solid var(--bo);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.diagph-title{font-size:11px;font-weight:600;color:var(--mu);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:6px}
.diagph-close{background:none;border:none;color:var(--mu);cursor:pointer;font-size:13px;padding:0;line-height:1;transition:color .15s}
.diagph-close:hover{color:var(--tx)}
.diagbody{overflow-y:auto;max-height:280px;padding:6px 8px}
.diagbody::-webkit-scrollbar{width:4px}.diagbody::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
.diagrow{display:flex;align-items:flex-start;gap:7px;padding:6px 8px;border-radius:6px;border:1px solid transparent;margin-bottom:3px}
.diagrow.ok{background:#0a180a;border-color:#22c55e22}
.diagrow.fail{background:#1f0f0f;border-color:#ef444433}
.diagrow.loading{background:var(--s2);border-color:var(--bo)}
.diag-ic{font-size:11px;flex-shrink:0;width:14px;text-align:center;margin-top:1px}
.diag-label{font-size:11px;font-weight:600;color:var(--tx);flex-shrink:0;min-width:160px}
.diag-detail{font-size:10px;color:var(--mu);word-break:break-all;flex:1;line-height:1.4}
.diagrow.ok .diag-detail{color:#4ade80}
.diagrow.fail .diag-detail{color:#f87171}
.diagsummary{margin:4px 0 2px;padding:6px 10px;border-radius:6px;font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px}
.diagsummary.ok{background:#0a180a;color:#4ade80;border:1px solid #22c55e33}
.diagsummary.fail{background:#1f0f0f;color:#f87171;border:1px solid #ef444433}
.diagsummary.loading{background:var(--s2);color:var(--mu);border:1px solid var(--bo)}
.diagbtn{background:none;border:1px solid var(--bo);color:var(--mu);padding:3px 8px;border-radius:5px;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap}
.diagbtn:hover{border-color:#d9770088;color:var(--or)}
.diagbtn.active{border-color:var(--or);color:var(--or);background:#1f150033}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="li">&#128196;</div>
    <div><div class="lt">Grove PDF Router</div><div class="ls">Dashboard</div></div>
  </div>
  <div style="display:flex;align-items:center;gap:7px;position:relative">
    <div class="sub-row">
      <div class="dot" id="sdot"></div>
      <span class="sub-txt" id="stxt">Loading...</span>
    </div>
    <button class="act-btn" id="actbtn" onclick="activateSub()">Activate</button>
    <div class="bell-wrap">
      <button class="bell-btn" onclick="toggleNotif()">&#9203;<span class="bell-num" id="bnum"></span></button>
      <div class="np" id="np">
        <div style="font-size:12px;font-weight:600;margin-bottom:8px">&#9203; Queue</div>
        <div id="nlist"><div style="font-size:11px;color:var(--mu);text-align:center;padding:8px">Queue empty</div></div>
      </div>
    </div>
  </div>
</header>

<div class="main">

  <!-- SCANS COLUMN -->
  <div class="fcol">
    <div class="fhead">
      <div><div class="fht">&#128228; Scans</div><div class="fhm" id="scan-count">—</div></div>
      <div style="display:flex;gap:5px">
        <button class="rfbtn diagbtn" id="diag-btn" onclick="toggleDiag()" title="Run system diagnostics">&#128295; Diag</button>
        <button class="rfbtn diagbtn" id="logs-btn" onclick="toggleLogs()" title="View Firestore read logs">&#128220; Logs</button>
        <button class="rfbtn" onclick="loadStatus().then(loadScans)">&#8635;</button>
      </div>
    </div>
    <div class="pathbar">&#128193; Grove Bedding &rsaquo; <span>Scans</span></div>
    <div class="diagpanel" id="diagpanel">
      <div class="diagph">
        <div class="diagph-title">&#128295; System Diagnostics</div>
        <button class="diagph-close" onclick="toggleDiag()" title="Close">&#10005;</button>
      </div>
      <div class="diagbody" id="diagbody">
        <div class="diagrow loading"><div class="diag-ic"><span class="spin"></span></div><div class="diag-label">Running checks...</div></div>
      </div>
    </div>
    <div class="diagpanel" id="logspanel">
      <div class="diagph">
        <div class="diagph-title">&#128220; Firestore Read Log</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="rfbtn" onclick="refreshLogs()" style="font-size:10px;padding:2px 7px">&#8635; Refresh</button>
          <button class="diagph-close" onclick="toggleLogs()" title="Close">&#10005;</button>
        </div>
      </div>
      <div class="diagbody" id="logsbody">
        <div style="font-size:11px;color:var(--mu);text-align:center;padding:12px">Click refresh to load recent logs</div>
      </div>
    </div>
    <div class="flist" id="scan-list">
      <div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading...</div></div>
    </div>
  </div>

  <!-- PROCESSED COLUMN -->
  <div class="fcol">
    <div class="fhead">
      <div><div class="fht">&#9989; Processed</div><div class="fhm" id="proc-count">—</div></div>
      <div style="display:flex;gap:5px">
        <button class="rfbtn" id="gd-retry-btn" onclick="retryGoogleDrive()" title="File missing Google Drive uploads" style="border-color:#22c55e44;color:var(--gn)">&#128230; GD</button>
        <button class="rfbtn" onclick="loadStatus().then(loadProcessed)">&#8635;</button>
      </div>
    </div>
    <div class="pathbar">&#128193; Grove Bedding &rsaquo; Scans &rsaquo; <span>Processed</span></div>
    <div id="gdpanel" class="gdpanel">
      <div class="gdph">
        <span id="gdp-title">Google Drive Filing</span>
        <span id="gdp-count" style="color:var(--tx)"></span>
      </div>
      <div class="gdpbody" id="gdp-body"></div>
    </div>
    <div class="flist" id="proc-list">
      <div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading...</div></div>
    </div>
  </div>

  <!-- RIGHT PANEL -->
  <div class="right">
    <div class="rsel">
      <div class="nosel" id="nosel"><div class="ic">&#9757;</div><div class="ti">Select a file from Scans to begin</div></div>
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
        <button class="runbtn" id="runbtn" onclick="startRun()" disabled>&#9654; Process</button>
      </div>
    </div>

    <div class="progpanel" id="progpanel">
      <div class="progtitle">Progress</div>
      <div class="progidle" id="progidle"><div class="ic">&#129514;</div><div class="de">Select a file and click <strong style="color:var(--tx)">Process</strong></div></div>
      <div id="steplist"></div>
      <div id="rescard"></div>
    </div>


  </div>
</div>

<script>
var SF = null, IR = false, CM = 'auto', ST = 1, WF = {}; // Unified always-on mode
var STATUS_CACHE = []; // All Firestore records — loaded once, reused everywhere
var STATUS_LOADED = false;
var AUTO_POLL_INTERVAL = null;
var AUTO_KNOWN_IDS = null; // Set of file IDs known to exist in Scans (for new-file detection)
var AUTO_PROCESSING = false; // True while auto mode is running a file
var NOTIFY_ES = null; // SSE connection to /api/notify for instant new-file detection
var STEPS = [
  {id:1,l:'Initialise record'},
  {id:2,l:'Download from OneDrive'},
  {id:3,l:'Split PDF into pages'},
  {id:4,l:'Send page 1 to Make.com'},
  {id:5,l:'AI extraction — Claude reads page'},
  {id:6,l:'File page to OneDrive & Google Drive'}
];

function esc(s){ return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
function fdate(iso){ if(!iso) return ''; var d=new Date(iso); return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
function fsize(b){ if(!b) return ''; var k=1024,i=Math.floor(Math.log(b)/Math.log(k)); return parseFloat((b/Math.pow(k,i)).toFixed(1))+['B','KB','MB','GB'][i]; }
function $(id){ return document.getElementById(id); }

async function api(url, opts) {
  try {
    var r = await fetch(url, opts || {});
    var json = await r.json().catch(function(){ return null; });
    return json; // return body even on error — caller checks d.success or d.error
  } catch(ex) { return null; }
}

// ── STATUS CACHE ──
// Loads all Firestore records once and caches them in memory.
// All dashboard panels use this cache — no repeated Firestore calls.
async function loadStatus() {
  var d = await api('/api/status?limit=200');
  if (d && d.records) {
    STATUS_CACHE = d.records;
    STATUS_LOADED = true;
    console.log('[dashboard] Status cache loaded:', STATUS_CACHE.length, 'records');
  }
  return STATUS_CACHE;
}

// Build lookup maps from cache
function buildStatusLookup() {
  var byFile = {}, byOriginal = {}, byCustomer = [];
  STATUS_CACHE.forEach(function(r) {
    (r.renamedFiles || []).forEach(function(fname) { byFile[fname] = r; });
    if (r.originalFileName) byOriginal[r.originalFileName.toLowerCase()] = r;
    byCustomer.push(r);
  });
  return { byFile: byFile, byOriginal: byOriginal, byCustomer: byCustomer };
}

// Find the Firestore record matching an OneDrive filename
function findRecord(fileName) {
  var lookup = buildStatusLookup();
  // 1. Exact renamed file match
  if (lookup.byFile[fileName]) return lookup.byFile[fileName];
  // 2. Base name match
  var base = fileName.replace(/[-_]d+.pdf$/i, '').replace(/.pdf$/i, '').toLowerCase();
  if (lookup.byOriginal[base]) return lookup.byOriginal[base];
  // 3. Customer name in filename
  return lookup.byCustomer.find(function(r) {
    return r.customerName && fileName.toLowerCase().includes(r.customerName.toLowerCase());
  }) || null;
}

// ── MODE ──
async function loadMode() {
  // System is always in unified auto-watch mode — no toggle needed.
  // Keep this call for compatibility; it simply ensures polling is running.
  CM = 'auto';
  // Always start polling and show stop button
  loadStopState();
  startAutoPolling();
}

// ── AUTO MODE POLLING + SSE NOTIFY ──
function startAutoPolling() {
  stopAutoPolling();
  // Keep the polling interval as a safety net (catches files if SSE misses anything)
  AUTO_POLL_INTERVAL = setInterval(autoPollScans, 60000); // 60s — SSE handles instant updates, this is fallback only
  // Seed known IDs immediately so first poll detects only NEW files added after this point
  seedAutoKnownIds();
}

function stopAutoPolling() {
  if (AUTO_POLL_INTERVAL) { clearInterval(AUTO_POLL_INTERVAL); AUTO_POLL_INTERVAL = null; }
}

// ── SSE NOTIFY CONNECTION ──
// Opens a persistent SSE connection to /api/notify.
// When webhook.js detects a new file it broadcasts a "new-file" event here,
// causing the scans panel to refresh instantly (≤2s) rather than waiting for
// the next 8-second auto-poll cycle.
// The connection auto-reconnects when the server sends a "reconnect" event
// (every ~55s before Vercel's function timeout) or if the connection drops.
function openNotifyStream() {
  if (NOTIFY_ES) { NOTIFY_ES.close(); NOTIFY_ES = null; }

  var es = new EventSource('/api/notify');
  NOTIFY_ES = es;

  es.addEventListener('connected', function() {
    console.log('[dashboard] Notify stream connected');
  });

  es.addEventListener('new-file', function(e) {
    try {
      var d = JSON.parse(e.data);
      console.log('[dashboard] New file(s) detected via notify:', d.count);
    } catch(ex) {}
    // Refresh scans panel immediately
    loadStatus().then(function(){ loadScans(); loadWaiting(); });
    // If in auto mode and not already processing, trigger auto-run after scans refresh
    if (!AUTO_PROCESSING) {
      setTimeout(function(){
        // Re-check after short delay to let loadScans finish
        if (!AUTO_PROCESSING && window.SCAN_FILES && window.SCAN_FILES.length > 0) {
          var newFile = window.SCAN_FILES.find(function(f){ return !AUTO_KNOWN_IDS || !AUTO_KNOWN_IDS[f.id]; });
          if (newFile) {
            if (AUTO_KNOWN_IDS) AUTO_KNOWN_IDS[newFile.id] = true;
            autoRunFile(newFile);
          }
        }
      }, 500);
    }
  });

  es.addEventListener('reconnect', function() {
    console.log('[dashboard] Notify stream reconnecting...');
    es.close();
    NOTIFY_ES = null;
    // Reconnect after a short pause
    setTimeout(openNotifyStream, 1000);
  });

  es.onerror = function() {
    console.log('[dashboard] Notify stream error — will retry in 5s');
    es.close();
    NOTIFY_ES = null;
    setTimeout(openNotifyStream, 5000);
  };
}

async function seedAutoKnownIds() {
  var d = await api('/api/scan-files');
  if (d && d.files) {
    var processedIds = {};
    STATUS_CACHE.forEach(function(r){ if (r.status==='completed') processedIds[r.fileId]=true; });
    var unprocessed = d.files.filter(function(f){ return !processedIds[f.id]; });
    AUTO_KNOWN_IDS = {};
    unprocessed.forEach(function(f){ AUTO_KNOWN_IDS[f.id] = true; });
  }
}

async function autoPollScans() {
  // Don't poll while already processing or stopped
  if (AUTO_PROCESSING) return;

  var d = await api('/api/scan-files');
  if (!d || !d.success || !d.files) return;

  // Refresh status cache so completed files are excluded
  await loadStatus();
  var processedIds = {};
  STATUS_CACHE.forEach(function(r){ if (r.status==='completed') processedIds[r.fileId]=true; });
  var unprocessed = d.files.filter(function(f){ return !processedIds[f.id]; });

  // Initialise known IDs on first poll if not seeded yet
  if (AUTO_KNOWN_IDS === null) {
    AUTO_KNOWN_IDS = {};
    unprocessed.forEach(function(f){ AUTO_KNOWN_IDS[f.id] = true; });
    return;
  }

  // Find files that are NEW (not in our known set)
  var newFiles = unprocessed.filter(function(f){ return !AUTO_KNOWN_IDS[f.id]; });

  if (!newFiles.length) return;

  // Add new files to known set immediately so we don't trigger again
  newFiles.forEach(function(f){ AUTO_KNOWN_IDS[f.id] = true; });

  // Refresh the Scans panel to show the new file
  window.SCAN_FILES = unprocessed;
  $('scan-count').textContent = unprocessed.length + ' file' + (unprocessed.length===1?'':'s');
  $('scan-list').innerHTML = unprocessed.map(function(f, idx){
    return '<div class="fi" id="sf-' + f.id + '" data-fid="' + esc(f.id) + '" data-idx="' + idx + '" onclick="clickScan(this)">'
      + '<div class="fic">&#128196;</div>'
      + '<div class="fin"><div class="fnm">' + esc(f.name) + '</div><div class="fmeta">' + fsize(f.size) + ' &middot; ' + fdate(f.createdAt) + '</div></div>'
      + '<div class="fac"><span class="wbadge">&#9203;</span>'
      + '<button class="rstbtn" data-rid="' + esc(f.id) + '" onclick="doReset(event,this.dataset.rid)" title="Reset">&#8635;</button>'
      + '<div class="chk">&#10003;</div></div>'
      + '</div>';
  }).join('');
  refreshBadges();

  // Auto-process the first new file
  var fileToProcess = newFiles[0];
  autoRunFile(fileToProcess);
}

async function autoRunFile(f) {
  if (AUTO_PROCESSING) return;
  AUTO_PROCESSING = true;

  // Highlight the file in the Scans list
  document.querySelectorAll('.fi').forEach(function(x){ x.classList.remove('sel'); });
  var el = $('sf-' + f.id);
  if (el) el.classList.add('sel');

  // Show file details in the right panel
  SF = f;
  $('nosel').style.display = 'none';
  $('seldet').style.display = 'block';
  $('selname').textContent = f.name;
  $('selmeta').textContent = fsize(f.size) + ' \u00b7 ' + fdate(f.createdAt) + ' \u2022 Auto-detected';
  var ss = $('stepsel');
  if (ss) ss.style.display = 'none';
  // Hide Run button during auto processing — only shown for manual selection
  var btn = $('runbtn');
  btn.style.display = 'none';

  // Show progress steps
  IR = true;
  $('progidle').style.display = 'none';
  $('rescard').innerHTML = '';
  $('steplist').innerHTML = STEPS.map(function(s){ return mkStep(s.id, s.l, '', 'pending'); }).join('');

  try {
    var body = {fileId:f.id, fileName:f.name, runMode:'auto', runStep:1, isWaiting:!!WF[f.id]};
    var resp = await fetch('/api/test-run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (!resp.ok && resp.status !== 200) { autoFinErr('unknown', 'Server error ' + resp.status); return; }
    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '', evt = null;
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, {stream:true});
      var lines = buf.split('\\n'); buf = lines.pop();
      lines.forEach(function(line){
        if (line.startsWith('event: ')) evt = line.slice(7).trim();
        else if (line.startsWith('data: ')) {
          try { handleEvt(evt, JSON.parse(line.slice(6))); } catch(ex){}
        } else if (line === '') {
          evt = null;
        }
      });
    }
  } catch(err) { autoFinErr('unknown', err.message); }
}

function autoFinErr(step, msg) {
  IR = false;
  AUTO_PROCESSING = false;
  if (step !== 'unknown') updStep(step, msg, 'error');
  $('rescard').innerHTML = '<div class="rescard err"><div class="restitle">\u274c Auto Run Failed</div>'
    + '<div class="resrow"><div class="reslbl">Error</div><div class="resval" style="color:var(--rd)">' + esc(msg) + '</div></div></div>';
  var btn = $('runbtn');
  btn.style.display = '';
  btn.className = 'runbtn go'; btn.disabled = false;
  btn.innerHTML = '\u21ba Try Again';
  // Refresh both panels even on error
  setTimeout(function(){ loadStatus().then(function(){ loadScans(); loadProcessed(); }); }, 2000);
}
function setSt(n) {
  ST = n;
  [1,2,3].forEach(function(i){
    var el=$('sopt'+i);
    if(el) el.className='stopt'+(i===n?' on':'');
  });
}

// ── STOP/RESUME ──
async function loadStopState() {
  // Clear any previously set stop flag so the system always starts watching.
  // The stop/resume concept is removed — processing is always on.
  await api('/api/admin?action=control', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({action: 'resume'})
  });
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
  $('actbtn').disabled = true; $('stxt').textContent = 'Activating...';
  var d = await api('/api/subscribe?action=create');
  if (d && d.success) { $('sdot').className='dot g'; $('stxt').textContent='Activated!'; $('actbtn').style.display='none'; }
  else { $('stxt').textContent='Failed — check logs'; $('actbtn').disabled=false; }
}

// ── WAITING ──
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
    nl.innerHTML = '<div style="font-size:11px;color:var(--mu);text-align:center;padding:8px">Queue empty</div>';
  } else {
    nl.innerHTML = files.map(function(f){
      return '<div style="display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:6px;background:var(--s2);border:1px solid #d9770033;margin-bottom:4px;cursor:pointer" data-wfid="' + esc(f.fileId) + '" onclick="selWait(this.dataset.wfid)">'
        + '<div style="font-size:15px">&#128196;</div>'
        + '<div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.fileName) + '</div>'
        + '<div style="font-size:10px;color:var(--mu)">' + (f.totalPages||'?') + ' pages</div></div>'
        + '<div style="color:var(--or);font-size:10px">&#9654;</div></div>';
    }).join('');
  }
  refreshBadges();
}
function selWait(fid) {
  closeNotif();
  // Find file in SCAN_FILES and select it directly
  var f = window.SCAN_FILES && window.SCAN_FILES.find(function(x){ return x.id === fid; });
  if (f) {
    var el = $('sf-' + fid);
    if (el) {
      document.querySelectorAll('.fi').forEach(function(x){ x.classList.remove('sel'); });
      el.classList.add('sel');
    }
    SF = f;
    $('nosel').style.display = 'none';
    $('seldet').style.display = 'block';
    $('selname').textContent = f.name;
    $('selmeta').textContent = fsize(f.size) + ' · ' + fdate(f.createdAt);
    var btn = $('runbtn');
    btn.className = 'runbtn go';
    btn.disabled = false;
    btn.textContent = '▶ Process';
    resetProg();
  }
}
function toggleNotif() { $('np').classList.toggle('show'); }
function closeNotif() { $('np').classList.remove('show'); }
document.addEventListener('click', function(ev){ if (!ev.target.closest('.bell-wrap')) closeNotif(); });
function refreshBadges() {
  document.querySelectorAll('.fi[data-fid]').forEach(function(el){
    var fid = el.dataset.fid;
    var wb = el.querySelector('.wbadge');
    if (!wb) return;
    if (WF[fid]) { el.classList.add('wt'); wb.style.display='inline-block'; }
    else { el.classList.remove('wt'); wb.style.display='none'; }
  });
}

// -- SCANS FOLDER --
async function loadScans() {
  $('scan-list').innerHTML = '<div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading...</div></div>';
  $('scan-count').textContent = '—';
  var d = await api('/api/scan-files');
  if (!d || !d.success || !d.files || !d.files.length) {
    $('scan-count').textContent = d && d.files ? '0 files' : 'Error';
    $('scan-list').innerHTML = '<div class="stmsg"><div class="ic">&#128589;</div><div class="ti">' + (d ? 'No PDFs found' : 'Failed to load') + '</div></div>';
    return;
  }
  // Filter out files already completed in Firestore
  var processedIds = {};
  STATUS_CACHE.forEach(function(r) { if (r.status === 'completed') processedIds[r.fileId] = r; });
  var unprocessedFiles = d.files.filter(function(f) { return !processedIds[f.id]; });
  // Store the FILTERED list so idx in clickScan matches the rendered list
  window.SCAN_FILES = unprocessedFiles;
  $('scan-count').textContent = unprocessedFiles.length + ' file' + (unprocessedFiles.length===1?'':'s');
  if (!unprocessedFiles.length) {
    $('scan-list').innerHTML = '<div class="stmsg"><div class="ic">&#10003;</div><div class="ti">All files processed</div></div>';
    return;
  }
  $('scan-list').innerHTML = unprocessedFiles.map(function(f, idx){
    return '<div class="fi" id="sf-' + f.id + '" data-fid="' + esc(f.id) + '" data-idx="' + idx + '" onclick="clickScan(this)">'      + '<div class="fic">&#128196;</div>'      + '<div class="fin"><div class="fnm">' + esc(f.name) + '</div><div class="fmeta">' + fsize(f.size) + ' &middot; ' + fdate(f.createdAt) + '</div></div>'      + '<div class="fac"><span class="wbadge">&#9203;</span>'      + '<button class="rstbtn" data-rid="' + esc(f.id) + '" onclick="doReset(event,this.dataset.rid)" title="Reset">&#8635;</button>'      + '<div class="chk">&#10003;</div></div>'      + '</div>';
  }).join('');
  refreshBadges();
}

function clickScan(el) {
  if (IR) return;
  var fid = el.dataset.fid;
  var f = window.SCAN_FILES && window.SCAN_FILES.find(function(x){ return x.id === fid; });
  if (!f) return;
  document.querySelectorAll('.fi').forEach(function(x){ x.classList.remove('sel'); });
  el.classList.add('sel');
  SF = f;
  $('nosel').style.display = 'none';
  $('seldet').style.display = 'block';
  $('selname').textContent = f.name;
  $('selmeta').textContent = fsize(f.size) + ' \u00b7 ' + fdate(f.createdAt);
  var ss = $('stepsel');
  if (ss) ss.style.display = 'none'; // Step selector hidden — unified mode
  var btn = $('runbtn');
  btn.style.display = '';
  btn.className = 'runbtn go';
  btn.disabled = false;
  btn.textContent = '\u25b6 Process';
  resetProgOnly();
}

// ── PROCESSED FOLDER ──
async function loadProcessed() {
  $('proc-list').innerHTML = '<div class="stmsg"><div class="ic pulse">&#128194;</div><div class="ti">Loading...</div></div>';
  $('proc-count').textContent = '—';

  // Use cached status data — no extra Firestore call needed
  // Refresh cache if not yet loaded
  if (!STATUS_LOADED) await loadStatus();

  var d = await api('/api/scan-files?folder=Processed');
  var statusData = { records: STATUS_CACHE };


  if (!d || !d.success || !d.files || !d.files.length) {
    $('proc-count').textContent = d && d.files ? '0 files' : 'Error';
    $('proc-list').innerHTML = '<div class="stmsg"><div class="ic">&#128100;</div><div class="ti">' + (d ? 'No files yet' : 'Failed to load') + '</div></div>';
    return;
  }

  // Build lookup from cached status data
  var recsByFile = {};
  var recsByOriginal = {};
  if (statusData && statusData.records) {
    statusData.records.forEach(function(r) {
      (r.renamedFiles || []).forEach(function(fname) { recsByFile[fname] = r; });
      if (r.originalFileName) recsByOriginal[r.originalFileName.toLowerCase()] = r;
    });
  }

  $('proc-count').textContent = d.files.length + ' file' + (d.files.length===1?'':'s');
  $('proc-list').innerHTML = d.files.map(function(f, idx) {
    // Try exact renamed file match first, then partial base name match, then original file name
    var rec = recsByFile[f.name] || null;
    if (!rec) {
      // Try matching by base name (strip page number suffix like _01, -2 etc.)
      var baseName = f.name.replace(/[-_]d+.pdf$/i, '').replace(/.pdf$/i, '').toLowerCase();
      rec = recsByOriginal[baseName] || null;
    }
    if (!rec) {
      // Try matching any record whose customerName appears in the filename
      if (statusData && statusData.records) {
        rec = statusData.records.find(function(r) {
          if (!r.customerName) return false;
          return f.name.toLowerCase().includes(r.customerName.toLowerCase());
        }) || null;
      }
    }
    var customer = rec && rec.customerName ? rec.customerName : '';
    var ref = rec && rec.ref ? rec.ref : '';
    var supplier = rec && rec.supplier ? rec.supplier : '';
    var gdUrl = rec && rec.googleDriveFolderUrl ? rec.googleDriveFolderUrl : '';
    var odUrl = f.webUrl || '';
    var folderLabel = customer ? (customer + (ref ? ' / ' + ref : '')) : '';

    // Folder tags
    var tags = '';
    if (gdUrl) {
      tags += '<span class="folder-tag gd">&#128230; Google Drive</span> ';
    } else if (rec) {
      // Has Firestore record but no GD URL yet — show pending tag
      tags += '<span class="folder-tag" style="background:#1a1a00;color:#eab308;border:1px solid #eab30833">&#9203; GD Pending</span> ';
    }
    if (odUrl) tags += '<span class="folder-tag od">&#9729;&#65039; OneDrive</span>';

    // Dropdown content
    var dropId = 'pdrop-' + idx;
    var dropHtml = '<div class="proc-drop" id="' + dropId + '">';
    if (supplier) dropHtml += '<div class="pd-row"><div class="pd-lbl">Supplier</div><div class="pd-val">' + esc(supplier) + '</div></div>';
    if (folderLabel) dropHtml += '<div class="pd-row"><div class="pd-lbl">Folder</div><div class="pd-val" title="' + esc(folderLabel) + '">' + esc(folderLabel) + '</div></div>';
    if (gdUrl) {
      dropHtml += '<div class="pd-row"><div class="pd-lbl">Google Drive</div><a class="pd-link" href="' + esc(gdUrl) + '" target="_blank" onclick="event.stopPropagation()">Open folder &#8599;</a></div>';
    } else if (rec) {
      var sendBtnId = 'gdsend-' + idx;
      dropHtml += '<div class="pd-row"><div class="pd-lbl">Google Drive</div>'
        + '<button class="gd-send-btn" id="' + sendBtnId + '" '
        + 'data-fname="' + esc(f.name) + '" data-fid="' + esc(rec.fileId || '') + '" '
        + 'onclick="event.stopPropagation();sendToGDrive(this)">&#128230; Send to GD</button></div>';
    } else if (!rec) {
      // No Firestore record — can still try to send using filename only
      var sendBtnId2 = 'gdsend-' + idx;
      dropHtml += '<div class="pd-row"><div class="pd-lbl">Google Drive</div>'
        + '<button class="gd-send-btn" id="' + sendBtnId2 + '" '
        + 'data-fname="' + esc(f.name) + '" data-fid="" '
        + 'onclick="event.stopPropagation();sendToGDrive(this)">&#128230; Send to GD</button></div>';
    }
    if (odUrl) dropHtml += '<div class="pd-row"><div class="pd-lbl">OneDrive</div><a class="pd-link" href="' + esc(odUrl) + '" target="_blank" onclick="event.stopPropagation()">Open file &#8599;</a></div>';

    dropHtml += '</div>';

    return '<div class="fi done-f" data-dropid="' + dropId + '"  onclick="toggleProcDrop(this.dataset.dropid,this)" style="flex-direction:column;align-items:stretch;cursor:pointer">'
      + '<div style="display:flex;align-items:center;gap:8px">'
      + '<div class="fic">&#128196;</div>'
      + '<div class="fin"><div class="fnm">' + esc(f.name) + '</div>'
      + '<div class="fmeta">' + fsize(f.size) + ' &middot; ' + fdate(f.createdAt) + '</div></div>'
      + '<div class="fac" style="flex-direction:column;align-items:flex-end;gap:2px">' + tags + '</div>'
      + '</div>'
      + dropHtml
      + '</div>';
  }).join('');
}

function toggleProcDrop(dropId, el) {
  var drop = document.getElementById(dropId);
  if (!drop) return;
  var isOpen = drop.classList.contains('open');
  // Close all other dropdowns
  document.querySelectorAll('.proc-drop.open').forEach(function(d){ d.classList.remove('open'); });
  // Toggle this one
  if (!isOpen) drop.classList.add('open');
}

// ── RESET ──
async function doReset(ev, fid) {
  ev.stopPropagation();
  if (!confirm('Reset this file so it can be reprocessed?')) return;
  var d = await api('/api/admin?action=reset', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fileId:fid})});
  if (d && d.success) { alert('Reset \u2014 you can now run this file.'); loadWaiting(); }
  else { alert('Reset failed: ' + (d && d.error ? d.error : 'Unknown')); }
}

// ── RUN ──
async function startRun() {
  if (!SF || IR) return;
  // Re-resolve SF from SCAN_FILES by ID in case list was refreshed since selection
  var currentFile = window.SCAN_FILES && window.SCAN_FILES.find(function(x){ return x.id === SF.id; });
  if (currentFile) SF = currentFile;
  IR = true;
  var btn = $('runbtn');
  btn.className = 'runbtn going'; btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Running...';
  $('progidle').style.display = 'none';
  $('rescard').innerHTML = '';
  $('steplist').innerHTML = STEPS.map(function(s){ return mkStep(s.id, s.l, '', 'pending'); }).join('');

  try {
    var body = {fileId:SF.id, fileName:SF.name, runMode:CM, runStep:ST, isWaiting:!!WF[SF.id]};
    var resp = await fetch('/api/test-run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (!resp.ok && resp.status !== 200) { finErr('unknown', 'Server error ' + resp.status); return; }
    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '', evt = null;
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, {stream:true});
      var lines = buf.split('\\n'); buf = lines.pop();
      lines.forEach(function(line){
        if (line.startsWith('event: ')) evt = line.slice(7).trim();
        else if (line.startsWith('data: ')) {
          try { handleEvt(evt, JSON.parse(line.slice(6))); } catch(ex){}
        } else if (line === '') {
          evt = null;
        }
      });
    }
  } catch(err) { finErr('unknown', err.message); }
}

function handleEvt(ev, d) {
  if (ev==='progress') {
    if (d.status === 'running') {
      // Defer running state slightly so any pending 'done' renders first
      requestAnimationFrame(function(){ updStep(d.step, d.message, d.status); });
    } else {
      updStep(d.step, d.message, d.status);
    }
  }
  else if (ev==='complete') {
    // Ensure all steps show green on completion
    updStep(4, 'All ' + (d.totalPages || '') + ' page(s) sent to Make.com \u2713', 'done');
    updStep(5, 'All ' + (d.totalPages || '') + ' page(s) extracted by Claude \u2713', 'done');
    updStep(6, 'All ' + (d.totalPages || '') + ' page(s) filed \u2713', 'done');
    showRes(d);
    finRun(true);
  }
  else if (ev==='error') finErr(d.step, d.message);
}

function updStep(n, msg, st) {
  STEPS.forEach(function(s){
    if (s.id < n) {
      var el=$('st-'+s.id);
      // Mark any earlier step that is still pending OR running as done
      if(el && (el.dataset.status==='pending' || el.dataset.status==='running')) {
        el.outerHTML=mkStep(s.id,s.l,'','done');
      }
    }
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
    + '<div class="resrow"><div class="reslbl">Customer</div><div class="resval">' + esc(d.customerName||'\u2014') + '</div></div>'
    + '<div class="resrow"><div class="reslbl">Reference</div><div class="resval">' + esc(d.ref||'\u2014') + '</div></div>'
    + '<div class="resrow"><div class="reslbl">Pages</div><div class="resval">' + (d.totalPages||'\u2014') + '</div></div>'
    + (d.googleDriveFolderUrl ? '<div class="resrow"><div class="reslbl">Google Drive</div><div class="resval"><a class="reslink" href="'+d.googleDriveFolderUrl+'" target="_blank">Open \u2197</a></div></div>' : '')
    + (d.oneDriveProcessedFolderUrl ? '<div class="resrow"><div class="reslbl">OneDrive</div><div class="resval"><a class="reslink" href="'+d.oneDriveProcessedFolderUrl+'" target="_blank">Open \u2197</a></div></div>' : '')
    + (files ? '<div class="resrow" style="flex-direction:column;gap:2px"><div class="reslbl">Files</div>' + files + '</div>' : '')
    + '</div>';
}

function resetProgOnly() {
  // Clears only the progress steps panel — leaves file selection visible.
  // Called when a new file is clicked so the progress area is fresh.
  $('progidle').style.display = 'flex';
  $('steplist').innerHTML = '';
  $('rescard').innerHTML = '';
}

function resetProg() {
  // Full reset — clears both progress and file selection. Called after completion.
  resetProgOnly();
  $('nosel').style.display = 'flex';
  $('seldet').style.display = 'none';
  var btn = $('runbtn');
  if (btn) { btn.style.display = 'none'; btn.className = 'runbtn'; btn.disabled = true; btn.innerHTML = '\u25b6 Process'; }
}

function finRun(success) {
  IR = false;
  AUTO_PROCESSING = false;
  var btn = $('runbtn');
  loadWaiting();
  if (success) {
    btn.style.display = '';
    btn.className = 'runbtn'; btn.disabled = true;
    btn.innerHTML = '\u2705 Complete';
    // Hold result visible for 5s then fully reset in both auto and human mode
    setTimeout(function(){
      if (SF && AUTO_KNOWN_IDS) delete AUTO_KNOWN_IDS[SF.id];
      loadStatus().then(function(){ loadScans(); loadProcessed(); });
      document.querySelectorAll('.fi').forEach(function(x){ x.classList.remove('sel'); });
      SF = null;
      $('seldet').style.display = 'none';
      $('nosel').style.display = 'flex';
      resetProg();
    }, 5000);
  } else {
    btn.className = 'runbtn go'; btn.disabled = false;
    btn.innerHTML = '\u21ba Run Again';
  }
}

function finErr(step, msg) {
  IR = false;
  if (step !== 'unknown') updStep(step, msg, 'error');
  $('rescard').innerHTML = '<div class="rescard err"><div class="restitle">\u274c Failed</div>'
    + '<div class="resrow"><div class="reslbl">Error</div><div class="resval" style="color:var(--rd)">' + esc(msg) + '</div></div></div>';
  var btn = $('runbtn');
  btn.style.display = '';
  btn.className = 'runbtn go'; btn.disabled = false;
  btn.innerHTML = '\u21ba Try Again';
}

// ── PROCESS ALL ──
// processAll removed — system auto-processes all detected files

// ── GOOGLE DRIVE RETRY ──
async function retryGoogleDrive() {
  var btn = document.getElementById('gd-retry-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  btn.style.color = 'var(--yl)';

  // Open progress panel
  var panel = $('gdpanel');
  var body = $('gdp-body');
  var title = $('gdp-title');
  var count = $('gdp-count');
  panel.classList.add('open');
  body.innerHTML = '<div class="gdrow"><div class="gdrow-ic">&#9203;</div><div class="gdrow-body"><div class="gdrow-name">Connecting...</div></div></div>';
  title.textContent = 'Google Drive Filing';
  count.textContent = '';

  var fileRows = {}; // track rows by file name
  var total = 0, succeeded = 0, failed = 0;

  function addRow(id, iconClass, icon, name, detail, linkUrl, linkText) {
    var existing = body.querySelector('[data-gdrow="' + id + '"]');
    var html = '<div class="gdrow ' + iconClass + '" data-gdrow="' + esc(id) + '">'
      + '<div class="gdrow-ic">' + icon + '</div>'
      + '<div class="gdrow-body">'
      + '<div class="gdrow-name" title="' + esc(name) + '">' + esc(name) + '</div>'
      + (detail ? '<div class="gdrow-detail">' + esc(detail) + '</div>' : '')
      + (linkUrl ? '<a class="gdrow-link" href="' + esc(linkUrl) + '" target="_blank" onclick="event.stopPropagation()">Open ' + (linkText||'folder') + ' &#8599;</a>' : '')
      + '</div></div>';
    if (existing) {
      existing.outerHTML = html;
    } else {
      body.insertAdjacentHTML('beforeend', html);
      // Remove connecting message once real data arrives
      var connecting = body.querySelector('[data-gdrow="connecting"]');
      if (connecting) connecting.remove();
    }
    // Scroll to bottom
    body.scrollTop = body.scrollHeight;
  }

  try {
    var resp = await fetch('/api/gdrive?action=retry', { method: 'POST' });
    var reader = resp.body.getReader();
    var dec = new TextDecoder();
    var buf = '';

    // Clear initial connecting message
    body.innerHTML = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var lines2 = buf.split('\\n');
      buf = lines2.pop();
      for (var i = 0; i < lines2.length; i++) {
        var line = lines2[i].trim();
        if (!line || line.startsWith(': ')) continue;
        if (line.startsWith('data: ')) {
          try {
            var ev = JSON.parse(line.slice(6));
            if (ev.type === 'start') {
              total = ev.total;
              title.textContent = 'Filing ' + total + ' file' + (total===1?'':'s') + ' to Google Drive';
            } else if (ev.type === 'file' && ev.status === 'filing') {
              addRow('file-' + ev.name, 'filing', '&#9203;', ev.name, 'Filing ' + ev.pages + ' page(s)...', null, null);
            } else if (ev.type === 'file' && ev.status === 'success') {
              succeeded++;
              count.textContent = succeeded + '/' + total + ' done';
              addRow('file-' + ev.name, 'success', '&#10003;', ev.name,
                ev.pages + ' page(s) filed',
                ev.gdFolderUrl, 'folder');
            } else if (ev.type === 'file' && ev.status === 'failed') {
              failed++;
              addRow('file-' + ev.name, 'failed', '&#10007;', ev.name, 'Failed', null, null);
            } else if (ev.type === 'file' && ev.status === 'skipped') {
              addRow('file-' + ev.name, 'skipped', '&#8212;', ev.name, ev.reason || 'Skipped', null, null);
            } else if (ev.type === 'page' && ev.status === 'success') {
              addRow('page-' + ev.name + '-' + ev.page, 'success', '&#128196;',
                ev.fileName,
                'Page ' + ev.page + ' → ' + (ev.folder || ''),
                ev.gdFileUrl || ev.gdFolderUrl, ev.gdFileUrl ? 'file' : 'folder');
            } else if (ev.type === 'page' && ev.status === 'failed') {
              addRow('page-' + ev.name + '-' + ev.page, 'failed', '&#10007;',
                ev.fileName, 'Page ' + ev.page + ': ' + (ev.reason || 'failed'), null, null);
            } else if (ev.type === 'done') {
              var msg = ev.message || (ev.succeeded + ' succeeded, ' + ev.failed + ' failed');
              if (ev.total === 0) {
                body.innerHTML = '<div class="gdrow success"><div class="gdrow-ic">&#10003;</div><div class="gdrow-body"><div class="gdrow-name">All files already in Google Drive</div></div></div>';
              }
              count.textContent = ev.total === 0 ? 'Nothing to do' : (ev.succeeded + '/' + ev.total + ' done');
              title.textContent = 'Google Drive Filing Complete';
              // Refresh processed panel
              setTimeout(function(){ loadStatus().then(loadProcessed); }, 1500);
            }
          } catch(ex) {}
        }
      }
    }
  } catch(err) {
    body.insertAdjacentHTML('beforeend', '<div class="gdrow failed"><div class="gdrow-ic">&#10007;</div><div class="gdrow-body"><div class="gdrow-name">Connection error</div><div class="gdrow-detail">' + esc(err.message) + '</div></div></div>');
  }

  btn.disabled = false;
  btn.innerHTML = '&#128230; GD';
  btn.style.color = 'var(--gn)';
}

// ── SEND SINGLE FILE TO GOOGLE DRIVE ──
async function sendToGDrive(btn) {
  var fileName = btn.dataset.fname;
  var fileId = btn.dataset.fid;
  if (!fileName) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  var d = await api('/api/gdrive?action=file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: fileName, fileId: fileId || undefined }),
  });

  if (d && d.success) {
    // Show success inline
    btn.style.display = 'none';
    var row = btn.closest('.pd-row');
    if (row) {
      row.innerHTML = '<div class="pd-lbl">Google Drive</div>'
        + (d.gdFileUrl
          ? '<a class="pd-link" href="' + esc(d.gdFileUrl) + '" target="_blank">Open file &#8599;</a>'
          : '<a class="pd-link" href="' + esc(d.gdFolderUrl) + '" target="_blank">Open folder &#8599;</a>'
        )
        + ' <span style="color:var(--gn);font-size:10px">&#10003; Filed to ' + esc(d.folder || '') + '</span>';
    }
    // Refresh status cache and processed panel after a moment
    setTimeout(function(){ loadStatus().then(loadProcessed); }, 2000);
  } else {
    var errMsg = (d && d.error) ? d.error : 'Request failed — check Vercel logs';
    btn.disabled = false;
    btn.innerHTML = '&#10007; Retry';
    btn.style.color = 'var(--rd)';
    // Show error message below the button
    var row = btn.closest('.pd-row');
    if (row) {
      var existing = row.parentNode.querySelector('.gd-err-msg');
      if (existing) existing.remove();
      var errDiv = document.createElement('div');
      errDiv.className = 'gd-err-msg';
      errDiv.style.cssText = 'font-size:10px;color:var(--rd);padding:3px 12px 4px;word-break:break-all';
      errDiv.textContent = '\u26a0 ' + errMsg;
      row.parentNode.insertBefore(errDiv, row.nextSibling);
      setTimeout(function(){
        if (errDiv.parentNode) errDiv.remove();
        btn.innerHTML = '&#128230; Send to GD';
        btn.style.color = 'var(--gn)';
      }, 8000);
    }
  }
}

// ── LOGS PANEL ──
var LOGS_OPEN = false;

function toggleLogs() {
  var panel = $('logspanel');
  var btn = $('logs-btn');
  LOGS_OPEN = !LOGS_OPEN;
  if (LOGS_OPEN) {
    panel.className = 'diagpanel open';
    btn.className = 'rfbtn diagbtn active';
    refreshLogs();
  } else {
    panel.className = 'diagpanel';
    btn.className = 'rfbtn diagbtn';
  }
}

async function refreshLogs() {
  var body = $('logsbody');
  body.innerHTML = '<div style="font-size:11px;color:var(--mu);text-align:center;padding:8px"><span class="spin"></span> Loading...</div>';
  try {
    var r = await fetch('/api/logs');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var d = await r.json();
    if (!d.entries || !d.entries.length) {
      body.innerHTML = '<div style="font-size:11px;color:var(--mu);text-align:center;padding:12px">No read logs found yet. Deploy and run the system for a few minutes then refresh.</div>';
      return;
    }
    // Group by source
    var grouped = {};
    d.entries.forEach(function(e) {
      if (!grouped[e.source]) grouped[e.source] = { source: e.source, total: 0, count: 0 };
      grouped[e.source].total += e.reads;
      grouped[e.source].count++;
    });
    var sorted = Object.values(grouped).sort(function(a, b) { return b.total - a.total; });
    var rows = sorted.map(function(g) {
      var pct = d.totalReads ? Math.round((g.total / d.totalReads) * 100) : 0;
      var bar = '<div style="height:4px;background:var(--bo);border-radius:2px;margin-top:3px"><div style="height:4px;background:var(--or);border-radius:2px;width:' + pct + '%"></div></div>';
      return '<div class="diagrow" style="flex-direction:column;gap:2px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
        + '<div class="diag-label" style="font-size:11px">' + esc(g.source) + '</div>'
        + '<div style="font-size:11px;color:var(--or);font-weight:600">' + g.total + ' reads (' + pct + '%)</div>'
        + '</div>'
        + bar
        + '<div style="font-size:10px;color:var(--mu)">' + g.count + ' invocation(s) logged</div>'
        + '</div>';
    }).join('');
    var summary = '<div class="diagrow" style="margin-top:6px;border-color:var(--or)33">'
      + '<div class="diag-label" style="font-size:11px;color:var(--or)">Total reads logged</div>'
      + '<div class="diag-detail" style="color:var(--or);font-weight:600">' + d.totalReads + ' across ' + d.entries.length + ' log entries (last ' + (d.windowMins || 60) + ' mins)</div>'
      + '</div>';
    body.innerHTML = rows + summary;
  } catch (err) {
    body.innerHTML = '<div class="diagrow fail"><div class="diag-ic">&#10060;</div><div class="diag-label">Failed to load</div><div class="diag-detail">' + esc(err.message) + '</div></div>';
  }
}

// ── DIAGNOSTICS ──
var DIAG_OPEN = false;
var DIAG_RUNNING = false;

function toggleDiag() {
  var panel = $('diagpanel');
  var btn = $('diag-btn');
  DIAG_OPEN = !DIAG_OPEN;
  if (DIAG_OPEN) {
    panel.className = 'diagpanel open';
    btn.className = 'rfbtn diagbtn active';
    runDiag();
  } else {
    panel.className = 'diagpanel';
    btn.className = 'rfbtn diagbtn';
  }
}

async function runDiag() {
  if (DIAG_RUNNING) return;
  DIAG_RUNNING = true;
  var body = $('diagbody');
  body.innerHTML = '<div class="diagrow loading"><div class="diag-ic"><span class="spin"></span></div><div class="diag-label">Running checks\u2026</div><div class="diag-detail">Contacting server</div></div>';

  try {
    var r = await fetch('/api/diag?format=json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var d = await r.json();

    var rows = (d.results || []).map(function(item) {
      var cls = item.ok ? 'ok' : 'fail';
      var ic  = item.ok ? '&#9989;' : '&#10060;';
      return '<div class="diagrow ' + cls + '">'
        + '<div class="diag-ic">' + ic + '</div>'
        + '<div class="diag-label">' + esc(item.label) + '</div>'
        + '<div class="diag-detail">' + esc(String(item.detail || '')) + '</div>'
        + '</div>';
    }).join('');

    var sumCls = d.ok ? 'ok' : 'fail';
    var sumIc  = d.ok ? '&#9989;' : '&#10060;';
    var summary = '<div class="diagsummary ' + sumCls + '">'
      + '<span>' + sumIc + '</span>'
      + '<span>' + esc(d.summary || '') + ' \u2014 ' + (d.ok ? 'All checks passed' : 'One or more checks failed') + '</span>'
      + '</div>';

    body.innerHTML = rows + summary;
  } catch (err) {
    body.innerHTML = '<div class="diagrow fail"><div class="diag-ic">&#10060;</div><div class="diag-label">Request failed</div><div class="diag-detail">' + esc(err.message) + '</div></div>';
  }

  DIAG_RUNNING = false;
}

// ── INIT ──
// Load status cache first — everything else depends on it
loadStatus().then(function() {
  loadMode();
  loadScans();
  loadProcessed();
  loadWaiting();
});
loadSub();
// Open SSE notify stream for instant new-file detection
openNotifyStream();
// Refresh status cache every 60 seconds
setInterval(loadStatus, 300000); // 5 mins — status cache refreshed on demand by SSE events
setInterval(loadWaiting, 120000); // 2 mins — queue rarely changes without a notify event
// Stop state cleared on load — no need to poll it
</script>
</body></html>`;
