/**
 * Code Recorder — JavaScript/Node.js tracer.
 *
 * Usage (invoked by the VSCode extension via --require):
 *   node --require ./js_tracer.js <target_script.js> [--max-events N]
 *
 * Strategy:
 *   - Intercept Node's module compilation to inject instrumentation.
 *   - Use a lightweight regex-based function wrapper rather than a full
 *     AST parser to avoid runtime dependencies.
 *   - Each trace event is written as a JSON line to stdout.
 *   - The final line is a JSON object with key "done" and summary info.
 *
 * Note: stderr is used for diagnostics so it doesn't contaminate the
 * JSON event stream on stdout.
 */

'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');

// ── configuration ────────────────────────────────────────────────────────────
const MAX_EVENTS_DEFAULT = 100_000;
let maxEvents = MAX_EVENTS_DEFAULT;

// Parse --max-events from argv before the target script sees it
{
  const idx = process.argv.indexOf('--max-events');
  if (idx !== -1 && process.argv[idx + 1]) {
    maxEvents = parseInt(process.argv[idx + 1], 10) || MAX_EVENTS_DEFAULT;
    process.argv.splice(idx, 2);
  }
}

// ── global state ─────────────────────────────────────────────────────────────
let eventId = 0;
let startTime = process.hrtime.bigint();
let stopped = false;
const tracerFile = path.resolve(__filename);

function nowMs() {
  return Number(process.hrtime.bigint() - startTime) / 1e6;
}

function reprSafe(value) {
  try {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return `[Function: ${value.name || '(anonymous)'}]`;
    if (typeof value === 'object') {
      const s = JSON.stringify(value);
      return s.length > 200 ? s.slice(0, 197) + '...' : s;
    }
    return String(value);
  } catch (_) {
    return '<repr error>';
  }
}

function emit(event) {
  if (stopped) return;
  try {
    process.stdout.write(JSON.stringify(event) + '\n');
  } catch (_) {}
}

function checkLimit() {
  if (eventId >= maxEvents) {
    stopped = true;
    emit({ type: 'limit_reached', max: maxEvents });
    return true;
  }
  return false;
}

// ── instrumentation ───────────────────────────────────────────────────────────

/**
 * Wraps a function so that call/return events are emitted.
 * callDepth is tracked per-module via a shared counter object.
 */
function wrapFunction(fn, funcName, absFile, depthRef) {
  if (typeof fn !== 'function') return fn;
  // Avoid double-wrapping
  if (fn.__crWrapped) return fn;

  const wrapped = function (...args) {
    if (stopped || checkLimit()) {
      return fn.apply(this, args);
    }

    const callDepth = depthRef.depth;
    depthRef.depth++;

    // Collect simple argument reprs as initial "variables"
    const variables = {};
    const paramNames = getParamNames(fn);
    args.forEach((a, i) => {
      const name = paramNames[i] || `arg${i}`;
      variables[name] = reprSafe(a);
    });

    emit({
      id: eventId++,
      timestamp: nowMs(),
      type: 'call',
      file: absFile,
      line: getFunctionLine(fn),
      functionName: funcName || fn.name || '(anonymous)',
      variables,
      callDepth,
    });

    let result;
    try {
      result = fn.apply(this, args);
    } catch (err) {
      if (!stopped && !checkLimit()) {
        emit({
          id: eventId++,
          timestamp: nowMs(),
          type: 'exception',
          file: absFile,
          line: getFunctionLine(fn),
          functionName: funcName || fn.name || '(anonymous)',
          variables: {},
          returnValue: `${err.name}: ${err.message}`,
          callDepth,
        });
      }
      depthRef.depth = Math.max(0, depthRef.depth - 1);
      throw err;
    }

    depthRef.depth = Math.max(0, depthRef.depth - 1);

    if (!stopped && !checkLimit()) {
      // Handle Promise returns
      if (result && typeof result.then === 'function') {
        return result.then(
          (resolved) => {
            emit({
              id: eventId++,
              timestamp: nowMs(),
              type: 'return',
              file: absFile,
              line: getFunctionLine(fn),
              functionName: funcName || fn.name || '(anonymous)',
              variables: {},
              returnValue: reprSafe(resolved),
              callDepth,
            });
            return resolved;
          },
          (err) => {
            emit({
              id: eventId++,
              timestamp: nowMs(),
              type: 'exception',
              file: absFile,
              line: getFunctionLine(fn),
              functionName: funcName || fn.name || '(anonymous)',
              variables: {},
              returnValue: `${err.name}: ${err.message}`,
              callDepth,
            });
            throw err;
          },
        );
      }

      emit({
        id: eventId++,
        timestamp: nowMs(),
        type: 'return',
        file: absFile,
        line: getFunctionLine(fn),
        functionName: funcName || fn.name || '(anonymous)',
        variables: {},
        returnValue: reprSafe(result),
        callDepth,
      });
    }

    return result;
  };

  wrapped.__crWrapped = true;
  wrapped.__crOriginal = fn;
  Object.defineProperty(wrapped, 'name', { value: fn.name || funcName });
  return wrapped;
}

