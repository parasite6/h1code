// Explorer: lazy tree backed by ide-core's fs.list_dir. No truth lives here —
// it just re-queries the backend on expand and reflects file events.

import { ipc, type DirEntry, type CoreEvent } from "./ipc";

export type CreateKind = "file" | "folder";

export type ScratchEntry = ScratchFile | ScratchFolder;

export interface ScratchFile {
  kind: "file";
  name: string;
  path: string;
  content: string;
}

export interface ScratchFolder {
  kind: "folder";
  name: string;
  path: string;
  children: ScratchEntry[];
}

export interface ExplorerBinding {
  setRoot(root: string): Promise<void>;
  setScratchRoot(rootName: string, rootPath: string, children: ScratchEntry[]): void;
  clearScratchRoot(): void;
  onOpenFile(handler: (path: string) => void): void;
  /** Called after the user creates a file via the in-tree input. */
  onFileCreated(handler: (path: string) => void): void;
  onRename(handler: (from: string, to: string, isDir: boolean) => void): void;
  onDelete(handler: (path: string, isDir: boolean) => void): void;
  onConfirmDelete(handler: (path: string, isDir: boolean) => Promise<boolean>): void;
  onScratchRootRename(handler: (name: string) => void): void;
  onScratchRootDelete(handler: () => void): void;
  /** Begin an inline create at the current target dir (workspace root if none selected). */
  beginCreate(kind: CreateKind, explicitTargetDir?: string): Promise<void>;
  applyEvent(evt: CoreEvent): void;
  /** Subtle indicator that a path drifted from disk outside the IDE. */
  markExternalChange(path: string): void;
  clearExternalChange(path: string): void;
  moveExternalChange(from: string, to: string): void;
  clearAllExternalChanges(): void;
}

interface NodeState {
  entry: DirEntry;
  el: HTMLElement;
  childrenWrap: HTMLElement | null;
  expanded: boolean;
  depth: number;
}

const chevronRightSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"></polyline>
  </svg>
`;

const folderClosedSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d8a042" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>
`;

const folderOpenSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d8a042" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
    <path d="M2 10h20" opacity="0.3"></path>
  </svg>
`;

const pythonFileSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3572A5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <path d="M8 13h6" stroke-width="1.5" opacity="0.6"></path>
    <path d="M8 17h6" stroke-width="1.5" opacity="0.6"></path>
  </svg>
`;

const genericFileSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8e8e93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>
`;

function fileIconFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return pythonFileSvg;
  return genericFileSvg;
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}

function debugExplorerTree(message: string, details?: Record<string, unknown>) {
  if (localStorage.getItem("h1code.debug.explorerTree") !== "1") return;
  console.debug(`[explorer-tree] ${message}`, details ?? {});
}

export function mountExplorer(host: HTMLElement): ExplorerBinding {
  let openHandler: ((p: string) => void) | null = null;
  let fileCreatedHandler: ((p: string) => void) | null = null;
  let renameHandler: ((from: string, to: string, isDir: boolean) => void) | null = null;
  let deleteHandler: ((path: string, isDir: boolean) => void) | null = null;
  let confirmDeleteHandler: ((path: string, isDir: boolean) => Promise<boolean>) | null = null;
  let scratchRootRenameHandler: ((name: string) => void) | null = null;
  let scratchRootDeleteHandler: (() => void) | null = null;
  let rootPath: string | null = null;
  let selectedDir: string | null = null;
  let selectedPath: string | null = null;
  const byPath = new Map<string, NodeState>();
  let pendingInput: HTMLElement | null = null;
  let scratchRoot: ScratchFolder | null = null;
  let scratchSelectedDir: string | null = null;
  let scratchSelectedPath: string | null = null;
  const scratchExpanded = new Set<string>();
  const scratchContainers = new Map<string, HTMLElement>();
  const scratchDepths = new Map<string, number>();
  /** Paths that changed on disk outside the IDE (subtle tree dots). */
  const externalChanges = new Set<string>();

  function normExplorerPath(p: string): string {
    return p.replace(/\\/g, "/");
  }

  function findNodeState(path: string): NodeState | undefined {
    const direct = byPath.get(path);
    if (direct) return direct;
    const want = normExplorerPath(path);
    for (const [key, state] of byPath) {
      if (normExplorerPath(key) === want) return state;
    }
    return undefined;
  }

  function paintExternalChange(path: string) {
    const state = findNodeState(path);
    if (!state) return;
    const marked = [...externalChanges].some(
      (p) => normExplorerPath(p) === normExplorerPath(path)
    );
    state.el.classList.toggle("external-change", marked);
    let dot = state.el.querySelector<HTMLElement>(".external-change-dot");
    if (marked && !dot) {
      dot = document.createElement("span");
      dot.className = "external-change-dot";
      dot.title = "Changed outside the IDE";
      state.el.appendChild(dot);
    } else if (!marked && dot) {
      dot.remove();
    }
  }

  function markExternalChange(path: string) {
    // Always record the path so dots appear when a collapsed parent is later expanded.
    externalChanges.add(path);
    paintExternalChange(path);
  }

  function clearExternalChange(path: string) {
    const want = normExplorerPath(path);
    for (const p of [...externalChanges]) {
      if (normExplorerPath(p) === want) externalChanges.delete(p);
    }
    paintExternalChange(path);
  }

  function moveExternalChange(from: string, to: string) {
    const want = normExplorerPath(from);
    let had = false;
    for (const p of [...externalChanges]) {
      if (normExplorerPath(p) === want) {
        externalChanges.delete(p);
        had = true;
      }
    }
    if (had) {
      externalChanges.add(to);
    }
    paintExternalChange(from);
    paintExternalChange(to);
  }

  function clearAllExternalChanges() {
    const prev = [...externalChanges];
    externalChanges.clear();
    for (const p of prev) paintExternalChange(p);
  }

  let setRootCallId = 0;
  async function setRoot(root: string) {
    scratchRoot = null;
    scratchSelectedDir = null;
    scratchSelectedPath = null;
    scratchExpanded.clear();
    scratchContainers.clear();
    scratchDepths.clear();
    rootPath = root;
    selectedDir = null;
    selectedPath = null;
    const currentId = ++setRootCallId;
    async function getEntries() {
      return await ipc.fsList(root);
    }
    const entries = await getEntries();
    if (currentId === setRootCallId) {
      host.innerHTML = "";
      byPath.clear();
      pendingInput = null;
      for (const e of entries) {
        host.appendChild(buildNode(e, 0));
      }
    }
  }

  function setScratchRoot(rootName: string, scratchPath: string, children: ScratchEntry[]) {
    rootPath = null;
    selectedDir = null;
    selectedPath = null;
    byPath.clear();
    pendingInput = null;
    scratchRoot = { kind: "folder", name: rootName, path: scratchPath, children };
    scratchSelectedDir = scratchPath;
    scratchSelectedPath = scratchPath;
    scratchExpanded.clear();
    scratchExpanded.add(scratchPath);
    renderScratchRoot();
  }

  function clearScratchRoot() {
    scratchRoot = null;
    scratchSelectedDir = null;
    scratchSelectedPath = null;
    scratchExpanded.clear();
    scratchContainers.clear();
    scratchDepths.clear();
    host.innerHTML = "";
  }

  function buildNode(entry: DirEntry, depth: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "file-tree-node";
    el.style.paddingLeft = `${12 + depth * 14}px`;

    const twisty = document.createElement("span");
    twisty.className = entry.is_dir ? "twisty folder-twisty" : "twisty";
    twisty.innerHTML = entry.is_dir ? chevronRightSvg : "";
    if (entry.is_dir) {
      twisty.onclick = async (e) => {
        e.stopPropagation();
        await toggleExpand(state);
      };
    }
    el.appendChild(twisty);

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = entry.is_dir ? folderClosedSvg : fileIconFor(entry.name);
    el.appendChild(icon);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    el.appendChild(name);

    const state: NodeState = { entry, el, childrenWrap: null, expanded: false, depth };
    byPath.set(entry.path, state);
    if ([...externalChanges].some((p) => normExplorerPath(p) === normExplorerPath(entry.path))) {
      el.classList.add("external-change");
      const dot = document.createElement("span");
      dot.className = "external-change-dot";
      dot.title = "Changed outside the IDE";
      el.appendChild(dot);
    }

    el.onclick = async () => {
      document
        .querySelectorAll(".file-tree-node.selected")
        .forEach((n) => n.classList.remove("selected"));
      el.classList.add("selected");
      selectedPath = entry.path;
      if (entry.is_dir) {
        selectedDir = entry.path;
      } else {
        // Selected file → context for new-file lives in its parent dir.
        selectedDir = parentOf(entry.path);
        openHandler?.(entry.path);
      }
    };

    el.oncontextmenu = (e) => {
      e.preventDefault();
      document
        .querySelectorAll(".file-tree-node.selected")
        .forEach((n) => n.classList.remove("selected"));
      el.classList.add("selected");
      selectedPath = entry.path;
      selectedDir = entry.is_dir ? entry.path : parentOf(entry.path);
      showContextMenu(e.clientX, e.clientY, {
        path: entry.path,
        name: entry.name,
        isDir: entry.is_dir,
        isScratch: false,
        isRoot: false,
        row: el,
      });
    };

    const wrap = document.createElement("div");
    wrap.dataset.nodeWrap = entry.path;
    wrap.appendChild(el);
    return wrap;
  }

  function parentOf(p: string): string {
    const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return idx > 0 ? p.slice(0, idx) : (rootPath ?? p);
  }

  async function toggleExpand(state: NodeState) {
    debugExplorerTree("filesystem caret toggle", {
      path: state.entry.path,
      wasExpanded: state.expanded,
      selected: selectedDir,
    });
    if (state.expanded) {
      if (state.childrenWrap) state.childrenWrap.remove();
      state.childrenWrap = null;
      state.expanded = false;
      state.el.classList.remove("expanded");
      for (const path of [...byPath.keys()]) {
        if (isDescendant(path, state.entry.path)) byPath.delete(path);
      }
      if (selectedPath && isSameOrDescendant(selectedPath, state.entry.path)) {
        // If a descendant was selected, move selection to this folder.
        // If this folder itself was selected, keep it selected.
        selectedPath = state.entry.path;
        selectedDir = parentOf(state.entry.path);
        syncFilesystemSelection();
      }
      debugExplorerTree("filesystem folder collapsed", {
        path: state.entry.path,
        selectedAfter: selectedDir,
      });
      const iconSpan = state.el.querySelector(".tree-icon");
      if (iconSpan) iconSpan.innerHTML = folderClosedSvg;
      return;
    }
    await expand(state);
  }

  async function expand(state: NodeState) {
    if (state.expanded) return;
    const childWrap = document.createElement("div");
    childWrap.className = "tree-children";
    const children = await ipc.fsList(state.entry.path);
    for (const e of children) {
      childWrap.appendChild(buildNode(e, state.depth + 1));
    }
    state.el.parentElement!.appendChild(childWrap);
    state.childrenWrap = childWrap;
    state.expanded = true;
    state.el.classList.add("expanded");
    const iconSpan = state.el.querySelector(".tree-icon");
    if (iconSpan) iconSpan.innerHTML = folderOpenSvg;
    debugExplorerTree("filesystem folder expanded", {
      path: state.entry.path,
      selected: selectedDir,
    });
  }

  async function refreshLevel(dir: string) {
    if (!rootPath) return;
    if (samePath(dir, rootPath)) {
      const entries = await ipc.fsList(rootPath);
      // Preserve expansion state for paths that still exist.
      const previouslyExpanded = new Set<string>();
      for (const [p, s] of byPath) {
        if (s.expanded) previouslyExpanded.add(p);
      }
      host.innerHTML = "";
      byPath.clear();
      for (const e of entries) {
        host.appendChild(buildNode(e, 0));
      }
      for (const p of previouslyExpanded) {
        const s = byPath.get(p);
        if (s) await expand(s);
      }
      syncFilesystemSelection();
      return;
    }
    const state = findStateByPath(dir);
    if (!state || !state.expanded) return;
    const previouslyExpanded = new Set<string>();
    if (state.childrenWrap) {
      state.childrenWrap.querySelectorAll<HTMLElement>(".file-tree-node").forEach((el) => {
        for (const [p, s] of byPath) {
          if (s.el === el && s.expanded) previouslyExpanded.add(p);
        }
      });
      // Drop child entries from byPath.
      const toDelete: string[] = [];
      for (const [p] of byPath) {
        if (p !== dir && isDescendant(p, dir)) toDelete.push(p);
      }
      for (const p of toDelete) byPath.delete(p);
      state.childrenWrap.innerHTML = "";
    } else {
      return;
    }
    const children = await ipc.fsList(dir);
    for (const e of children) {
      state.childrenWrap.appendChild(buildNode(e, state.depth + 1));
    }
    for (const p of previouslyExpanded) {
      const s = byPath.get(p);
      if (s) await expand(s);
    }
    syncFilesystemSelection();
  }

  function findStateByPath(p: string): NodeState | undefined {
    for (const [key, s] of byPath) {
      if (samePath(key, p)) return s;
    }
    return undefined;
  }

  function samePath(a: string, b: string): boolean {
    const na = a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const nb = b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return na === nb;
  }

  function isDescendant(child: string, parent: string): boolean {
    const c = child.replace(/\\/g, "/").toLowerCase();
    const p = parent.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return c.startsWith(`${p}/`);
  }

  function isSameOrDescendant(child: string, parent: string): boolean {
    return samePath(child, parent) || isDescendant(child, parent);
  }

  function clearSelectedRows() {
    host
      .querySelectorAll(".file-tree-node.selected")
      .forEach((n) => n.classList.remove("selected"));
  }

  function syncFilesystemSelection() {
    clearSelectedRows();
    const activeSelection = selectedPath ?? selectedDir;
    if (!activeSelection || (rootPath && samePath(activeSelection, rootPath))) {
      selectedDir = null;
      selectedPath = null;
      return;
    }
    const state = findStateByPath(activeSelection);
    if (!state) {
      selectedDir = null;
      selectedPath = null;
      return;
    }
    state.el.classList.add("selected");
  }

  // ── Inline create input ────────────────────────────────────────────────────
  async function beginCreate(kind: CreateKind, explicitTargetDir?: string) {
    if (scratchRoot) {
      beginScratchCreate(kind, explicitTargetDir);
      return;
    }
    if (!rootPath) return;
    cancelPendingInput();

    let targetDir = explicitTargetDir;
    if (!targetDir && selectedPath) {
      const state = findStateByPath(selectedPath);
      if (state) {
        if (state.entry.is_dir) {
          // Only use a selected folder as implicit target if it's expanded.
          // Collapsed folders should not capture toolbar creation actions;
          // fall back to the folder's parent instead of workspace root.
          if (state.expanded) {
            targetDir = state.entry.path;
          } else {
            targetDir = parentOf(state.entry.path);
          }
        } else {
          targetDir = parentOf(state.entry.path);
        }
      }
    }
    if (!targetDir) {
      targetDir = rootPath;
    }
    let container: HTMLElement;
    let depth: number;

    if (samePath(targetDir, rootPath)) {
      container = host;
      depth = 0;
    } else {
      const state = findStateByPath(targetDir);
      if (!state) return;
      if (!state.expanded) await expand(state);
      container = state.childrenWrap!;
      depth = state.depth + 1;
    }

    const row = buildInputRow(kind, depth, async (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const full = joinPath(targetDir, trimmed);
      try {
        if (kind === "file") {
          await ipc.fsCreateFile(full);
        } else {
          await ipc.fsCreateDir(full);
        }
        selectedPath = full;
        selectedDir = kind === "folder" ? full : targetDir;
        await refreshLevel(targetDir);
        if (kind === "file") {
          fileCreatedHandler?.(full);
        }
      } catch (e) {
        // Visual: blink the row red briefly then keep it editable.
        row.classList.add("create-error");
        row.title = String(e);
        setTimeout(() => row.classList.remove("create-error"), 600);
        const input = row.querySelector("input");
        input?.focus();
        throw e;
      }
    });

    container.insertBefore(row, container.firstChild);
    pendingInput = row;
    const input = row.querySelector("input")!;
    input.focus();
  }

  function buildInputRow(
    kind: CreateKind,
    depth: number,
    onSubmit: (name: string) => Promise<void>
  ): HTMLElement {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "file-tree-node create-row";
    row.style.paddingLeft = `${12 + depth * 14}px`;

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    row.appendChild(twisty);

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = kind === "folder" ? folderClosedSvg : genericFileSvg;
    row.appendChild(icon);

    const input = document.createElement("input");
    input.className = "create-input";
    input.type = "text";
    input.placeholder = kind === "folder" ? "folder name" : "file name";
    input.spellcheck = false;
    input.autocomplete = "off";
    row.appendChild(input);

    let submitted = false;
    const submit = async () => {
      if (submitted) return;
      submitted = true;
      const value = input.value;
      if (!value.trim()) {
        cancelPendingInput();
        return;
      }
      try {
        await onSubmit(value);
        if (pendingInput === wrap) pendingInput = null;
        wrap.remove();
      } catch {
        submitted = false;
        input.focus();
        input.select();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelPendingInput();
      }
    });
    input.addEventListener("blur", () => {
      // Defer so click-on-another-tree-row doesn't race.
      setTimeout(() => {
        if (pendingInput === wrap && !submitted) cancelPendingInput();
      }, 100);
    });

    wrap.appendChild(row);
    return wrap;
  }

  function cancelPendingInput() {
    if (pendingInput) {
      pendingInput.remove();
      pendingInput = null;
    }
  }

  // ── Context menu ──────────────────────────────────────────────────────────
  let activeMenu: HTMLElement | null = null;
  interface ContextTarget {
    path: string;
    name: string;
    isDir: boolean;
    isScratch: boolean;
    isRoot: boolean;
    row: HTMLElement;
  }

  function showContextMenu(x: number, y: number, target: ContextTarget) {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "explorer-context-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const mkItem = (label: string, fn: () => void) => {
      const it = document.createElement("button");
      it.className = "explorer-context-item";
      it.textContent = label;
      it.onclick = () => {
        closeContextMenu();
        fn();
      };
      return it;
    };
    const contextDir = target.isDir
      ? target.path
      : target.isScratch
        ? scratchParentOf(target.path)
        : parentOf(target.path);
    menu.appendChild(mkItem("New File", () => beginCreate("file", contextDir)));
    menu.appendChild(mkItem("New Folder", () => beginCreate("folder", contextDir)));
    menu.appendChild(mkItem("Rename", () => beginRename(target)));
    menu.appendChild(mkItem("Delete", () => {
      deleteTarget(target).catch(() => {});
    }));
    document.body.appendChild(menu);
    activeMenu = menu;

    const off = (e: MouseEvent) => {
      if (activeMenu && !activeMenu.contains(e.target as Node)) closeContextMenu();
    };
    setTimeout(() => document.addEventListener("mousedown", off, { once: true }), 0);
  }

  function renderScratchRoot() {
    if (!scratchRoot) return;
    debugExplorerTree("render scratch root", {
      selected: scratchSelectedPath ?? scratchSelectedDir,
      expanded: [...scratchExpanded],
    });
    host.innerHTML = "";
    scratchContainers.clear();
    scratchDepths.clear();

    const rootWrap = document.createElement("div");
    const rootRow = document.createElement("div");
    
    // Force workspace root to always be expanded internally
    if (!scratchExpanded.has(scratchRoot.path)) {
      scratchExpanded.add(scratchRoot.path);
    }

    rootRow.className =
      "file-tree-node scratch-root-node" +
      (samePath(scratchSelectedPath ?? scratchSelectedDir ?? "", scratchRoot.path) ? " selected" : "");
    rootRow.style.paddingLeft = "24px"; // align nicely with twisties of children

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = scratchRoot.name;
    rootRow.appendChild(name);

    rootRow.onclick = () => {
      selectScratchRow(rootRow, scratchRoot!.path);
    };
    rootRow.oncontextmenu = (e) => {
      e.preventDefault();
      selectScratchRow(rootRow, scratchRoot!.path);
      showContextMenu(e.clientX, e.clientY, {
        path: scratchRoot!.path,
        name: scratchRoot!.name,
        isDir: true,
        isScratch: true,
        isRoot: true,
        row: rootRow,
      });
    };
    rootWrap.appendChild(rootRow);

    scratchDepths.set(scratchRoot.path, 0);
    const childWrap = document.createElement("div");
    childWrap.className = "tree-children";
    scratchContainers.set(scratchRoot.path, childWrap);
    for (const child of scratchRoot.children) {
      childWrap.appendChild(buildScratchNode(child, 1));
    }
    rootWrap.appendChild(childWrap);
    host.appendChild(rootWrap);
  }

  function buildScratchNode(entry: ScratchEntry, depth: number): HTMLElement {
    const wrap = document.createElement("div");
    const el = document.createElement("div");
    const isDir = entry.kind === "folder";
    const expanded = isDir && scratchExpanded.has(entry.path);
    const isSelected = samePath(scratchSelectedPath ?? scratchSelectedDir ?? "", entry.path);
    el.className =
      "file-tree-node" +
      (expanded ? " expanded" : "") +
      (isSelected ? " selected" : "");
    el.style.paddingLeft = `${12 + depth * 14}px`;

    const twisty = document.createElement("span");
    twisty.className = isDir ? "twisty folder-twisty" : "twisty";
    twisty.innerHTML = isDir ? chevronRightSvg : "";
    if (isDir) {
      twisty.onclick = (e) => {
        e.stopPropagation();
        debugExplorerTree("scratch caret click", {
          path: entry.path,
          wasExpanded: scratchExpanded.has(entry.path),
          selected: scratchSelectedPath ?? scratchSelectedDir,
          expanded: [...scratchExpanded],
        });
        if (scratchExpanded.has(entry.path)) {
          collapseScratchFolder(entry.path);
        } else {
          scratchExpanded.add(entry.path);
          debugExplorerTree("scratch folder expanded", {
            path: entry.path,
            selected: scratchSelectedPath ?? scratchSelectedDir,
            expanded: [...scratchExpanded],
          });
          renderScratchRoot();
        }
      };
    }
    el.appendChild(twisty);

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = isDir ? (expanded ? folderOpenSvg : folderClosedSvg) : fileIconFor(entry.name);
    el.appendChild(icon);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    el.appendChild(name);

    el.onclick = () => {
      selectScratchRow(el, entry.path);
      if (entry.kind !== "folder") {
        openHandler?.(entry.path);
      }
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      selectScratchRow(el, entry.path);
      showContextMenu(e.clientX, e.clientY, {
        path: entry.path,
        name: entry.name,
        isDir,
        isScratch: true,
        isRoot: false,
        row: el,
      });
    };

    wrap.appendChild(el);
    if (entry.kind === "folder" && expanded) {
      const childWrap = document.createElement("div");
      childWrap.className = "tree-children";
      scratchContainers.set(entry.path, childWrap);
      scratchDepths.set(entry.path, depth);
      for (const child of entry.children) {
        childWrap.appendChild(buildScratchNode(child, depth + 1));
      }
      wrap.appendChild(childWrap);
    }
    return wrap;
  }

  function selectScratchRow(row: HTMLElement, path: string) {
    document
      .querySelectorAll(".file-tree-node.selected")
      .forEach((n) => n.classList.remove("selected"));
    row.classList.add("selected");
    scratchSelectedPath = path;
    const entry = findScratchEntry(path);
    if (entry && entry.kind === "folder") {
      scratchSelectedDir = entry.path;
    } else {
      scratchSelectedDir = scratchParentOf(path);
    }
  }

  function beginScratchCreate(kind: CreateKind, explicitTargetDir?: string) {
    if (!scratchRoot) return;
    
    console.log(`\n--- [RUNTIME_DEBUG] beginScratchCreate ---`);
    console.log(`[RUNTIME_DEBUG] full scratch tree:`, JSON.stringify(scratchRoot, null, 2));
    console.log(`[RUNTIME_DEBUG] requested kind: ${kind}`);
    console.log(`[RUNTIME_DEBUG] explicitTargetDir: ${explicitTargetDir}`);
    console.log(`[RUNTIME_DEBUG] scratchSelectedPath: ${scratchSelectedPath}`);
    console.log(`[RUNTIME_DEBUG] scratchSelectedDir: ${scratchSelectedDir}`);
    console.log(`[RUNTIME_DEBUG] scratchRoot.path: ${scratchRoot.path}`);

    cancelPendingInput();

    let targetDir = explicitTargetDir;
    let targetSource = "explicit";

    if (!targetDir && scratchSelectedPath) {
      const entry = findScratchEntry(scratchSelectedPath);
      if (entry) {
        console.log(`[RUNTIME_DEBUG] resolved entry.path: ${entry.path}`);
        console.log(`[RUNTIME_DEBUG] entry.kind === "folder": ${entry.kind === "folder"}`);
        console.log(`[RUNTIME_DEBUG] scratchExpanded.has(entry.path): ${scratchExpanded.has(entry.path)}`);
        
        if (entry.kind === "folder") {
          // Only use a selected folder as implicit target if it's expanded.
          // Collapsed folders should not capture toolbar creation actions;
          // fall back to the folder's parent instead of scratch root.
          if (scratchExpanded.has(entry.path)) {
            targetDir = entry.path;
            targetSource = "selected folder (expanded)";
          } else {
            targetDir = scratchParentOf(entry.path);
            targetSource = "selected folder (collapsed, fallback to parent)";
          }
        } else {
          targetDir = scratchParentOf(entry.path);
          targetSource = "selected file (fallback to parent)";
        }
      } else {
        console.log(`[RUNTIME_DEBUG] findScratchEntry returned null for ${scratchSelectedPath}`);
      }
    }
    if (!targetDir) {
      targetDir = scratchRoot.path;
      targetSource = "root fallback";
    }

    console.log(`[RUNTIME_DEBUG] final targetDir: ${targetDir}`);
    console.log(`[RUNTIME_DEBUG] targetSource: ${targetSource}`);
    console.log(`------------------------------------------\n`);

    debugExplorerTree("begin scratch create", {
      kind,
      explicitTargetDir,
      selected: scratchSelectedPath,
      targetDir,
      expanded: [...scratchExpanded],
    });
    if (!scratchExpanded.has(targetDir)) {
      scratchExpanded.add(targetDir);
      renderScratchRoot();
    }
    const container = scratchContainers.get(targetDir);
    if (!container) return;
    const depth = (scratchDepths.get(targetDir) ?? 0) + 1;

    const row = buildInputRow(kind, depth, async (name) => {
      const trimmed = name.trim();
      if (!trimmed || !scratchRoot) return;
      const parent = findScratchFolder(targetDir);
      if (!parent) return;
      const full = joinPath(targetDir, trimmed);
      if (scratchChildExists(parent, trimmed)) {
        row.classList.add("create-error");
        row.title = `${trimmed} already exists`;
        setTimeout(() => row.classList.remove("create-error"), 600);
        const input = row.querySelector("input");
        input?.focus();
        throw new Error(`${trimmed} already exists`);
      }
      const entry: ScratchEntry = kind === "file"
        ? { kind: "file", name: trimmed, path: full, content: "" }
        : { kind: "folder", name: trimmed, path: full, children: [] };
      parent.children.unshift(entry);
      if (entry.kind === "folder") {
        scratchExpanded.add(entry.path);
      }
      scratchSelectedPath = entry.path;
      scratchSelectedDir = entry.kind === "folder" ? entry.path : targetDir;
      debugExplorerTree("scratch create committed", {
        kind,
        targetDir,
        createdPath: entry.path,
        selected: scratchSelectedPath,
        expanded: [...scratchExpanded],
      });
      renderScratchRoot();
      if (entry.kind === "file") {
        fileCreatedHandler?.(entry.path);
      }
    });

    container.insertBefore(row, container.firstChild);
    pendingInput = row;
    const input = row.querySelector("input")!;
    input.focus();
  }

  function collapseScratchFolder(path: string) {
    console.log(`\n--- [RUNTIME_DEBUG] collapseScratchFolder ---`);
    console.log(`[RUNTIME_DEBUG] collapsed path: ${path}`);
    console.log(`[RUNTIME_DEBUG] scratchExpanded before:`, [...scratchExpanded]);
    console.log(`[RUNTIME_DEBUG] scratchSelectedPath before: ${scratchSelectedPath}`);
    console.log(`[RUNTIME_DEBUG] scratchSelectedDir before: ${scratchSelectedDir}`);

    debugExplorerTree("scratch folder collapse requested", {
      path,
      selectedBefore: scratchSelectedPath,
      expandedBefore: [...scratchExpanded],
    });
    scratchExpanded.delete(path);
    for (const expandedPath of [...scratchExpanded]) {
      if (isDescendant(expandedPath, path)) scratchExpanded.delete(expandedPath);
    }
    if (scratchSelectedPath && isSameOrDescendant(scratchSelectedPath, path)) {
      // If a descendant was selected, move selection to this folder.
      // If this folder itself was selected, keep it selected.
      // Mirrors the filesystem toggleExpand collapse behavior.
      scratchSelectedPath = path;
      scratchSelectedDir = scratchParentOf(path);
    }

    console.log(`[RUNTIME_DEBUG] scratchExpanded after:`, [...scratchExpanded]);
    console.log(`[RUNTIME_DEBUG] scratchSelectedPath after: ${scratchSelectedPath}`);
    console.log(`[RUNTIME_DEBUG] scratchSelectedDir after: ${scratchSelectedDir}`);
    console.log(`------------------------------------------\n`);

    debugExplorerTree("scratch folder collapsed", {
      path,
      selectedAfter: scratchSelectedPath,
      expandedAfter: [...scratchExpanded],
    });
    renderScratchRoot();
  }

  function beginRename(target: ContextTarget) {
    cancelPendingInput();
    if (target.isScratch) {
      beginScratchRename(target);
      return;
    }
    beginFilesystemRename(target);
  }

  function beginFilesystemRename(target: ContextTarget) {
    const parent = parentOf(target.path);
    const row = buildInputRow(target.isDir ? "folder" : "file", 0, async (name) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === target.name) return;
      const next = joinPath(parent, trimmed);
      try {
        await ipc.fsRename(target.path, next);
        renameHandler?.(target.path, next, target.isDir);
        await refreshLevel(parent);
      } catch (e) {
        row.classList.add("create-error");
        row.title = String(e);
        setTimeout(() => row.classList.remove("create-error"), 600);
        const input = row.querySelector("input");
        input?.focus();
        throw e;
      }
    });
    replaceRowWithInput(target.row, row, target.name);
  }

  function beginScratchRename(target: ContextTarget) {
    const row = buildInputRow(target.isDir ? "folder" : "file", 0, async (name) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === target.name || !scratchRoot) return;
      if (target.isRoot) {
        scratchRoot.name = trimmed;
        scratchRootRenameHandler?.(trimmed);
        renderScratchRoot();
        return;
      }
      const parent = findScratchFolder(scratchParentOf(target.path));
      if (!parent) return;
      if (scratchChildExists(parent, trimmed)) {
        row.classList.add("create-error");
        row.title = `${trimmed} already exists`;
        setTimeout(() => row.classList.remove("create-error"), 600);
        const input = row.querySelector("input");
        input?.focus();
        throw new Error(`${trimmed} already exists`);
      }
      const entry = findScratchEntry(target.path);
      if (!entry) return;
      const oldPath = entry.path;
      const nextPath = joinPath(scratchParentOf(entry.path), trimmed);
      renameScratchEntry(entry, nextPath, trimmed);
      scratchSelectedPath = entry.path;
      scratchSelectedDir = entry.kind === "folder" ? entry.path : scratchParentOf(entry.path);
      renameHandler?.(oldPath, nextPath, entry.kind === "folder");
      renderScratchRoot();
    });
    replaceRowWithInput(target.row, row, target.name);
  }

  function replaceRowWithInput(row: HTMLElement, inputWrap: HTMLElement, value: string) {
    const container = row.parentElement;
    if (!container) return;
    container.insertBefore(inputWrap, row);
    row.style.display = "none";
    pendingInput = inputWrap;
    const input = inputWrap.querySelector("input")!;
    input.value = value;
    input.focus();
    input.select();
    input.addEventListener("blur", () => {
      setTimeout(() => {
        row.style.display = "";
      }, 120);
    }, { once: true });
  }

  async function deleteTarget(target: ContextTarget) {
    if (target.isScratch && target.isRoot) {
      scratchRootDeleteHandler?.();
      return;
    }
    if (confirmDeleteHandler && !(await confirmDeleteHandler(target.path, target.isDir))) {
      return;
    }
    if (target.isScratch) {
      const entry = findScratchEntry(target.path);
      if (!entry) return;
      const parent = findScratchFolder(scratchParentOf(target.path));
      if (!parent) return;
      parent.children = parent.children.filter((child) => !samePath(child.path, target.path));
      deleteHandler?.(target.path, entry.kind === "folder");
      renderScratchRoot();
      return;
    }
    try {
      await ipc.fsRemove(target.path);
      deleteHandler?.(target.path, target.isDir);
      await refreshLevel(parentOf(target.path));
    } catch {
      // Keep the menu lightweight; backend/log surfaces the detailed error.
    }
  }

  function findScratchEntry(path: string): ScratchEntry | null {
    if (!scratchRoot) return null;
    if (samePath(scratchRoot.path, path)) return scratchRoot;
    const stack = [...scratchRoot.children];
    while (stack.length > 0) {
      const entry = stack.shift()!;
      if (samePath(entry.path, path)) return entry;
      if (entry.kind === "folder") stack.push(...entry.children);
    }
    return null;
  }

  function renameScratchEntry(entry: ScratchEntry, nextPath: string, nextName: string) {
    const oldPath = entry.path;
    entry.path = nextPath;
    entry.name = nextName;
    if (entry.kind === "folder") {
      const children = [...entry.children];
      while (children.length > 0) {
        const child = children.shift()!;
        child.path = joinPath(entry.path, child.path.slice(oldPath.length).replace(/^[\\/]+/, ""));
        if (child.kind === "folder") children.push(...child.children);
      }
    }
  }

  function findScratchFolder(path: string): ScratchFolder | null {
    if (!scratchRoot) return null;
    if (samePath(scratchRoot.path, path)) return scratchRoot;
    const stack = [...scratchRoot.children];
    while (stack.length > 0) {
      const entry = stack.shift()!;
      if (entry.kind === "folder") {
        if (samePath(entry.path, path)) return entry;
        stack.push(...entry.children);
      }
    }
    return null;
  }

  function scratchChildExists(parent: ScratchFolder, name: string) {
    const key = name.toLowerCase();
    return parent.children.some((child) => child.name.toLowerCase() === key);
  }

  function scratchParentOf(p: string): string {
    const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return idx > 0 ? p.slice(0, idx) : (scratchRoot?.path ?? p);
  }
  function closeContextMenu() {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
  }

  // Click on empty area deselects so new-file targets the workspace root.
  host.addEventListener("click", (e) => {
    if (e.target === host) {
      document
        .querySelectorAll(".file-tree-node.selected")
        .forEach((n) => n.classList.remove("selected"));
      selectedPath = null;
      selectedDir = null;
      scratchSelectedPath = scratchRoot?.path ?? null;
      scratchSelectedDir = scratchRoot?.path ?? null;
    }
  });

  function applyEvent(evt: CoreEvent) {
    if (!rootPath || scratchRoot) return;
    if (
      evt.kind === "file_created" ||
      evt.kind === "file_removed" ||
      evt.kind === "file_renamed" ||
      evt.kind === "file_modified"
    ) {
      if (evt.kind === "file_renamed") {
        refreshLevel(parentOf(evt.from)).catch(() => {});
        refreshLevel(parentOf(evt.to)).catch(() => {});
        return;
      }
      if (evt.kind === "file_modified") {
        // Content-only edits: indicator is owned by fileSync; tree structure unchanged.
        return;
      }
      const path = evt.path;
      const parent = parentOf(path);
      refreshLevel(parent).catch(() => {});
    }
  }

  return {
    setRoot,
    setScratchRoot,
    clearScratchRoot,
    onOpenFile(handler) {
      openHandler = handler;
    },
    onFileCreated(handler) {
      fileCreatedHandler = handler;
    },
    onRename(handler) {
      renameHandler = handler;
    },
    onDelete(handler) {
      deleteHandler = handler;
    },
    onConfirmDelete(handler) {
      confirmDeleteHandler = handler;
    },
    onScratchRootRename(handler) {
      scratchRootRenameHandler = handler;
    },
    onScratchRootDelete(handler) {
      scratchRootDeleteHandler = handler;
    },
    beginCreate,
    applyEvent,
    markExternalChange,
    clearExternalChange,
    moveExternalChange,
    clearAllExternalChanges,
  };
}
