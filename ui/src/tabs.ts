// Tabs: open files, switch, close, modified marker. The model is editor-local
// state (the rule says: TS owns rendering + editor-local state only).

import { ipc } from "./ipc";

export interface Tab {
  path: string;
  name: string;
  content: string; // current editor snapshot
  dirty: boolean;
}

export interface TabsBinding {
  open(path: string): Promise<void>;
  /** Spawn a new untitled tab with no on-disk path. Returns the synthetic key. */
  openUntitled(): string;
  openTemporaryFile(name: string, content?: string): string;
  openVirtualFile(path: string, name: string, content?: string): void;
  /**
   * Open a real on-disk `path` using already-read `content` (e.g. a lossy read
   * of a binary the user chose to open anyway). Opens clean (not dirty).
   */
  openWithContent(path: string, name: string, content: string): void;
  /**
   * Insert a clean tab from already-read `content` WITHOUT activating it or
   * re-rendering. Used to batch-restore many tabs cheaply; caller must call
   * `render()` and `setActive()` once afterwards.
   */
  addBackground(path: string, name: string, content: string): void;
  close(path: string): void;
  renamePath(oldPath: string, newPath: string, newName?: string): void;
  get(path: string): Tab | null;
  /**
   * Replace buffered content for an open tab. When `dirty` is provided, updates
   * the dirty flag; otherwise leaves it unchanged.
   */
  setContent(path: string, content: string, opts?: { dirty?: boolean }): void;
  active(): Tab | null;
  setActive(path: string): void;
  updateActiveContent(content: string): void;
  markDirty(dirty: boolean): void;
  saveActive(currentEditorText: string): Promise<void>;
  /**
   * Move an open (typically untitled) tab to a real on-disk path, writing the
   * given contents to that path. If the target path is already open, that
   * existing tab is closed first.
   */
  relocate(oldPath: string, newPath: string, contents: string): Promise<void>;
  all(): Tab[];
  hasUnsavedChanges(): boolean;
  onActiveChange(handler: (tab: Tab | null) => void): void;
  /**
   * Intercept the close (X) button. If a handler is set, the X button calls
   * it instead of `close()` directly — main wires this to the confirm modal.
   */
  onCloseRequest(handler: (path: string) => void): void;
  render(): void;
}

export function isUntitledPath(path: string): boolean {
  return path.startsWith("untitled:");
}

export function isTemporaryPath(path: string): boolean {
  return path.startsWith("untitled:") || path.startsWith("scratch:");
}

// Crisp outline SVGs for tabs
const pythonFileSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3572A5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <path d="M8 13h6" stroke-width="1.5" opacity="0.6"></path>
    <path d="M8 17h6" stroke-width="1.5" opacity="0.6"></path>
  </svg>
`;

const genericFileSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8e8e93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>
`;

const closeSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
`;

export function mountTabs(host: HTMLElement): TabsBinding {
  const tabs = new Map<string, Tab>();
  let activePath: string | null = null;
  let listener: ((t: Tab | null) => void) | null = null;
  let closeRequest: ((p: string) => void) | null = null;
  let untitledCounter = 0;

  function render() {
    host.innerHTML = "";
    host.classList.toggle("multi-tab", tabs.size > 1);
    for (const tab of tabs.values()) {
      const el = document.createElement("div");
      el.className =
        "tab" +
        (tab.path === activePath ? " active" : "") +
        (tab.dirty ? " modified" : "");
      el.title = tab.path;
      
      const label = document.createElement("span");
      label.className = "tab-label";
      
      // Inject correct file SVG
      if (tab.name.toLowerCase().endsWith(".py") || tab.name.toLowerCase().endsWith(".pyi")) {
        label.innerHTML = pythonFileSvg;
      } else {
        label.innerHTML = genericFileSvg;
      }
      
      const textSpan = document.createElement("span");
      textSpan.className = "tab-name";
      textSpan.textContent = tab.name;
      label.appendChild(textSpan);
      el.appendChild(label);
      
      const indicator = document.createElement("span");
      indicator.className = "tab-indicator";
      
      const close = document.createElement("span");
      close.className = "close";
      close.innerHTML = closeSvg;
      close.onclick = (e) => {
        e.stopPropagation();
        if (closeRequest) {
          closeRequest(tab.path);
        } else {
          api.close(tab.path);
        }
      };
      
      indicator.appendChild(close);
      el.appendChild(indicator);
      el.onclick = () => api.setActive(tab.path);
      host.appendChild(el);
    }
  }

  const api: TabsBinding = {
    async open(path: string) {
      if (!tabs.has(path)) {
        const content = await ipc.fsRead(path);
        const name = path.split(/[\\/]/).pop() ?? path;
        tabs.set(path, { path, name, content, dirty: false });
      }
      api.setActive(path);
    },
    openUntitled() {
      untitledCounter += 1;
      const key = `untitled:${untitledCounter}`;
      const name = `Untitled-${untitledCounter}`;
      tabs.set(key, { path: key, name, content: "", dirty: true });
      api.setActive(key);
      return key;
    },
    openTemporaryFile(name: string, content = "") {
      untitledCounter += 1;
      const cleanName = name.trim() || `Untitled-${untitledCounter}`;
      const key = `untitled:${untitledCounter}`;
      tabs.set(key, { path: key, name: cleanName, content, dirty: true });
      api.setActive(key);
      return key;
    },
    openVirtualFile(path: string, name: string, content = "") {
      if (!tabs.has(path)) {
        tabs.set(path, { path, name, content, dirty: true });
      }
      api.setActive(path);
    },
    openWithContent(path: string, name: string, content: string) {
      if (!tabs.has(path)) {
        tabs.set(path, { path, name, content, dirty: false });
      }
      api.setActive(path);
    },
    addBackground(path: string, name: string, content: string) {
      if (!tabs.has(path)) {
        tabs.set(path, { path, name, content, dirty: false });
      }
    },
    close(path: string) {
      tabs.delete(path);
      if (activePath === path) {
        const next = tabs.keys().next().value ?? null;
        activePath = next;
        listener?.(next ? tabs.get(next)! : null);
      }
      render();
    },
    renamePath(oldPath: string, newPath: string, newName?: string) {
      const tab = tabs.get(oldPath);
      if (!tab) return;
      tabs.delete(oldPath);
      tab.path = newPath;
      tab.name = newName ?? newPath.split(/[\\/]/).pop() ?? newPath;
      tabs.set(newPath, tab);
      if (activePath === oldPath) activePath = newPath;
      render();
      if (activePath === newPath) listener?.(tab);
    },
    get(path: string) {
      return tabs.get(path) ?? null;
    },
    setContent(path: string, content: string, opts?: { dirty?: boolean }) {
      const tab = tabs.get(path);
      if (!tab) return;
      tab.content = content;
      if (opts && opts.dirty !== undefined) {
        tab.dirty = opts.dirty;
      }
      render();
      if (activePath === path) listener?.(tab);
    },
    active() {
      return activePath ? tabs.get(activePath) ?? null : null;
    },
    setActive(path: string) {
      if (!tabs.has(path)) return;
      activePath = path;
      render();
      listener?.(tabs.get(path)!);
    },
    updateActiveContent(content: string) {
      const tab = api.active();
      if (!tab) return;
      tab.content = content;
    },
    markDirty(dirty: boolean) {
      const tab = api.active();
      if (!tab) return;
      if (tab.dirty !== dirty) {
        tab.dirty = dirty;
        render();
      }
    },
    async saveActive(currentEditorText: string) {
      const tab = api.active();
      if (!tab) return;
      await ipc.fsWrite(tab.path, currentEditorText);
      tab.content = currentEditorText;
      tab.dirty = false;
      render();
    },
    async relocate(oldPath: string, newPath: string, contents: string) {
      const tab = tabs.get(oldPath);
      if (!tab) return;
      // If a different tab already holds the target path, drop it so we don't
      // end up with two tabs pointing to the same file.
      if (newPath !== oldPath && tabs.has(newPath)) {
        tabs.delete(newPath);
      }
      await ipc.fsWrite(newPath, contents);
      const name = newPath.split(/[\\/]/).pop() ?? newPath;
      tab.path = newPath;
      tab.name = name;
      tab.content = contents;
      tab.dirty = false;
      tabs.delete(oldPath);
      // Re-insert under the new key, preserving insertion order at the end is
      // fine for v1 — the visible position only matters for adjacent close UX.
      tabs.set(newPath, tab);
      if (activePath === oldPath) activePath = newPath;
      render();
      if (activePath === newPath) listener?.(tab);
    },
    all() {
      return Array.from(tabs.values());
    },
    hasUnsavedChanges() {
      for (const t of tabs.values()) if (t.dirty) return true;
      return false;
    },
    onActiveChange(handler) {
      listener = handler;
    },
    onCloseRequest(handler) {
      closeRequest = handler;
    },
    render,
  };
  return api;
}
