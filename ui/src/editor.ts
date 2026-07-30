// Editor: a single Monaco instance whose document is swapped when the
// active tab changes. Editor-local state (cursor, selection) lives here.
//
// Diagnostics flow:
//   setDiagnostics(items) -> monaco.editor.setModelMarkers with positions
//   from LSP-style (line, character) ranges.

import { ensureMonacoEnvironment } from "./monacoEnv";
import * as monaco from "monaco-editor";
// Relative path bypasses monaco-editor package "exports" (blocks CSS subpaths).
import "../node_modules/monaco-editor/min/vs/editor/editor.main.css";
import {
  attachMarkupDiagnostics,
  clearMarkupMarkers,
  applyMarkupDiagnostics,
} from "./markupDiagnostics";
import {
  attachAutocomplete,
  tryAcceptInlineSuggestion,
  type AutocompleteBinding,
} from "./autocomplete";

const SEARCH_MATCH_STYLE_ID = "h1code-monaco-search-match-style";

function ensureSearchMatchStyles(): void {
  if (document.getElementById(SEARCH_MATCH_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = SEARCH_MATCH_STYLE_ID;
  style.textContent = `
#editor .monaco-search-match,
.monaco-editor .monaco-search-match {
  background-color: rgba(234, 156, 52, 0.45) !important;
  outline: 1px solid rgba(234, 156, 52, 0.7);
}
`;
  document.head.appendChild(style);
}

export interface DiagnosticItem {
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code: string | null;
  source: string | null;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** Minimal stand-in for the former CodeMirror EditorView surface used by main.ts. */
export interface EditorViewShim {
  requestMeasure(): void;
}

export interface EditorBinding {
  setDoc(text: string, filePath: string): void;
  getDoc(): string;
  focus(): void;
  view: EditorViewShim;
  /** Tear down the view (HMR / remount). Safe to call more than once. */
  destroy(): void;
  /** Push the diagnostic set for the currently-displayed doc. */
  setDiagnostics(items: DiagnosticItem[]): void;
  /**
   * Move caret to a 1-based (line, col); col is 1-based to match Problems UI.
   * When endCol is provided (1-based, exclusive), select and decorate that span
   * with a find-match highlight (search result navigation).
   */
  jumpTo(line: number, col: number, endCol?: number): void;
  /** Reload FIM autocomplete settings from `.h1code/settings.toml`. */
  reloadAutocompleteSettings(): Promise<void>;
}

const INDENT_UNIT = "    ";
const TAB_SIZE = 4;
const MARKER_OWNER = "h1code";

// Above this size (in characters) we open files without language highlighting.
const LARGE_FILE_PLAIN_THRESHOLD = 1_000_000;

const THEME_NAME = "h1code-dark";

/** Singleton so Vite HMR / remount cannot leave two live editors. */
let mountedEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let resizeObserver: ResizeObserver | null = null;
let mountedAutocomplete: AutocompleteBinding | null = null;

function destroyMountedEditor() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  mountedAutocomplete?.dispose();
  mountedAutocomplete = null;
  if (mountedEditor) {
    mountedEditor.dispose();
    mountedEditor = null;
  }
}

/** Destroy the live editor, if any. Used by Vite HMR dispose. */
export function destroyEditor() {
  destroyMountedEditor();
}

function languageForPath(filePath: string, plain: boolean): string {
  if (plain) return "plaintext";
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".html":
    case ".htm":
      return "html";
    case ".css":
      return "css";
    case ".py":
      return "python";
    default:
      return "plaintext";
  }
}

function countColumns(text: string, tabSize: number): number {
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") col += tabSize - (col % tabSize);
    else col += 1;
  }
  return col;
}

function spacesForColumns(columns: number): string {
  return " ".repeat(Math.max(0, columns));
}

function defineH1codeTheme(): void {
  monaco.editor.defineTheme(THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1e1e1e",
      "editor.foreground": "#d4d4d4",
      "editorCursor.foreground": "#aeafad",
      // Faint accent tint — must stay visually distinct from selection (#264f78).
      "editor.lineHighlightBackground": "#007ACC1A",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#264f7880",
      "editorGutter.background": "#1e1e1e",
      "editorLineNumber.foreground": "#5a5a5a",
      "editorLineNumber.activeForeground": "#8e8e93",
      "editorWidget.background": "#252526",
      "editorWidget.border": "#3c3c3c",
      // Squiggly underlines use border vars — empty border = invisible markers.
      "editorError.foreground": "#f14c4c",
      "editorError.border": "#f14c4c",
      "editorWarning.foreground": "#cca700",
      "editorWarning.border": "#cca700",
      "editorInfo.foreground": "#3794ff",
      "editorInfo.border": "#3794ff",
      "editorHint.foreground": "#eeeeee",
      "editorHint.border": "#eeeeee",
    },
  });
}

