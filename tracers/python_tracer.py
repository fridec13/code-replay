"""
Code Recorder — Python tracer.

Usage (invoked by the VSCode extension):
    python python_tracer.py <target_script.py> [args...]
                            [--max-events N]
                            [--all-files]      # trace stdlib too (default: user code only)

Each trace event is written as a single JSON line to stdout.
The final line is a JSON object with key "done" and summary info.

stderr is used for all diagnostic/error messages so it does not
contaminate the JSON event stream.
"""

import sys
import os
import json
import time
import argparse
import runpy
import traceback as tb

# ── configuration ────────────────────────────────────────────────────────────
DEFAULT_MAX_EVENTS = 100_000

# ── global state ─────────────────────────────────────────────────────────────
_event_id = 0
_start_time: float = 0.0
_max_events: int = DEFAULT_MAX_EVENTS
_depth: int = 0
_call_stack: list[tuple[str, str]] = []   # (file, funcname)
_tracer_file = os.path.abspath(__file__)
_stopped = False
_user_only: bool = True      # set in main()
_script_dir: str = ''        # set in main()

# Save the real stdout at import time; _emit always uses this directly
# so that our CaptureWriter (installed later) never causes recursion.
_real_stdout = sys.stdout


def _repr_safe(value) -> str:
    """Return a short, safe string representation of a value."""
    try:
        r = repr(value)
        return r if len(r) <= 200 else r[:197] + "..."
    except Exception:
        return "<repr error>"


def _collect_locals(frame) -> dict[str, str]:
    """Collect local variables, excluding dunder names."""
    result: dict[str, str] = {}
    try:
        for k, v in frame.f_locals.items():
            if k.startswith("__"):
                continue
            result[k] = _repr_safe(v)
    except Exception:
        pass
    return result


def _emit(event: dict) -> None:
    """Write a single event JSON line to the real stdout immediately."""
    try:
        _real_stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        _real_stdout.flush()
    except Exception:
        pass


class _CaptureWriter:
    """Replaces sys.stdout during script execution to intercept print() calls."""

    def __init__(self) -> None:
        self._buf = ""

    def write(self, text: str) -> int:
        if not text:
            return 0
        self._buf += text
        # Flush complete lines
        while "\n" in self._buf:
            idx = self._buf.index("\n")
            line_text = self._buf[:idx]
            self._buf = self._buf[idx + 1:]
            if line_text:
                self._emit_output(line_text)
        return len(text)

    def flush(self) -> None:
        if self._buf.strip():
            self._emit_output(self._buf)
            self._buf = ""

    def _emit_output(self, text: str) -> None:
        ts = round((time.perf_counter() - _start_time) * 1000.0, 4)
        _emit({
            "type": "output",
            "eventId": max(0, _event_id - 1),
            "text": text,
            "timestamp": ts,
        })

    # Delegate attribute accesses needed by some libraries
    def fileno(self) -> int:
        return _real_stdout.fileno()

    def isatty(self) -> bool:
        return False

    @property
    def encoding(self) -> str:
        return getattr(_real_stdout, "encoding", "utf-8")