/** Extract parameter names from function source (best-effort). */
function getParamNames(fn) {
  try {
    const src = fn.toString();
    const m = src.match(/^(?:function\s*\w*)?\s*\(([^)]*)\)/);
    if (!m) return [];
    return m[1]
      .split(',')
      .map((p) => p.trim().replace(/[=\s].*$/, '').replace(/^\.\.\./, ''))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

/** Get best-guess line number from function (only available in V8 via stack trick). */
function getFunctionLine(fn) {
  try {
    const err = {};
    const orig = Error.prepareStackTrace;
    Error.prepareStackTrace = (_, stack) => stack;
    Error.captureStackTrace(err, fn);
    const stack = err.stack;
    Error.prepareStackTrace = orig;
    if (Array.isArray(stack) && stack[0]) {
      return stack[0].getLineNumber() || 0;
    }
  } catch (_) {}
  return 0;
}

/**
 * Walk an exported object and wrap all function properties.
 * Also wraps class methods via prototype.
 */
function instrumentExports(exports, absFile, depthRef) {
  if (!exports || typeof exports !== 'object' && typeof exports !== 'function') {
    return exports;
  }

  const seen = new WeakSet();

  function walk(obj, depth) {
    if (depth > 3 || !obj || seen.has(obj)) return;
    seen.add(obj);

    const proto = Object.getPrototypeOf(obj);
    if (proto && proto !== Object.prototype && proto !== Function.prototype) {
      walk(proto, depth + 1);
    }

    for (const key of Object.getOwnPropertyNames(obj)) {
      if (key === 'constructor' || key.startsWith('__')) continue;
      try {
        const desc = Object.getOwnPropertyDescriptor(obj, key);
        if (!desc || !desc.writable || !desc.configurable) continue;
        const val = obj[key];
        if (typeof val === 'function' && !val.__crWrapped) {
          obj[key] = wrapFunction(val, key, absFile, depthRef);
        }
      } catch (_) {}
    }
  }

  // If exports is itself a function (class / factory), wrap it too
  if (typeof exports === 'function' && !exports.__crWrapped) {
    const wrapped = wrapFunction(exports, exports.name || '(module)', absFile, depthRef);
    // Copy static properties
    for (const key of Object.getOwnPropertyNames(exports)) {
      if (key === 'length' || key === 'prototype' || key === 'name') continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(exports, key));
      } catch (_) {}
    }
    if (exports.prototype) {
      walk(exports.prototype, 0);
    }
    return wrapped;
  }

  walk(exports, 0);
  return exports;
}

// ── Module hooking ────────────────────────────────────────────────────────────

const originalCompile = Module.prototype._compile;

Module.prototype._compile = function (content, filename) {
  const absFile = path.resolve(filename);

  // Skip node_modules, built-ins, and the tracer itself
  if (
    absFile === tracerFile ||
    absFile.includes('node_modules') ||
    absFile.includes('node:') ||
    filename.startsWith('node:')
  ) {
    return originalCompile.call(this, content, filename);
  }

  originalCompile.call(this, content, filename);

  // After compilation, instrument exported functions
  const depthRef = { depth: 0 };
  try {
    this.exports = instrumentExports(this.exports, absFile, depthRef);
  } catch (err) {
    process.stderr.write(`[code-recorder] Failed to instrument ${absFile}: ${err.message}\n`);
  }

  return this.exports;
};

// ── Process exit ──────────────────────────────────────────────────────────────

function onExit() {
  const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  process.stdout.write(
    JSON.stringify({
      type: 'done',
      totalEvents: eventId,
      durationMs: Math.round(durationMs * 100) / 100,
      entryFile: process.argv[1] ? path.resolve(process.argv[1]) : '',
    }) + '\n',
  );
}

process.on('exit', onExit);
process.on('uncaughtException', (err) => {
  emit({
    id: eventId++,
    timestamp: nowMs(),
    type: 'exception',
    file: process.argv[1] || '',
    line: 0,
    functionName: '(uncaught)',
    variables: {},
    returnValue: `${err.name}: ${err.message}`,
    callDepth: 0,
  });
  // Re-throw to let Node print the stack and exit with code 1
  throw err;
});
