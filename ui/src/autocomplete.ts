// FIM autocomplete: debounce → prefix/suffix + ring-buffer context → /infill via IPC.
// Logic ported from ggml-org/llama.vscode (not a verbatim copy).

import * as monaco from "monaco-editor";
import {
  ipc,
  type AutocompleteSettings,
  type InfillChunk,
} from "./ipc";

const HTML_CSS_REJECT = [
  "useState",
  "onChange={",
  "<?php",
  "{{",
  "@foreach",
] as const;

const MAX_QUEUED_CHUNKS = 16;
const MAX_LAST_PICK_LINE_DISTANCE = 32;
const RING_UPDATE_MIN_MS = 3000;
const RING_FLUSH_MS = 1000;

const DEFAULT_SETTINGS: AutocompleteSettings = {
  enabled: false,
  endpoint: "http://127.0.0.1:8081",
  debounceMs: 200,
  nPrefix: 256,
  nSuffix: 64,
  nPredict: 128,
  maxLineSuffix: 8,
  ringNChunks: 16,
  ringChunkSize: 64,
  ringScope: 1024,
};

export interface AutocompleteBinding {
  dispose(): void;
  setFilePath(path: string): void;
  reloadSettings(): Promise<void>;
}

interface RingChunk {
  text: string;
  filename: string;
  time: number;
}

function isHtmlOrCss(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : "";
  return ext === ".html" || ext === ".htm" || ext === ".css";
}

