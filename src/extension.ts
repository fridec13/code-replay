import * as vscode from 'vscode';
import * as path from 'path';
import { EventStore } from './eventStore';
import { Recorder } from './recorder';
import { LiveDebugBridge } from './liveDebugBridge';
import { ReplayController } from './replayController';
import { EditorDecorator } from './editorDecorator';
import { TimelinePanel } from './timelinePanel';
import { SPEED_OPTIONS, SpeedOption } from './types';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Code Replay');
  outputChannel.appendLine('[Code Replay] Activating…');

  try {
    _activate(context, outputChannel);
    outputChannel.appendLine('[Code Replay] Activated successfully.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[Code Replay] ACTIVATION ERROR: ${msg}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(`Code Replay failed to activate: ${msg}`);
  }
}

function _activate(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): void {
  // ── Core components ────────────────────────────────────────────────────────
  const store = new EventStore();
  const decorator = new EditorDecorator();
  const replay = new ReplayController(store, decorator);
  const recorder = new Recorder(context, store, outputChannel);
  const liveBridge = new LiveDebugBridge(store, outputChannel);
  const timelinePanel = new TimelinePanel(context, store, replay);

  context.subscriptions.push(
    store,
    decorator,
    replay,
    recorder,
    liveBridge,
    timelinePanel,
    outputChannel,
  );

  // ── WebView provider ────────────────────────────────────────────────────────
  const panelRegistration = vscode.window.registerWebviewViewProvider(
    'codeReplay.timeline',
    timelinePanel,
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  context.subscriptions.push(panelRegistration);

  // ── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReplay.recordPython', async () => {
      const file = getActiveFile(['.py']);
      if (!file) return;
      await recorder.start({ targetFile: file, language: 'python' });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReplay.recordJS', async () => {
      const file = getActiveFile(['.js', '.ts', '.mjs', '.cjs']);
      if (!file) {
        // Prompt to pick a file
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { JavaScript: ['js', 'mjs', 'cjs', 'ts'] },
          title: 'Select JavaScript/TypeScript file to record',
        });
        if (!picked || picked.length === 0) return;
        await recorder.start({
          targetFile: picked[0].fsPath,
          language: 'javascript',
        });
        return;
      }
      await recorder.start({ targetFile: file, language: 'javascript' });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReplay.liveMode', () => {
      if (liveBridge.isEnabled) {
        liveBridge.disable();
        vscode.window.showInformationMessage('Code Replay: Live mode disabled.');
      } else {
        liveBridge.enable();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReplay.openTimeline', () => {
      vscode.commands.executeCommand('codeReplay.timeline.focus');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReplay.playPause', () => {
      replay.playPause();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReplay.stop', () => {
      replay.stop();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReplay.setSpeed', async () => {
      const items = SPEED_OPTIONS.map((s) => ({
        label: `${s}x`,
        description: s === replay.speed ? '(current)' : '',
        speed: s,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select playback speed',
      });
      if (picked) {
        replay.setSpeed(picked.speed as SpeedOption);
      }
    }),
  );

  // ── Status bar item ────────────────────────────────────────────────────────
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = 'codeReplay.playPause';
  statusBarItem.tooltip = 'Code Replay — click to play/pause';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    replay.onStatusChanged((s) => {
      if (s.state === 'idle') {
        statusBarItem.hide();
      } else {
        statusBarItem.text =
          s.state === 'playing'
            ? `$(debug-pause) ${s.currentEventId}/${s.totalEvents} @${s.speed}x`
            : `$(play) ${s.currentEventId}/${s.totalEvents} @${s.speed}x`;
        statusBarItem.show();
      }
    }),
  );

  // ── Keyboard shortcut: Ctrl+Shift+Space → play/pause ──────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReplay.playPauseKeyboard', () => {
      replay.playPause();
    }),
  );
}

export function deactivate(): void {}

// ── Helpers ────────────────────────────────────────────────────────────────

function getActiveFile(extensions: string[]): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage(
      'Code Replay: No active editor. Open a file first.',
    );
    return null;
  }
  const file = editor.document.uri.fsPath;
  const ext = path.extname(file).toLowerCase();
  if (!extensions.includes(ext)) {
    vscode.window.showErrorMessage(
      `Code Replay: Expected ${extensions.join(' / ')} file, got ${ext}`,
    );
    return null;
  }
  return file;
}