function looksLikeBracketPair(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): boolean {
  if (position.column < 2) return false;
  const around = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: position.column - 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column + 1,
  });
  return /\(\)|\[\]|\{\}/.test(around);
}

/**
 * Tab: insert indent-unit whitespace at the cursor when there is no selection
 * and the caret is not at column 0. Whole-line indent only when there is a
 * selection or the caret is at the start of the line.
 */
function runInsertOrIndentTab(editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel();
  if (!model || model.isDisposed()) return;
  const sels = editor.getSelections() ?? [];
  const indentWholeLine = sels.some((sel) => {
    if (!sel.isEmpty()) return true;
    return sel.getPosition().column === 1;
  });
  if (indentWholeLine) {
    editor.trigger("keyboard", "editor.action.indentLines", null);
    return;
  }
  editor.executeEdits("h1code-tab", [
    {
      range: editor.getSelection()!,
      text: INDENT_UNIT,
      forceMoveMarkers: true,
    },
  ]);
}

/**
 * Enter: preserve/continue indent; after a line-merge / mid-line split, do not
 * let a weaker indent strip leading whitespace that already belongs to the
 * text moving onto the new line.
 */
function runInsertNewlinePreserveLineIndent(
  editor: monaco.editor.IStandaloneCodeEditor
): void {
  const model = editor.getModel();
  if (!model || model.isDisposed()) return;

  const sel = editor.getSelection();
  if (!sel) return;

  // Bracket-pair explode: insert blank line with extra indent between the pair.
  if (sel.isEmpty() && looksLikeBracketPair(model, sel.getPosition())) {
    const pos = sel.getPosition();
    const lineText = model.getLineContent(pos.lineNumber);
    const lead = /^\s*/.exec(lineText)![0];
    const baseIndent = countColumns(lead, TAB_SIZE);
    const inner = spacesForColumns(baseIndent + TAB_SIZE);
    const outer = spacesForColumns(baseIndent);
    const range = new monaco.Range(
      pos.lineNumber,
      pos.column - 1,
      pos.lineNumber,
      pos.column + 1
    );
    const open = model.getValueInRange({
      startLineNumber: pos.lineNumber,
      startColumn: pos.column - 1,
      endLineNumber: pos.lineNumber,
      endColumn: pos.column,
    });
    const close = model.getValueInRange({
      startLineNumber: pos.lineNumber,
      startColumn: pos.column,
      endLineNumber: pos.lineNumber,
      endColumn: pos.column + 1,
    });
    const insert = `${open}\n${inner}\n${outer}${close}`;
    editor.executeEdits("h1code-enter", [
      { range, text: insert, forceMoveMarkers: true },
    ]);
    editor.setPosition({
      lineNumber: pos.lineNumber + 1,
      column: inner.length + 1,
    });
    return;
  }

  let fromLine = sel.startLineNumber;
  let fromCol = sel.startColumn;
  let toLine = sel.endLineNumber;
  let toCol = sel.endColumn;
  if (
    fromLine > toLine ||
    (fromLine === toLine && fromCol > toCol)
  ) {
    [fromLine, toLine] = [toLine, fromLine];
    [fromCol, toCol] = [toCol, fromCol];
  }

  const lineText = model.getLineContent(fromLine);
  const lead = /^\s*/.exec(lineText)![0];
  let indent = countColumns(lead, TAB_SIZE);

  const after = lineText.slice(fromCol - 1);
  const afterLead = /^\s*/.exec(after)![0];
  indent = Math.max(indent, countColumns(afterLead, TAB_SIZE));

  // Eat whitespace immediately after the selection end (same line only for simplicity).
  let endCol = toCol;
  if (toLine === fromLine) {
    while (endCol <= lineText.length && /\s/.test(lineText[endCol - 1]!)) {
      endCol++;
    }
  }

  let startCol = fromCol;
  if (
    fromCol > 1 &&
    fromCol < 101 &&
    !/\S/.test(lineText.slice(0, fromCol - 1))
  ) {
    startCol = 1;
  }

  const indentText = spacesForColumns(indent);
  const insert = `\n${indentText}`;
  editor.executeEdits("h1code-enter", [
    {
      range: new monaco.Range(fromLine, startCol, toLine, endCol),
      text: insert,
      forceMoveMarkers: true,
    },
  ]);
  editor.setPosition({
    lineNumber: fromLine + 1,
    column: indentText.length + 1,
  });
}

