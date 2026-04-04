import * as vscode from 'vscode';
import { TraceEvent } from './types';
import { EventStore } from './eventStore';

/**
 * Bridges VSCode's Debug Adapter Protocol (DAP) with the EventStore.
 *
 * Strategy:
 *  - Register a DebugAdapterTrackerFactory for all debug sessions ('*').
 *  - On each `stopped` event (breakpoint, step, exception) ask the session
 *    for the current stack frame and local variables.
 *  - Convert each stop into one or more TraceEvents and feed them into
 *    the EventStore, so the same replay infrastructure can visualize live
 *    stepping just like a recorded trace.
 *
 * The user activates this by running "Code Replay: Attach Live Mode (DAP)"
 * which simply enables the factory.  Any subsequent debug session (already
 * started or newly launched) will be tracked.
 */
export class LiveDebugBridge implements vscode.Disposable {
  private _enabled = false;
  private _registration: vscode.Disposable | null = null;
  private _eventCounter = 0;
  private _startTime: number = Date.now();
  private _outputChannel: vscode.OutputChannel;

  constructor(
    private readonly _store: EventStore,
    outputChannel: vscode.OutputChannel,
  ) {
    this._outputChannel = outputChannel;
  }

  get isEnabled(): boolean {
    return this._enabled;
  }

  enable(): void {
    if (this._enabled) return;
    this._enabled = true;
    this._eventCounter = 0;
    this._startTime = Date.now();
    this._store.clear();

    this._registration = vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker: (session) => this._createTracker(session),
    });

    this._outputChannel.appendLine('[Code Replay] Live mode enabled — attach a debug session.');
    vscode.window.showInformationMessage(
      'Code Replay: Live mode active. Start or resume a debug session to begin capturing.',
    );
  }

  disable(): void {
    this._enabled = false;
    this._registration?.dispose();
    this._registration = null;
    this._outputChannel.appendLine('[Code Replay] Live mode disabled.');
  }

  private _createTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    this._outputChannel.appendLine(
      `[Code Replay] Tracking debug session: ${session.name} (${session.type})`,
    );

    return {
      onDidSendMessage: (message: DapMessage) => {
        this._onDapMessage(session, message).catch((err) => {
          this._outputChannel.appendLine(`[Code Replay] Live bridge error: ${err}`);
        });
      },
      onError: (error) => {
        this._outputChannel.appendLine(`[Code Replay] DAP error: ${error}`);
      },
      onExit: () => {
        this._outputChannel.appendLine('[Code Replay] Debug session ended.');
        this._store.finalize(session.workspaceFolder?.uri.fsPath ?? '');
      },
    };
  }

  private async _onDapMessage(session: vscode.DebugSession, msg: DapMessage): Promise<void> {
    if (!this._enabled) return;

    // We care about `stopped` events from the adapter → IDE
    if (msg.type !== 'event' || msg.event !== 'stopped') return;

    const stoppedBody = msg.body as DapStoppedBody | undefined;
    if (!stoppedBody) return;

    const threadId: number = stoppedBody.threadId ?? 1;

    try {
      // 1. Get the stack
      const stackResp = await session.customRequest('stackTrace', {
        threadId,
        startFrame: 0,
        levels: 20,
      });
      const frames: DapStackFrame[] = stackResp?.stackFrames ?? [];
      if (frames.length === 0) return;

      const topFrame = frames[0];
      const absFile = topFrame.source?.path ?? '';
      const line = topFrame.line ?? 0;
      const funcName = topFrame.name ?? '(unknown)';

      // 2. Get scopes for the top frame
      const scopesResp = await session.customRequest('scopes', {
        frameId: topFrame.id,
      });
      const scopes: DapScope[] = scopesResp?.scopes ?? [];

      // 3. Collect variables from the first (local) scope
      const variables: Record<string, string> = {};
      const localScope = scopes.find(
        (s) => s.name === 'Locals' || s.name === 'Local' || s.presentationHint === 'locals',
      ) ?? scopes[0];

      if (localScope) {
        const varsResp = await session.customRequest('variables', {
          variablesReference: localScope.variablesReference,
        });
        const rawVars: DapVariable[] = varsResp?.variables ?? [];
        for (const v of rawVars.slice(0, 50)) {
          if (!v.name.startsWith('__')) {
            variables[v.name] = v.value ?? '';
          }
        }
      }

      const ts = Date.now() - this._startTime;
      const reason = stoppedBody.reason ?? 'step';
      const eventType: TraceEvent['type'] =
        reason === 'exception' ? 'exception' : 'line';

      const event: TraceEvent = {
        id: this._eventCounter++,
        timestamp: ts,
        type: eventType,
        file: absFile,
        line,
        functionName: funcName,
        variables,
        callDepth: Math.max(0, frames.length - 1),
      };

      this._store.addEvent(event);
      this._outputChannel.appendLine(
        `[Live] ${funcName} @ ${absFile}:${line}`,
      );
    } catch (err) {
      // Ignore — session may have resumed before we could query it
    }
  }

  dispose(): void {
    this.disable();
  }
}

// ── minimal DAP type stubs ────────────────────────────────────────────────────
interface DapMessage {
  type: 'event' | 'request' | 'response';
  event?: string;
  body?: unknown;
}

interface DapStoppedBody {
  reason?: string;
  threadId?: number;
}

interface DapStackFrame {
  id: number;
  name: string;
  line?: number;
  source?: { path?: string };
}

interface DapScope {
  name: string;
  variablesReference: number;
  presentationHint?: string;
}

interface DapVariable {
  name: string;
  value?: string;
}
