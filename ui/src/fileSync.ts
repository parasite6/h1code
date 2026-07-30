// External file sync — reacts to watcher events + quiet open-buffer checkups.
// Keeps baselines (mtime/size), tree drift dots, and the active-buffer banner.

import { ipc, type CoreEvent, type FileStat } from "./ipc";
import { isTemporaryPath, type Tab, type TabsBinding } from "./tabs";
import type { ExplorerBinding } from "./explorer";
import type { EditorBinding } from "./editor";

export interface FileBaseline {
  mtime_ms: number | null;
  size: number | null;
}

export type FileSyncBannerKind = "modified" | "modified_dirty" | "deleted";

export interface FileSyncDeps {
  tabs: TabsBinding;
  explorer: ExplorerBinding;
  editor: EditorBinding;
  bannerEl: HTMLElement;
  messageEl: HTMLElement;
  actionsEl: HTMLElement;
  normPath: (p: string) => string;
  /** Directory moves: true when `from` was a directory (best-effort). */
  pathIsDescendant: (path: string, ancestor: string) => boolean;
  replacePathPrefix: (path: string, from: string, to: string) => string;
  basename: (path: string) => string;
  /** Persist tab state after path changes. */
  onTabsChanged?: () => void;
  /** Notify language server after content reload / rename. */
  onDocReloaded?: (path: string, content: string) => void;
  onDocRenamed?: (from: string, to: string) => void;
  onSaveAs?: (path: string) => void | Promise<void>;
}

const CHECKUP_MS = 120_000;
/** External editors often delete+recreate (or rename via temp) within this window. */
const ATOMIC_SAVE_MS = 500;

export interface FileSyncBinding {
  noteBaseline(path: string, stat?: FileStat | null): Promise<void>;
  clearBaseline(path: string): void;
  clearDrift(path: string): void;
  handleEvent(evt: CoreEvent): void;
  startCheckup(): void;
  stopCheckup(): void;
  clear(): void;
  /** Re-show banner if the newly active tab is still drifted. */
  onActiveTab(tab: Tab | null): void;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Temp/backup names used by atomic-save editors (gedit, Kate, vim, etc.). */
function looksLikeTempOrBackupName(name: string): boolean {
  if (name.endsWith("~") || name.endsWith(".tmp") || name.endsWith(".bak") || name.endsWith(".swp")) {
    return true;
  }
  if (name.startsWith(".#") || name.startsWith("#") || name.endsWith("#")) return true;
  // Hidden temp like `.goutput-XXXX` / `.filename.tmp` / `.#file`
  if (name.startsWith(".") && (name.includes("goutput") || name.includes("tmp") || name.startsWith(".#"))) {
    return true;
  }
  return false;
}

function looksLikeBackupOf(fromPath: string, toPath: string): boolean {
  const from = baseName(fromPath);
  const to = baseName(toPath);
  if (to === `${from}~` || to === `${from}.bak` || to === `${from}.old`) return true;
  if (to === `#${from}#` || to === `.#${from}`) return true;
  return looksLikeTempOrBackupName(to);
}

export function createFileSync(deps: FileSyncDeps): FileSyncBinding {
  const baselines = new Map<string, FileBaseline>();
  /** Paths with known external content drift (open or not). */
  const drifted = new Set<string>();
  /** Open tabs whose on-disk file was deleted externally. */
  const deleted = new Set<string>();
  /** Debounced removes — cancelled if the path is recreated (atomic save). */
  const pendingRemoves = new Map<string, ReturnType<typeof setTimeout>>();
  let checkupTimer: ReturnType<typeof setInterval> | null = null;
  let bannerPath: string | null = null;
  let bannerKind: FileSyncBannerKind | null = null;

  function keyOf(path: string): string {
    return deps.normPath(path);
  }

  function findOpenTab(path: string): Tab | null {
    const want = keyOf(path);
    return deps.tabs.all().find((t) => keyOf(t.path) === want) ?? null;
  }

  function isDiskBacked(path: string): boolean {
    return !isTemporaryPath(path);
  }

  async function noteBaseline(path: string, stat?: FileStat | null): Promise<void> {
    if (!isDiskBacked(path)) return;
    const st = stat ?? (await ipc.fsStat(path).catch(() => null));
    if (!st || !st.exists) {
      baselines.delete(keyOf(path));
      return;
    }
    baselines.set(keyOf(path), {
      mtime_ms: st.mtime_ms,
      size: st.size,
    });
  }

  function clearBaseline(path: string): void {
    baselines.delete(keyOf(path));
  }

  function moveBaseline(from: string, to: string): void {
    const fromKey = keyOf(from);
    const base = baselines.get(fromKey);
    baselines.delete(fromKey);
    if (base) baselines.set(keyOf(to), base);
  }

  function markDrift(path: string): void {
    const k = keyOf(path);
    drifted.add(k);
    deps.explorer.markExternalChange(path);
  }

  function clearDrift(path: string): void {
    const want = keyOf(path);
    for (const p of [...drifted]) {
      if (p === want) drifted.delete(p);
    }
    deleted.delete(want);
    deps.explorer.clearExternalChange(path);
  }

  function hideBanner(): void {
    bannerPath = null;
    bannerKind = null;
    deps.bannerEl.classList.remove("visible");
    deps.messageEl.textContent = "";
    deps.actionsEl.replaceChildren();
  }

  function showBanner(path: string, kind: FileSyncBannerKind): void {
    bannerPath = path;
    bannerKind = kind;
    deps.bannerEl.classList.add("visible");
    deps.actionsEl.replaceChildren();

    const addBtn = (label: string, primary: boolean, onClick: () => void) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      if (primary) btn.className = "primary";
      btn.onclick = () => void onClick();
      deps.actionsEl.appendChild(btn);
    };

    if (kind === "modified") {
      deps.messageEl.textContent = "File changed outside of IDE.";
      addBtn("Reload", true, () => void reloadFromDisk(path));
    } else if (kind === "modified_dirty") {
      deps.messageEl.textContent =
        "This file changed on disk since you opened it.";
      addBtn("Keep mine", false, () => void keepMine(path));
      addBtn("Reload from disk", true, () => void reloadFromDisk(path));
    } else {
      deps.messageEl.textContent = "File deleted outside of IDE.";
      addBtn("Keep", false, () => {
        // Accept orphan buffer; stop nagging until next checkup/removal.
        deleted.delete(keyOf(path));
        hideBanner();
      });
      addBtn("Save as…", true, () => {
        hideBanner();
        void deps.onSaveAs?.(path);
      });
    }
  }

