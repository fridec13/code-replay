import * as vscode from 'vscode';
import {
  TraceEvent,
  ExecutionTrace,
  PlaybackState,
  PlaybackStatus,
  SpeedOption,
  StartMode,
  SPEED_OPTIONS,
} from './types';
import { EventStore } from './eventStore';
import { EditorDecorator } from './editorDecorator';

const TICK_INTERVAL_MS = 16; // ~60fps

export class ReplayController implements vscode.Disposable {
  private _state: PlaybackState = 'idle';
  private _currentEventId = 0;
  private _speed: SpeedOption = 1;
  private _startMode: StartMode = 'user';
  private _trace: ExecutionTrace | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Step-rate playback clock.
   * 1x = 1 step per second  (msPerStep = 1000)
   * 2x = 2 steps per second (msPerStep = 500)
   * 0.1x = 1 step per 10 s  (msPerStep = 10000)
   */
  private _msAccumulated = 0;
  private _lastWallTime = 0;

  private readonly _onStatusChanged = new vscode.EventEmitter<PlaybackStatus>();
  readonly onStatusChanged: vscode.Event<PlaybackStatus> = this._onStatusChanged.event;

  private readonly _subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly _store: EventStore,
    private readonly _decorator: EditorDecorator,
  ) {
    this._subscriptions.push(
      _store.onTraceReady((trace) => this.loadTrace(trace)),
    );
  }

  // ── public API ──────────────────────────────────────────────────────────────

  get state(): PlaybackState {
    return this._state;
  }

  get currentEventId(): number {
    return this._currentEventId;
  }

  get speed(): SpeedOption {
    return this._speed;
  }

  get startMode(): StartMode {
    return this._startMode;
  }

  get availableSpeeds(): SpeedOption[] {
    return SPEED_OPTIONS;
  }

  loadTrace(trace: ExecutionTrace): void {
    this._stopTimer();
    this._trace = trace;
    this._currentEventId = this._resolveStartEventId();
    this._msAccumulated = 0;
    this._state = 'paused';
    this._applyEvent(trace.events[this._currentEventId]);
    this._emitStatus();
  }

  play(): void {
    if (!this._trace || this._trace.events.length === 0) return;
    if (this._state === 'playing') return;

    // If at or past the end, rewind to the appropriate start
    if (this._currentEventId >= this._trace.events.length) {
      this._currentEventId = this._resolveStartEventId();
    }

    this._state = 'playing';
    this._lastWallTime = Date.now();
    this._msAccumulated = 0;
    this._startTimer();
    this._emitStatus();
  }

  pause(): void {
    if (this._state !== 'playing') return;
    this._state = 'paused';
    this._stopTimer();
    this._emitStatus();
  }

  playPause(): void {
    if (this._state === 'playing') {
      this.pause();
    } else {
      this.play();
    }
  }

  stop(): void {
    this._stopTimer();
    this._state = 'idle';
    this._currentEventId = this._resolveStartEventId();
    this._msAccumulated = 0;
    this._decorator.clear();
    this._emitStatus();
  }

  setSpeed(speed: SpeedOption): void {
    this._speed = speed;
    if (this._state === 'playing') {
      // Reset accumulator so the new speed takes effect immediately
      this._msAccumulated = 0;
      this._lastWallTime = Date.now();
    }
    this._emitStatus();
  }

  setStartMode(mode: StartMode): void {
    const wasPlaying = this._state === 'playing';
    this._stopTimer();
    this._startMode = mode;
    this._currentEventId = this._resolveStartEventId();
    this._msAccumulated = 0;
    this._applyEvent(this._trace?.events[this._currentEventId]);
    if (wasPlaying) {
      this._state = 'playing';
      this._lastWallTime = Date.now();
      this._startTimer();
    } else {
      this._state = this._trace ? 'paused' : 'idle';
    }
    this._emitStatus();
  }

  seekToEvent(eventId: number): void {
    if (!this._trace) return;
    const clamped = Math.max(
      0,
      Math.min(eventId, this._trace.events.length - 1),
    );
    const wasPlaying = this._state === 'playing';
    this._stopTimer();

    this._currentEventId = clamped;
    this._msAccumulated = 0;
    this._applyEvent(this._trace.events[clamped]);

    if (wasPlaying) {
      this._state = 'playing';
      this._lastWallTime = Date.now();
      this._startTimer();
    } else {
      this._state = 'paused';
    }
    this._emitStatus();
  }

  seekToSegment(segmentKey: string): void {
    const seg = this._store.getSegment(segmentKey);
    if (seg) {
      this.seekToEvent(seg.startEventId);
    }
  }

  // ── timer / tick ────────────────────────────────────────────────────────────

  private _startTimer(): void {
    this._timer = setInterval(() => this._tick(), TICK_INTERVAL_MS);
  }

  private _stopTimer(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private _tick(): void {
    if (!this._trace || this._state !== 'playing') return;

    const now = Date.now();
    const wallElapsed = now - this._lastWallTime;
    this._lastWallTime = now;

    // Step-rate model: msPerStep = 1000 / speed
    // 1x  → 1000 ms/step (1 event per second)
    // 2x  → 500  ms/step
    // 0.1x → 10000 ms/step
    const msPerStep = 1000 / this._speed;
    this._msAccumulated += wallElapsed;

    const events = this._trace.events;
    let dispatched = 0;

    while (
      this._currentEventId < events.length &&
      this._msAccumulated >= msPerStep
    ) {
      this._applyEvent(events[this._currentEventId]);
      this._currentEventId++;
      this._msAccumulated -= msPerStep;
      dispatched++;

      // Cap per-tick dispatch to avoid UI lockup at very high speeds
      if (dispatched >= 50) {
        this._msAccumulated = 0;
        break;
      }
    }

    if (this._currentEventId >= events.length) {
      this._state = 'paused';
      this._stopTimer();
    }

    if (dispatched > 0 || this._currentEventId >= events.length) {
      this._emitStatus();
    }
  }

  private _resolveStartEventId(): number {
    if (!this._trace) return 0;
    if (this._startMode === 'user') {
      return this._trace.userCodeStartEventId;
    }
    return 0;
  }

  private _applyEvent(event: TraceEvent | undefined): void {
    if (!event) return;
    this._decorator.applyEvent(event);
  }

  private _emitStatus(): void {
    this._onStatusChanged.fire(this._getStatus());
  }

  private _getStatus(): PlaybackStatus {
    return {
      state: this._state,
      currentEventId: this._currentEventId,
      speed: this._speed,
      totalEvents: this._trace?.events.length ?? 0,
      startMode: this._startMode,
      userCodeStartEventId: this._trace?.userCodeStartEventId ?? 0,
    };
  }

  dispose(): void {
    this._stopTimer();
    this._subscriptions.forEach((d) => d.dispose());
    this._onStatusChanged.dispose();
  }
}
