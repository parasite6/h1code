// Search sidebar panel — queries the backend orchestrator (index assist + ripgrep).

import {
  ipc,
  type CoreEvent,
  type SearchHit,
  type SearchIndexStatus,
  type SearchResponse,
} from "./ipc";

export interface SearchBinding {
  focus(): void;
  setWorkspaceRoot(root: string | null): void;
  applyEvent(evt: CoreEvent): void;
  /** col / endCol are 1-based (endCol exclusive), matching editor.jumpTo. */
  onOpenFile(
    handler: (
      path: string,
      line?: number,
      col?: number,
      endCol?: number
    ) => void
  ): void;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function relativeDisplay(path: string, root: string | null): string {
  if (!root) return path;
  const normRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normPath = path.replace(/\\/g, "/");
  if (normPath.startsWith(normRoot + "/")) {
    return normPath.slice(normRoot.length + 1);
  }
  return path;
}

function statusLabel(status: SearchIndexStatus | null): string {
  if (!status) return "";
  switch (status.phase) {
    case "indexing":
      return "Indexing…";
    case "ready":
      return "Index ready";
    case "capped":
      return status.message || "Index capped — full scan still runs";
    case "error":
      return status.message || "Index error";
    case "idle":
    default:
      return "";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightSnippet(line: string, start: number, end: number): string {
  const safeStart = Math.max(0, Math.min(start, line.length));
  const safeEnd = Math.max(safeStart, Math.min(end, line.length));
  return (
    escapeHtml(line.slice(0, safeStart)) +
    "<mark>" +
    escapeHtml(line.slice(safeStart, safeEnd)) +
    "</mark>" +
    escapeHtml(line.slice(safeEnd))
  );
}

export function mountSearch(panel: HTMLElement): SearchBinding {
  const queryInput = panel.querySelector<HTMLInputElement>("#search-query")!;
  const caseToggle = panel.querySelector<HTMLInputElement>("#search-case")!;
  const regexToggle = panel.querySelector<HTMLInputElement>("#search-regex")!;
  const statusEl = panel.querySelector<HTMLElement>("#search-status")!;
  const resultsEl = panel.querySelector<HTMLElement>("#search-results")!;

  let workspaceRoot: string | null = null;
  let indexStatus: SearchIndexStatus | null = null;
  let debounceTimer: number | null = null;
  let requestSeq = 0;
  let openHandler:
    | ((
        path: string,
        line?: number,
        col?: number,
        endCol?: number
      ) => void)
    | null = null;
  let searching = false;

  function renderStatus() {
    const parts: string[] = [];
    const idx = statusLabel(indexStatus);
    if (idx) parts.push(idx);
    if (searching) parts.push("Searching…");
    statusEl.textContent = parts.join(" · ");
  }

  function renderEmpty(message: string) {
    resultsEl.innerHTML = `<p class="search-empty">${escapeHtml(message)}</p>`;
  }

  function renderResults(resp: SearchResponse) {
    const total =
      resp.files.length + resp.folders.length + resp.content.length;
    if (total === 0) {
      renderEmpty("No results");
      return;
    }

    const sections: string[] = [];

    if (resp.files.length) {
      sections.push(`<div class="search-section">
        <div class="search-section-title">Files (${resp.files.length})</div>
        ${resp.files
          .map(
            (f) => `<button type="button" class="search-result-row" data-kind="file" data-path="${escapeHtml(f.path)}">
            <span class="search-result-name">${escapeHtml(f.name)}</span>
            <span class="search-result-path">${escapeHtml(relativeDisplay(f.path, workspaceRoot))}</span>
          </button>`
          )
          .join("")}
      </div>`);
    }

    if (resp.folders.length) {
      sections.push(`<div class="search-section">
        <div class="search-section-title">Folders (${resp.folders.length})</div>
        ${resp.folders
          .map(
            (f) => `<button type="button" class="search-result-row" data-kind="folder" data-path="${escapeHtml(f.path)}">
            <span class="search-result-name">${escapeHtml(f.name)}</span>
            <span class="search-result-path">${escapeHtml(relativeDisplay(f.path, workspaceRoot))}</span>
          </button>`
          )
          .join("")}
      </div>`);
    }

    if (resp.content.length) {
      const byFile = new Map<string, SearchHit[]>();
      for (const hit of resp.content) {
        const list = byFile.get(hit.path) ?? [];
        list.push(hit);
        byFile.set(hit.path, list);
      }
      const groups = Array.from(byFile.entries())
        .map(([path, hits]) => {
          const rows = hits
            .map(
              (h) => `<button type="button" class="search-result-row search-content-row" data-kind="content" data-path="${escapeHtml(h.path)}" data-line="${h.line_number}" data-col="${h.start + 1}" data-end-col="${h.end + 1}">
              <span class="search-result-line">${h.line_number}</span>
              <span class="search-result-snippet">${highlightSnippet(h.line, h.start, h.end)}</span>
            </button>`
            )
            .join("");
          return `<div class="search-file-group">
            <button type="button" class="search-file-header" data-kind="file" data-path="${escapeHtml(path)}">
              <span class="search-result-name">${escapeHtml(basename(path))}</span>
              <span class="search-result-path">${escapeHtml(relativeDisplay(path, workspaceRoot))}</span>
            </button>
            ${rows}
          </div>`;
        })
        .join("");
      sections.push(`<div class="search-section">
        <div class="search-section-title">Content (${resp.content.length})</div>
        ${groups}
      </div>`);
    }

    resultsEl.innerHTML = sections.join("");
  }

  async function runSearch() {
    const pattern = queryInput.value.trim();
    if (!pattern) {
      resultsEl.innerHTML = "";
      searching = false;
      renderStatus();
      return;
    }
    if (!workspaceRoot) {
      renderEmpty("Open a folder to search");
      return;
    }

    const seq = ++requestSeq;
    searching = true;
    renderStatus();
    try {
      const resp = await ipc.search({
        pattern,
        literal: !regexToggle.checked,
        case_insensitive: !caseToggle.checked,
        include_hidden: false,
        max_results: 500,
      });
      if (seq !== requestSeq) return;
      renderResults(resp);
    } catch (e) {
      if (seq !== requestSeq) return;
      renderEmpty(`Search failed: ${String(e)}`);
    } finally {
      if (seq === requestSeq) {
        searching = false;
        renderStatus();
      }
    }
  }

  function scheduleSearch() {
    if (debounceTimer != null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void runSearch();
    }, 200);
  }

  queryInput.addEventListener("input", scheduleSearch);
  caseToggle.addEventListener("change", () => void runSearch());
  regexToggle.addEventListener("change", () => void runSearch());
  queryInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (debounceTimer != null) window.clearTimeout(debounceTimer);
      void runSearch();
    }
  });

  resultsEl.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>(
      "[data-path]"
    );
    if (!target || !openHandler) return;
    const path = target.dataset.path;
    if (!path) return;
    const kind = target.dataset.kind;
    if (kind === "folder") return;
    const line = target.dataset.line ? Number(target.dataset.line) : undefined;
    const col = target.dataset.col ? Number(target.dataset.col) : undefined;
    const endCol = target.dataset.endCol
      ? Number(target.dataset.endCol)
      : undefined;
    openHandler(path, line, col, endCol);
  });

  void ipc.searchStatus()
    .then((s) => {
      indexStatus = s;
      renderStatus();
    })
    .catch(() => {
      /* no workspace yet */
    });

  return {
    focus() {
      queryInput.focus();
      queryInput.select();
    },
    setWorkspaceRoot(root) {
      workspaceRoot = root;
      if (!root) {
        resultsEl.innerHTML = "";
        indexStatus = null;
        renderStatus();
      } else if (queryInput.value.trim()) {
        void runSearch();
      }
    },
    applyEvent(evt) {
      if (evt.kind === "search_index_status") {
        indexStatus = {
          phase: evt.phase,
          root: evt.root,
          files_indexed: evt.files_indexed,
          dirs_indexed: evt.dirs_indexed,
          content_indexed: evt.content_indexed,
          index_bytes: evt.index_bytes,
          max_index_bytes: evt.max_index_bytes,
          message: evt.message,
        };
        renderStatus();
      } else if (evt.kind === "workspace_closed") {
        workspaceRoot = null;
        indexStatus = null;
        resultsEl.innerHTML = "";
        renderStatus();
      }
    },
    onOpenFile(handler) {
      openHandler = handler;
    },
  };
}