  async function reloadFromDisk(path: string): Promise<void> {
    try {
      const content = await ipc.fsRead(path);
      deps.tabs.setContent(path, content, { dirty: false });
      const active = deps.tabs.active();
      if (active && keyOf(active.path) === keyOf(path)) {
        deps.editor.setDoc(content, path);
      }
      await noteBaseline(path);
      clearDrift(path);
      hideBanner();
      deps.onDocReloaded?.(path, content);
      deps.onTabsChanged?.();
    } catch (e) {
      deps.messageEl.textContent = `Reload failed: ${String(e)}`;
    }
  }

  async function keepMine(path: string): Promise<void> {
    // Accept divergence: refresh baseline to current disk so checkup won't re-nag
    // until the file changes again. Editor content stays as-is (still dirty).
    await noteBaseline(path);
    clearDrift(path);
    hideBanner();
  }

  function refreshBannerForActive(): void {
    const active = deps.tabs.active();
    if (!active || !isDiskBacked(active.path)) {
      hideBanner();
      return;
    }
    const k = keyOf(active.path);
    if (deleted.has(k)) {
      showBanner(active.path, "deleted");
      return;
    }
    if (drifted.has(k)) {
      showBanner(active.path, active.dirty ? "modified_dirty" : "modified");
      return;
    }
    if (bannerPath && keyOf(bannerPath) === k) {
      hideBanner();
    } else if (!bannerPath) {
      // nothing
    } else {
      // Active tab is clean of drift; hide if banner was for another path.
      hideBanner();
    }
  }

  function handleModified(path: string): void {
    if (!isDiskBacked(path)) return;
    // A modify means the path exists again — cancel any pending delete handling.
    cancelPendingRemove(path);
    deleted.delete(keyOf(path));
    markDrift(path);
    const tab = findOpenTab(path);
    const active = deps.tabs.active();
    if (tab && active && keyOf(active.path) === keyOf(path)) {
      showBanner(path, tab.dirty ? "modified_dirty" : "modified");
    }
  }

  function cancelPendingRemove(path: string): void {
    const k = keyOf(path);
    const t = pendingRemoves.get(k);
    if (t) {
      clearTimeout(t);
      pendingRemoves.delete(k);
    }
  }

  function finalizeRemove(path: string): void {
    pendingRemoves.delete(keyOf(path));
    markDrift(path);
    const tab = findOpenTab(path);
    if (!tab) return;
    if (!tab.dirty) {
      deps.tabs.close(path);
      clearDrift(path);
      clearBaseline(path);
      hideBanner();
      deps.onTabsChanged?.();
      return;
    }
    deleted.add(keyOf(path));
    const active = deps.tabs.active();
    if (active && keyOf(active.path) === keyOf(path)) {
      showBanner(path, "deleted");
    }
  }

  function handleRemoved(path: string): void {
    if (!isDiskBacked(path)) return;
    const tab = findOpenTab(path);
    if (!tab) {
      markDrift(path);
      return;
    }
    // Debounce: atomic saves often remove then recreate within a few hundred ms.
    cancelPendingRemove(path);
    const k = keyOf(path);
    pendingRemoves.set(
      k,
      setTimeout(() => finalizeRemove(path), ATOMIC_SAVE_MS)
    );
  }

