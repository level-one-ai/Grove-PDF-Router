const { requireAuth } = require('../lib/auth');
module.exports = async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(getDashboardHTML());
};
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grove PDF Router</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--or:#d97700;--orl:#f59e0b;--bg:#0a0a0a;--su:#1a1a1a;--s2:#242424;--bo:#2e2e2e;--tx:#f0f0f0;--mu:#888;--gn:#22c55e;--rd:#ef4444;--yl:#eab308}
body{background:var(--bg);color:var(--tx);font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
header{background:var(--su);border-bottom:1px solid var(--bo);padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;gap:12px}
.logo{display:flex;align-items:center;gap:9px;flex-shrink:0}
.li{width:30px;height:30px;background:var(--or);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px}
.lt{font-size:13px;font-weight:600}.ls{font-size:10px;color:var(--mu)}
/* TOGGLE */
.mw{display:flex;align-items:center;gap:10px}
.ml{font-size:12px;font-weight:600;color:var(--mu);min-width:36px;transition:color .3s;user-select:none;cursor:pointer}
.ml.on{color:var(--tx)}
.ts{position:relative;width:60px;height:28px;cursor:pointer;flex-shrink:0}
.tt{position:absolute;inset:0;border-radius:14px;background:linear-gradient(135deg,#0a220a,#14301a);border:2px solid #22c55e66;transition:all .35s;box-shadow:inset 0 2px 5px #0008}
.tt.h{background:linear-gradient(135deg,#220a00,#301400);border-color:#d9770066}
.tk{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#ccc 40%,#888);box-shadow:0 2px 5px #0008,inset 0 1px 2px #fffa;transition:all .35s cubic-bezier(.4,0,.2,1)}
.tk.h{left:35px}
/* HEADER RIGHT */
.hr{display:flex;align-items:center;gap:8px;position:relative}
.sb{display:flex;align-items:center;gap:6px;background:var(--s2);border:1px solid var(--bo);padding:4px 10px;border-radius:16px}
.sd{width:6px;height:6px;border-radius:50%}
.sd.green{background:var(--gn);box-shadow:0 0 5px var(--gn)}.sd.yellow{background:var(--yl)}.sd.red{background:var(--rd)}.sd.grey{background:var(--mu)}
.sl{font-size:11px;color:var(--mu);white-space:nowrap}
.sa{background:var(--or);color:#fff;border:none;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;cursor:pointer}
.bell{background:none;border:1px solid var(--bo);border-radius:7px;padding:4px 8px;cursor:pointer;color:var(--mu);font-size:14px;position:relative;transition:all .15s}
.bell:hover{border-color:var(--or);color:var(--or)}
.bb{position:absolute;top:-5px;right:-5px;background:var(--rd);color:#fff;font-size:9px;font-weight:700;border-radius:8px;padding:1px 4px;display:none}
.np{display:none;position:absolute;top:46px;right:0;width:290px;background:var(--su);border:1px solid var(--bo);border-radius:9px;box-shadow:0 8px 28px #0009;z-index:200;padding:12px}
.np.open{display:block}
.nt{font-size:12px;font-weight:600;margin-bottom:8px}
.ni{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:6px;background:var(--s2);border:1px solid #d9770033;margin-bottom:5px;cursor:pointer;transition:all .15s}
.ni:hover{border-color:var(--or)}
/* MAIN */
.main{display:grid;grid-template-columns:1fr 390px;flex:1;height:calc(100vh - 56px)}
/* FILE BROWSER */
.fb{border-right:1px solid var(--bo);display:flex;flex-direction:column;overflow:hidden}
.ph{padding:12px 16px 10px;border-bottom:1px solid var(--bo);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.pt{font-size:13px;font-weight:600}.pm{font-size:11px;color:var(--mu)}
.rb{background:none;border:1px solid var(--bo);color:var(--mu);padding:4px 9px;border-radius:5px;font-size:11px;cursor:pointer;transition:all .15s}
.rb:hover{border-color:var(--or);color:var(--or)}
.pb{padding:6px 16px;background:var(--su);border-bottom:1px solid var(--bo);font-size:11px;color:var(--mu);flex-shrink:0}
.pb span{color:var(--or)}
.fl{overflow-y:auto;flex:1;padding:7px}
.fl::-webkit-scrollbar{width:4px}.fl::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
/* FILE ITEMS */
.fi{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:8px;cursor:pointer;border:1px solid transparent;transition:all .15s;margin-bottom:4px;background:var(--su)}
.fi:hover{border-color:var(--bo);background:var(--s2)}
.fi.sel{border-color:var(--or);background:#1f1500}
.fi.wt{border-color:#d9770033;background:#1a0f00}
.fic{width:34px;height:34px;background:#1a0f00;border:1px solid #3a2000;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.fi.sel .fic{border-color:var(--or)}
.fin{flex:1;min-width:0}
.fnm{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:1px}
.fmt{font-size:11px;color:var(--mu)}
.fac{display:flex;align-items:center;gap:5px;flex-shrink:0}
.wb{background:#d9770022;color:var(--or);border:1px solid #d9770044;font-size:9px;font-weight:700;padding:2px 6px;border-radius:7px;display:none}
.rstb{background:none;border:1px solid var(--bo);color:var(--mu);width:20px;height:20px;border-radius:4px;cursor:pointer;font-size:10px;display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
.rstb:hover{border-color:var(--rd);color:var(--rd)}
.seldot{width:16px;height:16px;border-radius:50%;border:2px solid var(--bo);display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
.fi.sel .seldot{background:var(--or);border-color:var(--or)}
.fi.sel .seldot::after{content:"\u2713";font-size:9px;color:#fff;font-weight:700}
/* STATE */
.stm{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:44px 18px;color:var(--mu);text-align:center}
.stm .ic{font-size:32px}.stm .ti{font-size:13px;font-weight:500;color:var(--tx)}.stm .de{font-size:11px;line-height:1.5}
/* RIGHT PANEL */
.rp{display:flex;flex-direction:column;overflow:hidden}
.si{padding:14px 18px;border-bottom:1px solid var(--bo);flex-shrink:0;min-height:115px;display:flex;flex-direction:column;justify-content:center}
.ns{display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--mu);text-align:center}
.ns .ic{font-size:24px}.ns .ti{font-size:12px;font-weight:500;color:var(--mu)}
.sn{font-size:13px;font-weight:600;margin-bottom:3px;word-break:break-all}
.sm{font-size:11px;color:var(--mu);margin-bottom:10px}
/* STEP SELECTOR */
.ss{margin-bottom:9px;display:none}
.ssl{font-size:10px;color:var(--mu);margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.so{display:flex;flex-direction:column;gap:3px}
.sop{display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:6px;border:1px solid var(--bo);cursor:pointer;background:var(--s2);transition:all .15s}
.sop:hover{border-color:var(--or)}.sop.sel-op{border-color:var(--or);background:#1f1500}
.sop input{accent-color:var(--or)}
.sot strong{display:block;color:var(--tx);font-size:12px;margin-bottom:1px}.sot span{color:var(--mu);font-size:11px}
/* RUN BTN */
.runb{width:100%;padding:10px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px}
.runb:disabled{background:var(--s2);color:var(--mu);cursor:not-allowed;border:1px solid var(--bo)}
.runb.ready{background:var(--or);color:#fff;box-shadow:0 0 14px #d9770033}
.runb.ready:hover{background:var(--orl);transform:translateY(-1px)}
.runb.running{background:var(--s2);color:var(--mu);cursor:not-allowed;border:1px solid var(--bo)}
/* PROGRESS */
.pp{flex:1;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column}
.pp::-webkit-scrollbar{width:4px}.pp::-webkit-scrollbar-thumb{background:var(--bo);border-radius:2px}
.ptl{font-size:11px;font-weight:600;color:var(--mu);text-transform:uppercase;letter-spacing:.08em;margin-bottom:11px;flex-shrink:0}
.pid{display:flex;flex-direction:column;align-items:center;gap:7px;padding:24px 0;color:var(--mu);text-align:center}
.pid .ic{font-size:28px}.pid .de{font-size:12px;line-height:1.5}
.stpl{display:flex;flex-direction:column;gap:5px;flex:1}
.stp{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:6px;background:var(--su);border:1px solid var(--bo);transition:all .3s}
.stp.running{border-color:var(--or);background:#1f1500}.stp.done{border-color:#22c55e33;background:#0f1f0f}.stp.error{border-color:#ef444433;background:#1f0f0f}
.stpic{width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;margin-top:1px}
.stp.pending .stpic{background:var(--s2);color:var(--mu)}.stp.running .stpic{background:var(--or);color:#fff}.stp.done .stpic{background:var(--gn);color:#fff}.stp.error .stpic{background:var(--rd);color:#fff}
.stpl2{font-size:12px;font-weight:500;margin-bottom:1px}.stpm{font-size:11px;color:var(--mu);line-height:1.4}
.stp.running .stpm{color:var(--or)}.stp.done .stpm{color:#4ade80}.stp.error .stpm{color:var(--rd)}
/* RESULTS */
.rc{margin-top:10px;background:#0f1f0f;border:1px solid #22c55e44;border-radius:8px;padding:12px}
.rct{font-size:12px;font-weight:600;color:var(--gn);margin-bottom:9px}
.rr{display:flex;align-items:flex-start;gap:6px;margin-bottom:5px;font-size:11px}
.rl{color:var(--mu);min-width:76px;flex-shrink:0}.rv{color:var(--tx);word-break:break-all}
.rlk{color:var(--or);text-decoration:none}.rlk:hover{text-decoration:underline}
.fp{background:var(--s2);border:1px solid var(--bo);border-radius:4px;padding:2px 6px;font-size:10px;color:var(--mu);font-family:monospace;margin-top:2px}
/* STOP BUTTON */
.stop-area{padding:12px 18px;border-top:1px solid var(--bo);flex-shrink:0;display:none}
.stop-area.visible{display:block}
.stopb{width:100%;padding:9px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px}
.stopb.stop{background:#1f0f0f;color:var(--rd);border:1px solid #ef444455}
.stopb.stop:hover{background:#2f0f0f;border-color:var(--rd)}
.stopb.resume{background:#0f1f0f;color:var(--gn);border:1px solid #22c55e55}
.stopb.resume:hover{background:#0f2f0f;border-color:var(--gn)}
/* SPINNER */
@keyframes spin{to{transform:rotate(360deg)}}.sp{width:11px;height:11px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}.pl{animation:pulse 1.5s ease-in-out infinite}
</style>
</head>
<body>
<header>
  <div class="logo"><div class="li">&#128196;</div><div><div class="lt">Grove PDF Router</div><div class="ls">Dashboard</div></div></div>
  <div class="mw">
    <span class="ml on" id="lbl-auto" onclick="toggleMode()">Auto</span>
    <div class="ts" onclick="toggleMode()">
      <div class="tt" id="tt"></div>
      <div class="tk" id="tk"></div>
    </div>
    <span class="ml" id="lbl-human" onclick="toggleMode()">Human</span>
  </div>
  <div class="hr">
    <div class="sb"><div class="sd grey" id="sd"></div><span class="sl" id="sl">Checking...</span></div>
    <button class="sa" id="sa" style="display:none" onclick="activateSub()">Activate</button>
    <button class="bell" onclick="toggleNotif()">&#128276;<span class="bb" id="bb"></span></button>
    <div class="np" id="np"><div class="nt">&#9203; Waiting for Approval</div><div id="nl"></div></div>
  </div>
</header>

<div class="main">
  <div class="fb">
    <div class="ph">
      <div><div class="pt">OneDrive Scans Folder</div><div class="pm" id="fc">Loading...</div></div>
      <button class="rb" onclick="loadFiles()">&#8635; Refresh</button>
    </div>
    <div class="pb">&#128193; Grove Group Scotland &rsaquo; Grove Bedding &rsaquo; <span>Scans</span></div>
    <div class="fl" id="fl"><div class="stm"><div class="ic pl">&#128194;</div><div class="ti">Loading files...</div></div></div>
  </div>

  <div class="rp">
    <div class="si">
      <div id="ns" class="ns"><div class="ic">&#9757;</div><div class="ti">Select a file to begin</div></div>
      <div id="sd2" style="display:none">
        <div class="sn" id="sn"></div>
        <div class="sm" id="sm"></div>
        <div class="ss" id="ss">
          <div class="ssl">Run up to:</div>
          <div class="so">
            <label class="sop sel-op" id="op1"><input type="radio" name="rs" value="1" checked onchange="selSt(1)"><div class="sot"><strong>Full run</strong><span>AI extraction + file to Google Drive &amp; OneDrive</span></div></label>
            <label class="sop" id="op2"><input type="radio" name="rs" value="2" onchange="selSt(2)"><div class="sot"><strong>AI extraction only</strong><span>Send to Make.com, get JSON — skip filing</span></div></label>
            <label class="sop" id="op3"><input type="radio" name="rs" value="3" onchange="selSt(3)"><div class="sot"><strong>Split only</strong><span>Download &amp; split — skip Make.com</span></div></label>
          </div>
        </div>
        <button class="runb" id="runb" onclick="startRun()" disabled>&#9654; Run</button>
      </div>
    </div>

    <div class="pp" id="pp">
      <div class="ptl">Progress</div>
      <div id="pid" class="pid"><div class="ic">&#129514;</div><div class="de">Select a file and click <strong style="color:var(--tx)">Run</strong></div></div>
      <div id="stpl" class="stpl" style="display:none"></div>
      <div id="rc"></div>
    </div>

    <div class="stop-area" id="stop-area">
      <button class="stopb stop" id="stopb" onclick="handleStop()">&#9632; Stop Processing</button>
    </div>
  </div>
</div>

<script>
var SF=null,IR=false,CM='auto',SS=1,WF={},stopped=false;
var STEPS=[{id:1,l:'Initialise record'},{id:2,l:'Download from OneDrive'},{id:3,l:'Split PDF pages'},{id:4,l:'Dispatch to Make.com'},{id:5,l:'AI extraction'},{id:6,l:'File to OneDrive & Google Drive'}];

function e(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fd(iso){if(!iso)return'';var d=new Date(iso);return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}

// MODE
async function loadMode(){
  try{var r=await ft('/api/mode',null,5000),d=await r.json();CM=d.mode||'auto';updMode();}catch(ex){CM='auto';updMode();}
}
async function toggleMode(){
  var m=CM==='auto'?'human':'auto';
  CM=m;updMode();
  await ft('/api/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:m})});
  updSS();
}
function updMode(){
  var h=CM==='human';
  document.getElementById('tt').className='tt'+(h?' h':'');
  document.getElementById('tk').className='tk'+(h?' h':'');
  document.getElementById('lbl-auto').className='ml'+(h?'':' on');
  document.getElementById('lbl-human').className='ml'+(h?' on':'');
  updSS();
  // Show stop area only in auto mode
  if(CM==='auto') loadStopState();
  else{document.getElementById('stop-area').className='stop-area';}
}
function updSS(){
  var el=document.getElementById('ss');
  if(el)el.style.display=CM==='human'?'block':'none';
}
function selSt(n){
  SS=n;[1,2,3].forEach(function(i){
    var el=document.getElementById('op'+i);
    if(el)el.className='sop'+(i===n?' sel-op':'');
  });
}

// STOP/RESUME
async function loadStopState(){
  try{
    var r=await ft('/api/control',null,5000),d=await r.json();
    stopped=d.stopped||false;
    updateStopBtn();
  }catch(ex){}
}
function updateStopBtn(){
  var area=document.getElementById('stop-area');
  var btn=document.getElementById('stopb');
  if(CM!=='auto'){area.className='stop-area';return;}
  area.className='stop-area visible';
  if(stopped){
    btn.className='stopb resume';
    btn.innerHTML='&#9654; Resume Processing';
  } else {
    btn.className='stopb stop';
    btn.innerHTML='&#9632; Stop Processing';
  }
}
async function handleStop(){
  var action=stopped?'resume':'stop';
  try{
    var r=await ft('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action})});
    var d=await r.json();
    stopped=d.stopped;
    updateStopBtn();
  }catch(ex){alert('Control error: '+ex.message);}
}

// SUBSCRIPTION
async function loadSub(){
  try{
    var r=await ft('/api/subscribe?action=status',null,8000),d=await r.json();
    document.getElementById('sd').className='sd '+(d.colour||'grey');
    document.getElementById('sl').textContent=d.message||'Unknown';
    document.getElementById('sa').style.display=(d.status==='none'||d.status==='expired')?'inline-block':'none';
  }catch(ex){}
}
async function activateSub(){
  var btn=document.getElementById('sa'),lbl=document.getElementById('sl');
  btn.disabled=true;lbl.textContent='Activating...';
  try{
    var r=await ft('/api/subscribe?action=create',null,15000),d=await r.json();
    lbl.textContent=d.success?'Activated!':'Failed: '+(d.error||'');
    document.getElementById('sd').className='sd '+(d.success?'green':'red');
    if(d.success)btn.style.display='none';else btn.disabled=false;
  }catch(ex){lbl.textContent='Error';btn.disabled=false;}
}

// WAITING
async function loadWaiting(){
  try{
    var r=await ft('/api/waiting',null,6000),d=await r.json(),files=d.files||[];
    WF={};files.forEach(function(f){WF[f.fileId]=f;});
    var bb=document.getElementById('bb');
    if(files.length){bb.style.display='block';bb.textContent=String(files.length);}
    else bb.style.display='none';
    var nl=document.getElementById('nl');
    if(!files.length){nl.innerHTML='<div style="font-size:12px;color:var(--mu);text-align:center;padding:8px">No files waiting</div>';}
    else{nl.innerHTML=files.map(function(f){return'<div class="ni" onclick="selWait(\''+f.fileId+'\')"><div style="font-size:17px">&#128196;</div><div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+e(f.fileName)+'</div><div style="font-size:10px;color:var(--mu)">'+f.totalPages+' page(s) &middot; Waiting</div></div><div style="color:var(--or);font-size:11px">&#9654;</div></div>';}).join('');}
    refreshWB();
  }catch(ex){}
}
function selWait(fid){closeNotif();var el=document.getElementById('f-'+fid);if(el)el.click();}
function toggleNotif(){document.getElementById('np').classList.toggle('open');}
function closeNotif(){document.getElementById('np').classList.remove('open');}
document.addEventListener('click',function(ev){if(!ev.target.closest('.bell')&&!ev.target.closest('.np'))closeNotif();});
function refreshWB(){
  document.querySelectorAll('.fi').forEach(function(el){
    var fid=el.dataset.fid;
    var wb=el.querySelector('.wb');
    if(wb){if(WF[fid]){el.classList.add('wt');wb.style.display='inline-block';}else{el.classList.remove('wt');wb.style.display='none';}}
  });
}

// FILES
async function loadFiles(){
  var fl=document.getElementById('fl'),fc=document.getElementById('fc');
  fl.innerHTML='<div class="stm"><div class="ic pl">&#128194;</div><div class="ti">Loading...</div></div>';
  try{
    var r=await ft('/api/scan-files',null,10000);
    if(r.status===401){fl.innerHTML='<div class="stm"><div class="ic">&#128274;</div><div class="ti">Unauthorised</div></div>';return;}
    var d=await r.json();
    if(!d.success||!d.files||!d.files.length){
      fc.textContent='No PDFs found';
      fl.innerHTML='<div class="stm"><div class="ic">&#128589;</div><div class="ti">No PDFs found</div><div class="de">Upload a PDF to the Scans folder then refresh.</div></div>';
      return;
    }
    fc.textContent=d.files.length+' file'+(d.files.length===1?'':'s');
    fl.innerHTML=d.files.map(function(f){
      // Store file data as JSON in a data attribute - escape properly
      var fd=JSON.stringify(f).replace(/&/g,'&amp;').replace(/'/g,'&#39;');
      return '<div class="fi" id="f-'+f.id+'" data-fid="'+f.id+'" data-fd="'+fd+'" onclick="clickFile(this)">'
        +'<div class="fic">&#128196;</div>'
        +'<div class="fin"><div class="fnm">'+e(f.name)+'</div><div class="fmt">'+e(f.sizeFormatted)+' &middot; '+fd2(f.createdAt)+'</div></div>'
        +'<div class="fac"><span class="wb">&#9203; Waiting</span>'
        +'<button class="rstb" onclick="rstF(event,\''+f.id+'\')" title="Reset">&#8635;</button>'
        +'<div class="seldot"></div></div>'
        +'</div>';
    }).join('');
    refreshWB();
  }catch(err){
    fc.textContent='Error';
    fl.innerHTML='<div class="stm"><div class="ic">&#9888;</div><div class="ti">Failed to load</div><div class="de">'+e(err.message)+'</div></div>';
  }
}

function fd2(iso){if(!iso)return'';var d=new Date(iso);return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}

function clickFile(el){
  if(IR)return;
  document.querySelectorAll('.fi').forEach(function(x){x.classList.remove('sel');});
  el.classList.add('sel');
  var raw=el.dataset.fd;
  try{SF=JSON.parse(raw.replace(/&#39;/g,"'"));}catch(ex){console.error('Parse error',ex,raw);return;}
  document.getElementById('ns').style.display='none';
  document.getElementById('sd2').style.display='block';
  document.getElementById('sn').textContent=SF.name;
  document.getElementById('sm').textContent=SF.sizeFormatted+' \u00b7 '+fd2(SF.createdAt);
  updSS();
  var btn=document.getElementById('runb');
  btn.className='runb ready';
  btn.disabled=false;
  btn.textContent=WF[SF.id]?'Run (Waiting)':'\u25b6 Run';
  resetProg();
}

// RESET
async function rstF(ev,fid){
  ev.stopPropagation();
  if(!confirm('Reset this file record so it can be reprocessed?'))return;
  try{
    var r=await ft('/api/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:fid})});
    var d=await r.json();
    if(d.success){alert('Reset successful \u2014 you can now run this file.');loadWaiting();}
    else alert('Reset failed: '+(d.error||'Unknown'));
  }catch(err){alert('Error: '+err.message);}
}

// RUN
async function startRun(){
  if(!SF||IR)return;
  IR=true;
  var btn=document.getElementById('runb');
  btn.className='runb running';btn.disabled=true;
  btn.innerHTML='<div class="sp"></div> Running...';
  document.getElementById('pid').style.display='none';
  document.getElementById('rc').innerHTML='';
  var stpl=document.getElementById('stpl');
  stpl.style.display='flex';
  stpl.innerHTML=STEPS.map(function(s){return mkStep(s.id,s.l,'','pending');}).join('');
  try{
    var body={fileId:SF.id,fileName:SF.name,runMode:CM,runStep:SS,isWaiting:!!WF[SF.id]};
    var resp=await fetch('/api/test-run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'include'});
    if(resp.status===401){finErr('unknown','Session expired');return;}
    var reader=resp.body.getReader(),dec=new TextDecoder(),buf='';
    while(true){
      var chunk=await reader.read();
      if(chunk.done)break;
      buf+=dec.decode(chunk.value,{stream:true});
      var lines=buf.split('\n');buf=lines.pop();
      var evt=null;
      for(var i=0;i<lines.length;i++){
        if(lines[i].startsWith('event: '))evt=lines[i].slice(7).trim();
        else if(lines[i].startsWith('data: ')){try{handleEvt(evt,JSON.parse(lines[i].slice(6)));}catch(ex){}}
      }
    }
  }catch(err){finErr('unknown',err.message);}
}

function handleEvt(ev,d){
  if(ev==='progress')updStep(d.step,d.message,d.status);
  else if(ev==='complete'){updStep(6,'Filed to OneDrive & Google Drive \u2713','done');showRes(d);finRun();}
  else if(ev==='error')finErr(d.step,d.message);
}

function updStep(n,msg,st){
  STEPS.forEach(function(s){if(s.id<n){var el=document.getElementById('st-'+s.id);if(el&&el.dataset.status==='pending')el.outerHTML=mkStep(s.id,s.l,'','done');}});
  var ex=document.getElementById('st-'+n);
  var step=STEPS.find(function(s){return s.id===n;});
  if(!step)return;
  var html=mkStep(n,step.l,msg,st);
  if(ex)ex.outerHTML=html;
  else document.getElementById('stpl').insertAdjacentHTML('beforeend',html);
}

function mkStep(id,label,msg,st){
  var ico={pending:String(id),running:'',done:'\u2713',error:'\u2715'};
  var ic=st==='running'?'<div class="sp"></div>':ico[st]||String(id);
  return '<div class="stp '+st+'" id="st-'+id+'" data-status="'+st+'">'
    +'<div class="stpic">'+ic+'</div>'
    +'<div style="flex:1;min-width:0"><div class="stpl2">'+e(label)+'</div>'
    +(msg?'<div class="stpm">'+e(msg)+'</div>':'')
    +'</div></div>';
}

function showRes(d){
  var files=(d.renamedFiles||[]).map(function(f){return'<div class="fp">'+e(f)+'</div>';}).join('');
  document.getElementById('rc').innerHTML='<div class="rc"><div class="rct">\u2705 Complete</div>'
    +'<div class="rr"><div class="rl">Supplier</div><div class="rv">'+e(d.supplier||'\u2014')+'</div></div>'
    +'<div class="rr"><div class="rl">Customer</div><div class="rv">'+e(d.customerName||'\u2014')+'</div></div>'
    +'<div class="rr"><div class="rl">Reference</div><div class="rv">'+e(d.ref||'\u2014')+'</div></div>'
    +'<div class="rr"><div class="rl">Pages</div><div class="rv">'+(d.totalPages||'\u2014')+'</div></div>'
    +(d.googleDriveFolderUrl?'<div class="rr"><div class="rl">Google Drive</div><div class="rv"><a class="rlk" href="'+d.googleDriveFolderUrl+'" target="_blank">Open folder \u2197</a></div></div>':'')
    +(d.oneDriveProcessedFolderUrl?'<div class="rr"><div class="rl">OneDrive</div><div class="rv"><a class="rlk" href="'+d.oneDriveProcessedFolderUrl+'" target="_blank">Open folder \u2197</a></div></div>':'')
    +(files?'<div class="rr" style="flex-direction:column;gap:3px"><div class="rl">Output files</div>'+files+'</div>':'')
    +'</div>';
}

function resetProg(){
  document.getElementById('pid').style.display='flex';
  document.getElementById('stpl').style.display='none';
  document.getElementById('stpl').innerHTML='';
  document.getElementById('rc').innerHTML='';
}

function finRun(){
  IR=false;
  var btn=document.getElementById('runb');
  btn.className='runb ready';btn.disabled=false;
  btn.innerHTML='\u21ba Run Again';
  loadWaiting();
}

function finErr(step,msg){
  IR=false;
  if(step!=='unknown')updStep(step,msg,'error');
  document.getElementById('rc').innerHTML='<div class="rc" style="background:#1f0f0f;border-color:#ef444433">'
    +'<div class="rct" style="color:var(--rd)">\u274c Failed</div>'
    +'<div class="rr"><div class="rl">Error</div><div class="rv" style="color:var(--rd)">'+e(msg)+'</div></div>'
    +'</div>';
  var btn=document.getElementById('runb');
  btn.className='runb ready';btn.disabled=false;
  btn.innerHTML='\u21ba Try Again';
}


function ft(url,opts,ms){
  ms=ms||8000;
  var ctrl=new AbortController();
  var timer=setTimeout(function(){ctrl.abort();},ms);
  // Send credentials so Basic Auth passes through to API endpoints
  var merged=Object.assign({credentials:'include'},opts||{},{signal:ctrl.signal});
  return fetch(url,merged).finally(function(){clearTimeout(timer);});
}
// INIT
loadMode();
loadFiles();
loadSub();
loadWaiting();
setInterval(loadWaiting,30000);
setInterval(function(){if(CM==='auto')loadStopState();},10000);
</script>
</body></html>`;
}
