"""
Code Replay — C++ GDB tracer.

Usage (invoked by the VSCode extension via GDB batch mode):
    gdb --batch -x cpp_tracer.py --args /path/to/compiled_binary

Configuration is passed through environment variables set by recorder.ts:
    CR_MAX_EVENTS   Maximum number of trace events (default 100000)
    CR_SOURCE_DIR   Absolute path of the source directory to trace (user code only)

Each trace event is written as a single JSON line to stdout.
The inferior (C++ program) stdout is redirected to stderr via 'run 1>&2'
to avoid contaminating the JSON event stream.

stderr is used for all GDB diagnostic messages.
"""

import gdb  # type: ignore  (only available inside GDB's Python interpreter)
import sys
import os
import json
import time

# ── Configuration ─────────────────────────────────────────────────────────────
_CR_MAX_EVENTS = int(os.environ.get('CR_MAX_EVENTS', '100000'))
_CR_SOURCE_DIR = os.path.normcase(os.environ.get('CR_SOURCE_DIR', ''))

# ── Real stdout ───────────────────────────────────────────────────────────────
# GDB may redirect sys.stdout; use sys.__stdout__ for our JSON stream.
_real_stdout = sys.__stdout__

# ── Global state ──────────────────────────────────────────────────────────────
_event_id: int = 0
_start_time: float = 0.0


# ── Helpers ───────────────────────────────────────────────────────────────────

def _emit(obj: dict) -> None:
    try:
        _real_stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
        _real_stdout.flush()
    except Exception:
        pass


def _now_ms() -> float:
    return round((time.perf_counter() - _start_time) * 1000.0, 4)


def _repr_safe(val) -> str:
    s = str(val)
    return s if len(s) <= 200 else s[:197] + '...'


def _collect_vars(frame) -> dict:
    """Collect local variables and arguments from the current frame."""
    variables: dict = {}
    try:
        block = frame.block()
        while block is not None:
            for sym in block:
                if sym.name in variables:
                    continue
                if sym.is_variable or sym.is_argument:
                    try:
                        val = frame.read_var(sym.name)
                        variables[sym.name] = _repr_safe(val)
                    except Exception:
                        pass
            if block.is_global or block.is_static:
                break
            try:
                block = block.superblock
            except Exception:
                break
    except Exception:
        pass
    return variables


def _count_frames() -> int:
    """Count the number of frames on the call stack (0-based depth)."""
    depth = 0
    try:
        f = gdb.newest_frame()
        while f is not None:
            depth += 1
            try:
                f = f.older()
            except gdb.error:
                break
    except Exception:
        pass
    return max(0, depth - 1)


def _is_user_file(filename: str) -> bool:
    """Return True if filename is within the user's source directory."""
    if not _CR_SOURCE_DIR:
        return True
    return os.path.normcase(filename).startswith(_CR_SOURCE_DIR)


# ── Core tracing loop ─────────────────────────────────────────────────────────

def do_trace() -> None:
    global _event_id, _start_time

    entry_file = ''
    try:
        progspace = gdb.current_progspace()
        if progspace:
            entry_file = progspace.filename or ''
    except Exception:
        pass

    # Emit config so recorder.ts knows the filter mode
    _emit({
        'type': 'config',
        'userOnly': bool(_CR_SOURCE_DIR),
        'scriptDir': _CR_SOURCE_DIR,
    })

    # ── Set up and run ────────────────────────────────────────────────────────
    try:
        gdb.execute('set breakpoint pending on', to_string=True)
        gdb.execute('set pagination off',        to_string=True)
        gdb.execute('set print frame-info auto', to_string=True)
    except gdb.error:
        pass

    # Break at main so we can start stepping from there
    try:
        gdb.execute('break main', to_string=True)
    except gdb.error:
        _emit({'type': 'error', 'message': 'Could not set breakpoint at main. '
               'Is the binary compiled with -g?'})
        return

    # Redirect inferior stdout to stderr so it doesn't corrupt the JSON stream.
    # C++ program output will appear in the VS Code Output channel (stderr).
    try:
        gdb.execute('run 1>&2', to_string=True)
    except gdb.error as exc:
        _emit({'type': 'error', 'message': f'GDB run failed: {exc}'})
        return

    _start_time = time.perf_counter()

    prev_depth = 0

    # ── Stepping loop ─────────────────────────────────────────────────────────
    while True:
        if _event_id >= _CR_MAX_EVENTS:
            _emit({'type': 'limit_reached', 'max': _CR_MAX_EVENTS})
            break

        # Check the inferior is still alive
        try:
            inferiors = gdb.inferiors()
            if not inferiors:
                break
            inf = inferiors[0]
            if not inf.is_valid() or not inf.threads():
                break
        except Exception:
            break

        # Grab current frame info
        try:
            frame = gdb.selected_frame()
        except gdb.error:
            break

        try:
            sal = frame.find_sal()
        except gdb.error:
            # No source info — skip over this frame
            try:
                gdb.execute('finish', to_string=True)
            except gdb.error:
                try:
                    gdb.execute('next', to_string=True)
                except gdb.error:
                    break
            continue

        if not sal.is_valid() or sal.symtab is None:
            # Not in a source file (runtime startup, libc internals, etc.)
            try:
                gdb.execute('finish', to_string=True)
            except gdb.error:
                try:
                    gdb.execute('next', to_string=True)
                except gdb.error:
                    break
            continue

        try:
            filename = sal.symtab.fullname()
        except Exception:
            filename = sal.symtab.filename or ''

        if not _is_user_file(filename):
            # Outside user source directory — jump out of this call
            try:
                gdb.execute('finish', to_string=True)
            except gdb.error:
                try:
                    gdb.execute('next', to_string=True)
                except gdb.error:
                    break
            continue

        line_num = sal.line
        try:
            func_name = frame.name() or '(unknown)'
        except Exception:
            func_name = '(unknown)'

        depth = _count_frames()
        variables = _collect_vars(frame)
        ts = _now_ms()

        # Classify event type based on depth transitions
        if depth > prev_depth:
            event_type = 'call'
        elif depth < prev_depth:
            event_type = 'return'
        else:
            event_type = 'line'

        _emit({
            'id': _event_id,
            'timestamp': ts,
            'type': event_type,
            'file': filename,
            'line': line_num,
            'functionName': func_name,
            'variables': variables,
            'callDepth': depth,
        })

        _event_id += 1
        prev_depth = depth

        # Advance one source line (step enters called functions)
        try:
            gdb.execute('step', to_string=True)
        except gdb.error as exc:
            err = str(exc)
            if any(kw in err for kw in ('No stack', 'not stopped', 'Cannot', 'exited')):
                break
            break

    # ── Done ──────────────────────────────────────────────────────────────────
    _emit({
        'type': 'done',
        'totalEvents': _event_id,
        'durationMs': _now_ms(),
        'entryFile': entry_file,
        'userOnly': bool(_CR_SOURCE_DIR),
    })


# ── Entry point ───────────────────────────────────────────────────────────────
try:
    do_trace()
except Exception as exc:
    _emit({'type': 'error', 'message': str(exc)})
