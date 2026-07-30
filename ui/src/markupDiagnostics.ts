// Lightweight HTML/CSS structural diagnostics → Monaco markers.
// Monaco 0.56 ships CSS worker validation, but the HTML worker no longer
// exposes doValidation and htmlMode never registers DiagnosticsAdapter.
// This fills that gap for unclosed tags / mismatched brackets so errors get
// squiggly underlines (not just tokenizer coloring).

import * as monaco from "monaco-editor";

export const MARKUP_MARKER_OWNER = "h1code-markup";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function posAt(model: monaco.editor.ITextModel, offset: number): monaco.IPosition {
  return model.getPositionAt(Math.max(0, Math.min(offset, model.getValueLength())));
}

function markerAt(
  model: monaco.editor.ITextModel,
  from: number,
  to: number,
  message: string,
  severity: monaco.MarkerSeverity = monaco.MarkerSeverity.Error
): monaco.editor.IMarkerData {
  const start = posAt(model, from);
  const end = posAt(model, Math.max(from + 1, to));
  return {
    severity,
    message,
    source: "html",
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

/** Scan HTML for unclosed start tags and mismatched open/close tags. */
export function validateHtml(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const text = model.getValue();
  const markers: monaco.editor.IMarkerData[] = [];
  const stack: Array<{ name: string; from: number; to: number }> = [];

  let i = 0;
  while (i < text.length) {
    // Skip comments
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    // Skip DOCTYPE / declarations
    if (text.startsWith("<!", i)) {
      const end = text.indexOf(">", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }

    if (text[i] !== "<") {
      i++;
      continue;
    }

    const tagStart = i;
    i++; // past '<'

    // Closing tag
    if (text[i] === "/") {
      i++;
      const nameStart = i;
      while (i < text.length && /[A-Za-z0-9:-]/.test(text[i]!)) i++;
      const name = text.slice(nameStart, i).toLowerCase();
      // Find closing '>'
      const gt = text.indexOf(">", i);
      if (gt < 0) {
        markers.push(
          markerAt(model, tagStart, text.length, `Closing tag </${name || "?"}> is not properly closed.`)
        );
        break;
      }
      // Skip if malformed name
      if (name) {
        // Pop optional ignored void; find matching open
        let found = false;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s]!.name === name) {
            stack.length = s;
            found = true;
            break;
          }
        }
        if (!found) {
          markers.push(
            markerAt(
              model,
              tagStart,
              gt + 1,
              `Unexpected closing tag </${name}>.`
            )
          );
        }
      }
      i = gt + 1;
      continue;
    }

    // Start tag / self-closing
    if (!/[A-Za-z]/.test(text[i] ?? "")) {
      // Not a tag (e.g. `<=`); skip
      continue;
    }
    const nameStart = i;
    while (i < text.length && /[A-Za-z0-9:-]/.test(text[i]!)) i++;
    const name = text.slice(nameStart, i).toLowerCase();

    // Scan attributes until '>' or '/>' — flag if we hit another '<' or EOF first
    let selfClosing = false;
    let closed = false;
    let aborted = false;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"' || ch === "'") {
        const q = ch;
        i++;
        while (i < text.length && text[i] !== q) i++;
        if (i < text.length) i++; // closing quote
        continue;
      }
      if (ch === "<") {
        // Nested '<' before this tag closed — classic "<style" without '>'
        markers.push(
          markerAt(
            model,
            tagStart,
            i,
            `Tag <${name}> is not properly closed.`
          )
        );
        aborted = true;
        break;
      }
      if (ch === ">") {
        selfClosing = text[i - 1] === "/";
        closed = true;
        i++;
        break;
      }
      i++;
    }
    if (aborted) {
      // Leave `i` on the next '<'; outer loop will process it.
      continue;
    }
    if (!closed) {
      markers.push(
        markerAt(
          model,
          tagStart,
          text.length,
          `Tag <${name}> is not properly closed.`
        )
      );
      break;
    }

    if (!selfClosing && !VOID_TAGS.has(name)) {
      stack.push({ name, from: tagStart, to: nameStart + name.length + 1 });
    }
  }

  for (const open of stack) {
    markers.push(
      markerAt(
        model,
        open.from,
        open.to,
        `Tag <${open.name}> is never closed.`
      )
    );
  }

  return markers;
}

/** Scan CSS for unmatched braces / parens / brackets. */
export function validateCss(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const text = model.getValue();
  const markers: monaco.editor.IMarkerData[] = [];
  const stack: Array<{ ch: string; at: number }> = [];
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const closers: Record<string, string> = { "}": "{", ")": "(", "]": "[" };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    // Strings
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    // Comments
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }

    if (ch in pairs) {
      stack.push({ ch, at: i });
    } else if (ch in closers) {
      const want = closers[ch]!;
      const top = stack.pop();
      if (!top || top.ch !== want) {
        markers.push(
          markerAt(model, i, i + 1, `Unexpected '${ch}'.`)
        );
      }
    }
    i++;
  }

  for (const open of stack) {
    markers.push(
      markerAt(
        model,
        open.at,
        open.at + 1,
        `Unmatched '${open.ch}'.`,
        monaco.MarkerSeverity.Error
      )
    );
  }

  // Retarget CSS marker source
  for (const m of markers) m.source = "css";
  return markers;
}

export function clearMarkupMarkers(model: monaco.editor.ITextModel): void {
  monaco.editor.setModelMarkers(model, MARKUP_MARKER_OWNER, []);
}

export function applyMarkupDiagnostics(model: monaco.editor.ITextModel): void {
  const lang = model.getLanguageId();
  let markers: monaco.editor.IMarkerData[] = [];
  if (lang === "html") {
    markers = validateHtml(model);
  } else if (lang === "css") {
    markers = validateCss(model);
  }
  monaco.editor.setModelMarkers(model, MARKUP_MARKER_OWNER, markers);
}

/** Debounced live validation for the active editor model. */
export function attachMarkupDiagnostics(
  editor: monaco.editor.IStandaloneCodeEditor
): monaco.IDisposable {
  let timer: number | undefined;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const model = editor.getModel();
      if (model) applyMarkupDiagnostics(model);
    }, 200);
  };

  const subs = [
    editor.onDidChangeModelContent(schedule),
    editor.onDidChangeModel(schedule),
    editor.onDidChangeModelLanguage(schedule),
  ];
  schedule();

  return {
    dispose() {
      window.clearTimeout(timer);
      for (const s of subs) s.dispose();
      const model = editor.getModel();
      if (model) clearMarkupMarkers(model);
    },
  };
}
