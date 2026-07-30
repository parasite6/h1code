// Editor: a single CodeMirror 6 instance whose document is swapped when the
// active tab changes. Editor-local state (cursor, selection) lives here.
//
// Diagnostics flow:
//   setDiagnostics(items) -> dispatches @codemirror/lint's setDiagnostics
//   effect with positions converted from (line, character) -> doc offsets.

import {
  EditorState,
  Compartment,
  EditorSelection,
  Annotation,
  Text,
  countColumn,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  Decoration,
  type DecorationSet,
  type KeyBinding,
  type Command,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
  insertNewlineAndIndent,
} from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import {
  indentUnit,
  getIndentation,
  IndentContext,
  indentString,
} from "@codemirror/language";
import {
  linter,
  lintGutter,
  setDiagnostics as cmSetDiagnostics,
  type Diagnostic as CMDiagnostic,
} from "@codemirror/lint";

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

export interface EditorBinding {
  setDoc(text: string, filePath: string): void;
  getDoc(): string;
  focus(): void;
  view: EditorView;
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
}

// Tag programmatic doc swaps so the change listener doesn't treat them as
// user edits (which would mark the tab dirty and re-trigger didChange).
const ProgrammaticDocSet = Annotation.define<boolean>();

// Above this size (in characters) we open files without language highlighting.
// The Lezer parser is the dominant cost for large docs; CodeMirror's own line
// virtualization handles plain text of this size comfortably.
const LARGE_FILE_PLAIN_THRESHOLD = 1_000_000;

/** Singleton so Vite HMR / remount cannot leave two live EditorViews. */
let mountedView: EditorView | null = null;

function destroyMountedView() {
  if (mountedView) {
    mountedView.destroy();
    mountedView = null;
  }
}

/** Destroy the live editor, if any. Used by Vite HMR dispose. */
export function destroyEditor() {
  destroyMountedView();
}

/**
 * Tab: insert indent-unit whitespace at the cursor when there is no selection
 * and the caret is not at column 0. Whole-line indent (indentMore) only when
 * there is a selection or the caret is at the start of the line.
 *
 * Stock `indentWithTab` always calls indentMore — that is bug (a).
 */
const insertOrIndentTab: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const indentWholeLine = state.selection.ranges.some((range) => {
    if (!range.empty) return true;
    return range.head === state.doc.lineAt(range.head).from;
  });
  if (indentWholeLine) return indentMore(view);
  const unit = state.facet(indentUnit);
  view.dispatch(
    state.update(state.replaceSelection(unit), {
      scrollIntoView: true,
      userEvent: "input",
    })
  );
  return true;
};

/**
 * Enter: like insertNewlineAndIndent, but when splitting mid-line do not let
 * a syntax-indent of 0 strip leading whitespace that already belongs to the
 * text moving onto the new line (bug (b) after merge / mid-line split).
 */
const insertNewlinePreserveLineIndent: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;

  // Bracket-pair explode stays with the stock command.
  for (const range of state.selection.ranges) {
    if (range.empty && looksLikeBracketPair(state, range.head)) {
      return insertNewlineAndIndent(view);
    }
  }

  const changes = state.changeByRange((range) => {
    let { from, to } = range;
    const line = state.doc.lineAt(from);
    const cx = new IndentContext(state, { simulateBreak: from });
    let indent = getIndentation(cx, from);
    if (indent == null) {
      indent = countColumn(/^\s*/.exec(line.text)![0], state.tabSize);
    }

    // Text after the caret may already carry indent (e.g. after merging an
    // indented block line upward). Preserve at least that many columns.
    const after = line.text.slice(from - line.from);
    const afterLead = /^\s*/.exec(after)![0];
    indent = Math.max(indent, countColumn(afterLead, state.tabSize));

    let end = to;
    while (end < line.to && /\s/.test(line.text[end - line.from]!)) end++;

    let start = from;
    if (
      from > line.from &&
      from < line.from + 100 &&
      !/\S/.test(line.text.slice(0, from - line.from))
    ) {
      start = line.from;
    }

    const insertLines = ["", indentString(state, indent)];
    return {
      changes: { from: start, to: end, insert: Text.of(insertLines) },
      range: EditorSelection.cursor(start + 1 + insertLines[1]!.length),
    };
  });

  view.dispatch(
    state.update(changes, { scrollIntoView: true, userEvent: "input" })
  );
  return true;
};

function looksLikeBracketPair(state: EditorState, pos: number): boolean {
  if (pos <= 0 || pos >= state.doc.length) return false;
  return /\(\)|\[\]|\{\}/.test(state.sliceDoc(pos - 1, pos + 1));
}

/** Keymap that overrides stock Tab / Enter. Must be registered *after* defaultKeymap. */
const indentKeymap: KeyBinding[] = [
  { key: "Tab", run: insertOrIndentTab, shift: indentLess },
  { key: "Enter", run: insertNewlinePreserveLineIndent, shift: insertNewlinePreserveLineIndent },
];

/** Temporary find-match span from search-result navigation. */
const setSearchMatch = StateEffect.define<{ from: number; to: number } | null>();

const searchMatchMark = Decoration.mark({ class: "cm-searchMatch" });

