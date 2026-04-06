import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TraceEvent, OutputLog } from './types';
import { EventStore } from './eventStore';

/** Windows: try py launcher first, then python3, then python */
const PYTHON_CANDIDATES = process.platform === 'win32'
  ? ['py', 'python', 'python3']
  : ['python3', 'python'];

const GPP_CANDIDATES = ['g++', 'g++-14', 'g++-13', 'g++-12', 'g++-11'];
const GDB_CANDIDATES = ['gdb'];

/** Synchronously probe candidates until one succeeds. Returns null if none found. */
function detectExecutable(candidates: string[], versionFlag = '--version'): string | null {
  for (const exe of candidates) {
    try {
      const result = cp.spawnSync(exe, [versionFlag], { timeout: 3000, encoding: 'utf8' });
      if (result.status === 0) return exe;
    } catch {
      // not found, try next
    }
  }
  return null;
}

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

export type Language = 'python' | 'javascript' | 'cpp';

export interface RecorderOptions {
  targetFile: string;
  language: Language;
  maxEvents?: number;
  /** When true, trace stdlib/site-packages too. Default: false (user code only) */
  allFiles?: boolean;
  /** Internal: path to the compiled binary (set by _compileCpp before _buildCommand) */
  _compiledBinary?: string;
}

function truncateForToast(msg: string, max = 200): string {
  const firstLine = msg.split(/\r?\n/).find((l) => l.trim()) ?? msg;
  return firstLine.length > max ? firstLine.slice(0, max - 3) + '...' : firstLine;
}

