// Monaco web workers for Vite (?worker). Imported once before create().
// Relative paths bypass monaco-editor's package "exports" remapping.
import editorWorker from "../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import cssWorker from "../node_modules/monaco-editor/esm/vs/language/css/css.worker.js?worker";
import htmlWorker from "../node_modules/monaco-editor/esm/vs/language/html/html.worker.js?worker";
import tsWorker from "../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";

let configured = false;

export function ensureMonacoEnvironment(): void {
  if (configured) return;
  configured = true;
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === "css" || label === "scss" || label === "less") {
        return new cssWorker();
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new htmlWorker();
      }
      if (label === "typescript" || label === "javascript") {
        return new tsWorker();
      }
      // json / python / plaintext / default: editor worker
      return new editorWorker();
    },
  };
}