def _tracer(frame, event, arg):
    global _event_id, _depth, _stopped

    if _stopped:
        return None

    filename = frame.f_code.co_filename

    # Always skip the tracer itself and frozen/built-in modules
    if filename == _tracer_file:
        return _tracer
    if filename.startswith("<"):
        return _tracer

    abs_file = os.path.abspath(filename)

    # In user-only mode, skip files outside the script's directory
    if _user_only and not abs_file.startswith(_script_dir):
        return _tracer

    if _event_id >= _max_events:
        _stopped = True
        _emit({"type": "limit_reached", "max": _max_events})
        sys.settrace(None)
        return None

    ts = (time.perf_counter() - _start_time) * 1000.0
    func_name = frame.f_code.co_name
    line = frame.f_lineno

    if event == "call":
        _depth += 1
        _call_stack.append((abs_file, func_name))
        ev = {
            "id": _event_id,
            "timestamp": round(ts, 4),
            "type": "call",
            "file": abs_file,
            "line": line,
            "functionName": func_name,
            "variables": _collect_locals(frame),
            "callDepth": _depth - 1,
        }
        _emit(ev)
        _event_id += 1
        return _tracer

    if event == "line":
        ev = {
            "id": _event_id,
            "timestamp": round(ts, 4),
            "type": "line",
            "file": abs_file,
            "line": line,
            "functionName": func_name,
            "variables": _collect_locals(frame),
            "callDepth": max(0, _depth - 1),
        }
        _emit(ev)
        _event_id += 1
        return _tracer

    if event == "return":
        return_repr = _repr_safe(arg) if arg is not None else "None"
        ev = {
            "id": _event_id,
            "timestamp": round(ts, 4),
            "type": "return",
            "file": abs_file,
            "line": line,
            "functionName": func_name,
            "variables": _collect_locals(frame),
            "returnValue": return_repr,
            "callDepth": max(0, _depth - 1),
        }
        _emit(ev)
        _event_id += 1
        if _call_stack and _call_stack[-1] == (abs_file, func_name):
            _call_stack.pop()
        _depth = max(0, _depth - 1)
        return _tracer

    if event == "exception":
        exc_type, exc_value, _ = arg
        ev = {
            "id": _event_id,
            "timestamp": round(ts, 4),
            "type": "exception",
            "file": abs_file,
            "line": line,
            "functionName": func_name,
            "variables": _collect_locals(frame),
            "returnValue": f"{exc_type.__name__}: {exc_value}",
            "callDepth": max(0, _depth - 1),
        }
        _emit(ev)
        _event_id += 1
        return _tracer

    return _tracer


def main():
    global _start_time, _max_events, _user_only, _script_dir

    parser = argparse.ArgumentParser(
        description="Code Recorder Python tracer",
        add_help=False,
    )
    parser.add_argument("script", help="Target Python script to trace")
    parser.add_argument("--max-events", type=int, default=DEFAULT_MAX_EVENTS)
    parser.add_argument(
        "--all-files",
        action="store_true",
        default=False,
        help="Trace stdlib and site-packages too (default: user code only)",
    )
    # Remaining args are forwarded to the target script
    args, remaining = parser.parse_known_args()

    _max_events = args.max_events
    _user_only = not args.all_files

    script_path = os.path.abspath(args.script)
    _script_dir = os.path.dirname(script_path) + os.sep

    if not os.path.isfile(script_path):
        _emit({"type": "error", "message": f"File not found: {script_path}"})
        sys.exit(1)

    # Emit the active filter mode so the extension knows
    _emit({"type": "config", "userOnly": _user_only, "scriptDir": _script_dir})

    # Patch sys.argv so the target script sees its own args
    sys.argv = [script_path] + remaining

    # Add the script's directory to sys.path so relative imports work
    script_dir_no_sep = os.path.dirname(script_path)
    if script_dir_no_sep not in sys.path:
        sys.path.insert(0, script_dir_no_sep)

    _start_time = time.perf_counter()

    # Replace stdout so print() calls are captured as output events.
    # _emit() always writes to _real_stdout, so there is no recursion.
    sys.stdout = _CaptureWriter()

    sys.settrace(_tracer)
    try:
        runpy.run_path(script_path, run_name="__main__")
    except SystemExit:
        pass
    except Exception:
        sys.settrace(None)
        _emit({"type": "error", "message": tb.format_exc()})
    finally:
        sys.settrace(None)
        # Flush any buffered output and restore real stdout
        if isinstance(sys.stdout, _CaptureWriter):
            sys.stdout.flush()
        sys.stdout = _real_stdout

    duration_ms = round((time.perf_counter() - _start_time) * 1000.0, 2)
    _emit({
        "type": "done",
        "totalEvents": _event_id,
        "durationMs": duration_ms,
        "entryFile": script_path,
        "userOnly": _user_only,
    })


if __name__ == "__main__":
    main()
