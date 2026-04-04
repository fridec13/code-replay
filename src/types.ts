export type TraceEventType = 'call' | 'line' | 'return' | 'exception';

export interface TraceEvent {
  id: number;
  /** Milliseconds from execution start */
  timestamp: number;
  type: TraceEventType;
  /** Absolute file path */
  file: string;
  /** 1-based line number */
  line: number;
  functionName: string;
  /** Variable name -> string representation */
  variables: Record<string, string>;
  returnValue?: string;
  /** Call stack depth (0 = top level) */
  callDepth: number;
}

export interface FunctionSegment {
  /** Unique key: file + ':' + name + ':' + startEventId */
  key: string;
  name: string;
  file: string;
  startEventId: number;
  endEventId: number;
  startTimestamp: number;
  endTimestamp: number;
  callDepth: number;
}

export interface ExecutionTrace {
  /** Absolute path of the entry file */
  entryFile: string;
  /** ISO timestamp of when the recording started */
  recordedAt: string;
  events: TraceEvent[];
  segments: FunctionSegment[];
  /** Total wall-clock duration in ms */
  durationMs: number;
  /**
   * Index of the first event that belongs to the entry file (user code).
   * Events before this index are from Python stdlib (runpy, importlib, etc.)
   * and are only present when recorded with --all-files.
   * Replay defaults to starting from this index.
   */
  userCodeStartEventId: number;
  /** Whether the trace was recorded with --user-only (default) */
  userOnly: boolean;
}

export type PlaybackState = 'idle' | 'playing' | 'paused';

export type StartMode = 'user' | 'all';

export interface PlaybackStatus {
  state: PlaybackState;
  currentEventId: number;
  speed: number;
  totalEvents: number;
  startMode: StartMode;
  userCodeStartEventId: number;
}

export type SpeedOption = 0.01 | 0.1 | 0.5 | 1 | 2 | 5 | 10;
export const SPEED_OPTIONS: SpeedOption[] = [0.01, 0.1, 0.5, 1, 2, 5, 10];

/** Messages sent from extension host to the Timeline WebView */
export type ExtensionToWebviewMessage =
  | { type: 'traceLoaded'; trace: ExecutionTrace }
  | { type: 'playbackStatus'; status: PlaybackStatus }
  | { type: 'seekTo'; eventId: number }
  | { type: 'cleared' };

/** Messages sent from the Timeline WebView to the extension host */
export type WebviewToExtensionMessage =
  | { type: 'playPause' }
  | { type: 'stop' }
  | { type: 'setSpeed'; speed: SpeedOption }
  | { type: 'seekTo'; eventId: number }
  | { type: 'seekToSegment'; segmentKey: string }
  | { type: 'setStartMode'; mode: StartMode }
  | { type: 'ready' };