const searchMatchField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSearchMatch)) {
        if (e.value == null || e.value.from >= e.value.to) {
          deco = Decoration.none;
        } else {
          deco = Decoration.set([searchMatchMark.range(e.value.from, e.value.to)]);
        }
      }
    }
    // Drop the highlight once the user edits the document.
    if (tr.docChanged && !tr.effects.some((e) => e.is(setSearchMatch))) {
      deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function mountEditor(parent: HTMLElement, onChange: () => void): EditorBinding {
  // Hot reload re-runs bootstrap without a full document reload; destroy any
  // prior view so keymaps/updateListeners are never double-registered.
  destroyMountedView();
  parent.replaceChildren();

  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        // Python convention: 4-space indent unit (affects Tab insert + auto-indent).
        indentUnit.of("    "),
        // Draw the caret ourselves and hide the native one. WebView zoom
        // otherwise leaves a frozen native caret beside the live one.
        drawSelection(),
        dropCursor(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        // Later keymap wins over defaultKeymap's Tab/Enter bindings.
        keymap.of(indentKeymap),
        language.of(python()),
        // Install the lint state field with a no-op source. We push the actual
        // diagnostics imperatively via setDiagnostics().
        linter(() => [], { delay: 100000 }),
        lintGutter(),
        searchMatchField,
        EditorView.theme(
          {
            "&": { backgroundColor: "#1e1e1e", color: "#d4d4d4", height: "100%" },
            // Hide the browser caret; only .cm-cursor from drawSelection is shown.
            ".cm-content": { caretColor: "transparent" },
            ".cm-cursor, .cm-dropCursor": {
              borderLeftColor: "#aeafad",
              borderLeftWidth: "1.2px",
            },
            ".cm-gutters": {
              backgroundColor: "#1e1e1e",
              color: "#5a5a5a",
              border: "none",
            },
            // Active line: muted accent tint (matches --accent-bg). Kept subtle so
            // it never reads like selection (#264f78) or search-match orange.
            ".cm-activeLine": { backgroundColor: "rgba(0, 122, 204, 0.10)" },
            ".cm-activeLineGutter": { backgroundColor: "rgba(0, 122, 204, 0.10)" },
            ".cm-selectionBackground, .cm-content ::selection": {
              backgroundColor: "#264f78 !important",
            },
            // Find-match span: orange tint, distinct from active-line and selection.
            ".cm-searchMatch": {
              backgroundColor: "rgba(234, 156, 52, 0.45)",
              outline: "1px solid rgba(234, 156, 52, 0.7)",
            },
            ".cm-tooltip.cm-tooltip-lint": {
              backgroundColor: "#252526",
              border: "1px solid #3c3c3c",
              color: "#d4d4d4",
            },
          },
          { dark: true }
        ),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          if (u.transactions.some((t) => t.annotation(ProgrammaticDocSet))) return;
          onChange();
        }),
      ],
    }),
  });
  mountedView = view;

  function clampLineChar(line: number, character: number): number {
    const doc = view.state.doc;
    const ln = Math.max(1, Math.min(line + 1, doc.lines));
    const lineObj = doc.line(ln);
    const ch = Math.max(0, Math.min(character, lineObj.length));
    return lineObj.from + ch;
  }

  return {
    view,
    destroy() {
      if (mountedView === view) {
        destroyMountedView();
      } else {
        view.destroy();
      }
    },
    setDoc(text, filePath) {
      void filePath;
      // Large files: drop the Lezer language parser. Running Python (Lezer)
      // highlighting over multi-MB files (e.g. a 19MB HTML) locks the UI. Plain
      // text has no per-token parse cost, so big files open instantly.
      const plain = text.length > LARGE_FILE_PLAIN_THRESHOLD;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: [
          language.reconfigure(plain ? [] : python()),
          setSearchMatch.of(null),
        ],
        annotations: ProgrammaticDocSet.of(true),
      });
      // Reset diagnostics when the document is replaced; the caller is expected
      // to push the current file's set immediately after.
      view.dispatch(cmSetDiagnostics(view.state, []));
    },
    getDoc() {
      return view.state.doc.toString();
    },
    focus() {
      view.focus();
    },
    setDiagnostics(items) {
      const mapped: CMDiagnostic[] = items.map((d) => {
        const from = clampLineChar(d.range.start.line, d.range.start.character);
        let to = clampLineChar(d.range.end.line, d.range.end.character);
        if (to <= from) to = Math.min(view.state.doc.length, from + 1);
        return {
          from,
          to,
          severity: d.severity === "hint" ? "info" : d.severity,
          message: d.message,
          source: d.source ?? d.code ?? undefined,
        };
      });
      view.dispatch(cmSetDiagnostics(view.state, mapped));
    },
    jumpTo(line, col, endCol) {
      const doc = view.state.doc;
      const ln = Math.max(1, Math.min(line, doc.lines));
      const lineObj = doc.line(ln);
      const from = Math.min(lineObj.from + Math.max(0, col - 1), lineObj.to);
      const to =
        endCol != null
          ? Math.min(lineObj.from + Math.max(0, endCol - 1), lineObj.to)
          : from;
      const hasMatch = to > from;
      view.dispatch({
        // Anchor at end, head at start so the caret sits on the match start.
        selection: hasMatch
          ? EditorSelection.single(to, from)
          : EditorSelection.single(from),
        effects: setSearchMatch.of(hasMatch ? { from, to } : null),
        scrollIntoView: true,
      });
      view.focus();
    },
  };
}