export class Recorder {
  private _process: cp.ChildProcess | null = null;
  private _outputChannel: vscode.OutputChannel;
  private _tracerDir: string;
  /** Uncaught error / tracer fatal message; applied on `done` or process `close` */
  private _recordingError: string | undefined;

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
      vscode.window.showWarningMessage('Code Replay: A recording is already in progress.');
      return;
    }

    const config = vscode.workspace.getConfiguration('codeReplay');
    const maxEvents = opts.maxEvents ?? config.get<number>('maxEventsPerTrace', 100_000);

    this._store.clear();
    this._recordingError = undefined;

    // C++: compile source file to a temporary binary first
    if (opts.language === 'cpp') {
      const binPath = await this._compileCpp(opts.targetFile, config);
      if (!binPath) return;
      opts = { ...opts, _compiledBinary: binPath };
    }

    const cmd = this._buildCommand(opts, maxEvents);
    if (!cmd) return;

    this._outputChannel.appendLine(
      `[Code Replay] Starting ${opts.language} trace: ${opts.targetFile}`,
    );
    this._outputChannel.appendLine(`[Code Replay] Command: ${cmd.executable} ${cmd.args.join(' ')}`);

    this._process = cp.spawn(cmd.executable, cmd.args, {
      cwd: path.dirname(opts.targetFile),
      env: { ...process.env, ...(cmd.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lineBuffer = '';
    const entryFile = opts.targetFile;

    this._process.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        this._handleLine(line.trim(), entryFile);
      }
    });

    this._process.stderr?.on('data', (chunk: Buffer) => {
      this._outputChannel.appendLine(`[stderr] ${chunk.toString('utf8').trim()}`);
    });

    this._process.on('error', (err) => {
      this._outputChannel.appendLine(`[Code Replay] Process error: ${err.message}`);
      this._outputChannel.show(true);
      vscode.window.showErrorMessage(`Code Replay: ${err.message}`);
      this._process = null;
    });

    this._process.on('close', (code) => {
      this._outputChannel.appendLine(`[Code Replay] Process exited with code ${code}`);
      const rest = lineBuffer.trim();
      if (rest) {
        for (const line of rest.split('\n')) {
          const t = line.trim();
          if (t) this._handleLine(t, entryFile);
        }
      }
      // Tracers that emit `error` without `done` (e.g. early exit in cpp_tracer)
      if (!this._store.trace) {
        const hasEvents = this._store.eventCount > 0;
        if (this._recordingError || hasEvents) {
          this._store.finalize(entryFile, {
            recordingError:
              this._recordingError ??
              (code !== 0
                ? `Process exited with code ${code} before recording finished.`
                : undefined),
          });
          this._notifyRecordingComplete();
        } else if (code !== 0) {
          this._store.finalize(entryFile, {
            recordingError: `Recording failed (exit code ${code}).`,
          });
          this._notifyRecordingComplete();
        }
      }
      this._recordingError = undefined;
      this._process = null;
    });

    vscode.window.showInformationMessage(
      `Code Replay: Recording ${path.basename(opts.targetFile)}…`,
    );
  }

  stop(): void {
    if (this._process) {
      this._process.kill();
      this._process = null;
      this._outputChannel.appendLine('[Code Replay] Recording stopped by user.');
    }
  }

  private _buildCommand(
    opts: RecorderOptions,
    maxEvents: number,
  ): { executable: string; args: string[]; env?: Record<string, string> } | null {
    const config = vscode.workspace.getConfiguration('codeReplay');

    if (opts.language === 'python') {
      const tracerScript = path.join(this._tracerDir, 'python_tracer.py');
      if (!fs.existsSync(tracerScript)) {
        vscode.window.showErrorMessage(
          `Code Replay: tracer not found at ${tracerScript}`,
        );
        return null;
      }

      const preferred = config.get<string>('pythonPath') || undefined;
      const pythonExe = detectPython(preferred);
      if (!pythonExe) {
        const msg =
          'Code Replay: Python not found. Install Python or set "codeReplay.pythonPath" in settings.';
        this._outputChannel.appendLine(msg);
        this._outputChannel.show(true);
        vscode.window.showErrorMessage(msg, 'Open Settings').then((choice) => {
          if (choice === 'Open Settings') {
            vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'codeReplay.pythonPath',
            );
          }
        });
        return null;
      }

      this._outputChannel.appendLine(`[Code Replay] Using Python: ${pythonExe}`);
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
          `Code Replay: tracer not found at ${tracerScript}`,
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

    if (opts.language === 'cpp') {
      const tracerScript = path.join(this._tracerDir, 'cpp_tracer.py');
      if (!fs.existsSync(tracerScript)) {
        vscode.window.showErrorMessage(
          `Code Replay: C++ tracer not found at ${tracerScript}`,
        );
        return null;
      }

      const preferredGdb = config.get<string>('gdbPath') || undefined;
      const gdbCandidates = preferredGdb ? [preferredGdb, ...GDB_CANDIDATES] : GDB_CANDIDATES;
      const gdbExe = detectExecutable(gdbCandidates);
      if (!gdbExe) {
        const msg = 'Code Replay: GDB not found. Install GDB (MinGW/MSYS2) or set "codeReplay.gdbPath" in settings.';
        this._outputChannel.appendLine(msg);
        this._outputChannel.show(true);
        vscode.window.showErrorMessage(msg, 'Open Settings').then((choice) => {
          if (choice === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'codeReplay.gdbPath');
          }
        });
        return null;
      }

      const compiledBinary = opts._compiledBinary!;
      this._outputChannel.appendLine(`[Code Replay] Using GDB: ${gdbExe}`);
      this._outputChannel.appendLine(`[Code Replay] Binary: ${compiledBinary}`);

      const sourceDir = path.dirname(opts.targetFile).toLowerCase();

      return {
        executable: gdbExe,
        args: ['--batch', '-x', tracerScript, '--args', compiledBinary],
        env: {
          CR_MAX_EVENTS: String(maxEvents),
          CR_SOURCE_DIR: sourceDir,
        },
      };
    }

    return null;
  }

  /**
   * Compile a C++ source file with g++ -g -O0 to a temporary binary.
   * Returns the binary path on success, or null on failure.
   */
  private async _compileCpp(
    sourceFile: string,
    config: vscode.WorkspaceConfiguration,
  ): Promise<string | null> {
    const preferredGpp = config.get<string>('gppPath') || undefined;
    const gppCandidates = preferredGpp ? [preferredGpp, ...GPP_CANDIDATES] : GPP_CANDIDATES;
    const gppExe = detectExecutable(gppCandidates);

    if (!gppExe) {
      const msg = 'Code Replay: g++ not found. Install g++ (MinGW/MSYS2) or set "codeReplay.gppPath" in settings.';
      this._outputChannel.appendLine(msg);
      this._outputChannel.show(true);
      vscode.window.showErrorMessage(msg, 'Open Settings').then((choice) => {
        if (choice === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'codeReplay.gppPath');
        }
      });
      return null;
    }

    const sourceDir = path.dirname(sourceFile);
    const cppFiles = fs
      .readdirSync(sourceDir)
      .filter((f) => /\.(cpp|cc|cxx|c)$/i.test(f))
      .map((f) => path.join(sourceDir, f));

    const tmpBin = path.join(os.tmpdir(), `cr_cpp_${Date.now()}${process.platform === 'win32' ? '.exe' : ''}`);
    this._outputChannel.appendLine(
      `[Code Replay] Compiling ${cppFiles.length} file(s) in ${sourceDir}:\n` +
      cppFiles.map((f) => `  ${path.basename(f)}`).join('\n'),
    );

    return new Promise((resolve) => {
      const proc = cp.spawn(gppExe, ['-g', '-O0', '-o', tmpBin, ...cppFiles], {
        cwd: path.dirname(sourceFile),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      proc.on('error', (err) => {
        this._outputChannel.appendLine(`[Code Replay] Compile error: ${err.message}`);
        this._outputChannel.show(true);
        vscode.window.showErrorMessage(`Code Replay: Compile failed — ${err.message}`);
        resolve(null);
      });

      proc.on('close', (code) => {
        if (stderr) {
          this._outputChannel.appendLine(`[g++ stderr]\n${stderr.trim()}`);
        }
        if (code !== 0) {
          this._outputChannel.show(true);
          vscode.window.showErrorMessage(
            `Code Replay: g++ exited with code ${code}. See Output panel for details.`,
          );
          resolve(null);
        } else {
          this._outputChannel.appendLine(`[Code Replay] Compile OK → ${tmpBin}`);
          resolve(tmpBin);
        }
      });
    });
  }

  /** Toast + optional Output after trace is in the store */
  private _notifyRecordingComplete(totalEvents?: number, wallMs?: number): void {
    const trace = this._store.trace;
    if (!trace) return;
    const n = totalEvents ?? trace.events.length;
    const ms = wallMs ?? trace.durationMs;
    if (trace.recordingError) {
      const short = truncateForToast(trace.recordingError);
      vscode.window
        .showErrorMessage(
          `Code Replay: Recording stopped with an error — ${short}`,
          'Open Output',
        )
        .then((choice) => {
          if (choice === 'Open Output') {
            this._outputChannel.show(true);
          }
        });
    } else {
      vscode.window.showInformationMessage(
        `Code Replay: Captured ${n} events (${typeof ms === 'number' ? ms.toFixed(0) : String(ms)} ms). Open Timeline to replay.`,
      );
    }
  }

  private _handleLine(line: string, entryFile: string): void {
    if (!line) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      this._outputChannel.appendLine(`[Code Replay] Non-JSON output: ${line}`);
      return;
    }

    const type = parsed['type'] as string | undefined;

    if (type === 'config') {
      const userOnly = parsed['userOnly'] as boolean;
      this._store.setUserOnly(userOnly);
      return;
    }

    if (type === 'output') {
      const log: OutputLog = {
        eventId:   parsed['eventId']   as number,
        text:      parsed['text']      as string,
        level:     parsed['level']     as string | undefined,
        timestamp: parsed['timestamp'] as number,
      };
      this._store.addOutputLog(log);
      return;
    }

    if (type === 'done') {
      const totalEvents = parsed['totalEvents'] as number;
      const durationMs = parsed['durationMs'] as number;
      this._outputChannel.appendLine(
        `[Code Replay] Done — ${totalEvents} events in ${durationMs.toFixed(1)} ms`,
      );
      const err = this._recordingError;
      this._recordingError = undefined;
      this._store.finalize(entryFile, { recordingError: err });
      this._notifyRecordingComplete(totalEvents, durationMs);
      return;
    }

    if (type === 'error') {
      const msg = parsed['message'] as string;
      this._recordingError = msg;
      this._outputChannel.appendLine(`[Code Replay] Script error:\n${msg}`);
      return;
    }

    if (type === 'limit_reached') {
      const max = parsed['max'] as number;
      vscode.window.showWarningMessage(
        `Code Replay: Event limit reached (${max}). Increase codeReplay.maxEventsPerTrace to capture more.`,
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
