import * as vscode from 'vscode';
import * as path from 'path';
import { TraceEvent } from './types';

const FLASH_DURATION_MS = 350;
const VAR_DISPLAY_MAX = 6;

/**
 * Applies visual decorations to the VSCode editor as events are replayed:
 *
 *  1. Opens the correct file automatically when execution crosses file boundaries.
 *  2. Highlights the current execution line with a blue background.
 *  3. On `call` events, briefly flashes the function-definition line in gold.
 *  4. Shows local variables as dimmed inline text after the current line.
 */
export class EditorDecorator implements vscode.Disposable {
  // Active-line highlight (blue background, always visible while replaying)
  private readonly _activeLineType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('terminal.ansiBlue'),
  });

  // Flash decoration for function-call lines (gold, fades after FLASH_DURATION_MS)
  private readonly _flashType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorWarning.foreground'),
  });

  // Inline variable ghost text (after the line content)
  private readonly _varType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
    },
  });

  private _flashTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastFile: string | null = null;

  clear(): void {
    this._clearAll();
    this._lastFile = null;
  }

  /**
   * Apply decorations for the given trace event.
   * Must be called from the extension host (synchronous VSCode API calls).
   */
  applyEvent(event: TraceEvent): void {
    this._ensureFileOpen(event.file).then((editor) => {
      if (!editor) return;
      this._decorate(editor, event);
    });
  }

  private async _ensureFileOpen(absFile: string): Promise<vscode.TextEditor | null> {
    if (!absFile) return null;

    // If the file is already showing in the active editor, use it directly
    const active = vscode.window.activeTextEditor;
    if (active && this._normalizePath(active.document.uri.fsPath) === this._normalizePath(absFile)) {
      return active;
    }

    // Check if the file is already open in any visible editor
    for (const editor of vscode.window.visibleTextEditors) {
      if (this._normalizePath(editor.document.uri.fsPath) === this._normalizePath(absFile)) {
        await vscode.window.showTextDocument(editor.document, {
          viewColumn: editor.viewColumn,
          preserveFocus: true,
          preview: false,
        });
        return editor;
      }
    }

    // Open the file (new tab or existing tab)
    try {
      const uri = vscode.Uri.file(absFile);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preserveFocus: true,
        preview: true,
        viewColumn: vscode.ViewColumn.One,
      });
      this._lastFile = absFile;
      return editor;
    } catch {
      return null;
    }
  }

  private _decorate(editor: vscode.TextEditor, event: TraceEvent): void {
    const lineIndex = Math.max(0, event.line - 1); // convert 1-based to 0-based
    const lineRange = editor.document.lineAt(lineIndex).range;

    // ── Active line highlight ─────────────────────────────────────────────────
    editor.setDecorations(this._activeLineType, [lineRange]);

    // Reveal the line in the viewport
    editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    // ── Flash for function call ───────────────────────────────────────────────
    if (event.type === 'call') {
      editor.setDecorations(this._flashType, [lineRange]);
      this._clearFlashAfter();
    } else {
      editor.setDecorations(this._flashType, []);
    }

    // ── Inline variable ghost text ────────────────────────────────────────────
    const varEntries = Object.entries(event.variables).slice(0, VAR_DISPLAY_MAX);
    if (varEntries.length > 0) {
      const varText = varEntries.map(([k, v]) => `${k}=${v}`).join('  ');
      const endPos = lineRange.end;
      const varDecoration: vscode.DecorationOptions = {
        range: new vscode.Range(endPos, endPos),
        renderOptions: {
          after: {
            contentText: `   // ${varText}`,
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
          },
        },
      };
      editor.setDecorations(this._varType, [varDecoration]);
    } else {
      editor.setDecorations(this._varType, []);
    }
  }

  private _clearFlashAfter(): void {
    if (this._flashTimer) clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(this._flashType, []);
      }
      this._flashTimer = null;
    }, FLASH_DURATION_MS);
  }

  private _clearAll(): void {
    if (this._flashTimer) {
      clearTimeout(this._flashTimer);
      this._flashTimer = null;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this._activeLineType, []);
      editor.setDecorations(this._flashType, []);
      editor.setDecorations(this._varType, []);
    }
  }

  private _normalizePath(p: string): string {
    return path.normalize(p).toLowerCase();
  }

  dispose(): void {
    this._clearAll();
    this._activeLineType.dispose();
    this._flashType.dispose();
    this._varType.dispose();
  }
}