/** Reject obvious non-HTML injections for .html/.css files. */
export function shouldRejectCompletion(path: string, text: string): boolean {
  if (!isHtmlOrCss(path)) return false;
  return HTML_CSS_REJECT.some((p) => text.includes(p));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) {
    if (setB.has(x)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function getPrefixLines(
  model: monaco.editor.ITextModel,
  lineNumber: number,
  nPrefix: number
): string[] {
  // lineNumber is 1-based; collect up to nPrefix lines above the cursor line.
  const start = Math.max(1, lineNumber - nPrefix);
  const lines: string[] = [];
  for (let ln = start; ln < lineNumber; ln++) {
    lines.push(model.getLineContent(ln));
  }
  return lines;
}

function getSuffixLines(
  model: monaco.editor.ITextModel,
  lineNumber: number,
  nSuffix: number
): string[] {
  const end = Math.min(model.getLineCount(), lineNumber + nSuffix);
  const lines: string[] = [];
  for (let ln = lineNumber + 1; ln <= end; ln++) {
    lines.push(model.getLineContent(ln));
  }
  return lines;
}

function getDocumentLines(
  model: monaco.editor.ITextModel,
  startLine: number,
  endLine: number
): string[] {
  const lo = Math.max(1, startLine);
  const hi = Math.min(model.getLineCount(), endLine);
  if (hi < lo) return [];
  const lines: string[] = [];
  for (let ln = lo; ln <= hi; ln++) {
    lines.push(model.getLineContent(ln));
  }
  return lines;
}

function onlySpacesOrTabs(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** Drop model control tokens that sometimes leak into /infill content. */
function sanitizeCompletion(text: string): string {
  return text.replace(/<\|[^|>]+\|>/g, "").replace(/\s+$/u, "");
}

type InlineCtrl = {
  model?: {
    get?: () => {
      state?: {
        get?: () => { kind?: string; inlineSuggestion?: unknown } | undefined;
      };
      accept?: (editor: monaco.editor.ICodeEditor) => void | Promise<void>;
    } | undefined;
  };
};

/** Accept visible ghost text via Monaco's controller (single edit — no dual caret). */
export function tryAcceptInlineSuggestion(
  editor: monaco.editor.IStandaloneCodeEditor
): boolean {
  const contrib = editor.getContribution(
    "editor.contrib.inlineCompletionsController"
  ) as InlineCtrl | null;
  const model = contrib?.model?.get?.();
  const state = model?.state?.get?.();
  if (!state || state.kind !== "ghostText" || !state.inlineSuggestion) {
    return false;
  }
  if (!model?.accept) return false;
  void model.accept(editor);
  return true;
}

export function attachAutocomplete(
  editor: monaco.editor.IStandaloneCodeEditor
): AutocompleteBinding {
  let settings: AutocompleteSettings = { ...DEFAULT_SETTINGS };
  let filePath = "";
  let providerDisposable: monaco.IDisposable | null = null;
  let requestInProgress = false;
  let lastComplStartTime = Date.now();

  const chunks: RingChunk[] = [];
  const chunksLines: string[][] = [];
  const queuedChunks: RingChunk[] = [];
  const queuedChunksLines: string[][] = [];
  let lastLinePick = -9999;

  const disposables: monaco.IDisposable[] = [];

  function clearProvider() {
    providerDisposable?.dispose();
    providerDisposable = null;
  }

  function pickChunk(
    lines: string[],
    doEvict: boolean,
    filename: string
  ): void {
    if (settings.ringNChunks <= 0) return;
    if (lines.length < 3) return;

    let newChunkLines: string[];
    if (lines.length + 1 < settings.ringChunkSize) {
      newChunkLines = lines;
    } else {
      const half = Math.max(1, Math.floor(settings.ringChunkSize / 2));
      const startLine = Math.floor(
        Math.random() * Math.max(0, lines.length - half + 1)
      );
      newChunkLines = lines.slice(startLine, startLine + half);
    }
    const chunkString = newChunkLines.join("\n") + "\n";
    if (
      chunks.some((c) => c.text === chunkString) ||
      queuedChunks.some((c) => c.text === chunkString)
    ) {
      return;
    }

    if (doEvict) {
      for (let i = chunks.length - 1; i >= 0; i--) {
        if (jaccardSimilarity(chunksLines[i], newChunkLines) > 0.9) {
          chunks.splice(i, 1);
          chunksLines.splice(i, 1);
        }
      }
      for (let i = queuedChunks.length - 1; i >= 0; i--) {
        if (jaccardSimilarity(queuedChunksLines[i], newChunkLines) > 0.9) {
          queuedChunks.splice(i, 1);
          queuedChunksLines.splice(i, 1);
        }
      }
    }

    if (queuedChunks.length >= MAX_QUEUED_CHUNKS) {
      queuedChunks.shift();
      queuedChunksLines.shift();
    }
    queuedChunks.push({
      text: chunkString,
      filename,
      time: Date.now(),
    });
    queuedChunksLines.push(newChunkLines);
  }

  function addFimContextChunks(
    model: monaco.editor.ITextModel,
    lineNumber: number
  ): void {
    const delta = Math.abs(lineNumber - lastLinePick);
    if (delta <= MAX_LAST_PICK_LINE_DISTANCE) return;

    const prefixStart = Math.max(1, lineNumber - settings.ringScope);
    const prefixEnd = Math.max(1, lineNumber - settings.nPrefix);
    pickChunk(
      getDocumentLines(model, prefixStart, prefixEnd),
      false,
      filePath || model.uri.toString()
    );

    const suffixStart = Math.min(
      model.getLineCount(),
      lineNumber + settings.nSuffix
    );
    const suffixEnd = Math.min(
      model.getLineCount(),
      lineNumber + settings.nSuffix + settings.ringChunkSize
    );
    pickChunk(
      getDocumentLines(model, suffixStart, suffixEnd),
      false,
      filePath || model.uri.toString()
    );

    lastLinePick = lineNumber;
  }

  function flushRing(): void {
    if (queuedChunks.length === 0) return;
    if (Date.now() - lastComplStartTime < RING_UPDATE_MIN_MS) return;

    const lines = queuedChunksLines.shift();
    const chunk = queuedChunks.shift();
    if (!chunk || !lines) return;

    chunks.push(chunk);
    chunksLines.push(lines);
    while (chunks.length > settings.ringNChunks) {
      chunks.shift();
      chunksLines.shift();
    }

    const extra: InfillChunk[] = chunks.map((c) => ({
      text: c.text,
      filename: c.filename,
      time: c.time,
    }));
    void ipc
      .llamaInfillWarmup({
        endpoint: settings.endpoint,
        inputExtra: extra,
      })
      .catch(() => {});
  }

  function registerProvider(): void {
    clearProvider();
    if (!settings.enabled) {
      editor.updateOptions({ inlineSuggest: { enabled: false } });
      return;
    }
    editor.updateOptions({ inlineSuggest: { enabled: true } });

    providerDisposable = monaco.languages.registerInlineCompletionsProvider(
      { pattern: "**" },
      {
        provideInlineCompletions: async (
          model,
          position,
          _context,
          token
        ) => {
          if (!settings.enabled) {
            return { items: [] };
          }
          if (token.isCancellationRequested) {
            return { items: [] };
          }

          const debounceMs = settings.debounceMs;
          if (debounceMs > 0) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, debounceMs)
            );
            if (token.isCancellationRequested) {
              return { items: [] };
            }
          }

          // Wait out an in-flight request (simple serialisation).
          const waitStart = Date.now();
          while (requestInProgress && Date.now() - waitStart < 5000) {
            await new Promise<void>((r) => setTimeout(r, 50));
            if (token.isCancellationRequested) {
              return { items: [] };
            }
          }
          if (requestInProgress) {
            return { items: [] };
          }

          requestInProgress = true;
          lastComplStartTime = Date.now();

          try {
            const lineText = model.getLineContent(position.lineNumber);
            const col = position.column; // 1-based
            const linePrefix = lineText.slice(0, col - 1);
            const lineSuffix = lineText.slice(col - 1);

            if (lineSuffix.length > settings.maxLineSuffix) {
              return { items: [] };
            }

            let prompt = linePrefix;
            if (onlySpacesOrTabs(prompt)) {
              prompt = "";
            }

            const prefixLines = getPrefixLines(
              model,
              position.lineNumber,
              settings.nPrefix
            );
            const suffixLines = getSuffixLines(
              model,
              position.lineNumber,
              settings.nSuffix
            );
            const inputPrefix = prefixLines.join("\n") + "\n";
            const inputSuffix = lineSuffix + "\n" + suffixLines.join("\n") + "\n";

            const inputExtra: InfillChunk[] = chunks.map((c) => ({
              text: c.text,
              filename: c.filename,
              time: c.time,
            }));

            if (token.isCancellationRequested) {
              return { items: [] };
            }

            const data = await ipc.llamaInfill({
              endpoint: settings.endpoint,
              inputPrefix,
              inputSuffix,
              prompt,
              inputExtra,
              nPredict: settings.nPredict,
            });

            if (token.isCancellationRequested) {
              return { items: [] };
            }

            let content = sanitizeCompletion(
              (data.content ?? "").replace(/\r\n/g, "\n")
            );
            // Trim trailing blank lines.
            while (content.endsWith("\n\n")) {
              content = content.slice(0, -1);
            }
            if (!content.trim()) {
              return { items: [] };
            }
            if (shouldRejectCompletion(filePath, content)) {
              return { items: [] };
            }

            // Schedule ring gather after a successful completion.
            queueMicrotask(() => {
              if (!token.isCancellationRequested) {
                addFimContextChunks(model, position.lineNumber);
              }
            });

            const range = new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            );
            return {
              items: [
                {
                  insertText: content,
                  range,
                },
              ],
            };
          } catch (err) {
            console.debug("[autocomplete] infill failed:", err);
            return { items: [] };
          } finally {
            requestInProgress = false;
          }
        },
        disposeInlineCompletions: (_completions, _reason) => {},
      }
    );
  }

  async function reloadSettings(): Promise<void> {
    try {
      settings = await ipc.autocompleteSettingsGet();
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
    registerProvider();
  }

  const ringTimer = window.setInterval(() => {
    if (settings.enabled) flushRing();
  }, RING_FLUSH_MS);

  registerProvider();

  return {
    dispose() {
      window.clearInterval(ringTimer);
      clearProvider();
      for (const d of disposables) d.dispose();
      chunks.length = 0;
      chunksLines.length = 0;
      queuedChunks.length = 0;
      queuedChunksLines.length = 0;
    },
    setFilePath(path: string) {
      filePath = path;
    },
    reloadSettings,
  };
}
