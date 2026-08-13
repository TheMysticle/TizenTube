"use strict";

// TizenTube Standalone service

const express = require('express');
const app = express();
const PORT = 8099;
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const URL = require('url');
const crypto = require('crypto');
const injector = require('./injector.js');

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

app.get('/tizentube/getState', (req, res) => {
    injector.canConnectToDaemon().then(r => {
        res.json(r);
    });
});

app.get('/tizentube/debugger', (req, res) => {
    const args = req.originalUrl.split('?')[1] || '';
    const interval = setInterval(() => {
        tizen.application.getAppsContext((appsContext) => {
            const packageId = tizen.application.getAppInfo().packageId;
            const app = appsContext.find(app => app.appId === `${packageId}.TizenTubeStandalone`);
            if (!app) {
                injector.startDebugger(args);
                clearInterval(interval)
            }
        });
    }, 50);
});
const storageFile = require('path').join(__dirname, 'storage.json');
app.get('/tizentube/storage', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (require('fs').existsSync(storageFile)) {
        res.json(JSON.parse(require('fs').readFileSync(storageFile, 'utf8')));
    } else {
        res.json({ localStorage: {}, cookies: "" });
    }
});
app.post('/tizentube/storage', express.json({limit: '10mb'}), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    require('fs').writeFileSync(storageFile, JSON.stringify(req.body));
    res.send('OK');
});

// ── Debug Server ────────────────────────────────────────────────────────────────

const DEBUG_PORT = 8098;
const MAX_LOG_ENTRIES = 500;
const debugLogs = [];
let debugServerRunning = false;
let debugHttpServer = null;
const debugWsClients = new Set();

function getDebugEnabled() {
    try {
        if (require('fs').existsSync(storageFile)) {
            const data = JSON.parse(require('fs').readFileSync(storageFile, 'utf8'));
            if (data && data.localStorage) {
                const config = data.localStorage['ytaf-configuration'];
                if (config) {
                    const parsed = JSON.parse(config);
                    return !!parsed.enableDebugServer;
                }
            }
        }
    } catch (e) {}
    return false;
}

function addLogEntry(entry) {
    const logEntry = {
        timestamp: Date.now(),
        level: entry.level || 'log',
        message: entry.message || '',
        source: entry.source || 'client'
    };
    debugLogs.push(logEntry);
    if (debugLogs.length > MAX_LOG_ENTRIES) {
        debugLogs.shift();
    }
    // Broadcast to WebSocket clients
    const msg = JSON.stringify({ type: 'log', data: logEntry });
    for (const client of debugWsClients) {
        try { client.send(msg); } catch (e) { debugWsClients.delete(client); }
    }
}

// Minimal WebSocket frame helpers (no external dependency)
function wsEncodeFrame(data) {
    const payload = Buffer.from(data, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(len, 6);
    }
    return Buffer.concat([header, payload]);
}

function wsDecodeFrame(buf) {
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    const masked = !!(buf[1] & 0x80);
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;
    if (payloadLen === 126) {
        if (buf.length < 4) return null;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
    } else if (payloadLen === 127) {
        if (buf.length < 10) return null;
        payloadLen = buf.readUInt32BE(6);
        offset = 10;
    }
    let maskKey;
    if (masked) {
        if (buf.length < offset + 4) return null;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
    }
    if (buf.length < offset + payloadLen) return null;
    let payload = buf.slice(offset, offset + payloadLen);
    if (masked) {
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i % 4];
        }
    }
    return { opcode, payload, totalLength: offset + payloadLen };
}

function createWsClient(socket) {
    const client = {
        socket,
        send(data) {
            if (socket.writable) {
                socket.write(wsEncodeFrame(data));
            }
        },
        close() {
            try {
                // Send close frame
                const closeFrame = Buffer.alloc(2);
                closeFrame[0] = 0x88;
                closeFrame[1] = 0x00;
                socket.write(closeFrame);
                socket.end();
            } catch (e) {}
        }
    };
    socket.on('data', (buf) => {
        const frame = wsDecodeFrame(buf);
        if (!frame) return;
        if (frame.opcode === 0x08) { // close
            debugWsClients.delete(client);
            try { socket.end(); } catch (e) {}
        } else if (frame.opcode === 0x09) { // ping
            const pong = Buffer.alloc(2);
            pong[0] = 0x8A;
            pong[1] = 0x00;
            try { socket.write(pong); } catch (e) {}
        }
    });
    socket.on('close', () => debugWsClients.delete(client));
    socket.on('error', () => debugWsClients.delete(client));
    return client;
}

function getDebugDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TizenTube Debug Console</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;500;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg-primary: #0a0a0f;
    --bg-secondary: #12121a;
    --bg-tertiary: #1a1a26;
    --bg-hover: #22222e;
    --border: #2a2a3a;
    --text-primary: #e4e4ef;
    --text-secondary: #8888a0;
    --accent: #6c5ce7;
    --accent-glow: rgba(108, 92, 231, 0.3);
    --log: #b4b4cc;
    --info: #74b9ff;
    --warn: #ffc048;
    --error: #ff6b6b;
    --debug: #a29bfe;
    --success: #55efc4;
  }
  body {
    font-family: 'Inter', system-ui, sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo-icon {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, var(--accent), #a29bfe);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
    color: white;
    box-shadow: 0 2px 12px var(--accent-glow);
  }
  .logo h1 {
    font-size: 18px;
    font-weight: 700;
    background: linear-gradient(135deg, #e4e4ef, #a29bfe);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .status-bar {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .status-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--error);
    transition: background 0.3s;
  }
  .status-dot.connected {
    background: var(--success);
    box-shadow: 0 0 8px rgba(85, 239, 196, 0.5);
  }
  .toolbar {
    display: flex;
    align-items: center;
    padding: 8px 24px;
    gap: 8px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .filter-btn {
    padding: 5px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .filter-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .filter-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
    box-shadow: 0 2px 8px var(--accent-glow);
  }
  .filter-btn.active:hover { background: #7c6ef0; }
  .spacer { flex: 1; }
  .action-btn {
    padding: 5px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  .action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .action-btn.danger:hover { background: rgba(255, 107, 107, 0.15); color: var(--error); border-color: var(--error); }
  .log-count {
    font-size: 12px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  #log-container {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    scroll-behavior: smooth;
  }
  #log-container::-webkit-scrollbar { width: 6px; }
  #log-container::-webkit-scrollbar-track { background: transparent; }
  #log-container::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  #log-container::-webkit-scrollbar-thumb:hover { background: #3a3a4a; }
  .log-entry {
    display: flex;
    align-items: flex-start;
    padding: 4px 24px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12.5px;
    line-height: 1.6;
    border-bottom: 1px solid rgba(42, 42, 58, 0.4);
    transition: background 0.15s;
    animation: fadeIn 0.2s ease;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .log-entry:hover { background: var(--bg-hover); }
  .log-time {
    color: var(--text-secondary);
    margin-right: 16px;
    flex-shrink: 0;
    font-size: 11px;
    padding-top: 2px;
    user-select: none;
  }
  .log-level {
    width: 52px;
    flex-shrink: 0;
    font-weight: 600;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
    padding-top: 3px;
    margin-right: 12px;
  }
  .log-msg {
    flex: 1;
    word-break: break-all;
    white-space: pre-wrap;
  }
  .log-source {
    color: var(--text-secondary);
    font-size: 10px;
    margin-left: 12px;
    flex-shrink: 0;
    padding-top: 3px;
    opacity: 0.6;
  }
  .level-log .log-level { color: var(--log); }
  .level-log .log-msg { color: var(--log); }
  .level-info .log-level { color: var(--info); }
  .level-info .log-msg { color: var(--info); }
  .level-warn .log-level { color: var(--warn); }
  .level-warn .log-msg { color: var(--warn); }
  .level-warn { background: rgba(255, 192, 72, 0.04); }
  .level-error .log-level { color: var(--error); }
  .level-error .log-msg { color: var(--error); }
  .level-error { background: rgba(255, 107, 107, 0.06); }
  .level-debug .log-level { color: var(--debug); }
  .level-debug .log-msg { color: var(--debug); }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    gap: 12px;
  }
  .empty-state-icon { font-size: 48px; opacity: 0.3; }
  .empty-state-text { font-size: 14px; }
  .search-input {
    padding: 5px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    font-family: 'Inter', sans-serif;
    outline: none;
    width: 220px;
    transition: border-color 0.2s;
  }
  .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
  .search-input::placeholder { color: var(--text-secondary); }
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">TT</div>
    <h1>TizenTube Debug Console</h1>
  </div>
  <div class="status-bar">
    <div class="status-indicator">
      <div class="status-dot" id="status-dot"></div>
      <span id="status-text">Disconnected</span>
    </div>
  </div>
</header>
<div class="toolbar">
  <button class="filter-btn active" data-level="all">All</button>
  <button class="filter-btn" data-level="log">Log</button>
  <button class="filter-btn" data-level="info">Info</button>
  <button class="filter-btn" data-level="warn">Warn</button>
  <button class="filter-btn" data-level="error">Error</button>
  <div class="spacer"></div>
  <input type="text" class="search-input" id="search-input" placeholder="Filter logs...">
  <span class="log-count" id="log-count">0 entries</span>
  <button class="action-btn" id="btn-scroll">\u2193 Scroll to bottom</button>
  <button class="action-btn danger" id="btn-clear">Clear</button>
</div>
<div id="log-container">
  <div class="empty-state" id="empty-state">
    <div class="empty-state-icon">\u{1F50D}</div>
    <div class="empty-state-text">Waiting for logs...</div>
  </div>
</div>
<script>
(function() {
  const container = document.getElementById('log-container');
  const emptyState = document.getElementById('empty-state');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const logCount = document.getElementById('log-count');
  const searchInput = document.getElementById('search-input');
  let activeFilter = 'all';
  let searchTerm = '';
  let autoScroll = true;
  let entries = [];

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function escapeHTML(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function shouldShow(entry) {
    if (activeFilter !== 'all' && entry.level !== activeFilter) return false;
    if (searchTerm && entry.message.toLowerCase().indexOf(searchTerm) === -1) return false;
    return true;
  }

  function createLogElement(entry) {
    const div = document.createElement('div');
    div.className = 'log-entry level-' + entry.level;
    div.dataset.level = entry.level;
    div.innerHTML =
      '<span class="log-time">' + formatTime(entry.timestamp) + '</span>' +
      '<span class="log-level">' + entry.level + '</span>' +
      '<span class="log-msg">' + escapeHTML(entry.message) + '</span>' +
      '<span class="log-source">' + escapeHTML(entry.source) + '</span>';
    if (!shouldShow(entry)) div.style.display = 'none';
    return div;
  }

  function addLog(entry) {
    if (emptyState.parentNode) emptyState.remove();
    entries.push(entry);
    const el = createLogElement(entry);
    container.appendChild(el);
    logCount.textContent = entries.length + ' entries';
    if (autoScroll) container.scrollTop = container.scrollHeight;
  }

  function refilter() {
    const children = container.querySelectorAll('.log-entry');
    let idx = 0;
    children.forEach(function(el) {
      const entry = entries[idx++];
      if (!entry) return;
      el.style.display = shouldShow(entry) ? '' : 'none';
    });
  }

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeFilter = btn.dataset.level;
      refilter();
    });
  });

  // Search
  searchInput.addEventListener('input', function() {
    searchTerm = searchInput.value.toLowerCase();
    refilter();
  });

  // Scroll tracking
  container.addEventListener('scroll', function() {
    autoScroll = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
  });
  document.getElementById('btn-scroll').addEventListener('click', function() {
    container.scrollTop = container.scrollHeight;
    autoScroll = true;
  });

  // Clear
  document.getElementById('btn-clear').addEventListener('click', function() {
    entries = [];
    container.innerHTML = '';
    logCount.textContent = '0 entries';
    fetch('/clear', { method: 'POST' });
  });

  // WebSocket
  let ws;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = function() {
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
    };
    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'log') addLog(msg.data);
        if (msg.type === 'history') msg.data.forEach(addLog);
      } catch (err) {}
    };
    ws.onclose = function() {
      statusDot.classList.remove('connected');
      statusText.textContent = 'Disconnected';
      setTimeout(connect, 2000);
    };
    ws.onerror = function() { ws.close(); };
  }
  connect();
})();
</script>
</body>
</html>`;
}

function startDebugServer() {
    if (debugServerRunning) return;
    debugHttpServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        if (req.method === 'POST' && req.url === '/clear') {
            debugLogs.length = 0;
            res.writeHead(200); res.end('OK'); return;
        }
        if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getDebugDashboardHTML());
            return;
        }
        res.writeHead(404); res.end('Not Found');
    });

    debugHttpServer.on('upgrade', (req, socket, head) => {
        if (req.url !== '/ws') { socket.destroy(); return; }
        const key = req.headers['sec-websocket-key'];
        if (!key) { socket.destroy(); return; }
        const acceptKey = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + acceptKey + '\r\n' +
            '\r\n'
        );
        const client = createWsClient(socket);
        debugWsClients.add(client);
        // Send history
        client.send(JSON.stringify({ type: 'history', data: debugLogs }));
    });

    debugHttpServer.listen(DEBUG_PORT, '0.0.0.0', () => {
        debugServerRunning = true;
        console.log('TizenTube Debug Server running on port ' + DEBUG_PORT);
    });
    debugHttpServer.on('error', (e) => {
        console.error('Debug Server error:', e);
    });
}

function stopDebugServer() {
    if (!debugServerRunning || !debugHttpServer) return;
    for (const client of debugWsClients) {
        try { client.close(); } catch (e) {}
    }
    debugWsClients.clear();
    debugHttpServer.close();
    debugHttpServer = null;
    debugServerRunning = false;
    console.log('TizenTube Debug Server stopped');
}

// Log ingestion endpoint (client-side console hooks send logs here)
app.post('/tizentube/debug-log', express.json({limit: '1mb'}), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (debugServerRunning && req.body) {
        const logs = Array.isArray(req.body) ? req.body : [req.body];
        logs.forEach(entry => addLogEntry(entry));
    }
    res.send('OK');
});

// Debug server status / toggle
app.get('/tizentube/debug-server/status', (req, res) => {
    res.json({ enabled: debugServerRunning, port: DEBUG_PORT });
});
app.post('/tizentube/debug-server/toggle', express.json(), (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const enable = req.body && req.body.enabled;
    if (enable && !debugServerRunning) {
        startDebugServer();
    } else if (!enable && debugServerRunning) {
        stopDebugServer();
    }
    res.json({ enabled: debugServerRunning, port: DEBUG_PORT });
});

app.get('/tizentube/localUserScript.js', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const localScriptPath = path.join(__dirname, 'userScript.js');
    if (fs.existsSync(localScriptPath)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.sendFile(localScriptPath);
    } else {
        res.status(404).send('Local userscript not found');
    }
});

app.all('*', (req, res) => {
    const isCorsBypass = req.path.indexOf('/cors-bypass/') === 0;

    let targetUrl;
    if (isCorsBypass) {
        const rawTarget = req.url.substring('/cors-bypass/'.length);
        targetUrl = rawTarget.indexOf('http') === 0 ? rawTarget : `https://${rawTarget}`;
    } else {
        targetUrl = `https://www.youtube.com${req.url}`;
    }

    const headers = {};
    for (const key in req.headers) {
        if (Object.prototype.hasOwnProperty.call(req.headers, key)) {
            if (key === 'cookie') {
                headers[key] = req.headers[key]
                    .replace(/__LocalSecure-/g, '__Secure-')
                    .replace(/__LocalHost-/g, '__Host-');
                continue;
            }
            headers[key] = req.headers[key]
        }
    }

    try {
        const parsedUrl = URL.parse(targetUrl);
        headers['host'] = parsedUrl.host;
    } catch (e) {
        headers['host'] = isCorsBypass ? 'www.youtube.com' : 'www.youtube.com';
    }

    headers['origin'] = 'https://www.youtube.com';
    if (headers['referer']) {
        headers['referer'] = 'https://www.youtube.com/tv';
    }

    headers['accept-encoding'] = 'gzip, deflate';

    const hasBody = ['POST', 'PUT', 'PATCH'].indexOf(req.method) !== -1;
    const fetchOptions = {
        method: req.method,
        headers: headers,
        body: hasBody ? req : undefined,
        redirect: 'manual'
    };

    fetch(targetUrl, fetchOptions)
        .then((response) => {
            if (req.method === 'OPTIONS') {
                res.status(200);
            } else {
                res.status(response.status);
            }

            const headerKeys = response.headers.raw();
            for (const key in headerKeys) {
                if (Object.prototype.hasOwnProperty.call(headerKeys, key)) {
                    const lowerKey = key.toLowerCase();
                    const skipHeaders = ['content-encoding', 'content-length', 'transfer-encoding', 'content-security-policy', 'alt-svc'];
                    if (isCorsBypass) skipHeaders.push('access-control-allow-origin');

                    if (skipHeaders.indexOf(lowerKey) !== -1) continue;

                    const value = response.headers.get(key);
                    if (lowerKey === 'set-cookie') {
                        const rawCookies = headerKeys[key];
                        if (Array.isArray(rawCookies)) {
                            const modifiedCookies = rawCookies.map(cookieStr => {
                                return cookieStr
                                    .replace(/^__Secure-/i, '__LocalSecure-')
                                    .replace(/^__Host-/i, '__LocalHost-')
                                    .replace(/Domain=[^;]+/i, 'Domain=localhost')
                                    .replace(/;\s*Secure/i, '')
                                    .replace(/;\s*SameSite=None/i, '')
                                    .replace(/;\s*HttpOnly/gi, '')
                                    .replace(/;\s*;/g, ';')
                                    .replace(/;\s*$/, '');
                            });
                            res.setHeader('Set-Cookie', modifiedCookies);
                            continue;
                        }
                    }
                    if (lowerKey === 'location') {
                        let redirectUrl = value;
                        if (redirectUrl.startsWith('//')) {
                            redirectUrl = 'https:' + redirectUrl;
                        }
                        
                        if (redirectUrl.startsWith('/')) {
                            redirectUrl = `http://localhost:${PORT}${redirectUrl}`;
                        } else {
                            try {
                                const parsedLoc = URL.parse(redirectUrl);
                                if (parsedLoc && parsedLoc.hostname) {
                                    const hn = parsedLoc.hostname;
                                    if (hn === 'youtube.com' || hn === 'www.youtube.com' || hn === 'm.youtube.com') {
                                        redirectUrl = `http://localhost:${PORT}${parsedLoc.path || ''}${parsedLoc.hash || ''}`;
                                    } else if (hn.endsWith('googlevideo.com') || hn.endsWith('youtube.com')
                                        || hn.endsWith('gstatic.com') || hn.endsWith('.google.com')
                                        || hn.endsWith('.googleapis.com') || hn.endsWith('googleusercontent.com')
                                        || hn.endsWith('.ggpht.com')) {
                                        redirectUrl = `http://localhost:${PORT}/cors-bypass/${redirectUrl}`;
                                    }
                                }
                            } catch (e) {}
                        }
                        res.setHeader(key, redirectUrl);
                        continue;
                    }

                    res.setHeader(key, value);
                }
            }

            res.setHeader('Access-Control-Allow-Origin', '*');

            const contentType = response.headers.get('content-type') || '';

            if (contentType.indexOf('text/html') !== -1 ||
                contentType.indexOf('application/json') !== -1 ||
                contentType.indexOf('javascript') !== -1 ||
                contentType.indexOf('text/css') !== -1) {

                return response.text().then((text) => {
                    if (req.url.indexOf('/tv') === 0 && req.url.indexOf('/tv_config') === -1) {
                        // Insert the userscript for TizenTube
                        let scriptUrl = `https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?ver=${Date.now()}`;
                        if (require('fs').existsSync(require('path').join(__dirname, 'userScript.js'))) {
                            scriptUrl = `http://localhost:${PORT}/tizentube/localUserScript.js?ver=${Date.now()}`;
                        }
                        text += `<script src="${scriptUrl}"></script>`;
                    }

                    const proxyPrefix = `http://localhost:${PORT}/cors-bypass/`;

                    // Rewrite rules for replacing URLs so CORS and presumably YT is happy.
                    text = text.replace(/https:\/\/([a-zA-Z0-9-.]+)\.googlevideo\.com/g, `${proxyPrefix}https://$1.googlevideo.com`);
                    text = text.replace(/https:\\\/\\\/([a-zA-Z0-9-.]+)\.googlevideo\.com/g, `http:\\\/\\\/localhost:${PORT}\\\/cors-bypass\\\/https:\\\/\\\/$1.googlevideo.com`);
                    text = text.replace(/"\/\/([a-zA-Z0-9-.]+)\.googlevideo\.com/g, `"${proxyPrefix}https://$1.googlevideo.com`);

                    text = text.replace(/https:\/\/www\.gstatic\.com/g, `${proxyPrefix}https://www.gstatic.com`);
                    text = text.replace(/http:\/\/www\.gstatic\.com/g, `${proxyPrefix}https://www.gstatic.com`);
                    text = text.replace(/"\/\/www\.gstatic\.com/g, `"${proxyPrefix}https://www.gstatic.com`);
                    text = text.replace(/\(\/\/www\.gstatic\.com/g, `(${proxyPrefix}https://www.gstatic.com`);

                    text = text.replace(/https:\/\/yt3\.ggpht\.com/g, `${proxyPrefix}https://yt3.ggpht.com`);

                    text = text.replace(/https:\/\/clients1\.google\.com/g, `${proxyPrefix}https://clients1.google.com`);
                    text = text.replace(/http:\/\/clients1\.google\.com/g, `${proxyPrefix}https://clients1.google.com`);
                    text = text.replace(/"\/\/clients1\.google\.com/g, `"${proxyPrefix}https://clients1.google.com`);

                    text = text.replace('Set(["www.youtube.com","accounts.google.com"]);', 'Set(["www.youtube.com", "accounts.google.com", "localhost"]);');
                    text = text.replace(/:document\.location\.toString\(\)/g, ':document.location.toString().replace("http://localhost:8099", "https://www.youtube.com")');
                    text = text.replace(/euri:[^,]+,/g, 'euri:document.location.toString().replace("http://localhost:8099", "https://www.youtube.com"),')
                    text = text.replace(/https:\/\/s\.youtube\.com/g, `${proxyPrefix}https://s.youtube.com`);
                    text = text.replace(/redirector.googlevideo.com/g, `${proxyPrefix}https://redirector.googlevideo.com`);
                    text = text.replace(/this.scheme="https"/, 'this.scheme="http"');
                    text = text.replace(/https\:\/\/jnn-pa.googleapis.com/g, `${proxyPrefix}https://jnn-pa.googleapis.com`);
                    text = text.replace(/https:\/\/yt3\.googleusercontent\.com/g, `${proxyPrefix}https://yt3.googleusercontent.com`);
                    text = text.replace(/"\/\/yt3\.googleusercontent\.com/g, `"${proxyPrefix}https://yt3.googleusercontent.com`);

                    // In order to fix history not working
                    text = text.replace(/=window\.location\.href;/, '=window.location.href.replace("http://localhost:8099", "https://www.youtube.com");')
                    text = text.replace(/=document\.location\.href/, '=document.location.href.replace("http://localhost:8099", "https://www.youtube.com")')

                    res.send(text);
                });
            } else {
                if (response.body) {
                    response.body.pipe(res);
                } else {
                    res.end();
                }
            }
        })
        .catch((error) => {
            console.error(`Proxy Error for [${targetUrl}]: ${error}`);
            console.error(error.stack)
            if (!res.headersSent) {
                res.status(500).send('Proxy Connection Broken');
            }
        });
});

app.listen(PORT, "127.0.0.1");

// Start the DIAL server
global.isTizenTube = true;
require('../../dist/service.js');

// Auto-start debug server if previously enabled
startDebugServer();
console.log('--- TIZENTUBE FS DEBUG ---');
console.log('__dirname:', __dirname);
console.log('cwd:', process.cwd());
console.log('env HOME:', process.env.HOME);
try {
    const fs = require('fs');
    console.log('storage.json exists:', fs.existsSync(require('path').join(__dirname, 'storage.json')));
    console.log('userScript.js exists:', fs.existsSync(require('path').join(__dirname, 'userScript.js')));
} catch (e) {}