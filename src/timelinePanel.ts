import * as vscode from 'vscode';
import {
  ExecutionTrace,
  PlaybackStatus,
  SpeedOption,
  StartMode,
  SPEED_OPTIONS,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from './types';
import { ReplayController } from './replayController';
import { EventStore } from './eventStore';

/**
 * Manages the Timeline side-panel WebView.
 *
 * The panel is registered as a WebviewViewProvider under the view ID
 * `codeRecorder.timeline` (declared in package.json → contributes.views).
 *
 * Communication pattern:
 *   - Extension → WebView: post ExtensionToWebviewMessage objects
 *   - WebView → Extension: receive WebviewToExtensionMessage objects
 */
export class TimelinePanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private _view: vscode.WebviewView | null = null;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: EventStore,
    private readonly _replay: ReplayController,
  ) {
    this._disposables.push(
      _replay.onStatusChanged((status) => this._postMessage({ type: 'playbackStatus', status })),
    );
    this._disposables.push(
      _store.onTraceReady((trace) => {
        this._postMessage({ type: 'traceLoaded', trace });
      }),
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExtensionMessage) => this._handleWebviewMessage(msg),
      undefined,
      this._disposables,
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendCurrentState();
      }
    });
  }

  private _sendCurrentState(): void {
    const trace = this._store.trace;
    if (trace) {
      this._postMessage({ type: 'traceLoaded', trace });
    }
  }

  private _postMessage(msg: ExtensionToWebviewMessage): void {
    this._view?.webview.postMessage(msg);
  }

  private _handleWebviewMessage(msg: WebviewToExtensionMessage): void {
    switch (msg.type) {
      case 'ready':
        this._sendCurrentState();
        break;
      case 'playPause':
        this._replay.playPause();
        break;
      case 'stop':
        this._replay.stop();
        break;
      case 'setSpeed':
        this._replay.setSpeed(msg.speed as SpeedOption);
        break;
      case 'seekTo':
        this._replay.seekToEvent(msg.eventId);
        break;
      case 'seekToSegment':
        this._replay.seekToSegment(msg.segmentKey);
        break;
      case 'setStartMode':
        this._replay.setStartMode(msg.mode as StartMode);
        break;
    }
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    // Speed button labels: show step rate
    const speedLabels: Record<number, string> = {
      0.01: '0.01x',
      0.1:  '0.1x',
      0.5:  '0.5x',
      1:    '1x',
      2:    '2x',
      5:    '5x',
      10:   '10x',
    };
    const speedOptions = SPEED_OPTIONS.map(
      (s) => `<button class="speed-btn" data-speed="${s}" title="${s < 1 ? (1/s).toFixed(0)+'s' : s+'steps'}/s">${speedLabels[s] ?? s + 'x'}</button>`,
    ).join('');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src 'unsafe-inline';
             script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Recorder Timeline</title>
  <style>
    :root {
      --bg:        var(--vscode-sideBar-background, #1e1e1e);
      --fg:        var(--vscode-sideBar-foreground, #ccc);
      --border:    var(--vscode-panel-border, #444);
      --accent:    var(--vscode-terminal-ansiBlue, #569cd6);
      --accent2:   var(--vscode-editorWarning-foreground, #dcdcaa);
      --btn-bg:    var(--vscode-button-background, #0e639c);
      --btn-fg:    var(--vscode-button-foreground, #fff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --track-bg:  var(--vscode-editor-background, #252526);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, monospace);
      font-size: 12px;
      background: var(--bg);
      color: var(--fg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Controls ─────────────────────────────────────────────── */
    #controls {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 5px 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 3px 7px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 11px;
      font-family: inherit;
    }
    button:hover { background: var(--btn-hover); }
    button.active { outline: 2px solid var(--accent2); }
    #play-btn { min-width: 52px; }
    .speed-group { display: flex; gap: 2px; }
    .speed-btn { padding: 3px 5px; background: var(--track-bg); color: var(--vscode-foreground, #ccc); }
    .speed-btn.active { background: var(--btn-bg); color: var(--btn-fg); }
    .mode-group { display: flex; gap: 2px; margin-left: auto; }
    .mode-btn { padding: 2px 6px; background: var(--track-bg); font-size: 10px; color: var(--vscode-foreground, #ccc); }
    .mode-btn.active { background: #1a4a1a; outline: 1px solid #4ec94e; color: #9ee89e; }

    /* ── Speed info ────────────────────────────────────────────── */
    #speed-info {
      padding: 2px 8px;
      font-size: 10px;
      opacity: 0.6;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    /* ── Scrubber ─────────────────────────────────────────────── */
    #scrubber-row {
      padding: 3px 8px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #scrubber { width: 100%; accent-color: var(--accent); cursor: pointer; }

    /* ── Variable diff table ─────────────────────────────────── */
    #var-section {
      flex-shrink: 0;
      border-bottom: 1px solid var(--border);
      max-height: 180px;
      overflow-y: auto;
    }
    #var-section h4 {
      padding: 3px 8px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.6;
      position: sticky;
      top: 0;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
    }
    #var-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    #var-table th {
      padding: 2px 6px;
      text-align: left;
      opacity: 0.5;
      font-weight: normal;
      font-size: 10px;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 22px;
      background: var(--bg);
    }
    #var-table td {
      padding: 2px 6px;
      vertical-align: top;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      font-family: monospace;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #var-table td.var-name { opacity: 0.85; color: var(--accent); }
    td.diff-up    { background: rgba(0, 180, 0,  0.18); color: #7ec87e; }
    td.diff-down  { background: rgba(220, 50, 50, 0.18); color: #e07070; }
    td.diff-changed { background: rgba(200,180,0,0.15); color: #d4c060; }
    td.diff-new   { background: rgba(86,156,214,0.15); color: #9cdcfe; }
    td.diff-gone  { opacity: 0.4; text-decoration: line-through; }
    #var-empty {
      padding: 6px 8px;
      opacity: 0.4;
      font-size: 11px;
    }

    /* ── Main layout ─────────────────────────────────────────── */
    #main { display: flex; flex: 1; overflow: hidden; min-height: 0; }

    /* ── Splits sidebar ──────────────────────────────────────── */
    #splits {
      width: 150px;
      min-width: 90px;
      overflow-y: auto;
      border-right: 1px solid var(--border);
      flex-shrink: 0;
    }
    #splits h3 {
      padding: 4px 8px;
      font-size: 10px;
      text-transform: uppercase;
      opacity: 0.6;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--bg);
    }
    .split-item {
      padding: 4px 8px;
      cursor: pointer;
      border-left: 3px solid transparent;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 11px;
      line-height: 1.4;
    }
    .split-item:hover { background: rgba(255,255,255,0.06); }
    .split-item.active {
      border-left-color: var(--accent);
      background: rgba(86,156,214,0.15);
    }
    .split-duration { opacity: 0.5; font-size: 10px; display: block; }
    .split-seq {
      display: inline-block;
      min-width: 24px;
      font-size: 9px;
      opacity: 0.55;
      color: var(--accent2);
      margin-right: 4px;
      flex-shrink: 0;
    }
    .split-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Timeline canvas area ────────────────────────────────── */
    #timeline-area { flex: 1; overflow: auto; position: relative; min-width: 0; }
    #timeline-canvas { display: block; }
    #playhead {
      position: absolute;
      top: 0; bottom: 0;
      width: 2px;
      background: var(--accent2);
      pointer-events: none;
      opacity: 0.85;
      transition: left 0.05s linear;
    }

    /* ── Empty state ─────────────────────────────────────────── */
    #empty-state {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      height: 100%; opacity: 0.5; gap: 8px;
      padding: 16px; text-align: center;
    }
    #empty-state .icon { font-size: 28px; }

    /* ── Status / tooltip ────────────────────────────────────── */
    #status-text { font-size: 10px; opacity: 0.6; white-space: nowrap; }
    #tooltip {
      position: fixed;
      background: var(--vscode-editorHoverWidget-background, #252526);
      border: 1px solid var(--border);
      padding: 4px 8px;
      font-size: 11px;
      pointer-events: none;
      display: none;
      z-index: 999;
      max-width: 240px;
      word-break: break-all;
    }
  </style>
</head>
<body>

<!-- Controls -->
<div id="controls">
  <button id="play-btn" title="Play / Pause (Space)">&#9654; Play</button>
  <button id="stop-btn" title="Stop">&#9632;</button>
  <div class="speed-group" id="speed-group">${speedOptions}</div>
  <div class="mode-group">
    <button class="mode-btn active" id="mode-user" title="Start replay from your script's entry point">User</button>
    <button class="mode-btn" id="mode-all"  title="Start replay from the very first recorded event">Full</button>
  </div>
</div>

<!-- Speed info line -->
<div id="speed-info"><span id="speed-label">1x (1 step/s)</span> &nbsp;|&nbsp; <span id="status-text">No trace loaded</span></div>

<!-- Scrubber -->
<div id="scrubber-row">
  <input type="range" id="scrubber" min="0" max="0" value="0" step="1">
</div>

<!-- Variable diff table -->
<div id="var-section">
  <h4>Variables</h4>
  <div id="var-empty">Run a recording to see variable changes.</div>
  <table id="var-table" style="display:none">
    <thead>
      <tr>
        <th>Variable</th>
        <th>Previous</th>
        <th>Current</th>
      </tr>
    </thead>
    <tbody id="var-tbody"></tbody>
  </table>
</div>

<!-- Main: splits + timeline -->
<div id="main">
  <div id="splits">
    <h3>Functions</h3>
    <div id="splits-list"></div>
  </div>
  <div id="timeline-area">
    <div id="empty-state">
      <div class="icon">&#9654;</div>
      <div>Record or attach a debug session<br>to see the timeline.</div>
    </div>
    <canvas id="timeline-canvas" style="display:none"></canvas>
    <div id="playhead" style="display:none"></div>
  </div>
</div>

<div id="tooltip"></div>

<script nonce="${nonce}">
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  // ── State ─────────────────────────────────────────────────────
  let trace = null;
  let status = { state: 'idle', currentEventId: 0, speed: 1, totalEvents: 0,
                 startMode: 'user', userCodeStartEventId: 0 };
  let segmentColors = {};
  let segSeqNums = {};   // seg.key -> 1-based call order number
  let colorIndex = 0;
  let prevVariables = {};   // variables from the previous event

  const COLOR_PALETTE = [
    '#4ec9b0','#569cd6','#c586c0','#dcdcaa',
    '#ce9178','#9cdcfe','#f44747','#b5cea8',
  ];

  // ── DOM refs ──────────────────────────────────────────────────
  const playBtn     = document.getElementById('play-btn');
  const stopBtn     = document.getElementById('stop-btn');
  const scrubber    = document.getElementById('scrubber');
  const statusText  = document.getElementById('status-text');
  const speedLabel_ = document.getElementById('speed-label');
  const speedGroup  = document.getElementById('speed-group');
  const modeUser    = document.getElementById('mode-user');
  const modeAll     = document.getElementById('mode-all');
  const splitsList  = document.getElementById('splits-list');
  const canvasEl    = document.getElementById('timeline-canvas');
  const areaEl      = document.getElementById('timeline-area');
  const playhead    = document.getElementById('playhead');
  const emptyState  = document.getElementById('empty-state');
  const tooltip     = document.getElementById('tooltip');
  const varSection  = document.getElementById('var-section');
  const varEmpty    = document.getElementById('var-empty');
  const varTable    = document.getElementById('var-table');
  const varTbody    = document.getElementById('var-tbody');
  const ctx         = canvasEl.getContext('2d');

  const TRACK_H    = 22;
  const TRACK_PAD  = 2;
  const LABEL_MIN  = 40;
  const MIN_SEG_W  = 2;

  // ── Speed label helper ────────────────────────────────────────
  function speedLabel(s) {
    if (s >= 1) return s + 'x (' + s + ' step' + (s > 1 ? 's' : '') + '/s)';
    const secPerStep = (1 / s);
    return s + 'x (1 step/' + (Number.isInteger(secPerStep) ? secPerStep : secPerStep.toFixed(1)) + 's)';
  }

  // ── Message handling ──────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'traceLoaded':  onTraceLoaded(msg.trace); break;
      case 'playbackStatus': onStatusUpdate(msg.status); break;
      case 'cleared':      clearAll(); break;
    }
  });

  // ── Trace loaded ──────────────────────────────────────────────
  function onTraceLoaded(t) {
    trace = t;
    prevVariables = {};
    emptyState.style.display = 'none';
    canvasEl.style.display = 'block';
    playhead.style.display = 'block';

    scrubber.max = String(Math.max(0, t.events.length - 1));
    scrubber.value = String(t.userCodeStartEventId);

    assignColors(t.segments);
    assignSeqNums(t.segments);
    renderCanvas();
    renderSplits(t.segments);
    updateVarTable({}, {});
    updateStatusText();
  }

  function clearAll() {
    trace = null;
    prevVariables = {};
    emptyState.style.display = 'flex';
    canvasEl.style.display = 'none';
    playhead.style.display = 'none';
    splitsList.innerHTML = '';
    scrubber.value = '0'; scrubber.max = '0';
    statusText.textContent = 'No trace loaded';
    updateVarTable({}, {});
  }

  function assignColors(segments) {
    segmentColors = {}; colorIndex = 0;
    segments.forEach((seg) => {
      if (!segmentColors[seg.name]) {
        segmentColors[seg.name] = COLOR_PALETTE[colorIndex % COLOR_PALETTE.length];
        colorIndex++;
      }
    });
  }

  function assignSeqNums(segments) {
    segSeqNums = {};
    // Sort by startTimestamp to assign call-order numbers
    const sorted = [...segments].sort((a, b) => a.startTimestamp - b.startTimestamp);
    sorted.forEach((seg, i) => { segSeqNums[seg.key] = i + 1; });
  }

  // ── Status updates ────────────────────────────────────────────
  function onStatusUpdate(s) {
    const prevEventId = status.currentEventId;
    status = s;
    updatePlayBtn();
    updateSpeedBtns();
    updateModeBtns();
    updateStatusText();
    updateSpeedInfo();
    if (trace && s.totalEvents > 0) {
      scrubber.value = String(s.currentEventId);
      updatePlayhead(s.currentEventId);
      highlightActiveSplit(s.currentEventId);

      // Update variable diff table
      const cur  = trace.events[s.currentEventId]?.variables ?? {};
      const prev = prevEventId !== s.currentEventId
        ? (trace.events[prevEventId]?.variables ?? {})
        : prevVariables;
      prevVariables = prev;
      updateVarTable(prev, cur);
    }
  }

  function updatePlayBtn() {
    playBtn.textContent = status.state === 'playing' ? '⏸ Pause' : '▶ Play';
  }

  function updateSpeedBtns() {
    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.speed) === status.speed);
    });
  }

  function updateModeBtns() {
    modeUser.classList.toggle('active', status.startMode === 'user');
    modeAll.classList.toggle('active',  status.startMode === 'all');
  }

  function updateSpeedInfo() {
    speedLabel_.textContent = speedLabel(status.speed);
  }

  function updateStatusText() {
    if (!trace) { statusText.textContent = 'No trace loaded'; return; }
    const pct = trace.events.length > 0
      ? Math.round((status.currentEventId / trace.events.length) * 100) : 0;
    const modeNote = status.startMode === 'user' ? ' [User]' : ' [Full]';
    statusText.textContent = status.state === 'idle'
      ? trace.events.length + ' events' + modeNote
      : status.currentEventId + ' / ' + trace.events.length + ' (' + pct + '%)' + modeNote;
  }

  function updatePlayhead(eventId) {
    if (!trace || trace.events.length === 0) return;
    const totalDuration = trace.durationMs || 1;
    const event = trace.events[eventId];
    if (!event) return;
    const pct = event.timestamp / totalDuration;
    playhead.style.left = Math.round(pct * canvasEl.width) + 'px';
  }

  // ── Variable diff table ───────────────────────────────────────
  function tryNum(s) {
    if (s === undefined || s === null) return NaN;
    const n = Number(s);
    return isNaN(n) ? NaN : n;
  }

  function updateVarTable(prev, cur) {
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
    if (allKeys.size === 0) {
      varEmpty.style.display = 'block';
      varTable.style.display = 'none';
      return;
    }
    varEmpty.style.display = 'none';
    varTable.style.display = 'table';

    varTbody.innerHTML = '';
    allKeys.forEach((k) => {
      const pVal = prev[k];
      const cVal = cur[k];

      const tr = document.createElement('tr');

      // Variable name cell
      const tdName = document.createElement('td');
      tdName.className = 'var-name';
      tdName.textContent = k;
      tdName.title = k;
      tr.appendChild(tdName);

      // Previous value cell
      const tdPrev = document.createElement('td');
      tdPrev.textContent = pVal !== undefined ? pVal : '—';
      tdPrev.title = pVal ?? '';
      if (pVal === undefined) tdPrev.style.opacity = '0.3';
      tr.appendChild(tdPrev);

      // Current value cell — with diff highlight
      const tdCur = document.createElement('td');
      tdCur.textContent = cVal !== undefined ? cVal : '—';
      tdCur.title = cVal ?? '';

      if (cVal === undefined) {
        // Variable disappeared
        tdCur.className = 'diff-gone';
        tdCur.textContent = '(gone)';
      } else if (pVal === undefined) {
        // New variable
        tdCur.className = 'diff-new';
      } else if (cVal !== pVal) {
        const pn = tryNum(pVal), cn = tryNum(cVal);
        if (!isNaN(pn) && !isNaN(cn)) {
          tdCur.className = cn > pn ? 'diff-up' : 'diff-down';
        } else {
          tdCur.className = 'diff-changed';
        }
      }
      tr.appendChild(tdCur);

      varTbody.appendChild(tr);
    });
  }

  // ── Canvas rendering ──────────────────────────────────────────
  function renderCanvas() {
    if (!trace) return;
    const segments = trace.segments;
    if (segments.length === 0) return;

    const maxDepth = segments.reduce((m, s) => Math.max(m, s.callDepth), 0);
    const canvasH = (maxDepth + 1) * (TRACK_H + TRACK_PAD) + TRACK_PAD;
    const containerW = areaEl.clientWidth || 400;

    canvasEl.width  = Math.max(containerW, 400);
    canvasEl.height = canvasH;

    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    const totalDuration = trace.durationMs || 1;
    const W = canvasEl.width;

    segments.forEach((seg) => {
      const x = Math.floor((seg.startTimestamp / totalDuration) * W);
      const w = Math.max(MIN_SEG_W, Math.ceil(((seg.endTimestamp - seg.startTimestamp) / totalDuration) * W));
      const y = seg.callDepth * (TRACK_H + TRACK_PAD) + TRACK_PAD;

      const color = segmentColors[seg.name] || '#888';
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.82;
      ctx.beginPath();
      ctx.roundRect(x, y, w, TRACK_H, 3);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (w >= LABEL_MIN) {
        ctx.fillStyle = '#fff';
        ctx.font = '10px monospace';
        ctx.textBaseline = 'middle';
        const seqN = segSeqNums[seg.key] ? '#' + segSeqNums[seg.key] + ' ' : '';
        const maxNameLen = Math.max(0, 18 - seqN.length);
        const namePart = seg.name.length > maxNameLen ? seg.name.slice(0, maxNameLen - 2) + '..' : seg.name;
        ctx.fillText(seqN + namePart, x + 4, y + TRACK_H / 2, w - 8);
      }

      seg._bounds = { x, y, w, h: TRACK_H };
    });
  }

  // ── Splits sidebar ────────────────────────────────────────────
  function renderSplits(segments) {
    splitsList.innerHTML = '';
    const byKey = {};
    segments.forEach((seg) => { if (!byKey[seg.key]) byKey[seg.key] = seg; });
    const sorted = Object.values(byKey).sort((a, b) => a.startTimestamp - b.startTimestamp);

    sorted.forEach((seg) => {
      const dur = seg.endTimestamp - seg.startTimestamp;
      const seqN = segSeqNums[seg.key];
      const el = document.createElement('div');
      el.className = 'split-item';
      el.dataset.segKey = seg.key;
      el.style.borderLeftColor = segmentColors[seg.name] || '#888';

      // Sequence badge + name
      const seqSpan = document.createElement('span');
      seqSpan.className = 'split-seq';
      seqSpan.textContent = seqN ? '#' + seqN : '';
      el.appendChild(seqSpan);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'split-name';
      nameSpan.textContent = seg.name;
      el.appendChild(nameSpan);

      const durEl = document.createElement('span');
      durEl.className = 'split-duration';
      durEl.textContent = formatDuration(dur);
      el.appendChild(durEl);

      el.addEventListener('click', () => {
        vscode.postMessage({ type: 'seekToSegment', segmentKey: seg.key });
      });
      splitsList.appendChild(el);
    });
  }

  function highlightActiveSplit(eventId) {
    if (!trace) return;
    document.querySelectorAll('.split-item').forEach((el) => {
      const seg = trace.segments.find((s) => s.key === el.dataset.segKey);
      if (seg) el.classList.toggle('active', seg.startEventId <= eventId && seg.endEventId >= eventId);
    });
  }

  function formatDuration(ms) {
    if (ms < 1) return '<1 ms';
    if (ms < 1000) return ms.toFixed(1) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  // ── Canvas interactions ───────────────────────────────────────
  canvasEl.addEventListener('click', (e) => {
    if (!trace) return;
    const rect = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = trace.segments.find(
      (s) => s._bounds && mx >= s._bounds.x && mx <= s._bounds.x + s._bounds.w &&
             my >= s._bounds.y && my <= s._bounds.y + s._bounds.h,
    );
    if (hit) {
      vscode.postMessage({ type: 'seekToSegment', segmentKey: hit.key });
    } else {
      const pct = mx / canvasEl.width;
      const targetTs = pct * (trace.durationMs || 1);
      const idx = trace.events.findIndex((ev) => ev.timestamp >= targetTs);
      vscode.postMessage({ type: 'seekTo', eventId: idx >= 0 ? idx : trace.events.length - 1 });
    }
  });

  canvasEl.addEventListener('mousemove', (e) => {
    if (!trace) return;
    const rect = canvasEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = trace.segments.find(
      (s) => s._bounds && mx >= s._bounds.x && mx <= s._bounds.x + s._bounds.w &&
             my >= s._bounds.y && my <= s._bounds.y + s._bounds.h,
    );
    if (hit) {
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top  = (e.clientY - 8) + 'px';
      const seqN = segSeqNums[hit.key] ? ' #' + segSeqNums[hit.key] : '';
      tooltip.textContent = hit.name + '()' + seqN + '  ' +
                            formatDuration(hit.endTimestamp - hit.startTimestamp) +
                            '  depth=' + hit.callDepth;
    } else {
      tooltip.style.display = 'none';
    }
  });

  canvasEl.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

  if (window.ResizeObserver) {
    new ResizeObserver(() => renderCanvas()).observe(areaEl);
  }

  // ── Control interactions ──────────────────────────────────────
  playBtn.addEventListener('click',  () => vscode.postMessage({ type: 'playPause' }));
  stopBtn.addEventListener('click',  () => vscode.postMessage({ type: 'stop' }));

  speedGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.speed-btn');
    if (!btn) return;
    vscode.postMessage({ type: 'setSpeed', speed: Number(btn.dataset.speed) });
  });

  modeUser.addEventListener('click', () => vscode.postMessage({ type: 'setStartMode', mode: 'user' }));
  modeAll.addEventListener('click',  () => vscode.postMessage({ type: 'setStartMode', mode: 'all' }));

  scrubber.addEventListener('input', () => {
    vscode.postMessage({ type: 'seekTo', eventId: parseInt(scrubber.value, 10) });
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement !== scrubber) {
      e.preventDefault();
      vscode.postMessage({ type: 'playPause' });
    }
  });

  // ── Init ──────────────────────────────────────────────────────
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }

  dispose(): void {
    this._disposables.forEach((d) => d.dispose());
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
