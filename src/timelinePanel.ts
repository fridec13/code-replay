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
      case 'stepBy':
        this._replay.seekToEvent(this._replay.currentEventId + msg.delta);
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
    const varDiffMode =
      vscode.workspace.getConfiguration('codeReplay').get<string>('varDiffGranularity', 'char') === 'word'
        ? 'word'
        : 'char';

    // Speed button labels: show step rate; step prev/next replace former 0.01x / 10x slots
    const speedLabels: Record<number, string> = {
      0.1: '0.1x',
      0.5: '0.5x',
      1: '1x',
      2: '2x',
      5: '5x',
    };
    const speedOptions =
      SPEED_OPTIONS.map(
        (s) =>
          `<button type="button" class="speed-btn" data-speed="${s}" title="${
            s < 1 ? (1 / s).toFixed(0) + 's' : s + ' steps'
          }/s">${speedLabels[s] ?? s + 'x'}</button>`,
      ).join('') +
      '<button type="button" class="step-btn" id="step-prev" title="Previous step (&minus;1)">&#9664;</button>' +
      '<button type="button" class="step-btn" id="step-next" title="Next step (+1)">&#9654;</button>';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src 'unsafe-inline';
             script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Replay Timeline</title>
  <style>
    :root {
      --bg:        var(--vscode-sideBar-background, #1e1e1e);
      --fg:        var(--vscode-sideBar-foreground, #cccccc);
      --fg-muted:  var(--vscode-descriptionForeground, #9d9d9d);
      --border:    var(--vscode-panel-border, #3c3c3c);
      --border-strong: var(--vscode-contrastBorder, var(--vscode-widget-border, #6b6b6b));
      --accent:    var(--vscode-terminal-ansiBlue, #569cd6);
      --accent2:   var(--vscode-editorWarning-foreground, #cca700);
      --btn-bg:    var(--vscode-button-background, #0e639c);
      --btn-fg:    var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --track-bg:  var(--vscode-input-background, var(--vscode-editor-background, #252526));
      --list-hover: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08));
      --list-active: var(--vscode-list-activeSelectionBackground, rgba(0, 122, 204, 0.35));
      --list-active-fg: var(--vscode-list-activeSelectionForeground, var(--fg));
      --resize-bar: var(--vscode-scrollbarSlider-background, rgba(120,120,120,0.35));
      --resize-bar-hover: var(--vscode-scrollbarSlider-hoverBackground, rgba(160,160,160,0.5));
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, monospace);
      font-size: 13px;
      background: var(--bg);
      color: var(--fg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #fill {
      flex: 1;
      min-height: 0;
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
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
      font-family: inherit;
    }
    button:hover { background: var(--btn-hover); }
    button.active { outline: 2px solid var(--accent2); }
    #play-btn { min-width: 56px; }
    .speed-group { display: flex; gap: 2px; }
    .speed-btn {
      padding: 4px 6px;
      background: var(--track-bg);
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .speed-btn.active { background: var(--btn-bg); color: var(--btn-fg); border-color: transparent; }
    .step-btn {
      padding: 4px 8px;
      min-width: 30px;
      background: var(--track-bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 3px;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      font-family: inherit;
    }
    .step-btn:hover { background: var(--list-hover); }
    .step-btn:active { background: var(--list-active); }
    .mode-group { display: flex; gap: 2px; margin-left: auto; }
    .mode-btn {
      padding: 3px 7px;
      background: var(--track-bg);
      font-size: 11px;
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .mode-btn.active {
      background: var(--list-active);
      color: var(--list-active-fg);
      border-color: var(--accent);
      outline: none;
    }

    /* ── Speed info ────────────────────────────────────────────── */
    #speed-info {
      padding: 5px 8px;
      font-size: 12px;
      font-weight: 500;
      color: var(--fg-muted);
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
      height: 160px;
      min-height: 72px;
      overflow-y: auto;
      overflow-x: hidden;
    }
    #var-section h4 {
      padding: 6px 8px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--fg);
      position: sticky;
      top: 0;
      background: var(--bg);
      border-bottom: 1px solid var(--border-strong);
      z-index: 1;
    }
    #var-table {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      font-size: 12px;
    }
    #var-table col.var-col-name { width: 30%; }
    #var-table col.var-col-prev { width: 35%; }
    #var-table col.var-col-cur { width: 35%; }
    #var-table th {
      padding: 4px 6px;
      text-align: left;
      color: var(--fg-muted);
      font-weight: 600;
      font-size: 11px;
      border-bottom: 1px solid var(--border-strong);
      position: sticky;
      top: 28px;
      background: var(--bg);
      z-index: 1;
      box-sizing: border-box;
    }
    #var-table td {
      padding: 5px 6px;
      vertical-align: top;
      border-bottom: 1px solid var(--border);
      color: var(--fg);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      box-sizing: border-box;
      min-width: 0;
    }
    #var-table td.var-name {
      color: var(--accent);
      font-weight: 500;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    td.diff-up {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, #388a3a) 28%, var(--bg));
      color: var(--fg);
      border-left: 2px solid var(--vscode-testing-iconPassed, #388a3a);
    }
    td.diff-down {
      background: color-mix(in srgb, var(--vscode-errorForeground, #c72e0f) 22%, var(--bg));
      color: var(--fg);
      border-left: 2px solid var(--vscode-errorForeground, #c72e0f);
    }
    td.diff-changed {
      background: color-mix(in srgb, var(--accent2) 25%, var(--bg));
      color: var(--fg);
      border-left: 2px solid var(--accent2);
    }
    td.diff-new {
      background: color-mix(in srgb, var(--accent) 22%, var(--bg));
      color: var(--fg);
      border-left: 2px solid var(--accent);
    }
    td.diff-gone {
      color: var(--fg-muted);
      text-decoration: line-through;
      opacity: 0.85;
    }
    /* Emphasize the displayed value when it changed (current column) */
    td.diff-up .diff-val-em,
    td.diff-down .diff-val-em,
    td.diff-changed .diff-val-em,
    td.diff-new .diff-val-em {
      font-weight: 700;
      font-size: 1.07em;
      letter-spacing: 0.02em;
      color: var(--fg);
      text-decoration: underline;
      text-decoration-thickness: 2px;
      text-underline-offset: 3px;
      text-decoration-color: color-mix(in srgb, var(--fg) 55%, transparent);
    }
    td.diff-up .diff-val-em { text-decoration-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #388a3a) 70%, var(--fg)); }
    td.diff-down .diff-val-em { text-decoration-color: color-mix(in srgb, var(--vscode-errorForeground, #c72e0f) 70%, var(--fg)); }
    td.diff-changed .diff-val-em { text-decoration-color: color-mix(in srgb, var(--accent2) 65%, var(--fg)); }
    td.diff-new .diff-val-em { text-decoration-color: color-mix(in srgb, var(--accent) 65%, var(--fg)); }

    #var-table td .diff-val-del {
      text-decoration: line-through;
      text-decoration-thickness: 1.5px;
      color: var(--fg-muted);
      font-weight: 600;
    }
    #var-empty {
      padding: 8px;
      color: var(--fg-muted);
      font-size: 12px;
    }
    #var-table td.var-cell-empty {
      color: var(--fg-muted);
    }

    /* ── Resize handles ──────────────────────────────────────── */
    .resize-h {
      flex-shrink: 0;
      height: 6px;
      cursor: row-resize;
      background: var(--resize-bar);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      position: relative;
    }
    .resize-h:hover, .resize-h.dragging { background: var(--resize-bar-hover); }
    .resize-v {
      flex-shrink: 0;
      width: 6px;
      cursor: col-resize;
      background: var(--resize-bar);
      border-left: 1px solid var(--border);
      border-right: 1px solid var(--border);
    }
    .resize-v:hover, .resize-v.dragging { background: var(--resize-bar-hover); }

    /* ── Main layout ─────────────────────────────────────────── */
    #main {
      display: flex;
      flex-direction: row;
      flex: 1;
      overflow: hidden;
      min-height: 60px;
    }

    /* ── Splits sidebar ──────────────────────────────────────── */
    #splits {
      width: 150px;
      min-width: 72px;
      max-width: 85%;
      overflow-y: auto;
      overflow-x: hidden;
      flex-shrink: 0;
    }
    #splits h3 {
      padding: 6px 8px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--fg);
      border-bottom: 1px solid var(--border-strong);
      position: sticky;
      top: 0;
      background: var(--bg);
      z-index: 1;
    }
    .split-item {
      padding: 6px 8px;
      cursor: pointer;
      border-left: 3px solid transparent;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
      line-height: 1.5;
      color: var(--fg);
    }
    .split-item:hover { background: var(--list-hover); }
    .split-item.active {
      border-left-color: var(--accent);
      background: var(--list-active);
      color: var(--list-active-fg);
    }
    .split-duration { color: var(--fg-muted); font-size: 11px; display: block; }
    .split-seq {
      display: inline-block;
      min-width: 26px;
      font-size: 10px;
      color: var(--fg-muted);
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
      height: 100%;
      gap: 8px;
      padding: 16px; text-align: center;
      color: var(--fg-muted);
      font-size: 12px;
    }
    #empty-state .icon { font-size: 28px; }

    /* ── Console output section ──────────────────────────────────── */
    #console-section {
      flex-shrink: 0;
      border-top: 1px solid var(--border-strong);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      max-height: 30px;
    }
    #console-section.open {
      max-height: none;
    }
    #console-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--fg);
      background: var(--bg);
      border-bottom: 1px solid transparent;
    }
    #console-section.open #console-header {
      border-bottom-color: var(--border);
    }
    #console-header:hover { background: var(--list-hover); }
    #console-toggle { font-size: 9px; width: 10px; }
    #console-count { margin-left: auto; color: var(--fg-muted); font-weight: 500; }
    #console-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      font-family: monospace;
      font-size: 12px;
      color: var(--fg);
      line-height: 1.55;
    }
    .con-line {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 3px 8px 3px 20px;
      border-left: 3px solid transparent;
      color: var(--fg);
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.55;
    }
    .con-line.con-active {
      border-left-color: var(--accent2);
      background: color-mix(in srgb, var(--accent2) 14%, var(--bg));
    }
    .con-line.con-future { color: var(--fg-muted); }
    .con-level { font-size: 10px; color: var(--fg-muted); flex-shrink: 0; font-weight: 600; }
    .con-level.warn  { color: #e8c070; opacity: 0.8; }
    .con-level.error { color: #f44747; opacity: 0.9; }

    /* ── Recording error banner ───────────────────────────────── */
    #recording-error {
      display: none;
      margin: 6px 8px 0 8px;
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 55%, var(--bg));
      background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 12%, var(--bg));
      color: var(--fg);
      max-height: 120px;
      overflow-y: auto;
    }
    #recording-error.visible { display: block; }

    /* ── Status / tooltip ────────────────────────────────────── */
    #status-text { font-size: 11px; color: var(--fg-muted); font-weight: 500; white-space: nowrap; }
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

<div id="recording-error" aria-live="polite"></div>

<div id="fill">
<!-- Scrubber -->
<div id="scrubber-row">
  <input type="range" id="scrubber" min="0" max="0" value="0" step="1">
</div>

<!-- Variable diff table -->
<div id="var-section">
  <h4>Variables</h4>
  <div id="var-empty">Run a recording to see variable changes.</div>
  <table id="var-table" style="display:none">
    <colgroup>
      <col class="var-col-name" />
      <col class="var-col-prev" />
      <col class="var-col-cur" />
    </colgroup>
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

<div id="resize-var-main" class="resize-h" title="Drag to resize Variables height"></div>

<!-- Main: splits + timeline -->
<div id="main">
  <div id="splits">
    <h3>Functions</h3>
    <div id="splits-list"></div>
  </div>
  <div id="resize-splits" class="resize-v" title="Drag to resize Functions width"></div>
  <div id="timeline-area">
    <div id="empty-state">
      <div class="icon">&#9654;</div>
      <div>Record or attach a debug session<br>to see the timeline.</div>
    </div>
    <canvas id="timeline-canvas" style="display:none"></canvas>
    <div id="playhead" style="display:none"></div>
  </div>
</div>

<div id="resize-main-console" class="resize-h" title="Drag to resize Console height"></div>

<!-- Console output section (collapsible) -->
<div id="console-section">
  <div id="console-header">
    <span id="console-toggle">&#9658;</span>
    <span>Console</span>
    <span id="console-count"></span>
  </div>
  <div id="console-body"></div>
</div>
</div>

<div id="tooltip"></div>

<script nonce="${nonce}">
(function () {
  'use strict';

  const VAR_DIFF_MODE = ${JSON.stringify(varDiffMode)};

  const vscode = acquireVsCodeApi();

  // ── State ─────────────────────────────────────────────────────
  let trace = null;
  let status = { state: 'idle', currentEventId: 0, speed: 1, totalEvents: 0,
                 startMode: 'user', userCodeStartEventId: 0 };
  let segmentColors = {};
  let segSeqNums = {};   // seg.key -> 1-based call order number
  let colorIndex = 0;
  let prevVariables = {};   // variables from the previous event
  let outputLogs = [];      // OutputLog[]

  const COLOR_PALETTE = [
    '#4ec9b0','#569cd6','#c586c0','#dcdcaa',
    '#ce9178','#9cdcfe','#f44747','#b5cea8',
  ];

  // ── Inline string diff (char / word) — LCS backtrack, merged runs ─────
  var MAX_DIFF_UNITS = 2500;
  var MAX_DIFF_DP = 6000000;

  function tokenizeWords(s) {
    if (!s) return [];
    return s.split(/(\s+)/).filter(function (t) { return t.length > 0; });
  }

  function diffSequences(oldSeq, newSeq, eq) {
    var n = oldSeq.length;
    var m = newSeq.length;
    if (n * m > MAX_DIFF_DP) return null;
    var dp = new Array(n + 1);
    var i, j;
    for (i = 0; i <= n; i++) {
      dp[i] = new Array(m + 1);
      for (j = 0; j <= m; j++) dp[i][j] = 0;
    }
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        if (eq(oldSeq[i - 1], newSeq[j - 1])) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var raw = [];
    i = n;
    j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && eq(oldSeq[i - 1], newSeq[j - 1])) {
        raw.push({ op: 'equal', o: oldSeq[i - 1], n: newSeq[j - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        raw.push({ op: 'insert', n: newSeq[j - 1] });
        j--;
      } else if (i > 0) {
        raw.push({ op: 'delete', o: oldSeq[i - 1] });
        i--;
      } else {
        break;
      }
    }
    raw.reverse();
    return raw;
  }

  function mergeRawOps(raw, isWord) {
    var out = [];
    for (var k = 0; k < raw.length; k++) {
      var r = raw[k];
      var op = r.op;
      var text;
      if (op === 'equal') {
        text = String(r.o);
      } else if (op === 'insert') {
        text = String(r.n);
      } else {
        text = String(r.o);
      }
      var last = out[out.length - 1];
      if (last && last.op === op) last.text += text;
      else out.push({ op: op, text: text });
    }
    return out;
  }

  function computeInlineOps(oldStr, newStr, mode) {
    var oldSeq = mode === 'word' ? tokenizeWords(oldStr) : oldStr.split('');
    var newSeq = mode === 'word' ? tokenizeWords(newStr) : newStr.split('');
    if (oldSeq.length > MAX_DIFF_UNITS || newSeq.length > MAX_DIFF_UNITS) return null;
    if (oldSeq.length * newSeq.length > MAX_DIFF_DP) return null;
    var raw = diffSequences(oldSeq, newSeq, function (a, b) { return a === b; });
    if (!raw) return null;
    return mergeRawOps(raw, mode === 'word');
  }

  function renderDiffOpsPrev(td, ops) {
    td.textContent = '';
    for (var i = 0; i < ops.length; i++) {
      var seg = ops[i];
      if (seg.op === 'equal') td.appendChild(document.createTextNode(seg.text));
      else if (seg.op === 'delete') {
        var sp = document.createElement('span');
        sp.className = 'diff-val-del';
        sp.textContent = seg.text;
        td.appendChild(sp);
      }
    }
  }

  function renderDiffOpsCur(td, ops) {
    td.textContent = '';
    for (var i = 0; i < ops.length; i++) {
      var seg = ops[i];
      if (seg.op === 'equal') td.appendChild(document.createTextNode(seg.text));
      else if (seg.op === 'insert') {
        var sp = document.createElement('span');
        sp.className = 'diff-val-em';
        sp.textContent = seg.text;
        td.appendChild(sp);
      }
    }
  }

  function tryInlineDiff(tdPrev, tdCur, pVal, cVal, rowClass) {
    var ps = String(pVal);
    var cs = String(cVal);
    if (ps === cs) return false;
    var mode = VAR_DIFF_MODE === 'word' ? 'word' : 'char';
    var ops = computeInlineOps(ps, cs, mode);
    if (!ops || ops.length === 0) return false;
    tdPrev.title = ps;
    tdPrev.className = '';
    renderDiffOpsPrev(tdPrev, ops);
    tdCur.title = cs;
    tdCur.className = rowClass;
    renderDiffOpsCur(tdCur, ops);
    return true;
  }

  // ── DOM refs ──────────────────────────────────────────────────
  const playBtn     = document.getElementById('play-btn');
  const stopBtn     = document.getElementById('stop-btn');
  const scrubber    = document.getElementById('scrubber');
  const statusText  = document.getElementById('status-text');
  const recordingErrorEl = document.getElementById('recording-error');
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
  const varSection    = document.getElementById('var-section');
  const varEmpty      = document.getElementById('var-empty');
  const varTable      = document.getElementById('var-table');
  const varTbody      = document.getElementById('var-tbody');
  const splits        = document.getElementById('splits');
  const resizeVarMain = document.getElementById('resize-var-main');
  const resizeSplits  = document.getElementById('resize-splits');
  const resizeMainConsole = document.getElementById('resize-main-console');
  const consoleSection = document.getElementById('console-section');
  const consoleToggle  = document.getElementById('console-toggle');
  const consoleCount   = document.getElementById('console-count');
  const consoleBody    = document.getElementById('console-body');
  const ctx           = canvasEl.getContext('2d');

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
    outputLogs = t.outputLogs || [];
    consoleCount.textContent = outputLogs.length ? '(' + outputLogs.length + ')' : '';
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
    updateRecordingErrorBanner();
    updateStatusText();
  }

  function updateRecordingErrorBanner() {
    if (!recordingErrorEl) return;
    if (trace && trace.recordingError) {
      recordingErrorEl.textContent = trace.recordingError;
      recordingErrorEl.classList.add('visible');
    } else {
      recordingErrorEl.textContent = '';
      recordingErrorEl.classList.remove('visible');
    }
  }

  function clearAll() {
    trace = null;
    prevVariables = {};
    outputLogs = [];
    consoleCount.textContent = '';
    consoleBody.innerHTML = '';
    emptyState.style.display = 'flex';
    canvasEl.style.display = 'none';
    playhead.style.display = 'none';
    splitsList.innerHTML = '';
    scrubber.value = '0'; scrubber.max = '0';
    statusText.textContent = 'No trace loaded';
    if (recordingErrorEl) {
      recordingErrorEl.textContent = '';
      recordingErrorEl.classList.remove('visible');
    }
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

      updateConsole(s.currentEventId);
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
    const errNote = trace.recordingError ? ' — error' : '';
    statusText.textContent = status.state === 'idle'
      ? trace.events.length + ' events' + modeNote + errNote
      : status.currentEventId + ' / ' + trace.events.length + ' (' + pct + '%)' + modeNote + errNote;
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

  function appendEmphasizedValue(td, text) {
    td.textContent = '';
    const span = document.createElement('span');
    span.className = 'diff-val-em';
    span.textContent = text;
    td.appendChild(span);
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

      const tdPrev = document.createElement('td');
      const tdCur = document.createElement('td');

      if (cVal === undefined) {
        tdPrev.textContent = pVal !== undefined ? String(pVal) : '—';
        tdPrev.title = pVal !== undefined ? String(pVal) : '';
        tdPrev.className = pVal === undefined ? 'var-cell-empty' : '';
        tdCur.className = 'diff-gone';
        tdCur.textContent = '(gone)';
        tdCur.title = '';
      } else if (pVal === undefined) {
        tdPrev.textContent = '—';
        tdPrev.className = 'var-cell-empty';
        tdPrev.title = '';
        tdCur.className = 'diff-new';
        tdCur.title = String(cVal);
        appendEmphasizedValue(tdCur, String(cVal));
      } else if (cVal !== pVal) {
        const pn = tryNum(pVal),
          cn = tryNum(cVal);
        let rowClass = 'diff-changed';
        if (!isNaN(pn) && !isNaN(cn)) {
          rowClass = cn > pn ? 'diff-up' : 'diff-down';
        }
        if (!tryInlineDiff(tdPrev, tdCur, pVal, cVal, rowClass)) {
          tdPrev.textContent = String(pVal);
          tdPrev.title = String(pVal);
          tdPrev.className = '';
          tdCur.title = String(cVal);
          tdCur.className = rowClass;
          appendEmphasizedValue(tdCur, String(cVal));
        }
      } else {
        tdPrev.textContent = String(pVal);
        tdPrev.title = String(pVal);
        tdPrev.className = '';
        tdCur.className = '';
        tdCur.textContent = String(cVal);
        tdCur.title = String(cVal);
      }

      tr.appendChild(tdPrev);
      tr.appendChild(tdCur);

      varTbody.appendChild(tr);
    });
  }

  // ── Console output (B-style: context window around current step) ─────────
  const CONSOLE_BEFORE = 5;
  const CONSOLE_AFTER  = 3;

  function updateConsole(currentEventId) {
    if (!outputLogs.length) { consoleBody.innerHTML = ''; return; }

    // Binary-search for the last log with eventId <= currentEventId
    let lo = 0, hi = outputLogs.length - 1, pivot = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (outputLogs[mid].eventId <= currentEventId) { pivot = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }

    const from = Math.max(0, pivot - CONSOLE_BEFORE + 1);
    const to   = Math.min(outputLogs.length - 1, (pivot === -1 ? 0 : pivot) + CONSOLE_AFTER);
    const window_ = outputLogs.slice(from, to + 1);

    consoleBody.innerHTML = '';
    window_.forEach((log) => {
      const div = document.createElement('div');
      div.className = 'con-line';
      if (log.eventId === currentEventId) {
        div.classList.add('con-active');
      } else if (log.eventId > currentEventId) {
        div.classList.add('con-future');
      }

      if (log.level && log.level !== 'log') {
        const badge = document.createElement('span');
        badge.className = 'con-level ' + log.level;
        badge.textContent = log.level.toUpperCase();
        div.appendChild(badge);
      }

      const text = document.createElement('span');
      text.textContent = log.text;
      div.appendChild(text);
      consoleBody.appendChild(div);
    });

    // Scroll active line into view
    const active = consoleBody.querySelector('.con-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
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
        ctx.fillStyle = getComputedStyle(document.body).color || '#ffffff';
        ctx.font = '11px monospace';
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

  const stepPrev = document.getElementById('step-prev');
  const stepNext = document.getElementById('step-next');
  if (stepPrev) {
    stepPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'stepBy', delta: -1 });
    });
  }
  if (stepNext) {
    stepNext.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'stepBy', delta: 1 });
    });
  }

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

  // ── Resizable panel layout (persisted in webview state) ───────
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
  function readLayoutState() {
    const st = vscode.getState() || {};
    return {
      varH: clamp(st.varH ?? 160, 72, 420),
      splitW: clamp(st.splitW ?? 150, 72, 480),
      consoleH: clamp(st.consoleH ?? 200, 100, 560),
    };
  }
  let layout = readLayoutState();
  function persistLayout() {
    vscode.setState({
      ...(vscode.getState() || {}),
      varH: layout.varH,
      splitW: layout.splitW,
      consoleH: layout.consoleH,
    });
  }
  function applyLayout() {
    if (varSection) varSection.style.height = layout.varH + 'px';
    if (splits) splits.style.width = layout.splitW + 'px';
    if (consoleSection) {
      if (consoleSection.classList.contains('open')) {
        consoleSection.style.height = layout.consoleH + 'px';
      } else {
        consoleSection.style.height = '';
      }
    }
  }
  applyLayout();

  function bindResizeV(el, onDrag) {
    if (!el) return;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      el.classList.add('dragging');
      const startX = e.clientX;
      const startVal = onDrag.getStart();
      function move(ev) {
        onDrag.apply(startVal + (ev.clientX - startX));
        persistLayout();
      }
      function up() {
        el.classList.remove('dragging');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  if (resizeVarMain) {
    resizeVarMain.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizeVarMain.classList.add('dragging');
      const startY = e.clientY;
      const startH = layout.varH;
      function move(ev) {
        layout.varH = clamp(startH + (ev.clientY - startY), 72, 420);
        applyLayout();
        persistLayout();
      }
      function up() {
        resizeVarMain.classList.remove('dragging');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  bindResizeV(resizeSplits, {
    getStart: function () { return layout.splitW; },
    apply: function (v) {
      layout.splitW = clamp(v, 72, 480);
      applyLayout();
      renderCanvas();
    },
  });
  if (resizeMainConsole) {
    resizeMainConsole.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizeMainConsole.classList.add('dragging');
      const startY = e.clientY;
      const startH = layout.consoleH;
      if (!consoleSection.classList.contains('open')) {
        consoleSection.classList.add('open');
        if (consoleToggle) consoleToggle.textContent = '▼';
      }
      function move(ev) {
        layout.consoleH = clamp(startH - (ev.clientY - startY), 100, 560);
        applyLayout();
        persistLayout();
      }
      function up() {
        resizeMainConsole.classList.remove('dragging');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement !== scrubber) {
      e.preventDefault();
      vscode.postMessage({ type: 'playPause' });
    }
  });

  // ── Console toggle ────────────────────────────────────────────
  document.getElementById('console-header').addEventListener('click', () => {
    const open = consoleSection.classList.toggle('open');
    consoleToggle.textContent = open ? '▼' : '▶';
    if (open) {
      consoleSection.style.height = layout.consoleH + 'px';
    } else {
      consoleSection.style.height = '';
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