export function mountEditor(parent: HTMLElement, onChange: () => void): EditorBinding {
  ensureMonacoEnvironment();
  ensureSearchMatchStyles();
  destroyMountedEditor();
  parent.replaceChildren();

  defineH1codeTheme();
  monaco.editor.setTheme(THEME_NAME);

  // CSS: Monaco's built-in worker validation (validate + DiagnosticsAdapter).
  // HTML: Monaco 0.56 dropped doValidation on the HTML worker — we use
  // markupDiagnostics.ts instead (see attachMarkupDiagnostics below).
  try {
    const { cssDefaults } = monaco.css;
    cssDefaults.setOptions({ validate: true });
    cssDefaults.setModeConfiguration({
      ...cssDefaults.modeConfiguration,
      diagnostics: true,
    });
  } catch {
    /* optional — our lightweight CSS checker still runs */
  }

  let programmatic = false;
  let searchDecorationIds: string[] = [];

  const editor = monaco.editor.create(parent, {
    value: "",
    language: "python",
    theme: THEME_NAME,
    automaticLayout: false,
    fontFamily:
      '"Fira Code", "JetBrains Mono", Consolas, Menlo, Monaco, "Courier New", monospace',
    fontSize: 12,
    lineNumbers: "on",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
    renderLineHighlightOnlyWhenFocus: false,
    cursorBlinking: "solid",
    cursorStyle: "line",
    cursorWidth: 1,
    insertSpaces: true,
    tabSize: TAB_SIZE,
    detectIndentation: false,
    wordWrap: "off",
    folding: true,
    glyphMargin: true,
    padding: { top: 0, bottom: 0 },
    overviewRulerLanes: 2,
    fixedOverflowWidgets: true,
    // Keep occurrence/selection-word highlights from competing with find-match orange.
    selectionHighlight: false,
    occurrencesHighlight: "off",
    // Disable stock Tab-accepts-suggestion stealing Tab when we want indent.
    // FIM ghost-text uses inlineSuggest; Tab handler accepts that first.
    tabCompletion: "off",
    suggest: { showWords: false },
    quickSuggestions: false,
    parameterHints: { enabled: false },
    inlineSuggest: { enabled: false },
    hover: { enabled: "on" },
    renderValidationDecorations: "on",
  });
  mountedEditor = editor;

  const markupDiagnostics = attachMarkupDiagnostics(editor);
  const autocomplete: AutocompleteBinding = attachAutocomplete(editor);
  mountedAutocomplete = autocomplete;

  const clearSearchMatch = () => {
    searchDecorationIds = editor.deltaDecorations(searchDecorationIds, []);
  };

  editor.onDidChangeModelContent(() => {
    if (programmatic) return;
    clearSearchMatch();
    onChange();
  });

  // Tab: accept FIM ghost text when visible, else indent (no dual-caret path).
  editor.addCommand(monaco.KeyCode.Tab, () => {
    if (tryAcceptInlineSuggestion(editor)) return;
    runInsertOrIndentTab(editor);
  });
  editor.addCommand(
    monaco.KeyMod.Shift | monaco.KeyCode.Tab,
    () => editor.trigger("keyboard", "editor.action.outdentLines", null)
  );
  editor.addCommand(monaco.KeyCode.Enter, () =>
    runInsertNewlinePreserveLineIndent(editor)
  );
  editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () =>
    runInsertNewlinePreserveLineIndent(editor)
  );

  // Dev/verify harness hooks (monaco-verify.html).
  if (import.meta.env.DEV) {
    (window as unknown as { __h1codeEditorTest?: object }).__h1codeEditorTest = {
      runTab: () => runInsertOrIndentTab(editor),
      runEnter: () => runInsertNewlinePreserveLineIndent(editor),
      getLanguageId: () => editor.getModel()?.getLanguageId() ?? null,
      getEditor: () => editor,
      setDiagnostics: (items: DiagnosticItem[]) => {
        // Reuse binding path — assigned after return is awkward; call markers here.
        const model = editor.getModel();
        if (!model) return;
        const markers: monaco.editor.IMarkerData[] = items.map((d) => {
          const severity =
            d.severity === "error"
              ? monaco.MarkerSeverity.Error
              : d.severity === "warning"
                ? monaco.MarkerSeverity.Warning
                : d.severity === "hint"
                  ? monaco.MarkerSeverity.Hint
                  : monaco.MarkerSeverity.Info;
          return {
            severity,
            message: d.message,
            code: d.code ?? undefined,
            source: d.source ?? undefined,
            startLineNumber: d.range.start.line + 1,
            startColumn: d.range.start.character + 1,
            endLineNumber: d.range.end.line + 1,
            endColumn: Math.max(
              d.range.end.character + 1,
              d.range.start.character + 2
            ),
          };
        });
        monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
      },
      getMarkers: () => {
        const model = editor.getModel();
        if (!model) return [];
        return monaco.editor.getModelMarkers({ resource: model.uri });
      },
    };
  }

  resizeObserver = new ResizeObserver(() => {
    editor.layout();
  });
  resizeObserver.observe(parent);

  const view: EditorViewShim = {
    requestMeasure() {
      editor.layout();
    },
  };

  return {
    view,
    destroy() {
      if (mountedAutocomplete === autocomplete) {
        mountedAutocomplete = null;
      }
      autocomplete.dispose();
      markupDiagnostics.dispose();
      if (mountedEditor === editor) {
        destroyMountedEditor();
      } else {
        editor.dispose();
      }
    },
    setDoc(text, filePath) {
      const model = editor.getModel();
      if (!model) return;
      const plain = text.length > LARGE_FILE_PLAIN_THRESHOLD;
      const lang = languageForPath(filePath, plain);
      programmatic = true;
      try {
        clearSearchMatch();
        monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
        clearMarkupMarkers(model);
        // Avoid pushing an identical setValue that still fires events.
        if (model.getValue() !== text) {
          model.setValue(text);
        }
        monaco.editor.setModelLanguage(model, lang);
      } finally {
        programmatic = false;
      }
      autocomplete.setFilePath(filePath);
      // Re-run HTML/CSS structural checks for the new doc/language.
      applyMarkupDiagnostics(model);
    },
    getDoc() {
      return editor.getValue();
    },
    focus() {
      editor.focus();
    },
    reloadAutocompleteSettings() {
      return autocomplete.reloadSettings();
    },
    setDiagnostics(items) {
      const model = editor.getModel();
      if (!model) return;
      const markers: monaco.editor.IMarkerData[] = items.map((d) => {
        const severity =
          d.severity === "error"
            ? monaco.MarkerSeverity.Error
            : d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : d.severity === "hint"
                ? monaco.MarkerSeverity.Hint
                : monaco.MarkerSeverity.Info;
        return {
          severity,
          message: d.message,
          code: d.code ?? undefined,
          source: d.source ?? undefined,
          startLineNumber: d.range.start.line + 1,
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: Math.max(
            d.range.end.character + 1,
            d.range.start.character + 2
          ),
        };
      });
      monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
    },
    jumpTo(line, col, endCol) {
      const model = editor.getModel();
      if (!model) return;
      const lineCount = model.getLineCount();
      const ln = Math.max(1, Math.min(line, lineCount));
      const maxCol = model.getLineMaxColumn(ln);
      const fromCol = Math.min(Math.max(1, col), maxCol);
      const toCol =
        endCol != null ? Math.min(Math.max(1, endCol), maxCol) : fromCol;
      const hasMatch = toCol > fromCol;

      if (hasMatch) {
        // Selection so caret sits on match start (anchor at end, head at start).
        editor.setSelection(new monaco.Selection(ln, toCol, ln, fromCol));
        searchDecorationIds = editor.deltaDecorations(searchDecorationIds, [
          {
            range: new monaco.Range(ln, fromCol, ln, toCol),
            options: {
              inlineClassName: "monaco-search-match",
              stickiness:
                monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ]);
      } else {
        clearSearchMatch();
        editor.setPosition({ lineNumber: ln, column: fromCol });
      }
      editor.revealLineInCenter(ln);
      editor.focus();
    },
  };
}
