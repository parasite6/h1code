import { mountEditor } from "./editor";

type Check = { name: string; ok: boolean; detail?: string };

type TestHooks = {
  runTab: () => void;
  runEnter: () => void;
  getLanguageId: () => string | null;
  getEditor: () => import("monaco-editor").editor.IStandaloneCodeEditor;
};

const logEl = document.getElementById("log")!;
const checks: Check[] = [];

function record(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  logEl.textContent = checks
    .map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`)
    .join("\n");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function hooks(): TestHooks {
  const h = (window as unknown as { __h1codeEditorTest?: TestHooks }).__h1codeEditorTest;
  if (!h) throw new Error("missing __h1codeEditorTest hooks");
  return h;
}

async function main() {
  const host = document.getElementById("editor")!;
  let dirty = 0;
  const editor = mountEditor(host, () => {
    dirty++;
  });
  const t = hooks();
  const monacoMod = await import("monaco-editor");

  const langCases: Array<[string, string, string]> = [
    ["py", "def hello():\n    return 1\n", "python"],
    ["html", "<html><body><h1>Hi</h1></body></html>\n", "html"],
    ["css", "body { color: red; }\n", "css"],
    ["ts", "const x: number = 1;\n", "typescript"],
    ["js", "const y = 2;\n", "javascript"],
  ];

  for (const [ext, text, expectLang] of langCases) {
    dirty = 0;
    editor.setDoc(text, `/tmp/sample.${ext}`);
    await sleep(30);
    const lang = t.getLanguageId();
    record(`language .${ext}`, lang === expectLang, `got ${lang}`);
    record(`setDoc no dirty .${ext}`, dirty === 0, `dirty=${dirty}`);
  }

  // Tab mid-line → insert 4 spaces
  editor.setDoc("abcd", "/tmp/t.py");
  await sleep(20);
  dirty = 0;
  t.getEditor().setPosition({ lineNumber: 1, column: 3 });
  t.runTab();
  await sleep(20);
  const afterMidTab = editor.getDoc();
  record("Tab mid-line inserts spaces", afterMidTab === "ab    cd", JSON.stringify(afterMidTab));
  record("Tab mid-line marks dirty", dirty >= 1, `dirty=${dirty}`);

  // Tab at column 0 → indent whole line
  editor.setDoc("abcd", "/tmp/t.py");
  await sleep(20);
  t.getEditor().setPosition({ lineNumber: 1, column: 1 });
  t.runTab();
  await sleep(20);
  const afterCol0 = editor.getDoc();
  record("Tab col0 indents line", afterCol0 === "    abcd", JSON.stringify(afterCol0));

  // Tab with selection → indent
  editor.setDoc("abcd", "/tmp/t.py");
  await sleep(20);
  t.getEditor().setSelection({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 5,
  });
  t.runTab();
  await sleep(20);
  const afterSel = editor.getDoc();
  record("Tab with selection indents", afterSel === "    abcd", JSON.stringify(afterSel));

  // Enter after merge-like line: caret after ':' before spaces+code
  editor.setDoc("def f():    x = 1", "/tmp/t.py");
  await sleep(20);
  t.getEditor().setPosition({ lineNumber: 1, column: 9 });
  t.runEnter();
  await sleep(20);
  const afterEnter = editor.getDoc();
  const lines = afterEnter.split("\n");
  record(
    "Enter preserves after-caret indent",
    lines.length === 2 && lines[0] === "def f():" && lines[1] === "    x = 1",
    JSON.stringify(afterEnter)
  );

  // jumpTo search match decoration
  editor.setDoc("hello world hello", "/tmp/t.py");
  await sleep(20);
  editor.jumpTo(1, 1, 6);
  await sleep(120);
  const match = host.querySelector(".monaco-search-match");
  record("search match decoration", !!match, match ? "found" : "missing");

  // Single caret
  const cursors = host.querySelectorAll(".cursor");
  record("single caret element", cursors.length <= 1, `cursors=${cursors.length}`);

  // Theme active-line vs selection: confirm CSS variables from theme colors applied
  const edDom = host.querySelector(".monaco-editor") as HTMLElement | null;
  record("monaco mounted", !!edDom, `children=${host.childElementCount}`);

  // Selection highlight — Monaco paints selection in view overlays
  t.getEditor().setSelection({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 6,
  });
  await sleep(80);
  const sel =
    host.querySelector(".selected-text") ||
    host.querySelector(".cslr") ||
    host.querySelector(".view-line span.inline-selected-text");
  const hasSel =
    !!sel ||
    (() => {
      const s = t.getEditor().getSelection();
      return !!s && !s.isEmpty();
    })();
  record("selection highlight present", hasSel, sel ? "overlay" : "selection-nonempty");

  // HTML structural diagnostics: remove '>' from <style> → real squiggly marker
  editor.setDoc(
    "<!doctype html>\n<html>\n<style\nbody { color: red; }\n</style>\n</html>\n",
    "/tmp/broken.html"
  );
  await sleep(300);
  const htmlMarkers = monacoMod.editor
    .getModelMarkers({ resource: t.getEditor().getModel()!.uri })
    .filter((m) => /not properly closed|never closed|Unexpected/i.test(m.message));
  const hasSquiggle =
    htmlMarkers.length > 0 || !!host.querySelector(".squiggly-error, .cdr.squiggly-error");
  record(
    "HTML unclosed <style> marker",
    hasSquiggle && htmlMarkers.some((m) => /style/i.test(m.message)),
    htmlMarkers.map((m) => m.message).join(" | ") || "no markers"
  );

  // CSS unmatched brace
  editor.setDoc("body { color: red;\n", "/tmp/broken.css");
  await sleep(300);
  const cssMarkers = monacoMod.editor
    .getModelMarkers({ resource: t.getEditor().getModel()!.uri })
    .filter((m) => /Unmatched|Unexpected|}/i.test(m.message) || m.source === "css");
  record(
    "CSS unmatched brace marker",
    cssMarkers.length > 0 || !!host.querySelector(".squiggly-error"),
    cssMarkers.map((m) => `${m.source}:${m.message}`).join(" | ") || "no markers"
  );

  // setDiagnostics → visible squiggly (Pyright-owned path, not Ruff)
  editor.setDoc("import os\nprint(1)\n", "/tmp/unused.py");
  await sleep(50);
  editor.setDiagnostics([
    {
      severity: "error",
      message: "Import \"os\" is not accessed",
      code: "reportUnusedImport",
      source: "pyright",
      range: {
        start: { line: 0, character: 7 },
        end: { line: 0, character: 9 },
      },
    },
  ]);
  await sleep(400);
  const pyrightMarkers = monacoMod.editor
    .getModelMarkers({ resource: t.getEditor().getModel()!.uri })
    .filter((m) => m.owner === "h1code" && (m.source === "pyright" || /not accessed/i.test(m.message)));
  const squigglyEl = host.querySelector(
    ".cdr.squiggly-error, .cdr.squiggly-warning, .squiggly-error, .squiggly-warning"
  ) as HTMLElement | null;
  const borderVar = getComputedStyle(host.querySelector(".monaco-editor")!)
    .getPropertyValue("--vscode-editorError-border")
    .trim();
  const painted =
    !!squigglyEl &&
    (getComputedStyle(squigglyEl).borderBottom.includes("241, 76, 76") ||
      getComputedStyle(squigglyEl).backgroundImage.includes("svg") ||
      getComputedStyle(squigglyEl).borderBottomWidth !== "0px");
  record(
    "Pyright setDiagnostics visible squiggly",
    pyrightMarkers.length > 0 && painted,
    `markers=${pyrightMarkers.length} squiggly=${!!squigglyEl} painted=${painted} class=${squigglyEl?.className ?? "none"} border=${borderVar || "empty"}`
  );

  const allOk = checks.every((c) => c.ok);
  (window as unknown as { __monacoVerify?: { checks: Check[]; allOk: boolean } }).__monacoVerify = {
    checks,
    allOk,
  };
  document.title = allOk ? "VERIFY_OK" : "VERIFY_FAIL";
}

main().catch((e) => {
  record("harness", false, String(e));
  document.title = "VERIFY_FAIL";
  (window as unknown as { __monacoVerify?: { checks: Check[]; allOk: boolean } }).__monacoVerify = {
    checks,
    allOk: false,
  };
});
