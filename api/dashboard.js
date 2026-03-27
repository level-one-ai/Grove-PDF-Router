/**
 * /api/dashboard
 *
 * Serves the test dashboard HTML page.
 * Password protected via Basic Auth.
 */

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
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Grove PDF Router — Test Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --orange: #d97700;
      --orange-light: #f59e0b;
      --bg: #0a0a0a;
      --surface: #1a1a1a;
      --surface2: #242424;
      --border: #2e2e2e;
      --text: #f0f0f0;
      --text-muted: #888;
      --green: #22c55e;
      --red: #ef4444;
      --blue: #3b82f6;
      --yellow: #eab308;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* ── HEADER ── */
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 32px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-icon {
      width: 36px;
      height: 36px;
      background: var(--orange);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }

    .logo-text {
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
    }

    .logo-sub {
      font-size: 12px;
      color: var(--text-muted);
    }

    .header-right { display: flex; align-items: center; gap: 14px; }
    .header-badge { background: #1a2a1a; border: 1px solid #22c55e44; color: var(--green); font-size: 12px; padding: 4px 12px; border-radius: 20px; font-weight: 500; }
    .sub-bar { display: flex; align-items: center; gap: 8px; background: var(--surface2); border: 1px solid var(--border); padding: 5px 14px; border-radius: 20px; }
    .sub-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .sub-dot.green { background: var(--green); box-shadow: 0 0 5px var(--green); }
    .sub-dot.yellow { background: var(--yellow); box-shadow: 0 0 5px var(--yellow); }
    .sub-dot.red { background: var(--red); box-shadow: 0 0 5px var(--red); }
    .sub-dot.grey { background: var(--text-muted); }
    .sub-label { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
    .sub-activate-btn { background: var(--orange); color: white; border: none; padding: 5px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .sub-activate-btn:hover { background: var(--orange-light); }
    .sub-activate-btn:disabled { background: var(--surface2); color: var(--text-muted); cursor: not-allowed; border: 1px solid var(--border); }

    /* ── LAYOUT ── */
    .main {
      display: grid;
      grid-template-columns: 1fr 420px;
      gap: 0;
      flex: 1;
      height: calc(100vh - 64px);
    }

    /* ── FILE BROWSER ── */
    .file-browser {
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .panel-header {
      padding: 20px 24px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .panel-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }

    .panel-meta {
      font-size: 12px;
      color: var(--text-muted);
    }

    .refresh-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .refresh-btn:hover {
      border-color: var(--orange);
      color: var(--orange);
    }

    .file-list {
      overflow-y: auto;
      flex: 1;
      padding: 12px;
    }

    .file-list::-webkit-scrollbar { width: 6px; }
    .file-list::-webkit-scrollbar-track { background: transparent; }
    .file-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    .file-item {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 16px;
      border-radius: 10px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s;
      margin-bottom: 6px;
      background: var(--surface);
    }

    .file-item:hover {
      border-color: var(--border);
      background: var(--surface2);
    }

    .file-item.selected {
      border-color: var(--orange);
      background: #1f1500;
    }

    .file-icon {
      width: 40px;
      height: 40px;
      background: #1a0f00;
      border: 1px solid #3a2000;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      flex-shrink: 0;
    }

    .file-item.selected .file-icon {
      background: #2a1800;
      border-color: var(--orange);
    }

    .file-info { flex: 1; min-width: 0; }

    .file-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 3px;
    }

    .file-meta {
      font-size: 12px;
      color: var(--text-muted);
    }

    .file-select-indicator {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 2px solid var(--border);
      flex-shrink: 0;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .file-item.selected .file-select-indicator {
      background: var(--orange);
      border-color: var(--orange);
    }

    .file-item.selected .file-select-indicator::after {
      content: '✓';
      font-size: 11px;
      color: white;
      font-weight: 700;
    }

    /* Loading / empty states */
    .state-msg {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 60px 24px;
      color: var(--text-muted);
      text-align: center;
    }

    .state-msg .icon { font-size: 40px; }
    .state-msg .title { font-size: 15px; font-weight: 500; color: var(--text); }
    .state-msg .desc { font-size: 13px; line-height: 1.5; }

    /* ── RIGHT PANEL ── */
    .right-panel {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── SELECTED FILE INFO ── */
    .selected-info {
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      min-height: 140px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .no-selection {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 20px;
      color: var(--text-muted);
      text-align: center;
    }

    .no-selection .icon { font-size: 32px; }
    .no-selection .title { font-size: 14px; font-weight: 500; color: var(--text-muted); }
    .no-selection .desc { font-size: 12px; }

    .selected-file-name {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 6px;
      word-break: break-all;
    }

    .selected-file-details {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }

    /* ── TEST RUN BUTTON ── */
    .test-run-btn {
      width: 100%;
      padding: 14px;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      letter-spacing: 0.01em;
    }

    .test-run-btn:disabled {
      background: var(--surface2);
      color: var(--text-muted);
      cursor: not-allowed;
      border: 1px solid var(--border);
    }

    .test-run-btn.ready {
      background: var(--orange);
      color: white;
      box-shadow: 0 0 20px #d9770044;
    }

    .test-run-btn.ready:hover {
      background: var(--orange-light);
      box-shadow: 0 0 30px #d9770066;
      transform: translateY(-1px);
    }

    .test-run-btn.running {
      background: var(--surface2);
      color: var(--text-muted);
      cursor: not-allowed;
      border: 1px solid var(--border);
    }

    /* ── PROGRESS PANEL ── */
    .progress-panel {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px;
    }

    .progress-panel::-webkit-scrollbar { width: 6px; }
    .progress-panel::-webkit-scrollbar-track { background: transparent; }
    .progress-panel::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    .progress-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 16px;
    }

    .progress-idle {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 40px 0;
      color: var(--text-muted);
      text-align: center;
    }

    .progress-idle .icon { font-size: 36px; }
    .progress-idle .desc { font-size: 13px; line-height: 1.5; }

    .step-list { display: flex; flex-direction: column; gap: 8px; }

    .step {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      transition: all 0.3s;
    }

    .step.running {
      border-color: var(--orange);
      background: #1f1500;
    }

    .step.done {
      border-color: #22c55e33;
      background: #0f1f0f;
    }

    .step.error {
      border-color: #ef444433;
      background: #1f0f0f;
    }

    .step-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .step.pending .step-icon { background: var(--surface2); color: var(--text-muted); font-size: 11px; }
    .step.running .step-icon { background: var(--orange); color: white; }
    .step.done .step-icon { background: var(--green); color: white; }
    .step.error .step-icon { background: var(--red); color: white; }

    .step-content { flex: 1; min-width: 0; }

    .step-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
      margin-bottom: 2px;
    }

    .step-msg {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .step.running .step-msg { color: var(--orange); }
    .step.done .step-msg { color: #4ade80; }
    .step.error .step-msg { color: var(--red); }

    /* ── RESULTS CARD ── */
    .results-card {
      margin-top: 16px;
      background: #0f1f0f;
      border: 1px solid #22c55e44;
      border-radius: 10px;
      padding: 16px;
    }

    .results-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--green);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .result-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 12px;
    }

    .result-label {
      color: var(--text-muted);
      min-width: 90px;
      flex-shrink: 0;
    }

    .result-value {
      color: var(--text);
      word-break: break-all;
    }

    .result-link {
      color: var(--orange);
      text-decoration: none;
    }

    .result-link:hover { text-decoration: underline; }

    .files-list {
      margin-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .file-pill {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: 'Courier New', monospace;
    }

    /* ── SPINNER ── */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .pulsing { animation: pulse 1.5s ease-in-out infinite; }

    /* ── PATH BAR ── */
    .path-bar {
      padding: 10px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .path-bar span { color: var(--orange); }
  </style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-icon">📄</div>
    <div>
      <div class="logo-text">Grove PDF Router</div>
      <div class="logo-sub">Test Dashboard</div>
    </div>
  </div>
  <div class="header-right">
    <div class="sub-bar" id="sub-bar">
      <div class="sub-dot grey" id="sub-dot"></div>
      <span class="sub-label" id="sub-label">Checking webhook...</span>
    </div>
    <button class="sub-activate-btn" id="sub-activate-btn" style="display:none" onclick="activateSubscription()">Activate Webhook</button>
    <div class="header-badge">● Live System</div>
  </div>
</header>

<div class="main">

  <!-- ── LEFT: FILE BROWSER ── -->
  <div class="file-browser">
    <div class="panel-header">
      <div>
        <div class="panel-title">OneDrive Scans Folder</div>
        <div class="panel-meta" id="file-count">Loading files...</div>
      </div>
      <button class="refresh-btn" onclick="loadFiles()">
        <span id="refresh-icon">↻</span> Refresh
      </button>
    </div>

    <div class="path-bar">
      📁 Grove Group Scotland &rsaquo; Grove Bedding &rsaquo; <span>Scans</span>
    </div>

    <div class="file-list" id="file-list">
      <div class="state-msg">
        <div class="icon pulsing">📂</div>
        <div class="title">Loading files...</div>
        <div class="desc">Connecting to OneDrive</div>
      </div>
    </div>
  </div>

  <!-- ── RIGHT: CONTROL + PROGRESS ── -->
  <div class="right-panel">

    <!-- Selected file + test button -->
    <div class="selected-info">
      <div id="no-selection" class="no-selection">
        <div class="icon">☝️</div>
        <div class="title">No file selected</div>
        <div class="desc">Click a file on the left to select it</div>
      </div>

      <div id="selection-detail" style="display:none;">
        <div class="selected-file-name" id="selected-name"></div>
        <div class="selected-file-details" id="selected-meta"></div>
        <button
          class="test-run-btn ready"
          id="test-run-btn"
          onclick="startTestRun()">
          ▶ Run Test
        </button>
      </div>
    </div>

    <!-- Progress log -->
    <div class="progress-panel">
      <div class="progress-title">Progress Log</div>

      <div id="progress-idle" class="progress-idle">
        <div class="icon">🧪</div>
        <div class="desc">Select a file and click<br><strong style="color:var(--text)">Run Test</strong> to begin</div>
      </div>

      <div id="step-list" class="step-list" style="display:none;"></div>
      <div id="results-card" style="display:none;"></div>
    </div>

  </div>
</div>

<script>
  // ── STATE ──
  let selectedFile = null;
  let isRunning = false;

  const STEPS = [
    { id: 1, label: 'Initialise record' },
    { id: 2, label: 'Download from OneDrive' },
    { id: 3, label: 'Split PDF pages' },
    { id: 4, label: 'Dispatch to Make.com' },
    { id: 5, label: 'AI extraction & callbacks' },
    { id: 6, label: 'File to OneDrive & Google Drive' },
  ];

  // ── LOAD FILES ──
  async function loadFiles() {
    const list = document.getElementById('file-list');
    const countEl = document.getElementById('file-count');
    const icon = document.getElementById('refresh-icon');

    icon.classList.add('pulsing');
    list.innerHTML = \`<div class="state-msg">
      <div class="icon pulsing">📂</div>
      <div class="title">Loading files...</div>
      <div class="desc">Connecting to OneDrive</div>
    </div>\`;

    try {
      const res = await fetch('/api/scan-files');
      if (res.status === 401) {
        list.innerHTML = \`<div class="state-msg"><div class="icon">🔒</div><div class="title">Unauthorised</div></div>\`;
        return;
      }
      const data = await res.json();

      if (!data.success || data.files.length === 0) {
        countEl.textContent = 'No PDF files found';
        list.innerHTML = \`<div class="state-msg">
          <div class="icon">📭</div>
          <div class="title">No PDFs found</div>
          <div class="desc">Upload a PDF to the Scans folder in OneDrive, then refresh.</div>
        </div>\`;
        return;
      }

      countEl.textContent = \`\${data.files.length} PDF file\${data.files.length === 1 ? '' : 's'}\`;
      list.innerHTML = data.files.map(file => \`
        <div class="file-item" id="file-\${file.id}" onclick="selectFile(\${JSON.stringify(file).replace(/"/g, '&quot;')})">
          <div class="file-icon">📄</div>
          <div class="file-info">
            <div class="file-name">\${escHtml(file.name)}</div>
            <div class="file-meta">\${file.sizeFormatted} &middot; \${formatDate(file.createdAt)}</div>
          </div>
          <div class="file-select-indicator"></div>
        </div>
      \`).join('');

    } catch (err) {
      countEl.textContent = 'Error loading files';
      list.innerHTML = \`<div class="state-msg">
        <div class="icon">⚠️</div>
        <div class="title">Failed to load</div>
        <div class="desc">\${escHtml(err.message)}</div>
      </div>\`;
    } finally {
      icon.classList.remove('pulsing');
    }
  }

  // ── SELECT FILE ──
  function selectFile(file) {
    if (isRunning) return;

    // Deselect previous
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));

    // Select new
    const el = document.getElementById('file-' + file.id);
    if (el) el.classList.add('selected');

    selectedFile = file;

    // Update right panel
    document.getElementById('no-selection').style.display = 'none';
    document.getElementById('selection-detail').style.display = 'block';
    document.getElementById('selected-name').textContent = file.name;
    document.getElementById('selected-meta').textContent =
      file.sizeFormatted + ' · Uploaded ' + formatDate(file.createdAt);

    const btn = document.getElementById('test-run-btn');
    btn.className = 'test-run-btn ready';
    btn.disabled = false;
    btn.innerHTML = '▶ Run Test';

    // Reset progress
    resetProgress();
  }

  // ── RESET PROGRESS ──
  function resetProgress() {
    document.getElementById('progress-idle').style.display = 'flex';
    document.getElementById('step-list').style.display = 'none';
    document.getElementById('step-list').innerHTML = '';
    document.getElementById('results-card').style.display = 'none';
    document.getElementById('results-card').innerHTML = '';
  }

  // ── START TEST RUN ──
  async function startTestRun() {
    if (!selectedFile || isRunning) return;

    isRunning = true;

    const btn = document.getElementById('test-run-btn');
    btn.className = 'test-run-btn running';
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Running...';

    // Show step list
    document.getElementById('progress-idle').style.display = 'none';
    document.getElementById('results-card').style.display = 'none';
    const stepList = document.getElementById('step-list');
    stepList.style.display = 'flex';
    stepList.innerHTML = STEPS.map(s => renderStep(s.id, s.label, '', 'pending')).join('');

    try {
      const response = await fetch('/api/test-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: selectedFile.id, fileName: selectedFile.name }),
      });

      if (response.status === 401) {
        finishWithError('unknown', 'Session expired — please refresh the page');
        return;
      }

      // Stream SSE events
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\\n');
        buffer = lines.pop();

        let currentEvent = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              handleEvent(currentEvent, data);
            } catch (e) {}
          }
        }
      }

    } catch (err) {
      finishWithError('unknown', err.message);
    }
  }

  // ── HANDLE SSE EVENTS ──
  function handleEvent(event, data) {
    if (event === 'progress') {
      updateStep(data.step, data.message, data.status);
    } else if (event === 'complete') {
      updateStep(6, 'Filed to OneDrive & Google Drive ✓', 'done');
      showResults(data);
      finishRun();
    } else if (event === 'error') {
      finishWithError(data.step, data.message);
    }
  }

  // ── UPDATE A STEP ──
  function updateStep(stepNum, message, status) {
    const stepList = document.getElementById('step-list');
    const step = STEPS.find(s => s.id === stepNum);
    if (!step) return;

    // Mark all previous steps as done if they're still pending
    STEPS.forEach(s => {
      if (s.id < stepNum) {
        const el = document.getElementById('step-el-' + s.id);
        if (el && el.dataset.status === 'pending') {
          el.outerHTML = renderStep(s.id, s.label, '', 'done');
        }
      }
    });

    const existing = document.getElementById('step-el-' + stepNum);
    const html = renderStep(stepNum, step.label, message, status);
    if (existing) {
      existing.outerHTML = html;
    } else {
      stepList.innerHTML = STEPS.map(s => {
        const el = document.getElementById('step-el-' + s.id);
        if (s.id === stepNum) return renderStep(s.id, s.label, message, status);
        return el ? el.outerHTML : renderStep(s.id, s.label, '', 'pending');
      }).join('');
    }
  }

  function renderStep(id, label, message, status) {
    const icons = { pending: id, running: '●', done: '✓', error: '✕' };
    const icon = icons[status] || id;
    return \`<div class="step \${status}" id="step-el-\${id}" data-status="\${status}">
      <div class="step-icon">\${status === 'running' ? '<div class="spinner" style="border-color:rgba(255,255,255,0.3);border-top-color:white;width:12px;height:12px;border-width:2px;"></div>' : icon}</div>
      <div class="step-content">
        <div class="step-label">\${escHtml(label)}</div>
        \${message ? \`<div class="step-msg">\${escHtml(message)}</div>\` : ''}
      </div>
    </div>\`;
  }

  // ── SHOW RESULTS ──
  function showResults(data) {
    const card = document.getElementById('results-card');
    card.style.display = 'block';

    const filesList = (data.renamedFiles || []).map(f =>
      \`<div class="file-pill">\${escHtml(f)}</div>\`
    ).join('');

    card.innerHTML = \`
      <div class="results-card">
        <div class="results-title">✅ Test Run Complete</div>
        <div class="result-row">
          <div class="result-label">Supplier</div>
          <div class="result-value">\${escHtml(data.supplier || '—')}</div>
        </div>
        <div class="result-row">
          <div class="result-label">Customer</div>
          <div class="result-value">\${escHtml(data.customerName || '—')}</div>
        </div>
        <div class="result-row">
          <div class="result-label">Reference</div>
          <div class="result-value">\${escHtml(data.ref || '—')}</div>
        </div>
        <div class="result-row">
          <div class="result-label">Pages</div>
          <div class="result-value">\${data.totalPages || '—'}</div>
        </div>
        \${data.googleDriveFolderUrl ? \`
        <div class="result-row">
          <div class="result-label">Google Drive</div>
          <div class="result-value"><a class="result-link" href="\${data.googleDriveFolderUrl}" target="_blank">Open folder ↗</a></div>
        </div>\` : ''}
        \${data.oneDriveProcessedFolderUrl ? \`
        <div class="result-row">
          <div class="result-label">OneDrive</div>
          <div class="result-value"><a class="result-link" href="\${data.oneDriveProcessedFolderUrl}" target="_blank">Open folder ↗</a></div>
        </div>\` : ''}
        \${filesList ? \`
        <div class="result-row" style="flex-direction:column;gap:6px;">
          <div class="result-label">Output files</div>
          <div class="files-list">\${filesList}</div>
        </div>\` : ''}
      </div>
    \`;
  }

  // ── FINISH STATES ──
  function finishRun() {
    isRunning = false;
    const btn = document.getElementById('test-run-btn');
    btn.className = 'test-run-btn ready';
    btn.disabled = false;
    btn.innerHTML = '↺ Run Again';
  }

  function finishWithError(step, message) {
    isRunning = false;
    if (step !== 'unknown') updateStep(step, message, 'error');

    const card = document.getElementById('results-card');
    card.style.display = 'block';
    card.innerHTML = \`
      <div class="results-card" style="background:#1f0f0f;border-color:#ef444433;">
        <div class="results-title" style="color:var(--red)">❌ Test Run Failed</div>
        <div class="result-row">
          <div class="result-label">Error</div>
          <div class="result-value" style="color:var(--red)">\${escHtml(message)}</div>
        </div>
      </div>
    \`;

    const btn = document.getElementById('test-run-btn');
    btn.className = 'test-run-btn ready';
    btn.disabled = false;
    btn.innerHTML = '↺ Try Again';
  }

  // ── UTILS ──
  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // ── SUBSCRIPTION STATUS ──
  async function loadSubscriptionStatus() {
    try {
      const res = await fetch('/api/subscribe?action=status');
      if (!res.ok) return;
      const data = await res.json();
      const dot = document.getElementById('sub-dot');
      const label = document.getElementById('sub-label');
      const btn = document.getElementById('sub-activate-btn');
      dot.className = 'sub-dot ' + (data.colour || 'grey');
      label.textContent = data.message || 'Unknown';
      if (data.status === 'none' || data.status === 'expired') {
        btn.style.display = 'inline-block';
      } else {
        btn.style.display = 'none';
      }
    } catch(e) {
      document.getElementById('sub-label').textContent = 'Webhook status unavailable';
    }
  }

  async function activateSubscription() {
    const btn = document.getElementById('sub-activate-btn');
    const label = document.getElementById('sub-label');
    btn.disabled = true;
    btn.textContent = 'Activating...';
    label.textContent = 'Creating webhook subscription...';
    try {
      const res = await fetch('/api/subscribe?action=create');
      const data = await res.json();
      if (data.success) {
        label.textContent = 'Activated! ' + (data.message || '');
        btn.style.display = 'none';
        document.getElementById('sub-dot').className = 'sub-dot green';
      } else {
        label.textContent = 'Activation failed: ' + (data.error || 'Unknown error');
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    } catch(e) {
      label.textContent = 'Activation failed: ' + e.message;
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }

  // ── INIT ──
  loadFiles();
  loadSubscriptionStatus();
</script>

</body>
</html>`;
}