  async function applyRealRename(from: string, to: string): Promise<void> {
    const fromKey = keyOf(from);
    const affected = deps.tabs
      .all()
      .filter(
        (tab) =>
          isDiskBacked(tab.path) &&
          (keyOf(tab.path) === fromKey ||
            deps.pathIsDescendant(tab.path, from))
      );

    for (const tab of affected) {
      const oldPath = tab.path;
      const nextPath =
        keyOf(oldPath) === fromKey
          ? to
          : deps.replacePathPrefix(oldPath, from, to);
      deps.tabs.renamePath(oldPath, nextPath, deps.basename(nextPath));
      moveBaseline(oldPath, nextPath);
      deps.explorer.moveExternalChange(oldPath, nextPath);
      const dWant = keyOf(oldPath);
      if (drifted.has(dWant)) {
        drifted.delete(dWant);
        drifted.add(keyOf(nextPath));
      }
      if (deleted.has(dWant)) {
        deleted.delete(dWant);
        deleted.add(keyOf(nextPath));
      }
      cancelPendingRemove(oldPath);
      deps.onDocRenamed?.(oldPath, nextPath);
      await noteBaseline(nextPath);
    }

    if (affected.length === 0) {
      deps.explorer.moveExternalChange(from, to);
      moveBaseline(from, to);
    }

    deps.onTabsChanged?.();
    refreshBannerForActive();
  }

  async function handleRenamed(from: string, to: string): Promise<void> {
    const fromKey = keyOf(from);
    const toKey = keyOf(to);

    // Atomic save: temp → open file. Notify only — never auto-reload.
    if (findOpenTab(to) && looksLikeTempOrBackupName(baseName(from)) && fromKey !== toKey) {
      handleModified(to);
      return;
    }

    // Atomic save / backup copy: open file briefly renamed aside (file → file~).
    // Keep the tab on the original path; wait for recreate. If none arrives,
    // fall through to a real rename onto the backup name.
    if (findOpenTab(from) && looksLikeBackupOf(from, to)) {
      cancelPendingRemove(from);
      const k = keyOf(from);
      pendingRemoves.set(
        k,
        setTimeout(() => {
          pendingRemoves.delete(k);
          void applyRealRename(from, to);
        }, ATOMIC_SAVE_MS)
      );
      return;
    }

    // Same-path rename noise: treat as modify.
    if (fromKey === toKey) {
      if (findOpenTab(to)) handleModified(to);
      return;
    }

    await applyRealRename(from, to);
  }

  function handleCreated(path: string): void {
    if (!isDiskBacked(path)) return;
    const hadPendingRemove = pendingRemoves.has(keyOf(path));
    cancelPendingRemove(path);

    // Recreate after remove/rename-aside = atomic save → prompt, don't auto-load.
    if (hadPendingRemove || findOpenTab(path) || deleted.has(keyOf(path))) {
      deleted.delete(keyOf(path));
      handleModified(path);
      return;
    }
    clearDrift(path);
  }

  function handleEvent(evt: CoreEvent): void {
    if (evt.kind === "file_modified") {
      handleModified(evt.path);
      return;
    }
    if (evt.kind === "file_removed") {
      handleRemoved(evt.path);
      return;
    }
    if (evt.kind === "file_renamed") {
      void handleRenamed(evt.from, evt.to);
      return;
    }
    if (evt.kind === "file_created") {
      handleCreated(evt.path);
      return;
    }
    if (evt.kind === "workspace_closed") {
      clear();
    }
  }

  async function checkupOnce(): Promise<void> {
    const open = deps.tabs.all().filter((t) => isDiskBacked(t.path));
    for (const tab of open) {
      let st: FileStat;
      try {
        st = await ipc.fsStat(tab.path);
      } catch {
        continue;
      }
      const base = baselines.get(keyOf(tab.path));
      if (!st.exists) {
        await handleRemoved(tab.path);
        continue;
      }
      if (!base) {
        await noteBaseline(tab.path, st);
        continue;
      }
      const changed =
        st.mtime_ms !== base.mtime_ms || st.size !== base.size;
      if (changed) {
        handleModified(tab.path);
      }
    }
  }

  function startCheckup(): void {
    stopCheckup();
    checkupTimer = setInterval(() => {
      void checkupOnce();
    }, CHECKUP_MS);
  }

  function stopCheckup(): void {
    if (checkupTimer) {
      clearInterval(checkupTimer);
      checkupTimer = null;
    }
  }

  function clear(): void {
    stopCheckup();
    for (const t of pendingRemoves.values()) clearTimeout(t);
    pendingRemoves.clear();
    baselines.clear();
    drifted.clear();
    deleted.clear();
    deps.explorer.clearAllExternalChanges();
    hideBanner();
  }

  function onActiveTab(tab: Tab | null): void {
    if (!tab) {
      hideBanner();
      return;
    }
    refreshBannerForActive();
  }

  return {
    noteBaseline,
    clearBaseline,
    clearDrift,
    handleEvent,
    startCheckup,
    stopCheckup,
    clear,
    onActiveTab,
  };
}
