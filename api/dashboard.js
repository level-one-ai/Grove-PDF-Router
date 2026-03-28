const { requireAuth } = require('../lib/auth');
const fs = require('fs');
const path = require('path');

module.exports = async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Inline the HTML directly as a string to avoid file system issues on Vercel
  res.status(200).send(getDashboardHTML());
};

function getDashboardHTML() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grove PDF Router</title><style>' +
  '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}' +
  ':root{--orange:#d97700;--bg:#0a0a0a;--sur:#1a1a1a;--sur2:#242424;--bor:#2e2e2e;--txt:#f0f0f0;--mut:#888;--grn:#22c55e;--red:#ef4444;--yel:#eab308}' +
  'body{background:var(--bg);color:var(--txt);font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}' +
  'header{background:var(--sur);border-bottom:1px solid var(--bor);padding:0 20px;height:58px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}' +
  '.logo{display:flex;align-items:center;gap:10px}' +
  '.logo-icon{width:32px;height:32px;background:var(--orange);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:16px}' +
  '.logo-text{font-size:14px;font-weight:600}.logo-sub{font-size:11px;color:var(--mut)}' +
  '.hdr-mid{display:flex;align-items:center;gap:8px}' +
  '.mode-wrap{display:flex;align-items:center;gap:10px}' +
  '.mode-lbl{font-size:12px;font-weight:600;color:var(--mut);min-width:36px;transition:color .3s;user-select:none}' +
  '.mode-lbl.active{color:var(--txt)}' +
  '.toggle-switch{position:relative;width:64px;height:30px;cursor:pointer;flex-shrink:0}' +
  '.toggle-track{position:absolute;inset:0;border-radius:15px;background:linear-gradient(135deg,#0d2a0d,#1a3a1a);border:2px solid #22c55e77;transition:all .35s;box-shadow:inset 0 2px 5px #0007}' +
  '.toggle-track.human{background:linear-gradient(135deg,#2a0d00,#3a1a00);border-color:#d9770077}' +
  '.toggle-knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffffff,#c8c8c8 40%,#909090);box-shadow:0 2px 6px #0007,inset 0 1px 2px #fffa;transition:all .35s cubic-bezier(.4,0,.2,1)}' +
  '.toggle-knob.human{left:39px}' +
  '.mode-toggle{display:flex;background:var(--sur2);border:1px solid var(--bor);border-radius:20px;padding:3px;gap:3px}' +
  '.mode-btn{padding:5px 14px;border-radius:16px;border:none;font-size:12px;font-weight:600;cursor:pointer;background:transparent;color:var(--mut);transition:all .2s}' +
  '.mode-btn.active-auto{background:var(--grn);color:#fff}' +
  '.mode-btn.active-human{background:var(--orange);color:#fff}' +
  '.hdr-right{display:flex;align-items:center;gap:8px;position:relative}' +
  '.sub-bar{display:flex;align-items:center;gap:7px;background:var(--sur2);border:1px solid var(--bor);padding:4px 12px;border-radius:20px}' +
  '.sub-dot{width:7px;height:7px;border-radius:50%}' +
  '.sub-dot.green{background:var(--grn);box-shadow:0 0 5px var(--grn)}.sub-dot.yellow{background:var(--yel)}.sub-dot.red{background:var(--red)}.sub-dot.grey{background:var(--mut)}' +
  '.sub-label{font-size:11px;color:var(--mut);white-space:nowrap}' +
  '.sub-act{background:var(--orange);color:#fff;border:none;padding:4px 12px;border-radius:16px;font-size:11px;font-weight:600;cursor:pointer}' +
  '.bell{background:none;border:1px solid var(--bor);border-radius:8px;padding:5px 9px;cursor:pointer;color:var(--mut);font-size:15px;position:relative;transition:all .15s}' +
  '.bell:hover{border-color:var(--orange);color:var(--orange)}' +
  '.bell-badge{position:absolute;top:-5px;right:-5px;background:var(--red);color:#fff;font-size:10px;font-weight:700;border-radius:10px;padding:1px 5px;display:none}' +
  '.notif-panel{display:none;position:absolute;top:48px;right:0;width:300px;background:var(--sur);border:1px solid var(--bor);border-radius:10px;box-shadow:0 8px 30px #0008;z-index:200;padding:14px}' +
  '.notif-panel.open{display:block}' +
  '.notif-title{font-size:12px;font-weight:600;margin-bottom:10px}' +
  '.notif-item{display:flex;align-items:center;gap:10px;padding:8px;border-radius:7px;background:var(--sur2);border:1px solid #d9770044;margin-bottom:6px;cursor:pointer;transition:all .15s}' +
  '.notif-item:hover{border-color:var(--orange)}' +
  '.main{display:grid;grid-template-columns:1fr 400px;flex:1;height:calc(100vh - 58px)}' +
  '.file-browser{border-right:1px solid var(--bor);display:flex;flex-direction:column;overflow:hidden}' +
  '.ph{padding:14px 18px 10px;border-bottom:1px solid var(--bor);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}' +
  '.panel-title{font-size:13px;font-weight:600}.panel-meta{font-size:11px;color:var(--mut)}' +
  '.ref-btn{background:none;border:1px solid var(--bor);color:var(--mut);padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;transition:all .15s}' +
  '.ref-btn:hover{border-color:var(--orange);color:var(--orange)}' +
  '.path-bar{padding:7px 18px;background:var(--sur);border-bottom:1px solid var(--bor);font-size:11px;color:var(--mut);flex-shrink:0}' +
  '.path-bar span{color:var(--orange)}' +
  '.file-list{overflow-y:auto;flex:1;padding:8px}' +
  '.file-list::-webkit-scrollbar{width:5px}.file-list::-webkit-scrollbar-thumb{background:var(--bor);border-radius:3px}' +
  '.fi{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:9px;cursor:pointer;border:1px solid transparent;transition:all .15s;margin-bottom:4px;background:var(--sur)}' +
  '.fi:hover{border-color:var(--bor);background:var(--sur2)}' +
  '.fi.sel{border-color:var(--orange);background:#1f1500}' +
  '.fi.waiting{border-color:#d9770044;background:#1a0f00}' +
  '.fi-icon{width:36px;height:36px;background:#1a0f00;border:1px solid #3a2000;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}' +
  '.fi.sel .fi-icon{border-color:var(--orange)}' +
  '.fi-info{flex:1;min-width:0}' +
  '.fi-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}' +
  '.fi-meta{font-size:11px;color:var(--mut)}' +
  '.fi-acts{display:flex;align-items:center;gap:5px;flex-shrink:0}' +
  '.w-badge{background:#d9770022;color:var(--orange);border:1px solid #d9770055;font-size:9px;font-weight:700;padding:2px 6px;border-radius:8px;display:none}' +
  '.rst-btn{background:none;border:1px solid var(--bor);color:var(--mut);width:22px;height:22px;border-radius:5px;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;transition:all .15s}' +
  '.rst-btn:hover{border-color:var(--red);color:var(--red)}' +
  '.sel-dot{width:17px;height:17px;border-radius:50%;border:2px solid var(--bor);display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}' +
  '.fi.sel .sel-dot{background:var(--orange);border-color:var(--orange)}' +
  '.fi.sel .sel-dot::after{content:"\\2713";font-size:10px;color:#fff;font-weight:700}' +
  '.state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:50px 20px;color:var(--mut);text-align:center}' +
  '.state .icon{font-size:34px}.state .title{font-size:14px;font-weight:500;color:var(--txt)}.state .desc{font-size:12px;line-height:1.5}' +
  '.right-panel{display:flex;flex-direction:column;overflow:hidden}' +
  '.sel-info{padding:16px 20px;border-bottom:1px solid var(--bor);flex-shrink:0;min-height:120px;display:flex;flex-direction:column;justify-content:center}' +
  '.no-sel{display:flex;flex-direction:column;align-items:center;gap:7px;color:var(--mut);text-align:center}' +
  '.no-sel .icon{font-size:26px}.no-sel .title{font-size:12px;font-weight:500;color:var(--mut)}' +
  '.sel-name{font-size:13px;font-weight:600;margin-bottom:3px;word-break:break-all}' +
  '.sel-meta{font-size:11px;color:var(--mut);margin-bottom:10px}' +
  '.step-sel{margin-bottom:10px;display:none}' +
  '.step-sel-label{font-size:10px;color:var(--mut);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}' +
  '.step-opts{display:flex;flex-direction:column;gap:4px}' +
  '.sopt{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:6px;border:1px solid var(--bor);cursor:pointer;background:var(--sur2);transition:all .15s}' +
  '.sopt:hover{border-color:var(--orange)}.sopt.sel-opt{border-color:var(--orange);background:#1f1500}' +
  '.sopt input{accent-color:var(--orange)}' +
  '.sopt-txt strong{display:block;color:var(--txt);font-size:12px;margin-bottom:1px}.sopt-txt span{color:var(--mut);font-size:11px}' +
  '.run-btn{width:100%;padding:11px;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;border:none;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:7px}' +
  '.run-btn:disabled{background:var(--sur2);color:var(--mut);cursor:not-allowed;border:1px solid var(--bor)}' +
  '.run-btn.ready{background:var(--orange);color:#fff;box-shadow:0 0 16px #d9770033}' +
  '.run-btn.ready:hover{background:#f59e0b;transform:translateY(-1px)}' +
  '.run-btn.running{background:var(--sur2);color:var(--mut);cursor:not-allowed;border:1px solid var(--bor)}' +
  '.prog-panel{flex:1;overflow-y:auto;padding:16px 20px}' +
  '.prog-panel::-webkit-scrollbar{width:5px}.prog-panel::-webkit-scrollbar-thumb{background:var(--bor);border-radius:3px}' +
  '.prog-title{font-size:11px;font-weight:600;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}' +
  '.prog-idle{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 0;color:var(--mut);text-align:center}' +
  '.prog-idle .icon{font-size:30px}.prog-idle .desc{font-size:12px;line-height:1.5}' +
  '.step-list{display:flex;flex-direction:column;gap:6px}' +
  '.step{display:flex;align-items:flex-start;gap:9px;padding:9px 11px;border-radius:7px;background:var(--sur);border:1px solid var(--bor);transition:all .3s}' +
  '.step.running{border-color:var(--orange);background:#1f1500}.step.done{border-color:#22c55e33;background:#0f1f0f}.step.error{border-color:#ef444433;background:#1f0f0f}' +
  '.step-ico{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;margin-top:1px}' +
  '.step.pending .step-ico{background:var(--sur2);color:var(--mut)}.step.running .step-ico{background:var(--orange);color:#fff}.step.done .step-ico{background:var(--grn);color:#fff}.step.error .step-ico{background:var(--red);color:#fff}' +
  '.step-lbl{font-size:12px;font-weight:500;margin-bottom:1px}.step-msg{font-size:11px;color:var(--mut);line-height:1.4}' +
  '.step.running .step-msg{color:var(--orange)}.step.done .step-msg{color:#4ade80}.step.error .step-msg{color:var(--red)}' +
  '.res-card{margin-top:12px;background:#0f1f0f;border:1px solid #22c55e44;border-radius:9px;padding:13px}' +
  '.res-title{font-size:12px;font-weight:600;color:var(--grn);margin-bottom:10px}' +
  '.res-row{display:flex;align-items:flex-start;gap:7px;margin-bottom:6px;font-size:11px}' +
  '.res-lbl{color:var(--mut);min-width:80px;flex-shrink:0}.res-val{color:var(--txt);word-break:break-all}' +
  '.res-link{color:var(--orange);text-decoration:none}.res-link:hover{text-decoration:underline}' +
  '.fpill{background:var(--sur2);border:1px solid var(--bor);border-radius:5px;padding:2px 7px;font-size:10px;color:var(--mut);font-family:monospace;margin-top:2px}' +
  '@keyframes spin{to{transform:rotate(360deg)}}.spinner{width:11px;height:11px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}' +
  '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}.pulsing{animation:pulse 1.5s ease-in-out infinite}' +
  '</style></head><body>' +
  '<header>' +
  '<div class="logo"><div class="logo-icon">&#128196;</div><div><div class="logo-text">Grove PDF Router</div><div class="logo-sub">Dashboard</div></div></div>' +
  '<div class="hdr-mid"><div class="mode-wrap"><span class="mode-lbl active" id="lbl-auto">Auto</span><div class="toggle-switch" id="toggle-sw" onclick="toggleMode()"><div class="toggle-track" id="toggle-track"></div><div class="toggle-knob" id="toggle-knob"></div></div><span class="mode-lbl" id="lbl-human">Human</span></div></div>' +
  '<div class="hdr-right">' +
  '<div class="sub-bar"><div class="sub-dot grey" id="sub-dot"></div><span class="sub-label" id="sub-label">Checking...</span></div>' +
  '<button class="sub-act" id="sub-act" style="display:none" onclick="activateSub()">Activate</button>' +
  '<button class="bell" onclick="toggleNotif()">&#128276;<span class="bell-badge" id="bell-badge"></span></button>' +
  '<div class="notif-panel" id="notif-panel"><div class="notif-title">&#9203; Waiting for Approval</div><div id="notif-list"></div></div>' +
  '</div></header>' +
  '<div class="main">' +
  '<div class="file-browser">' +
  '<div class="ph"><div><div class="panel-title">OneDrive Scans Folder</div><div class="panel-meta" id="fcount">Loading...</div></div><button class="ref-btn" onclick="loadFiles()">&#8635; Refresh</button></div>' +
  '<div class="path-bar">&#128193; Grove Group Scotland &rsaquo; Grove Bedding &rsaquo; <span>Scans</span></div>' +
  '<div class="file-list" id="file-list"><div class="state"><div class="icon pulsing">&#128194;</div><div class="title">Loading files...</div></div></div>' +
  '</div>' +
  '<div class="right-panel">' +
  '<div class="sel-info">' +
  '<div id="no-sel" class="no-sel"><div class="icon">&#9757;</div><div class="title">Select a file to begin</div></div>' +
  '<div id="sel-detail" style="display:none">' +
  '<div class="sel-name" id="sel-name"></div><div class="sel-meta" id="sel-meta"></div>' +
  '<div class="step-sel" id="step-sel">' +
  '<div class="step-sel-label">Run up to:</div>' +
  '<div class="step-opts">' +
  '<label class="sopt sel-opt" id="opt1"><input type="radio" name="rs" value="1" checked onchange="selStep(1)"><div class="sopt-txt"><strong>Full run</strong><span>AI extraction + file to Google Drive &amp; OneDrive</span></div></label>' +
  '<label class="sopt" id="opt2"><input type="radio" name="rs" value="2" onchange="selStep(2)"><div class="sopt-txt"><strong>AI extraction only</strong><span>Send to Make.com, get JSON — skip filing</span></div></label>' +
  '<label class="sopt" id="opt3"><input type="radio" name="rs" value="3" onchange="selStep(3)"><div class="sopt-txt"><strong>Split only</strong><span>Download &amp; split — skip Make.com</span></div></label>' +
  '</div></div>' +
  '<button class="run-btn" id="run-btn" onclick="startRun()" disabled>&#9654; Run</button>' +
  '</div></div>' +
  '<div class="prog-panel"><div class="prog-title">Progress</div>' +
  '<div id="prog-idle" class="prog-idle"><div class="icon">&#129514;</div><div class="desc">Select a file and click <strong style="color:var(--txt)">Run</strong></div></div>' +
  '<div id="step-list" class="step-list" style="display:none"></div>' +
  '<div id="res-card"></div>' +
  '</div></div></div>' +
  '<script>' +
  'var selFile=null,isRun=false,curMode="auto",selStep_=1,waiting={};' +
  'var STEPS=[{id:1,l:"Initialise record"},{id:2,l:"Download from OneDrive"},{id:3,l:"Split PDF pages"},{id:4,l:"Dispatch to Make.com"},{id:5,l:"AI extraction"},{id:6,l:"File to OneDrive & Google Drive"}];' +
  'function esc(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}' +
  'function fmtD(iso){if(!iso)return"";var d=new Date(iso);return d.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})+" "+d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}' +
  'async function loadMode(){try{var r=await fetch("/api/mode"),d=await r.json();curMode=d.mode||"auto";updMode();}catch(e){}}' +
  'async function toggleMode(){var m=curMode==="auto"?"human":"auto";await setMode(m);}async function setMode(m){curMode=m;updMode();await fetch("/api/mode",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:m})});updStepSel();}' +
  'function updMode(){var h=curMode==="human";var t=document.getElementById("toggle-track");var k=document.getElementById("toggle-knob");var la=document.getElementById("lbl-auto");var lh=document.getElementById("lbl-human");if(t)t.className="toggle-track"+(h?" human":"");if(k)k.className="toggle-knob"+(h?" human":"");if(la)la.className="mode-lbl"+(h?"":" active");if(lh)lh.className="mode-lbl"+(h?" active":"");updStepSel();}' +
  'function updStepSel(){var el=document.getElementById("step-sel");if(el)el.style.display=curMode==="human"?"block":"none";}' +
  'function selStep(n){selStep_=n;[1,2,3].forEach(function(i){var el=document.getElementById("opt"+i);if(el)el.className="sopt"+(i===n?" sel-opt":"");});}' +
  'async function loadSubStatus(){try{var r=await fetch("/api/subscribe?action=status"),d=await r.json();document.getElementById("sub-dot").className="sub-dot "+(d.colour||"grey");document.getElementById("sub-label").textContent=d.message||"Unknown";document.getElementById("sub-act").style.display=(d.status==="none"||d.status==="expired")?"inline-block":"none";}catch(e){}}' +
  'async function activateSub(){var btn=document.getElementById("sub-act"),lbl=document.getElementById("sub-label");btn.disabled=true;lbl.textContent="Activating...";try{var r=await fetch("/api/subscribe?action=create"),d=await r.json();lbl.textContent=d.success?"Activated!":"Failed: "+(d.error||"");document.getElementById("sub-dot").className="sub-dot "+(d.success?"green":"red");if(d.success)btn.style.display="none";else btn.disabled=false;}catch(e){lbl.textContent="Error";btn.disabled=false;}}' +
  'async function loadWaiting(){try{var r=await fetch("/api/waiting"),d=await r.json(),files=d.files||[];waiting={};files.forEach(function(f){waiting[f.fileId]=f;});var badge=document.getElementById("bell-badge");if(files.length>0){badge.style.display="block";badge.textContent=String(files.length);}else{badge.style.display="none";}var list=document.getElementById("notif-list");if(!files.length){list.innerHTML="<div style=\\"font-size:12px;color:var(--mut);text-align:center;padding:10px\\">No files waiting</div>";}else{list.innerHTML=files.map(function(f){return"<div class=\\"notif-item\\" onclick=\\"selWaiting(\'"+f.fileId+"\')\\" ><div style=\\"font-size:18px\\">&#128196;</div><div style=\\"flex:1;min-width:0\\"><div style=\\"font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\\">"+esc(f.fileName)+"</div><div style=\\"font-size:10px;color:var(--mut)\\">"+f.totalPages+" page(s) &middot; Waiting</div></div><div style=\\"color:var(--orange);font-size:11px;font-weight:600\\">&#9654;</div></div>";}).join("");}refreshWBadges();}catch(e){}}' +
  'function selWaiting(fid){var wf=waiting[fid];if(!wf)return;closeNotif();var el=document.getElementById("file-"+fid);if(el){el.click();}}' +
  'function toggleNotif(){document.getElementById("notif-panel").classList.toggle("open");}' +
  'function closeNotif(){document.getElementById("notif-panel").classList.remove("open");}' +
  'document.addEventListener("click",function(e){if(!e.target.closest(".bell")&&!e.target.closest(".notif-panel"))closeNotif();});' +
  'function refreshWBadges(){document.querySelectorAll(".fi").forEach(function(el){var fid=el.dataset.fileid;var badge=el.querySelector(".w-badge");if(badge){if(waiting[fid]){el.classList.add("waiting");badge.style.display="inline-block";}else{el.classList.remove("waiting");badge.style.display="none";}}});}' +
  'async function loadFiles(){var list=document.getElementById("file-list"),cnt=document.getElementById("fcount");list.innerHTML="<div class=\\"state\\"><div class=\\"icon pulsing\\">&#128194;</div><div class=\\"title\\">Loading...</div></div>";try{var r=await fetch("/api/scan-files");if(r.status===401){list.innerHTML="<div class=\\"state\\"><div class=\\"icon\\">&#128274;</div><div class=\\"title\\">Unauthorised</div></div>";return;}var d=await r.json();if(!d.success||!d.files||!d.files.length){cnt.textContent="No PDFs found";list.innerHTML="<div class=\\"state\\"><div class=\\"icon\\">&#128589;</div><div class=\\"title\\">No PDFs found</div></div>";return;}cnt.textContent=d.files.length+" file"+(d.files.length===1?"":"s");list.innerHTML=d.files.map(function(f){var fd=encodeURIComponent(JSON.stringify(f));return"<div class=\\"fi\\" id=\\"file-"+f.id+"\\" data-fileid=\\""+f.id+"\\" data-fd=\\""+esc(JSON.stringify(f))+"\\" onclick=\\"selFile(this)\\"><div class=\\"fi-icon\\">&#128196;</div><div class=\\"fi-info\\"><div class=\\"fi-name\\">"+esc(f.name)+"</div><div class=\\"fi-meta\\">"+esc(f.sizeFormatted)+" &middot; "+fmtD(f.createdAt)+"</div></div><div class=\\"fi-acts\\"><span class=\\"w-badge\\">&#9203; Waiting</span><button class=\\"rst-btn\\" onclick=\\"rstFile(event,\'"+f.id+"\')\\" title=\\"Reset\\">&#8635;</button><div class=\\"sel-dot\\"></div></div></div>";}).join("");refreshWBadges();}catch(err){cnt.textContent="Error";list.innerHTML="<div class=\\"state\\"><div class=\\"icon\\">&#9888;</div><div class=\\"title\\">Failed to load</div><div class=\\"desc\\">"+esc(err.message)+"</div></div>";}}' +
  'function selFile(el){if(isRun)return;document.querySelectorAll(".fi").forEach(function(e){e.classList.remove("sel");});el.classList.add("sel");var f=JSON.parse(el.dataset.fd);selFile_=f;document.getElementById("no-sel").style.display="none";document.getElementById("sel-detail").style.display="block";document.getElementById("sel-name").textContent=f.name;document.getElementById("sel-meta").textContent=f.sizeFormatted+" \u00b7 "+fmtD(f.createdAt);updStepSel();var btn=document.getElementById("run-btn");btn.className="run-btn ready";btn.disabled=false;btn.innerHTML=waiting[f.id]?"&#9654; Run (Waiting)":"&#9654; Run";resetProg();}' +
  'var selFile_=null;' +
  'async function rstFile(e,fid){e.stopPropagation();if(!confirm("Reset this file so it can be reprocessed?"))return;try{var r=await fetch("/api/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fileId:fid})});var d=await r.json();if(d.success){alert("Reset successful \u2014 you can now run this file.");loadWaiting();}else{alert("Reset failed: "+(d.error||"Unknown"));}}catch(err){alert("Error: "+err.message);}}' +
  'async function startRun(){if(!selFile_||isRun)return;isRun=true;var btn=document.getElementById("run-btn");btn.className="run-btn running";btn.disabled=true;btn.innerHTML="<div class=\\"spinner\\"></div> Running...";document.getElementById("prog-idle").style.display="none";document.getElementById("res-card").innerHTML="";var sl=document.getElementById("step-list");sl.style.display="flex";sl.innerHTML=STEPS.map(function(s){return renderStep(s.id,s.l,"","pending");}).join("");try{var body={fileId:selFile_.id,fileName:selFile_.name,runMode:curMode,runStep:selStep_,isWaiting:!!waiting[selFile_.id]};var response=await fetch("/api/test-run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});if(response.status===401){finErr("unknown","Session expired");return;}var reader=response.body.getReader(),decoder=new TextDecoder(),buf="";while(true){var chunk=await reader.read();if(chunk.done)break;buf+=decoder.decode(chunk.value,{stream:true});var lines=buf.split("\\n");buf=lines.pop();var evt=null;for(var i=0;i<lines.length;i++){if(lines[i].startsWith("event: "))evt=lines[i].slice(7).trim();else if(lines[i].startsWith("data: ")){try{handleEvt(evt,JSON.parse(lines[i].slice(6)));}catch(ex){}}}};}catch(err){finErr("unknown",err.message);}}' +
  'function handleEvt(event,data){if(event==="progress")updStep(data.step,data.message,data.status);else if(event==="complete"){updStep(6,"Filed to OneDrive & Google Drive \u2713","done");showRes(data);finRun();}else if(event==="error")finErr(data.step,data.message);}' +
  'function updStep(n,msg,st){STEPS.forEach(function(s){if(s.id<n){var el=document.getElementById("s-"+s.id);if(el&&el.dataset.status==="pending")el.outerHTML=renderStep(s.id,s.l,"","done");}});var existing=document.getElementById("s-"+n);var step=STEPS.find(function(s){return s.id===n;});if(!step)return;var html=renderStep(n,step.l,msg,st);if(existing)existing.outerHTML=html;else document.getElementById("step-list").insertAdjacentHTML("beforeend",html);}' +
  'function renderStep(id,label,msg,st){var icons={pending:id,running:"",done:"\u2713",error:"\u2715"};var ico=st==="running"?"<div class=\\"spinner\\"></div>":String(icons[st]||id);return"<div class=\\"step "+st+"\\" id=\\"s-"+id+"\\" data-status=\\""+st+"\\"><div class=\\"step-ico\\">"+ico+"</div><div style=\\"flex:1;min-width:0\\"><div class=\\"step-lbl\\">"+esc(label)+"</div>"+(msg?"<div class=\\"step-msg\\">"+esc(msg)+"</div>":"")+"</div></div>";}' +
  'function showRes(data){var files=(data.renamedFiles||[]).map(function(f){return"<div class=\\"fpill\\">"+esc(f)+"</div>";}).join("");document.getElementById("res-card").innerHTML="<div class=\\"res-card\\"><div class=\\"res-title\\">\u2705 Complete</div><div class=\\"res-row\\"><div class=\\"res-lbl\\">Supplier</div><div class=\\"res-val\\">"+esc(data.supplier||"\u2014")+"</div></div><div class=\\"res-row\\"><div class=\\"res-lbl\\">Customer</div><div class=\\"res-val\\">"+esc(data.customerName||"\u2014")+"</div></div><div class=\\"res-row\\"><div class=\\"res-lbl\\">Reference</div><div class=\\"res-val\\">"+esc(data.ref||"\u2014")+"</div></div><div class=\\"res-row\\"><div class=\\"res-lbl\\">Pages</div><div class=\\"res-val\\">"+(data.totalPages||"\u2014")+"</div></div>"+(data.googleDriveFolderUrl?"<div class=\\"res-row\\"><div class=\\"res-lbl\\">Google Drive</div><div class=\\"res-val\\"><a class=\\"res-link\\" href=\\""+data.googleDriveFolderUrl+"\\" target=\\"_blank\\">Open folder \u2197</a></div></div>":"")+(data.oneDriveProcessedFolderUrl?"<div class=\\"res-row\\"><div class=\\"res-lbl\\">OneDrive</div><div class=\\"res-val\\"><a class=\\"res-link\\" href=\\""+data.oneDriveProcessedFolderUrl+"\\" target=\\"_blank\\">Open folder \u2197</a></div></div>":"")+(files?"<div class=\\"res-row\\" style=\\"flex-direction:column;gap:3px\\"><div class=\\"res-lbl\\">Output files</div>"+files+"</div>":"")+"</div>";}' +
  'function resetProg(){document.getElementById("prog-idle").style.display="flex";document.getElementById("step-list").style.display="none";document.getElementById("step-list").innerHTML="";document.getElementById("res-card").innerHTML="";}' +
  'function finRun(){isRun=false;var btn=document.getElementById("run-btn");btn.className="run-btn ready";btn.disabled=false;btn.innerHTML="\u21ba Run Again";loadWaiting();}' +
  'function finErr(step,msg){isRun=false;if(step!=="unknown")updStep(step,msg,"error");document.getElementById("res-card").innerHTML="<div class=\\"res-card\\" style=\\"background:#1f0f0f;border-color:#ef444433\\"><div class=\\"res-title\\" style=\\"color:var(--red)\\">\u274c Failed</div><div class=\\"res-row\\"><div class=\\"res-lbl\\">Error</div><div class=\\"res-val\\" style=\\"color:var(--red)\\">"+esc(msg)+"</div></div></div>";var btn=document.getElementById("run-btn");btn.className="run-btn ready";btn.disabled=false;btn.innerHTML="\u21ba Try Again";}' +
  'loadMode();loadFiles();loadSubStatus();loadWaiting();setInterval(loadWaiting,30000);' +
  '<\/script></body></html>';
}
