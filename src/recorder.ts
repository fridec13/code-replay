import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { TraceEvent } from './types';
import { EventStore } from './eventStore';

/** Windows: try py launcher first, then python3, then python */
const PYTHON_CANDIDATES = process.platform === 'win32'
  ? ['py', 'python', 'python3']
  : ['python3', 'python'];

/** Synchronously probe candidates until one succeeds. Returns null if none found. */
function detectPython(preferred?: string): string | null {
  const candidates = preferred ? [preferred, ...PYTHON_CANDIDATES] : PYTHON_CANDIDATES;
  for (const exe of candidates) {
    try {
      const result = cp.spawnSync(exe, ['--version'], { timeout: 3000, encoding: 'utf8' });
      if (result.status === 0 || (result.stdout ?? '').startsWith('Python')) {
        return exe;
      }
    } catch {
      // not found, try next
    }
  }
  return null;
}

export type Language = 'python' | 'javascript';

export interface RecorderOptions {
  targetFile: string;
  language: Language;
  maxEvents?: number;
  /** When true, trace stdlib/site-packages too. Default: false (user code only) */
  allFiles?: boolean;
}

export class Recorder {
  private _process: cp.ChildProcess | null = null;
  private _outputChannel: vscode.OutputChannel;
  private _tracerDir: string;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: EventStore,
    outputChannel: vscode.OutputChannel,
  ) {
    this._outputChannel = outputChannel;
    this._tracerDir = path.join(_context.extensionPath, 'tracers');
  }

  get isRunning(): boolean {
    return this._process !== null;
  }

  async start(opts: RecorderOptions): Promise<void> {
    if (this._process) {
      vscode.window.showWarningMessage('Code Recorder: A recording is already in progress.');
      return;
    }

    const config = vscode.workspace.getConfiguration('codeRecorder');
    const maxEvents = opts.maxEvents ?? config.get<number>('maxEventsPerTrace', 100_000);

    this._store.clear();

    const cmd = this._buildCommand(opts, maxEvents);
    if (!cmd) return;

    this._outputChannel.appendLine(
      `[Code Recorder] Starting ${opts.language} trace: ${opts.targetFile}`,
    );
    this._outputChannel.appendLine(`[Code Recorder] Command: ${cmd.args.join(' ')}`);

    this._process = cp.spawn(cmd.executable, cmd.args, {
      cwd: path.dirname(opts.targetFile),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lineBuffer = '';

    this._process.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        this._handleLine(line.trim(), opts.targetFile);
      }
    });

    this._process.stderr?.on('data', (chunk: Buffer) => {
      this._outputChannel.appendLine(`[stderr] ${chunk.toString('utf8').trim()}`);
    });

    this._process.on('error', (err) => {
      this._outputChannel.appendLine(`[Code Recorder] Process error: ${err.message}`);
      this._outputChannel.show(true);
      vscode.window.showErrorMessage(`Code Recorder: ${err.message}`);
      this._process = null;
    });

    this._process.on('close', (code) => {
      this._outputChannel.appendLine(`[Code Recorder] Process exited with code ${code}`);
      this._process = null;
    });

    vscode.window.showInformationMessage(
      `Code Recorder: Recording ${path.basename(opts.targetFile)}…`,
    );
  }

  stop(): void {
    if (this._process) {
      this._process.kill();
      this._process = null;
      this._outputChannel.appendLine('[Code Recorder] Recording stopped by user.');
    }
  }

  private _buildCommand(
    opts: RecorderOptions,
    maxEvents: number,
  ): { executable: string; args: string[] } | null {
    const config = vscode.workspace.getConfiguration('codeRecorder');

    if (opts.language === 'python') {
      const tracerScript = path.join(this._tracerDir, 'python_tracer.py');
      if (!fs.existsSync(tracerScript)) {
        vscode.window.showErrorMessage(
          `Code Recorder: tracer not found at ${tracerScript}`,
        );
        return null;
      }

      const preferred = config.get<string>('pythonPath') || undefined;
      const pythonExe = detectPython(preferred);
      if (!pythonExe) {
        const msg =
          'Code Recorder: Python not found. Install Python or set "codeRecorder.pythonPath" in settings.';
        this._outputChannel.appendLine(msg);
        this._outputChannel.show(true);
        vscode.window.showErrorMessage(msg, 'Open Settings').then((choice) => {
          if (choice === 'Open Settings') {
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'codeRecorder.pythonPath',
            );
          }
        });
        return null;
      }

      this._outputChannel.appendLine(`[Code Recorder] Using Python: ${pythonExe}`);
      const args = [tracerScript, opts.targetFile, '--max-events', String(maxEvents)];
      if (opts.allFiles) {
        args.push('--all-files');
      }
      return { executable: pythonExe, args };
    }

    if (opts.language === 'javascript') {
      const nodePath = config.get<string>('nodePath', 'node');
      const tracerScript = path.join(this._tracerDir, 'js_tracer.js');
      if (!fs.existsSync(tracerScript)) {
        vscode.window.showErrorMessage(
          `Code Recorder: tracer not found at ${tracerScript}`,
        );
        return null;
      }
      return {
        executable: nodePath,
        args: [
          '--require',
          tracerScript,
          opts.targetFile,
          '--max-events',
          String(maxEvents),
        ],
      };
    }

    return null;
  }

  private _handleLine(line: string, entryFile: string): void {
    if (!line) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      this._outputChannel.appendLine(`[Code Recorder] Non-JSON output: ${line}`);
      return;
    }

    const type = parsed['type'] as string | undefined;

    if (type === 'config') {
      const userOnly = parsed['userOnly'] as boolean;
      this._store.setUserOnly(userOnly);
      return;
    }

    if (type === 'done') {
      const totalEvents = parsed['totalEvents'] as number;
      const durationMs = parsed['durationMs'] as number;
      this._outputChannel.appendLine(
        `[Code Recorder] Done — ${totalEvents} events in ${durationMs.toFixed(1)} ms`,
      );
      this._store.finalize(entryFile);
      vscode.window.showInformationMessage(
        `Code Recorder: Captured ${totalEvents} events (${durationMs.toFixed(0)} ms). Open Timeline to replay.`,
      );
      return;
    }

    if (type === 'error') {
      const msg = parsed['message'] as string;
      this._outputChannel.appendLine(`[Code Recorder] Script error:\n${msg}`);
      vscode.window.showErrorMessage(`Code Recorder: Script error — see Output panel.`);
      return;
    }

    if (type === 'limit_reached') {
      const max = parsed['max'] as number;
      vscode.window.showWarningMessage(
        `Code Recorder: Event limit reached (${max}). Increase codeRecorder.maxEventsPerTrace to capture more.`,
      );
      return;
    }

    // Regular trace event
    if (
      type === 'call' ||
      type === 'line' ||
      type === 'return' ||
      type === 'exception'
    ) {
      const event: TraceEvent = {
        id: parsed['id'] as number,
        timestamp: parsed['timestamp'] as number,
        type: type as TraceEvent['type'],
        file: parsed['file'] as string,
        line: parsed['line'] as number,
        functionName: parsed['functionName'] as string,
        variables: (parsed['variables'] as Record<string, string>) ?? {},
        returnValue: parsed['returnValue'] as string | undefined,
        callDepth: parsed['callDepth'] as number,
      };
      this._store.addEvent(event);
    }
  }

  dispose(): void {
    this.stop();
  }
}
