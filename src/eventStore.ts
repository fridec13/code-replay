import * as vscode from 'vscode';
import { TraceEvent, FunctionSegment, ExecutionTrace, OutputLog } from './types';

/**
 * Central repository for all captured trace events.
 *
 * Responsibilities:
 *  - Store events in order as they stream in.
 *  - Build FunctionSegments on-the-fly (call → return pairs).
 *  - Emit an `onTraceReady` event when `finalize()` is called so that the
 *    Timeline panel and ReplayController can pick up the completed trace.
 *  - Provide random-access lookup by eventId and by segment key.
 */
export class EventStore implements vscode.Disposable {
  private _events: TraceEvent[] = [];
  private _segments: FunctionSegment[] = [];
  private _outputLogs: OutputLog[] = [];
  /** Stack of open call events (not yet matched to a return) */
  private _callStack: OpenCall[] = [];
  private _trace: ExecutionTrace | null = null;
  private _entryFile = '';
  private _userOnly = true;

  private readonly _onTraceReadyEmitter = new vscode.EventEmitter<ExecutionTrace>();
  readonly onTraceReady: vscode.Event<ExecutionTrace> = this._onTraceReadyEmitter.event;

  private readonly _onEventAddedEmitter = new vscode.EventEmitter<TraceEvent>();
  readonly onEventAdded: vscode.Event<TraceEvent> = this._onEventAddedEmitter.event;

  get events(): readonly TraceEvent[] {
    return this._events;
  }

  get segments(): readonly FunctionSegment[] {
    return this._segments;
  }

  get trace(): ExecutionTrace | null {
    return this._trace;
  }

  get eventCount(): number {
    return this._events.length;
  }

  clear(): void {
    this._events = [];
    this._segments = [];
    this._outputLogs = [];
    this._callStack = [];
    this._trace = null;
    this._entryFile = '';
    this._userOnly = true;
  }

  setUserOnly(userOnly: boolean): void {
    this._userOnly = userOnly;
  }

  addOutputLog(log: OutputLog): void {
    this._outputLogs.push(log);
  }

  addEvent(event: TraceEvent): void {
    this._events.push(event);
    this._onEventAddedEmitter.fire(event);

    if (event.type === 'call') {
      this._callStack.push({
        event,
        segmentKey: `${event.file}:${event.functionName}:${event.id}`,
      });
    } else if (event.type === 'return' || event.type === 'exception') {
      this._closeSegment(event);
    }
  }

  /**
   * Called once the tracer process exits.  Closes any unclosed call segments
   * (e.g. if the script was interrupted) and emits `onTraceReady`.
   */
  finalize(entryFile: string, options?: { recordingError?: string }): void {
    this._entryFile = entryFile;

    // Close dangling open calls
    for (const open of [...this._callStack].reverse()) {
      const last = this._events[this._events.length - 1];
      const seg: FunctionSegment = {
        key: open.segmentKey,
        name: open.event.functionName,
        file: open.event.file,
        startEventId: open.event.id,
        endEventId: last?.id ?? open.event.id,
        startTimestamp: open.event.timestamp,
        endTimestamp: last?.timestamp ?? open.event.timestamp,
        callDepth: open.event.callDepth,
      };
      this._segments.push(seg);
    }
    this._callStack = [];

    const durationMs =
      this._events.length > 0
        ? this._events[this._events.length - 1].timestamp
        : 0;

    // Find the first event that belongs to the entry file (user's own code).
    // When recording with --all-files, stdlib events appear first; this index
    // lets the replay controller skip straight to the user's script.
    const normalizedEntry = this._entryFile.toLowerCase();
    const userCodeStartEventId =
      this._events.findIndex(
        (e) => e.file.toLowerCase() === normalizedEntry,
      ) ?? 0;

    this._trace = {
      entryFile: this._entryFile,
      recordedAt: new Date().toISOString(),
      events: this._events,
      segments: this._segments,
      durationMs,
      userCodeStartEventId: userCodeStartEventId < 0 ? 0 : userCodeStartEventId,
      userOnly: this._userOnly,
      outputLogs: this._outputLogs,
      recordingError: options?.recordingError,
    };

    this._onTraceReadyEmitter.fire(this._trace);
  }

  getEvent(id: number): TraceEvent | undefined {
    return this._events[id];
  }

  getSegment(key: string): FunctionSegment | undefined {
    return this._segments.find((s) => s.key === key);
  }

  /** Returns all segments that contain the given eventId */
  segmentsAt(eventId: number): FunctionSegment[] {
    return this._segments.filter(
      (s) => s.startEventId <= eventId && s.endEventId >= eventId,
    );
  }

  private _closeSegment(returnEvent: TraceEvent): void {
    // Find the most-recent matching call on the stack
    for (let i = this._callStack.length - 1; i >= 0; i--) {
      const open = this._callStack[i];
      if (
        open.event.functionName === returnEvent.functionName &&
        open.event.file === returnEvent.file
      ) {
        const seg: FunctionSegment = {
          key: open.segmentKey,
          name: open.event.functionName,
          file: open.event.file,
          startEventId: open.event.id,
          endEventId: returnEvent.id,
          startTimestamp: open.event.timestamp,
          endTimestamp: returnEvent.timestamp,
          callDepth: open.event.callDepth,
        };
        this._segments.push(seg);
        this._callStack.splice(i, 1);
        break;
      }
    }
  }

  dispose(): void {
    this._onTraceReadyEmitter.dispose();
    this._onEventAddedEmitter.dispose();
  }
}

interface OpenCall {
  event: TraceEvent;
  segmentKey: string;
}
