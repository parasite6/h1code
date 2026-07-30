// Wire the panels to ipc. No business logic — every action is a backend call,
// every notification is a backend event.

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { ipc, onCoreEvent, type CoreDiagnostic, type CoreEvent, type RecentProject, type WorkspaceInfo } from "./ipc";
import { mountEditor, destroyEditor } from "./editor";
import { mountTabs, isTemporaryPath, type Tab } from "./tabs";
import { mountMediaViewer } from "./mediaViewer";
import { isTextTabKind, classifyOpenPath } from "./fileKind";
import { mountExplorer, type ScratchEntry, type ScratchFile, type ScratchFolder } from "./explorer";
import { createFileSync } from "./fileSync";
import { confirmSave, promptName, type SaveDecision } from "./modal";
import { mountTerminal } from "./terminal";
import { mountProblems, type ProblemEntry } from "./problems";
import { mountSearch } from "./search";
import { mountPreview } from "./preview";
import {
  chooseRunTarget,
  rememberRunTarget,
  suppressRunPrompt,
  type RunTargetSuggestion,
} from "./runTarget";
import { CommandRegistry, registerDisabledCommand } from "./commands";
import { menuCommand, menuSeparator, menuSubmenu, mountMenus, type MenuItem } from "./menus";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// Path normalisation — backend uses native OS paths; tab keys must match
// diagnostic event paths after a round trip through file:// URIs.
function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Gated `[recent-debug]` logger — enable with localStorage `h1code.debug.recent=1`. */
function recentDebugEnabled(): boolean {
  try {
    return localStorage.getItem("h1code.debug.recent") === "1";
  } catch {
    return false;
  }
}

function pushRecentDebugEntry(label: string, payload: Record<string, unknown>) {
  const entry = { t: Date.now(), label, payload };
  try {
    const w = window as unknown as { __recentDebugLog?: Array<typeof entry> };
    if (!w.__recentDebugLog) w.__recentDebugLog = [];
    w.__recentDebugLog.push(entry);
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line no-console
  console.log("[recent-debug]", label, payload);
}

interface TempWorkspace {
  id: number;
  name: string;
  rootPath: string;
  children: ScratchEntry[];
}

async function bootstrap() {
  // Arm recent-debug before any load/persist so cold-start reads are captured.
  try {
    const params = new URLSearchParams(location.search);
    const phase = params.get("reproRecent");
    if (phase === "write" || phase === "read" || params.get("debugRecent") === "1") {
      localStorage.setItem("h1code.debug.recent", "1");
    }
    if (
      params.get("debugNewFolder") === "1" ||
      params.get("reproNewFolder") === "menu" ||
      params.get("reproNewFolder") === "sidebar"
    ) {
      localStorage.setItem("h1code.debug.newfolder", "1");
    }
  } catch {
    /* ignore */
  }

  let activePtyId: string | null = null;
  /** Whether the active PTY is an interactive shell or a one-shot Run. */
  let activePtyKind: "shell" | "run" | null = null;
  /** After a Run finishes, reopen a shell if the user was in shell mode before. */
  let restoreShellAfterRun = false;
  let changeTimer: number | null = null;
  let terminalFocused = false;

  // path-key -> { path, items } so we always know how to clear / re-render.
  const diagnostics = new Map<string, { path: string; items: CoreDiagnostic[] }>();

  const editor = mountEditor($("editor"), () => {
    tabs.updateActiveContent(editor.getDoc());
    syncActiveScratchFile();
    tabs.markDirty(true);
    scheduleDidChange();
  });
  const tabs = mountTabs($("tabs"));
  const mediaViewer = mountMediaViewer($("media-viewer"));
  const explorer = mountExplorer($("explorer-tree"));
  const terminal = mountTerminal($("terminal"));
  const problems = mountProblems($("problems"));
  const search = mountSearch($("panel-search"));
  const editorHost = $("editor");
  const mediaViewerHost = $("media-viewer");
  const editorEmptyState = $("editor-empty-state");
  const fileSyncBanner = $("file-sync-banner");
  const fileSyncMessage = fileSyncBanner.querySelector(".file-sync-message") as HTMLElement;
  const fileSyncActions = fileSyncBanner.querySelector(".file-sync-actions") as HTMLElement;
  const runButton = $("btn-run") as HTMLButtonElement;
  const runTargetPopover = $("run-target-popover");
  const runTargetSuggestion = $("run-target-suggestion");
  const runTargetCurrent = $("run-target-current");
  const runTargetSuppress = $("run-target-suppress");
  const preview = mountPreview({
    centerEl: $("center"),
    paneEl: $("preview-pane"),
    resizerEl: $("preview-resizer"),
    frameEl: $("preview-frame") as HTMLIFrameElement,
    chromePlaceholderEl: $("preview-chrome-placeholder"),
    statusEl: document.querySelector(".preview-status") as HTMLElement,
    engineBtn: $("btn-preview-engine") as HTMLButtonElement,
    popoutBtn: $("btn-preview-popout") as HTMLButtonElement,
    closeBtn: $("btn-preview-close") as HTMLButtonElement,
    onLog: (message) => terminal.log(message, { newPrompt: true }),
  });
  terminal.onFocusChange((focused) => {
    terminalFocused = focused;
  });

  const fileSync = createFileSync({
    tabs,
    explorer,
    editor,
    bannerEl: fileSyncBanner,
    messageEl: fileSyncMessage,
    actionsEl: fileSyncActions,
    normPath,
    pathIsDescendant: (path, ancestor) => pathIsDescendant(path, ancestor),
    replacePathPrefix: (path, from, to) => replacePathPrefix(path, from, to),
    basename: (path) => basename(path),
    onTabsChanged: () => {
      persistWorkspaceTabState().catch(() => {});
    },
    onDocReloaded: (path, content) => {
      if (/\.pyi?$/i.test(path) && content.length <= PYRIGHT_MAX_DOC_CHARS) {
        ipc.docDidClose(path).catch(() => {});
        ipc.docDidOpen(path, content).catch(() => {});
      }
      if (
        preview.isOpen() &&
        preview.currentFile() &&
        normPath(path) === normPath(preview.currentFile()!)
      ) {
        preview.reload(path).catch((err) =>
          terminal.log(`preview reload failed: ${String(err)}`, { newPrompt: true })
        );
      }
    },
    onDocRenamed: (from, to) => {
      const diagnostic = diagnostics.get(normPath(from));
      if (diagnostic) {
        diagnostics.delete(normPath(from));
        diagnostics.set(normPath(to), { ...diagnostic, path: to });
        refreshProblems();
      }
      if (/\.pyi?$/i.test(from)) {
        ipc.docDidClose(from).catch(() => {});
      }
      const tab = tabs.get(to);
      if (tab && /\.pyi?$/i.test(to) && tab.content.length <= PYRIGHT_MAX_DOC_CHARS) {
        ipc.docDidOpen(to, tab.content).catch(() => {});
      }
      if (preview.isOpen() && preview.currentFile() && normPath(from) === normPath(preview.currentFile()!)) {
        if (isHtmlPath(to)) {
          preview.open(to).catch(() => {});
        } else {
          preview.close().catch(() => {});
        }
      }
      syncRunButton();
    },
    onSaveAs: () => {
      void saveActiveAs();
    },
  });

  // ── IDE-wide zoom ────────────────────────────────────────────────────────
  const ZOOM_MIN  = 0.8;
  const ZOOM_MAX  = 1.5;
  const ZOOM_STEP = 0.1;
  const ZOOM_KEY  = "h1code.zoom";

  let zoomLevel: number = (() => {
    const v = parseFloat(localStorage.getItem(ZOOM_KEY) ?? "1");
    return Number.isFinite(v) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v)) : 1;
  })();

  async function applyZoom(z: number): Promise<void> {
    zoomLevel = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) * 100) / 100;
    // Native WebView zoom: the OS renderer scales the entire coordinate system,
    // so layout geometry, fonts, overlays, and panels all scale coherently.
    await getCurrentWebview().setZoom(zoomLevel);
    localStorage.setItem(ZOOM_KEY, zoomLevel.toFixed(2));
    window.dispatchEvent(new CustomEvent("ide:zoomchange"));
  }

  // Apply persisted zoom at startup. The IPC round-trip completes before the
  // user's first interaction; fire-and-forget is intentional here.
  applyZoom(zoomLevel);

  // Welcome-screen zoom tier. Native WebView zoom doesn't change CSS pixel
  // dimensions, so @container queries can't see it — we derive a tier from
  // zoomLevel directly and reflect it on <body> for CSS to key off.
  // Container queries still handle sidebar/panel/window resize separately.
  function updateWelcomeZoomTier() {
    let tier: "wide" | "medium" | "small" | "very-small";
    if      (zoomLevel >= 1.5) tier = "very-small";
    else if (zoomLevel >= 1.4) tier = "small";
    else if (zoomLevel >= 1.25) tier = "medium";
    else                       tier = "wide";
    document.body.dataset.welcomeZoomTier = tier;
  }
  updateWelcomeZoomTier();
  window.addEventListener("ide:zoomchange", updateWelcomeZoomTier);
  // WebView zoom changes layout metrics; force CodeMirror to remeasure so the
  // drawn caret doesn't drift relative to a stale native caret position.
  window.addEventListener("ide:zoomchange", () => {
    editor.view.requestMeasure();
  });

  let currentWorkspace: WorkspaceInfo | null = null;
  let recentProjects: RecentProject[] = [];
  let scratchWorkspace: TempWorkspace | null = null;
  let scratchWorkspaceCounter = 0;
  /** Active frictionless-run snapshot under `<workspace>/.h1code/run_temp_`, if any. */
  let activeRunTempDir: string | null = null;
  const RUN_TEMP_DIR_NAME = "run_temp_";
  const H1CODE_DIR_NAME = ".h1code";
  /** Skip sending buffers larger than this (chars) to Pyright — huge docs stall the LSP. */
  const PYRIGHT_MAX_DOC_CHARS = 1_000_000;

  function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  function recentDebug(label: string, extra?: Record<string, unknown>) {
    if (!recentDebugEnabled()) return;
    const payload = {
      workspace: currentWorkspace?.root ?? null,
      scratch: scratchWorkspace
        ? { root: scratchWorkspace.rootPath, name: scratchWorkspace.name }
        : null,
      recentCount: recentProjects.length,
      ...extra,
    };
    pushRecentDebugEntry(label, payload);
    try {
      terminal.log(`[recent-debug] ${label} ${JSON.stringify(payload)}`);
    } catch {
      /* terminal may not be ready during early boot */
    }
  }

  function getLocalRecentProjects(): RecentProject[] {
    try {
      const raw = localStorage.getItem("h1code.recentProjects");
      recentDebug("localStorage.read", {
        storageKey: "h1code.recentProjects",
        raw,
        rawLength: raw?.length ?? 0,
      });
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const filtered = list.filter(
          (p: any) => p && typeof p.path === "string" && typeof p.name === "string"
        );
        recentDebug("localStorage.parsed", {
          count: filtered.length,
          paths: filtered.map((p: RecentProject) => p.path),
        });
        return filtered;
      }
      recentDebug("localStorage.skip", { reason: "not-array" });
    } catch (e) {
      console.error("Error reading recent projects", e);
      recentDebug("localStorage.error", { error: String(e) });
    }
    return [];
  }

  /** Keep only recent project folders that still exist on disk.
   * Uses unjailed `recentProjectPathCheck` — NOT `fsList` — so cold-start
   * prune does not treat NoWorkspace / jail failure as "path missing".
   * Fail closed: keep on present or ambiguous error; drop only when missing.
   */
  async function pruneMissingRecentProjects(projects: RecentProject[]): Promise<RecentProject[]> {
    recentDebug("prune.start", {
      count: projects.length,
      paths: projects.map((p) => p.path),
      note: "uses ipc.recentProjectPathCheck (unjailed)",
    });
    const kept: RecentProject[] = [];
    for (const project of projects) {
      try {
        const check = await ipc.recentProjectPathCheck(project.path);
        if (check.status === "missing") {
          recentDebug("prune.drop", {
            path: project.path,
            reason: "missing",
            skip: "path positively absent or not a directory",
          });
          continue;
        }
        if (check.status === "error") {
          recentDebug("prune.keep", {
            path: project.path,
            reason: "check-error-fail-closed",
            message: check.message,
          });
        } else {
          recentDebug("prune.keep", { path: project.path, reason: "present" });
        }
        kept.push(project);
      } catch (e) {
        // IPC failure is ambiguous — keep (fail closed), never wipe.
        recentDebug("prune.keep", {
          path: project.path,
          reason: "ipc-error-fail-closed",
          error: String(e),
        });
        kept.push(project);
      }
    }
    recentDebug("prune.done", {
      before: projects.length,
      after: kept.length,
      keptPaths: kept.map((p) => p.path),
      dropped: projects.length - kept.length,
    });
    return kept;
  }

  async function loadRecentProjects() {
    recentDebug("load.start", { api: "ipc.recentProjectsGet / settings recentProjects" });
    let migratedFromLocal = false;
    try {
      const backendRaw = await ipc.recentProjectsGet();
      recentDebug("load.backend", {
        count: backendRaw.length,
        paths: backendRaw.map((project) => project.path),
        api: "cmd_recent_projects_get → settings.get_user(recentProjects)",
      });
      recentProjects = trimRecentProjects(backendRaw);
      if (recentProjects.length === 0) {
        const local = getLocalRecentProjects();
        recentDebug("load.backendEmpty.fallbackLocal", {
          count: local.length,
          paths: local.map((project) => project.path),
        });
        if (local.length > 0) {
          recentProjects = trimRecentProjects(local);
          migratedFromLocal = true;
        } else {
          recentDebug("load.skip", { reason: "backend-and-local-empty" });
        }
      }
    } catch (e) {
      console.error("Error loading recent projects", e);
      recentDebug("load.backendError", { error: String(e) });
      recentProjects = trimRecentProjects(getLocalRecentProjects());
      migratedFromLocal = recentProjects.length > 0;
    }

    const before = recentProjects.length;
    const beforePaths = recentProjects.map((p) => p.path);
    recentProjects = trimRecentProjects(await pruneMissingRecentProjects(recentProjects));
    const willPersist = migratedFromLocal || recentProjects.length !== before;
    recentDebug("load.afterPrune", {
      before,
      after: recentProjects.length,
      beforePaths,
      afterPaths: recentProjects.map((p) => p.path),
      migratedFromLocal,
      willPersist,
      persistReason: migratedFromLocal
        ? "migrated-from-localStorage"
        : recentProjects.length !== before
          ? "prune-changed-count"
          : "none",
    });
    if (willPersist) {
      await persistRecentProjects();
    }
    recentDebug("load.done", {
      count: recentProjects.length,
      paths: recentProjects.map((p) => p.path),
    });
  }

  async function persistRecentProjects() {
    const beforeLocal = localStorage.getItem("h1code.recentProjects");
    localStorage.setItem("h1code.recentProjects", JSON.stringify(recentProjects));
    recentDebug("persist.localStorage", {
      storageKey: "h1code.recentProjects",
      count: recentProjects.length,
      paths: recentProjects.map((project) => project.path),
      previousRaw: beforeLocal,
      nextRaw: localStorage.getItem("h1code.recentProjects"),
    });
    try {
      await ipc.recentProjectsSet(recentProjects);
      recentDebug("persist.backend.ok", {
        api: "cmd_recent_projects_set → settings.set_user(recentProjects)",
        count: recentProjects.length,
        paths: recentProjects.map((project) => project.path),
      });
    } catch (e) {
      console.error("Error saving recent projects", e);
      recentDebug("persist.backend.fail", { error: String(e) });
    }
  }

  async function addToRecentProjects(path: string, name: string) {
    const before = recentProjects.map((p) => p.path);
    recentDebug("add.start", { path, name, before });
    recentProjects = recentProjects.filter(p => normPath(p.path) !== normPath(path));
    recentProjects.unshift({
      name: name,
      path: path,
      lastOpened: Date.now()
    });
    recentProjects = trimRecentProjects(recentProjects);
    recentDebug("add.afterUnshift", {
      path,
      name,
      after: recentProjects.map((p) => p.path),
    });
    await persistRecentProjects();
    recentDebug("add.done", { path, name, count: recentProjects.length });
  }

  function trimRecentProjects(projects: RecentProject[]) {
    if (projects.length > 4) {
      recentDebug("trim", { before: projects.length, after: 4 });
    }
    return projects.slice(0, 4);
  }

  function pathBelongsToWorkspace(path: string, workspaceRoot: string) {
    const root = normPath(workspaceRoot).replace(/\/+$/, "");
    const file = normPath(path);
    return file === root || file.startsWith(`${root}/`);
  }

  function pathIsDescendant(path: string, parent: string) {
    const root = normPath(parent).replace(/\/+$/, "");
    const file = normPath(path);
    return file === root || file.startsWith(`${root}/`);
  }

  function joinPath(parent: string, name: string) {
    const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
  }

  function basename(path: string) {
    return path.split(/[\\/]/).pop() ?? path;
  }

  function dirname(path: string) {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    const idx = normalized.lastIndexOf("/");
    if (idx <= 0) return ".";
    return normalized.slice(0, idx);
  }

  function relativeToWorkspace(path: string, workspaceRoot: string) {
    const root = workspaceRoot.replace(/[\\/]+$/, "");
    const rootNorm = normPath(root);
    const fileNorm = normPath(path);
    if (fileNorm === rootNorm) return "";
    if (fileNorm.startsWith(`${rootNorm}/`)) {
      return path.slice(root.length).replace(/^[\\/]+/, "");
    }
    return null;
  }

  function isRunTempPath(path: string) {
    return /(?:^|[\\/])run_temp_(?:[\\/]|$)/i.test(path);
  }

  async function resolveRunTempDir(): Promise<string> {
    // Must stay inside the open workspace so FS / python-run jails allow it.
    if (!currentWorkspace) {
      throw new Error("No workspace open");
    }
    return joinPath(joinPath(currentWorkspace.root, H1CODE_DIR_NAME), RUN_TEMP_DIR_NAME);
  }

  async function stopActiveRunner() {
    if (!activePtyId) return;
    const id = activePtyId;
    activePtyId = null;
    activePtyKind = null;
    terminal.detachSession();
    try {
      await ipc.ptyClose(id);
    } catch {
      try {
        await ipc.processKill(id);
      } catch {
        /* ignore */
      }
    }
  }

  /** Open (or replace with) an interactive shell PTY. Default terminal mode. */
  async function openShell(opts?: { focus?: boolean }) {
    const focus = opts?.focus !== false;
    restoreShellAfterRun = false;
    await stopActiveRunner();
    showBottom("terminal", focus);
    terminal.fit();
    try {
      const dims = terminal.dimensions();
      const { id } = await ipc.ptyOpen(dims);
      activePtyId = id;
      activePtyKind = "shell";
      terminal.attachSession(id, { kind: "shell" });
      if (!focus) {
        // attachSession focuses the terminal; return focus to the editor on boot.
        editor.focus();
      }
    } catch (e) {
      terminal.log(`shell failed: ${String(e)}`);
    }
  }

  /**
   * Recursively delete `<workspace>/.h1code/run_temp_`. Stops an active *run* PTY first so
   * file locks from a just-finished process don't block deletion; does not kill
   * an interactive shell. Backend remove also retries with backoff.
   */
  async function cleanupRunTempDir() {
    const tracked = activeRunTempDir;
    activeRunTempDir = null;
    // Only stop a one-shot run process that may still hold locks on run_temp_.
    // An interactive shell must stay alive across cleanup / subsequent Runs.
    if (tracked && activePtyKind === "run") {
      await stopActiveRunner();
    }

    let dir = tracked;
    if (!dir) {
      try {
        dir = await resolveRunTempDir();
      } catch {
        return;
      }
    }

    let delay = 40;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await ipc.fsRemove(dir);
        return;
      } catch {
        await sleep(delay);
        delay = Math.min(delay * 2, 800);
      }
    }
  }

  /**
   * Snapshot every open editor buffer into `<workspace>/.h1code/run_temp_/`
   * and return the absolute path of `runPath` inside that folder (plus the folder).
   * Does not write to the user's real project source files.
   */
  async function prepareRunTempSnapshot(runPath: string): Promise<{ runFile: string; runDir: string } | null> {
    // Flush the active editor into the tab model before snapshotting.
    tabs.updateActiveContent(editor.getDoc());
    syncActiveScratchFile();

    await cleanupRunTempDir();

    const runDir = await resolveRunTempDir();
    await ipc.fsCreateDir(runDir);

    const usedNames = new Map<string, number>();
    let mappedRunFile: string | null = null;
    const workspaceRoot = currentWorkspace?.root ?? scratchWorkspace?.rootPath ?? null;

    for (const tab of tabs.all()) {
      let destRel: string;
      if (isTemporaryPath(tab.path) || isRunTempPath(tab.path)) {
        const base = tab.name || basename(tab.path) || "untitled.py";
        const count = usedNames.get(base) ?? 0;
        usedNames.set(base, count + 1);
        destRel = count === 0 ? base : `${base.replace(/(\.[^.]+)?$/, `_${count}$1`)}`;
      } else if (workspaceRoot) {
        const rel = relativeToWorkspace(tab.path, workspaceRoot);
        destRel = rel && rel.length > 0 ? rel : basename(tab.path);
      } else {
        destRel = basename(tab.path);
      }

      const destAbs = joinPath(runDir, destRel);
      const parent = dirname(destAbs);
      if (parent && parent !== runDir && !samePathLoose(parent, runDir)) {
        await ipc.fsCreateDir(parent);
      }
      await ipc.fsWrite(destAbs, tab.content);

      if (normPath(tab.path) === normPath(runPath)) {
        mappedRunFile = destAbs;
      }
    }

    if (!mappedRunFile) {
      // Run target wasn't an open tab (e.g. suggested entrypoint) — copy from disk.
      try {
        const text = await ipc.fsRead(runPath);
        let destRel: string;
        if (workspaceRoot) {
          const rel = relativeToWorkspace(runPath, workspaceRoot);
          destRel = rel && rel.length > 0 ? rel : basename(runPath);
        } else {
          destRel = basename(runPath);
        }
        const destAbs = joinPath(runDir, destRel);
        const parent = dirname(destAbs);
        if (parent && !samePathLoose(parent, runDir)) {
          await ipc.fsCreateDir(parent);
        }
        await ipc.fsWrite(destAbs, text);
        mappedRunFile = destAbs;
      } catch (e) {
        terminal.log(`run snapshot failed: could not read ${runPath}: ${String(e)}`);
        try {
          await ipc.fsRemove(runDir);
        } catch {
          /* ignore */
        }
        return null;
      }
    }

    activeRunTempDir = runDir;
    return { runFile: mappedRunFile, runDir };
  }

  function samePathLoose(a: string, b: string) {
    return normPath(a.replace(/[\\/]+$/, "")) === normPath(b.replace(/[\\/]+$/, ""));
  }

  function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string) {
    const suffix = path.slice(oldPrefix.length).replace(/^[\\/]+/, "");
    return suffix ? joinPath(newPrefix, suffix) : newPrefix;
  }

  function scratchWorkspaceRoot(): ScratchFolder | null {
    if (!scratchWorkspace) return null;
    return {
      kind: "folder",
      name: scratchWorkspace.name,
      path: scratchWorkspace.rootPath,
      children: scratchWorkspace.children,
    };
  }

  function updateScratchWorkspaceName(name: string) {
    if (!scratchWorkspace) return;
    scratchWorkspace.name = name;
    updateWorkspaceUi(null);
  }

  function scratchChildExists(parent: ScratchFolder, name: string) {
    const key = name.toLowerCase();
    return parent.children.some((child) => child.name.toLowerCase() === key);
  }

  function findScratchFile(path: string): ScratchFile | null {
    if (!scratchWorkspace) return null;
    const stack = [...scratchWorkspace.children];
    while (stack.length > 0) {
      const entry = stack.shift()!;
      if (entry.kind === "file" && normPath(entry.path) === normPath(path)) {
        return entry;
      }
      if (entry.kind === "folder") {
        stack.push(...entry.children);
      }
    }
    return null;
  }

  function openScratchFile(path: string) {
    const file = findScratchFile(path);
    if (!file) return;
    tabs.openVirtualFile(file.path, file.name, file.content);
  }

  function syncActiveScratchFile() {
    const active = tabs.active();
    if (!active || !isTemporaryPath(active.path)) return;
    tabs.updateActiveContent(editor.getDoc());
    const file = findScratchFile(active.path);
    if (file) {
      file.content = editor.getDoc();
    }
  }

  function closeTabsForDeletedPath(path: string, isDir: boolean) {
    const affected = tabs
      .all()
      .filter((tab) => isDir ? pathIsDescendant(tab.path, path) : normPath(tab.path) === normPath(path));
    for (const tab of affected) {
      tabs.close(tab.path);
    }
    if (isDir) {
      for (const key of Array.from(diagnostics.keys())) {
        if (pathIsDescendant(key, path)) diagnostics.delete(key);
      }
    } else {
      diagnostics.delete(normPath(path));
    }
    refreshProblems();
  }

  function renameTabsForPath(from: string, to: string, isDir: boolean) {
    const affected = tabs
      .all()
      .filter((tab) => isDir ? pathIsDescendant(tab.path, from) : normPath(tab.path) === normPath(from));
    for (const tab of affected) {
      const oldPath = tab.path;
      const nextPath = isDir ? replacePathPrefix(tab.path, from, to) : to;
      const diagnostic = diagnostics.get(normPath(oldPath));
      tabs.renamePath(oldPath, nextPath, basename(nextPath));
      fileSync.clearBaseline(oldPath);
      void fileSync.noteBaseline(nextPath);
      if (diagnostic) {
        diagnostics.delete(normPath(oldPath));
        diagnostics.set(normPath(nextPath), { ...diagnostic, path: nextPath });
      }
    }
    refreshProblems();
    persistWorkspaceTabState().catch(() => {});
  }

  function discardScratchWorkspace() {
    scratchWorkspace = null;
    explorer.clearScratchRoot();
    for (const tab of tabs.all()) {
      if (isTemporaryPath(tab.path)) tabs.close(tab.path);
    }
    updateWorkspaceUi(null);
    showEditor(false);
    renderEmptyState();
  }

  function syncScratchTabs() {
    syncActiveScratchFile();
    if (!scratchWorkspace) return;
    for (const tab of tabs.all()) {
      const file = findScratchFile(tab.path);
      if (file) {
        file.content = tab.content;
      }
    }
  }

  function scratchRelativePath(path: string, rootPath = scratchWorkspace?.rootPath) {
    if (!rootPath) return path;
    return path
      .slice(rootPath.length)
      .replace(/^[\\/]+/, "");
  }

  async function writeScratchEntry(
    destRoot: string,
    entry: ScratchEntry,
    scratchRootPath: string
  ) {
    const dest = joinPath(destRoot, scratchRelativePath(entry.path, scratchRootPath));
    if (entry.kind === "folder") {
      await ipc.fsCreateDir(dest);
      for (const child of entry.children) {
        await writeScratchEntry(destRoot, child, scratchRootPath);
      }
      return;
    }
    await ipc.fsWrite(dest, entry.content);
  }

  /** When set, saveScratchWorkspace skips the folder dialog (diagnosis only). */
  let debugForcedScratchSaveParent: string | null = null;

  async function saveScratchWorkspace(): Promise<boolean> {
    saveDebug("saveScratchWorkspace:start");
    if (!scratchWorkspace) {
      saveDebug("saveScratchWorkspace:no-scratch");
      return false;
    }
    syncScratchTabs();
    // Local snapshot: adoptWorkspaceRoot clears scratchWorkspace before writes.
    const scratch = scratchWorkspace;
    const active = tabs.active();
    const activeScratchFile = active ? findScratchFile(active.path) : null;
    const activeRelativePath = activeScratchFile
      ? scratchRelativePath(activeScratchFile.path, scratch.rootPath)
      : null;
    saveDebug("saveScratchWorkspace:pre-dialog", {
      scratchName: scratch.name,
      scratchRoot: scratch.rootPath,
      childCount: scratch.children.length,
      activeRelativePath,
      forcedDest: debugForcedScratchSaveParent,
    });

    let picked: string | string[] | null = debugForcedScratchSaveParent;
    if (!picked) {
      picked = await openDialog({
        title: "Save Scratch Workspace",
        directory: true,
        multiple: false,
      });
    } else {
      saveDebug("saveScratchWorkspace:using-forced-dest", { picked });
    }
    if (!picked || Array.isArray(picked)) {
      saveDebug("saveScratchWorkspace:dialog-cancelled", { picked });
      return false;
    }

    const destRoot = joinPath(picked, scratch.name);
    saveDebug("saveScratchWorkspace:will-write", {
      picked,
      destRoot,
      workspaceBefore: currentWorkspace?.root ?? null,
      scratchStillSet: scratchWorkspace !== null,
    });

    // FS IPC is workspace-jailed: open the chosen parent as the jail root
    // before creating destRoot — same pattern as ensureWorkspaceForFile for
    // untitled Save. Does not weaken the jail; ops stay under `picked`.
    saveDebug("saveScratchWorkspace:adopt-parent", { picked });
    if (!(await adoptWorkspaceRoot(picked))) {
      saveDebug("saveScratchWorkspace:adopt-parent-fail", { picked });
      return false;
    }

    try {
      saveDebug("saveScratchWorkspace:fsCreateDir", { destRoot });
      await ipc.fsCreateDir(destRoot);
      saveDebug("saveScratchWorkspace:fsCreateDir:ok", { destRoot });
      for (const child of scratch.children) {
        saveDebug("saveScratchWorkspace:write-child", {
          childPath: child.path,
          childKind: child.kind,
          dest: joinPath(destRoot, scratchRelativePath(child.path, scratch.rootPath)),
        });
        await writeScratchEntry(destRoot, child, scratch.rootPath);
      }
      saveDebug("saveScratchWorkspace:cleared-scratch", { destRoot });
      const opened = await openWorkspace(destRoot, false, true);
      saveDebug("saveScratchWorkspace:openWorkspace-result", {
        opened,
        workspaceAfter: currentWorkspace?.root ?? null,
        scratchAfter: scratchWorkspace?.rootPath ?? null,
        activeAfter: tabs.active()?.path ?? null,
      });
      if (opened && activeRelativePath) {
        const reopenPath = joinPath(destRoot, activeRelativePath);
        saveDebug("saveScratchWorkspace:reopen-active", { reopenPath });
        await tabs.open(reopenPath);
      }
      saveDebug("saveScratchWorkspace:done", {
        ok: opened,
        workspace: currentWorkspace?.root ?? null,
        activeTab: tabs.active()?.path ?? null,
        activeTemporary: tabs.active() ? isTemporaryPath(tabs.active()!.path) : null,
        scratch: scratchWorkspace?.rootPath ?? null,
      });
      return opened;
    } catch (e) {
      // adopt already cleared the live scratch pointer — restore so the user can retry.
      scratchWorkspace = scratch;
      explorer.setScratchRoot(scratch.name, scratch.rootPath, scratch.children);
      updateWorkspaceUi(currentWorkspace);
      saveDebug("saveScratchWorkspace:fail", {
        error: String(e),
        destRoot,
        workspace: currentWorkspace?.root ?? null,
        scratchStillSet: scratchWorkspace !== null,
        activeTab: tabs.active()?.path ?? null,
        activeTemporary: tabs.active() ? isTemporaryPath(tabs.active()!.path) : null,
      });
      terminal.log(`save scratch workspace failed: ${String(e)}`);
      return false;
    }
  }

  function hasUnsavedWork() {
    return tabs.hasUnsavedChanges() || scratchWorkspace !== null;
  }

  function workspaceTabPaths(workspaceRoot: string) {
    return tabs
      .all()
      .map((tab) => tab.path)
      .filter((path) => !isTemporaryPath(path) && pathBelongsToWorkspace(path, workspaceRoot));
  }

  async function persistWorkspaceTabState() {
    if (!currentWorkspace) return;
    const openFiles = workspaceTabPaths(currentWorkspace.root);
    await ipc.workspaceOpenFilesSet(currentWorkspace.root, openFiles);

    const active = tabs.active();
    if (
      active &&
      !isTemporaryPath(active.path) &&
      pathBelongsToWorkspace(active.path, currentWorkspace.root)
    ) {
      await ipc.workspaceLastActiveFileSet(currentWorkspace.root, active.path);
    }
  }

  async function removeRecentProject(path: string) {
    recentProjects = recentProjects.filter(p => normPath(p.path) !== normPath(path));
    await persistRecentProjects();
  }

  function updateWorkspaceUi(info: WorkspaceInfo | null) {
    const workspaceLabel = $("workspace-label");
    const pythonSpan = $("statusbar-python-text");
    const folderSvg = `
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>`;
    const emptySvg = `
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>`;

    function setWorkspaceLabel(svgMarkup: string, labelText: string) {
      if (!workspaceLabel) return;
      // Keep static SVG via innerHTML; never interpolate user-controlled names.
      workspaceLabel.innerHTML = svgMarkup;
      const span = document.createElement("span");
      span.textContent = labelText;
      workspaceLabel.appendChild(span);
    }

    if (scratchWorkspace) {
      setWorkspaceLabel(folderSvg, `${scratchWorkspace.name} (unsaved)`);
      if (pythonSpan) {
        pythonSpan.textContent = "Scratch workspace";
      }
    } else if (info) {
      setWorkspaceLabel(folderSvg, info.name);
      if (pythonSpan) {
        pythonSpan.textContent = info.python ? `${info.python.interpreter} (${info.python.version ?? "?"})` : "No python";
      }
    } else {
      setWorkspaceLabel(emptySvg, "No workspace");
      if (pythonSpan) {
        pythonSpan.textContent = "No python";
      }
    }
  }

  async function openWorkspace(path: string, restoreLastActiveFile = false, skipUnsavedConfirm = false): Promise<boolean> {
    if (!skipUnsavedConfirm && !(await confirmDiscardAllUnsaved("Switching workspace will close all open files."))) {
      return false;
    }
    await cleanupRunTempDir();
    preview.resetLocal();
    fileSync.clear();
    // Drop any leftover tabs (untitled or dirty) before swapping workspace.
    for (const tab of tabs.all()) {
      tabs.close(tab.path);
    }
    diagnostics.clear();
    editor.setDiagnostics([]);
    refreshProblems();

    try {
      const info = await ipc.workspaceOpen(path);
      scratchWorkspace = null;
      explorer.clearScratchRoot();
      currentWorkspace = info;
      updateWorkspaceUi(info);
      await explorer.setRoot(info.root);
      search.setWorkspaceRoot(info.root);
      recentDebug("openWorkspace.addRecent", { root: info.root, name: info.name });
      await addToRecentProjects(info.root, info.name);
      if (restoreLastActiveFile) {
        await restoreWorkspaceTabs(info.root);
      }
      for (const tab of tabs.all()) {
        if (!isTemporaryPath(tab.path)) {
          await fileSync.noteBaseline(tab.path);
        }
      }
      fileSync.startCheckup();
      renderEmptyState();
      recentDebug("openWorkspace.ok", { root: info.root });
      return true;
    } catch (e) {
      recentDebug("openWorkspace.fail", { path, error: String(e) });
      terminal.log(`Failed to open workspace: ${String(e)}`, { newPrompt: true });
      return false;
    }
  }

  async function createFileFromEmptyState() {
    const name = await promptName({
      title: "New File",
      label: "File name",
      initialValue: "untitled.py",
    });
    if (!name) return;

    if (scratchWorkspace) {
      const root = scratchWorkspaceRoot();
      if (!root || scratchChildExists(root, name)) {
        terminal.log(`new file failed: ${name} already exists`);
        return;
      }
      const file: ScratchFile = {
        kind: "file",
        name,
        path: joinPath(scratchWorkspace.rootPath, name),
        content: "",
      };
      scratchWorkspace.children.unshift(file);
      explorer.setScratchRoot(scratchWorkspace.name, scratchWorkspace.rootPath, scratchWorkspace.children);
      openScratchFile(file.path);
      return;
    }

    tabs.openTemporaryFile(name);
  }

  /** When set, createFolderFromEmptyState skips the name modal (diagnosis only). */
  let debugForcedScratchWorkspaceName: string | null = null;

  async function createFolderFromEmptyState() {
    // File → New Folder semantics: leave cwd / open workspace and start a new
    // scratch folder-workspace (name prompt). Not an in-explorer inline create.
    newfolderDebug("createFolderFromEmptyState:prompt-start", {
      locationDialog: false,
      namePrompt: !debugForcedScratchWorkspaceName,
      forcedName: debugForcedScratchWorkspaceName,
      note: "no openDialog; modal names the new scratch workspace outside cwd",
    });
    let name = debugForcedScratchWorkspaceName;
    if (!name) {
      name = await promptName({
        title: "Name your scratch workspace",
        description: "This creates a temporary workspace root for your unsaved files and folders. The root exists only while working in scratch mode and helps organize temporary project structure before saving to disk.",
        label: "Workspace name",
        initialValue: "Scratch Workspace",
        confirmLabel: "Start Workspace",
      });
    } else {
      newfolderDebug("createFolderFromEmptyState:using-forced-name", { name });
    }
    if (!name) {
      newfolderDebug("createFolderFromEmptyState:prompt-result", { result: "cancelled" });
      saveDebug("createFolderFromEmptyState:cancelled");
      return;
    }
    newfolderDebug("createFolderFromEmptyState:prompt-result", { result: "ok", name });

    if (!(await confirmDiscardAllUnsaved("Starting a scratch workspace will close current open files."))) {
      newfolderDebug("createFolderFromEmptyState:discard-aborted");
      saveDebug("createFolderFromEmptyState:discard-aborted");
      return;
    }
    await cleanupRunTempDir();
    fileSync.clear();
    try {
      await ipc.workspaceClose();
    } catch {
      /* ignore */
    }
    for (const tab of tabs.all()) {
      tabs.close(tab.path);
    }
    currentWorkspace = null;
    diagnostics.clear();
    editor.setDiagnostics([]);
    refreshProblems();

    scratchWorkspaceCounter += 1;
    scratchWorkspace = {
      id: scratchWorkspaceCounter,
      name,
      rootPath: `scratch:${scratchWorkspaceCounter}`,
      children: [],
    };
    explorer.setScratchRoot(scratchWorkspace.name, scratchWorkspace.rootPath, scratchWorkspace.children);
    search.setWorkspaceRoot(null);
    updateWorkspaceUi(null);
    showEditor(false);
    newfolderDebug("createFolderFromEmptyState:ok", {
      scratchName: scratchWorkspace.name,
      scratchRoot: scratchWorkspace.rootPath,
      createdInCwd: false,
      createdPath: scratchWorkspace.rootPath,
    });
    saveDebug("createFolderFromEmptyState:ok", {
      scratchName: scratchWorkspace.name,
      scratchRoot: scratchWorkspace.rootPath,
    });
  }

  async function restoreWorkspaceTabs(workspaceRoot: string) {
    try {
      const [openFiles, activeFile] = await Promise.all([
        ipc.workspaceOpenFilesGet(workspaceRoot),
        ipc.workspaceLastActiveFileGet(workspaceRoot),
      ]);
      const orderedFiles = dedupePaths([
        ...openFiles.filter((path) => !activeFile || normPath(path) !== normPath(activeFile)),
        ...(activeFile ? [activeFile] : []),
      ]);

      // Read every restored file in parallel and insert the tabs without
      // activating/persisting per file. Opening them one-by-one previously did
      // N sequential reads + N editor swaps + ~2N settings writes, which is the
      // lag when reopening a recent project.
      const loaded = await Promise.all(
        orderedFiles.map(async (path) => {
          try {
            const kind = await classifyOpenPath(path);
            if (kind !== "text") {
              return { path, content: "", kind };
            }
            return { path, content: await ipc.fsRead(path), kind: "text" as const };
          } catch (e) {
            // Safety net for session restore: binary leftovers become viewer tabs.
            if (String(e).toLowerCase().includes("not a text file")) {
              return { path, content: "", kind: "binary" as const };
            }
            terminal.log(`Could not restore tab ${path}: ${String(e)}`, { newPrompt: true });
            return null;
          }
        })
      );

      for (const item of loaded) {
        if (!item) continue;
        tabs.addBackground(item.path, basename(item.path), item.content, item.kind);
        if (
          item.kind === "text" &&
          !isTemporaryPath(item.path) &&
          /\.pyi?$/i.test(item.path) &&
          item.content.length <= PYRIGHT_MAX_DOC_CHARS
        ) {
          ipc.docDidOpen(item.path, item.content).catch(() => {});
        }

      }
      tabs.render();

      // Activate the previously-active file once (or the first that loaded).
      const activeLoaded =
        activeFile && loaded.some((i) => i && normPath(i.path) === normPath(activeFile));
      const finalActive = activeLoaded
        ? activeFile
        : loaded.find((i) => i)?.path ?? null;
      if (finalActive) tabs.setActive(finalActive);
    } catch (e) {
      terminal.log(`Could not restore workspace tabs: ${String(e)}`, { newPrompt: true });
    }
  }

  function dedupePaths(paths: string[]) {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const path of paths) {
      const key = normPath(path);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(path);
    }
    return deduped;
  }

  function renderEmptyState() {
    const listContainer = $("recent-projects-list");
    const recentSection = $("recent-projects-section");
    const shortcutsSection = document.querySelector<HTMLElement>(".empty-state-shortcuts");
    
    if (!listContainer || !recentSection || !shortcutsSection) {
      recentDebug("render.skip", {
        reason: "missing-DOM",
        hasListContainer: Boolean(listContainer),
        hasRecentSection: Boolean(recentSection),
        hasShortcutsSection: Boolean(shortcutsSection),
      });
      return;
    }

    const recents = recentProjects;
    const shouldShowRecents = !currentWorkspace && !scratchWorkspace && recents.length > 0;
    recentDebug("render.start", {
      currentWorkspace: currentWorkspace?.root ?? null,
      scratch: scratchWorkspace?.rootPath ?? null,
      count: recents.length,
      paths: recents.map((p) => p.path),
      showRecents: shouldShowRecents,
      skipReason: shouldShowRecents
        ? null
        : currentWorkspace
          ? "workspace-open"
          : scratchWorkspace
            ? "scratch-open"
            : recents.length === 0
              ? "empty-list"
              : "unknown",
    });
    
    if (shouldShowRecents) {
      recentSection.classList.remove("hidden");
      shortcutsSection.classList.add("hidden");
      
      listContainer.innerHTML = "";
      recents.forEach((proj) => {
        const row = document.createElement("div");
        row.className = "recent-project-row";
        row.title = proj.path;
        
        const infoDiv = document.createElement("div");
        infoDiv.className = "recent-project-info";
        
        const nameSpan = document.createElement("span");
        nameSpan.className = "recent-project-name";
        nameSpan.textContent = proj.name;
        
        const pathSpan = document.createElement("span");
        pathSpan.className = "recent-project-path";
        pathSpan.textContent = proj.path;
        
        infoDiv.appendChild(nameSpan);
        infoDiv.appendChild(pathSpan);
        row.appendChild(infoDiv);
        
        const removeBtn = document.createElement("button");
        removeBtn.className = "recent-project-remove";
        removeBtn.title = "Remove from recent projects";
        removeBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        `;
        
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          removeRecentProject(proj.path).then(() => renderEmptyState());
        };
        
        row.appendChild(removeBtn);
        
        row.onclick = () => {
          openWorkspace(proj.path, true);
        };
        
        listContainer.appendChild(row);
      });
    } else {
      recentSection.classList.add("hidden");
      shortcutsSection.classList.remove("hidden");
    }
    recentDebug("render.applied", {
      recentSectionHidden: recentSection.classList.contains("hidden"),
      shortcutsHidden: shortcutsSection.classList.contains("hidden"),
      listChildren: listContainer.children.length,
      editorEmptyStateHidden: editorEmptyState.classList.contains("hidden"),
      editorHostHidden: editorHost.classList.contains("hidden"),
      activeTab: tabs.active()?.path ?? null,
      currentWorkspace: currentWorkspace?.root ?? null,
      recentCount: recents.length,
    });
  }

  function showEditor(active: boolean) {
    showCenterPane(active ? "editor" : "empty");
  }

  function showCenterPane(mode: "empty" | "editor" | "viewer") {
    editorEmptyState.classList.toggle("hidden", mode !== "empty");
    editorHost.classList.toggle("hidden", mode !== "editor");
    mediaViewerHost.classList.toggle("hidden", mode !== "viewer");
    if (mode !== "viewer") {
      mediaViewer.hide();
    }
    if (mode === "empty") {
      renderEmptyState();
    }
  }

  function hideRunTargetPopover() {
    runTargetPopover.classList.add("hidden");
    runTargetSuggestion.replaceChildren();
    runTargetCurrent.onclick = null;
    runTargetSuppress.onclick = null;
  }

  const RUN_BUTTON_TITLE = "Run Active Python File";
  const RUN_BUTTON_HTML_TITLE = "Use Preview for HTML files";

  function isHtmlPath(path: string): boolean {
    return /\.html?$/i.test(path);
  }

  /** Run executes Python; HTML uses Preview; media/binary tabs stay disabled. */
  function syncRunButton() {
    const active = tabs.active();
    const htmlActive = !!active && isHtmlPath(active.path);
    const nonText = !!active && !isTextTabKind(active.kind);
    runButton.disabled = htmlActive || nonText;
    runButton.title = htmlActive
      ? RUN_BUTTON_HTML_TITLE
      : nonText
        ? "Can't run this file type"
        : RUN_BUTTON_TITLE;
    if (htmlActive || nonText) hideRunTargetPopover();
  }

  function showRunTargetPopover(activePath: string, suggestion: RunTargetSuggestion) {
    runTargetSuggestion.replaceChildren();
    const label = document.createElement("span");
    label.className = "run-target-path";
    label.textContent = suggestion.label;
    const reason = document.createElement("span");
    reason.className = "run-target-reason";
    reason.textContent = suggestion.reason;
    runTargetSuggestion.appendChild(label);
    runTargetSuggestion.appendChild(reason);

    runTargetSuggestion.onclick = async () => {
      hideRunTargetPopover();
      try {
        await tabs.open(suggestion.path);
        await runFile(suggestion.path);
      } catch (e) {
        terminal.log(`run failed: ${String(e)}`);
      }
    };
    runTargetCurrent.onclick = () => {
      hideRunTargetPopover();
      runFile(activePath);
    };
    runTargetSuppress.onclick = () => {
      suppressRunPrompt(activePath);
      hideRunTargetPopover();
      runFile(activePath);
    };

    const rect = runButton.getBoundingClientRect();
    runTargetPopover.style.top = `${rect.bottom + 6}px`;
    runTargetPopover.style.left = `${Math.max(8, rect.right - 280)}px`;
    runTargetPopover.classList.remove("hidden");
  }

  function scheduleDidChange() {
    const tab = tabs.active();
    if (!tab) return;
    if (isTemporaryPath(tab.path)) return;
    if (changeTimer) window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => {
      const cur = tabs.active();
      if (!cur || isTemporaryPath(cur.path)) return;
      const doc = editor.getDoc();
      if (doc.length > PYRIGHT_MAX_DOC_CHARS) return;
      ipc.docDidChange(cur.path, doc).catch(() => {});
    }, 250);
  }

  function pushDiagsToEditor(forPath: string) {
    const key = normPath(forPath);
    const entry = diagnostics.get(key);
    editor.setDiagnostics(entry?.items ?? []);
  }

  function refreshProblems() {
    const flat: ProblemEntry[] = [];
    let errorsCount = 0;
    let warningsCount = 0;
    for (const { path, items } of diagnostics.values()) {
      for (const d of items) {
        flat.push({ path, diagnostic: d });
        if (d.severity === "error") {
          errorsCount++;
        } else if (d.severity === "warning") {
          warningsCount++;
        }
      }
    }
    // Stable sort: by file, then line.
    flat.sort((a, b) => {
      const p = a.path.localeCompare(b.path);
      if (p !== 0) return p;
      return a.diagnostic.range.start.line - b.diagnostic.range.start.line;
    });
    problems.setEntries(flat);
    
    // Update statusbar diagnostic counters!
    const errCountSpan = $("statusbar-error-count");
    const warnCountSpan = $("statusbar-warning-count");
    if (errCountSpan) errCountSpan.textContent = errorsCount.toString();
    if (warnCountSpan) warnCountSpan.textContent = warningsCount.toString();
  }

  tabs.onActiveChange((tab) => {
    if (tab) {
      if (!isTextTabKind(tab.kind)) {
        showCenterPane("viewer");
        mediaViewer.show(tab);
        editor.setDoc("", "");
        editor.setDiagnostics([]);
        fileSync.onActiveTab(tab);
      } else {
        showCenterPane("editor");
        editor.setDoc(tab.content, tab.path);
        editor.view.requestMeasure();
        // Re-apply any known diagnostics for this file (avoid stale set from previous tab).
        pushDiagsToEditor(tab.path);
        editor.focus();
        fileSync.onActiveTab(tab);
        if (preview.isOpen() && isHtmlPath(tab.path) && !isTemporaryPath(tab.path)) {
          preview.open(tab.path).catch((err) =>
            terminal.log(`preview failed: ${String(err)}`, { newPrompt: true })
          );
        }
      }
      if (currentWorkspace) {
        persistWorkspaceTabState().catch(() => {});
      }
    } else {
      showCenterPane("empty");
      editor.setDoc("", "");
      editor.setDiagnostics([]);
      fileSync.onActiveTab(null);
    }
    syncRunButton();
  });

  // tabs.open -> after fsRead, also notify Pyright (text tabs only).
  const baseOpen = tabs.open.bind(tabs);
  tabs.open = async (path: string) => {
    const isNew = !tabs.all().some((t) => t.path === path);
    await baseOpen(path);
    const cur = tabs.active();
    if (
      isNew &&
      cur &&
      cur.path === path &&
      cur.kind === "text" &&
      !isTemporaryPath(path) &&
      /\.pyi?$/i.test(path) &&
      cur.content.length <= PYRIGHT_MAX_DOC_CHARS
    ) {
      ipc.docDidOpen(path, cur.content).catch(() => {});
    }
    if (!isTemporaryPath(path)) {
      fileSync.clearDrift(path);
      await fileSync.noteBaseline(path);
    }
    persistWorkspaceTabState().catch(() => {});
  };

  // tabs.close -> notify Pyright + drop local diagnostics for that path.
  const baseClose = tabs.close.bind(tabs);
  tabs.close = (path: string) => {
    if (!isTemporaryPath(path) && /\.pyi?$/i.test(path)) {
      ipc.docDidClose(path).catch(() => {});
    }
    diagnostics.delete(normPath(path));
    refreshProblems();
    fileSync.clearBaseline(path);
    fileSync.clearDrift(path);
    baseClose(path);
    persistWorkspaceTabState().catch(() => {});
  };

  // Confirming close wraps the wrapped close, so the modal sits in front of
  // the pyright/persistence side-effects.
  async function closeTabWithConfirm(path: string): Promise<boolean> {
    const tab = tabs.all().find((t) => t.path === path);
    if (!tab) return true;
    if (!tab.dirty) {
      tabs.close(path);
      return true;
    }
    const decision = await confirmSave({
      title: `Save changes to ${tab.name}?`,
      message: "Your changes will be lost if you don't save them.",
    });
    if (decision === "cancel") return false;
    if (decision === "discard") {
      await cleanupRunTempDir();
      tabs.close(path);
      return true;
    }
    // "save" — if active, use editor text; otherwise persist last-known content.
    const wasActive = tabs.active()?.path === path;
    const wasScratch = Boolean(scratchWorkspace && findScratchFile(path));
    if (!wasActive) tabs.setActive(path);
    const saved = await saveActiveWithDialog();
    if (!saved) return false;
    await cleanupRunTempDir();
    if (tabs.all().some((t) => t.path === path)) {
      tabs.close(path);
    } else if (!wasScratch) {
      const current = tabs.active();
      if (current) tabs.close(current.path);
    }
    return true;
  }

  // tabs.saveActive -> notify Pyright with new text.
  const baseSave = tabs.saveActive.bind(tabs);
  tabs.saveActive = async (text: string) => {
    const active = tabs.active();
    await baseSave(text);
    if (active && !isTemporaryPath(active.path) && /\.pyi?$/i.test(active.path)) {
      ipc.docDidSave(active.path, text).catch(() => {});
    }
    if (active && !isTemporaryPath(active.path)) {
      fileSync.clearDrift(active.path);
      await fileSync.noteBaseline(active.path);
    }
    if (
      active &&
      preview.isOpen() &&
      preview.currentFile() &&
      normPath(active.path) === normPath(preview.currentFile()!)
    ) {
      preview.reload(active.path).catch((err) =>
        terminal.log(`preview reload failed: ${String(err)}`, { newPrompt: true })
      );
    }
  };

  function saveDebug(label: string, extra?: Record<string, unknown>) {
    try {
      if (localStorage.getItem("h1code.debug.save") !== "1") return;
    } catch {
      return;
    }
    const payload = {
      workspace: currentWorkspace?.root ?? null,
      scratch: scratchWorkspace
        ? { root: scratchWorkspace.rootPath, name: scratchWorkspace.name, children: scratchWorkspace.children.length }
        : null,
      activeTab: tabs.active()?.path ?? null,
      activeTemporary: tabs.active() ? isTemporaryPath(tabs.active()!.path) : null,
      activeDirty: tabs.active()?.dirty ?? null,
      activeKind: tabs.active()?.kind ?? null,
      ...extra,
    };
    const entry = { t: Date.now(), label, payload };
    try {
      const w = window as unknown as { __saveDebugLog?: Array<typeof entry> };
      if (!w.__saveDebugLog) w.__saveDebugLog = [];
      w.__saveDebugLog.push(entry);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line no-console
    console.log("[save-debug]", label, payload);
    try {
      terminal.log(`[save-debug] ${label} ${JSON.stringify(payload)}`);
    } catch {
      /* terminal may not be ready during early boot */
    }
  }

  /** Gated `[newfolder-debug]` — enable with localStorage `h1code.debug.newfolder=1`. */
  function newfolderDebugEnabled(): boolean {
    try {
      return localStorage.getItem("h1code.debug.newfolder") === "1";
    } catch {
      return false;
    }
  }

  function newfolderDebug(label: string, extra?: Record<string, unknown>) {
    if (!newfolderDebugEnabled()) return;
    const payload = {
      workspace: currentWorkspace?.root ?? null,
      scratch: scratchWorkspace
        ? { root: scratchWorkspace.rootPath, name: scratchWorkspace.name }
        : null,
      ...extra,
    };
    const entry = { t: Date.now(), label, payload };
    try {
      const w = window as unknown as { __newfolderDebugLog?: Array<typeof entry> };
      if (!w.__newfolderDebugLog) w.__newfolderDebugLog = [];
      w.__newfolderDebugLog.push(entry);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line no-console
    console.log("[newfolder-debug]", label, payload);
    try {
      terminal.log(`[newfolder-debug] ${label} ${JSON.stringify(payload)}`);
    } catch {
      /* ignore */
    }
  }

  /**
   * Open `dir` as the workspace without wiping existing tabs.
   * Used when a standalone Save/Open picks a path and we need a jail root
   * before the FS write/read — unlike openWorkspace(), which closes all tabs.
   */
  async function adoptWorkspaceRoot(dir: string): Promise<boolean> {
    saveDebug("adoptWorkspaceRoot", { dir });
    try {
      const info = await ipc.workspaceOpen(dir);
      scratchWorkspace = null;
      explorer.clearScratchRoot();
      currentWorkspace = info;
      updateWorkspaceUi(info);
      await explorer.setRoot(info.root);
      search.setWorkspaceRoot(info.root);
      recentDebug("adoptWorkspaceRoot.addRecent", { root: info.root, name: info.name });
      await addToRecentProjects(info.root, info.name);
      fileSync.startCheckup();
      renderEmptyState();
      saveDebug("adoptWorkspaceRoot:ok", { root: info.root });
      recentDebug("adoptWorkspaceRoot.ok", { root: info.root });
      return true;
    } catch (e) {
      saveDebug("adoptWorkspaceRoot:fail", { error: String(e) });
      recentDebug("adoptWorkspaceRoot.fail", { dir, error: String(e) });
      terminal.log(`Failed to open workspace: ${String(e)}`, { newPrompt: true });
      return false;
    }
  }

  /** Ensure `filePath` lies under an open workspace root before jailed FS ops. */
  async function ensureWorkspaceForFile(filePath: string): Promise<boolean> {
    if (currentWorkspace && pathBelongsToWorkspace(filePath, currentWorkspace.root)) {
      return true;
    }
    if (currentWorkspace) {
      terminal.log(
        `Path is outside the open workspace (${currentWorkspace.root}). Open that folder or save inside it.`,
        { newPrompt: true }
      );
      return false;
    }
    const parent = dirname(filePath);
    if (!parent || parent === ".") {
      terminal.log("Could not determine a folder for this file.", { newPrompt: true });
      return false;
    }
    return adoptWorkspaceRoot(parent);
  }

  // Save current tab. Routes untitled tabs through the save() dialog; converts
  // them into real on-disk files on success. Returns true if persisted.
  async function saveActiveWithDialog(): Promise<boolean> {
    const active = tabs.active();
    saveDebug("saveActiveWithDialog:start", {
      hasActive: Boolean(active),
      isScratchFile: Boolean(active && scratchWorkspace && findScratchFile(active.path)),
      branchHint: !active && scratchWorkspace
        ? "no-active+scratch"
        : !active
          ? "no-active"
          : active && !isTextTabKind(active.kind)
            ? "non-text"
            : scratchWorkspace && findScratchFile(active.path)
              ? "scratch-file"
              : active && !isTemporaryPath(active.path)
                ? "disk-save"
                : "untitled-dialog",
    });
    if (!active && scratchWorkspace) {
      saveDebug("saveActiveWithDialog:route", { route: "saveScratchWorkspace(no-active)" });
      return saveScratchWorkspace();
    }
    if (!active) {
      saveDebug("saveActiveWithDialog:early-return", { reason: "no-active" });
      return false;
    }
    if (!isTextTabKind(active.kind)) {
      // Media/binary tabs have nothing to write back through the text editor.
      saveDebug("saveActiveWithDialog:early-return", { reason: "non-text", kind: active.kind });
      return true;
    }
    if (scratchWorkspace && findScratchFile(active.path)) {
      saveDebug("saveActiveWithDialog:route", { route: "saveScratchWorkspace(active-scratch-file)" });
      return saveScratchWorkspace();
    }
    if (!isTemporaryPath(active.path)) {
      saveDebug("saveActiveWithDialog:disk-save-in-place", { path: active.path });
      try {
        await tabs.saveActive(editor.getDoc());
        saveDebug("saveActiveWithDialog:disk-save-ok", { path: active.path });
        return true;
      } catch (e) {
        saveDebug("saveActiveWithDialog:disk-save-fail", { error: String(e) });
        terminal.log(`save failed: ${String(e)}`);
        return false;
      }
    }
    const defaultPath = currentWorkspace
      ? joinPath(currentWorkspace.root, active.name)
      : active.name;
    const picked = await saveDialog({
      defaultPath,
      filters: [
        { name: "Python", extensions: ["py", "pyi"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!picked) {
      saveDebug("saveActiveWithDialog:dialog-cancelled");
      return false;
    }
    const contents = editor.getDoc();
    // FS IPC is workspace-jailed: adopt the save folder as the workspace root
    // before writing so standalone "New File → Save" works without a prior Open Folder.
    if (!(await ensureWorkspaceForFile(picked))) {
      saveDebug("saveActiveWithDialog:ensure-workspace-fail", { picked });
      return false;
    }
    saveDebug("saveActiveWithDialog:relocate", { from: active.path, to: picked });
    try {
      await tabs.relocate(active.path, picked, contents);
    } catch (e) {
      saveDebug("saveActiveWithDialog:relocate-fail", { error: String(e) });
      terminal.log(`save failed: ${String(e)}`);
      return false;
    }
    saveDebug("saveActiveWithDialog:ok", {
      activeAfter: tabs.active()?.path ?? null,
      workspace: currentWorkspace?.root ?? null,
    });
    if (/\.pyi?$/i.test(picked)) {
      ipc.docDidOpen(picked, contents).catch(() => {});
    }
    await fileSync.noteBaseline(picked).catch(() => {});
    persistWorkspaceTabState().catch(() => {});
    return true;
  }

  async function saveActiveAs(): Promise<boolean> {
    const active = tabs.active();
    if (!active && scratchWorkspace) {
      return saveScratchWorkspace();
    }
    if (!active) return false;
    if (!isTextTabKind(active.kind)) {
      return true;
    }
    if (scratchWorkspace && findScratchFile(active.path)) {
      return saveScratchWorkspace();
    }

    const defaultPath = currentWorkspace && isTemporaryPath(active.path)
      ? joinPath(currentWorkspace.root, active.name)
      : isTemporaryPath(active.path)
        ? active.name
        : active.path;
    const picked = await saveDialog({
      defaultPath,
      filters: [
        { name: "Python", extensions: ["py", "pyi"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!picked) return false;

    const contents = editor.getDoc();
    if (!(await ensureWorkspaceForFile(picked))) return false;
    try {
      await tabs.relocate(active.path, picked, contents);
    } catch (e) {
      terminal.log(`save as failed: ${String(e)}`);
      return false;
    }
    if (/\.pyi?$/i.test(picked)) {
      ipc.docDidOpen(picked, contents).catch(() => {});
      ipc.docDidSave(picked, contents).catch(() => {});
    }
    fileSync.clearBaseline(active.path);
    fileSync.clearDrift(active.path);
    await fileSync.noteBaseline(picked);
    persistWorkspaceTabState().catch(() => {});
    return true;
  }

  async function saveAllDirtyTabs(): Promise<boolean> {
    syncActiveScratchFile();
    tabs.updateActiveContent(editor.getDoc());
    const dirtyTabs = tabs.all().filter((tab) => tab.dirty);
    if (scratchWorkspace) {
      return saveScratchWorkspace();
    }
    for (const tab of dirtyTabs) {
      tabs.setActive(tab.path);
      const ok = await saveActiveWithDialog();
      if (!ok) return false;
    }
    return true;
  }

  // Walks every dirty tab, prompting once per tab. Returns false if user
  // cancels at any step. Used by workspace switch and window close.
  async function confirmDiscardAllUnsaved(reason: string): Promise<boolean> {
    if (!hasUnsavedWork()) return true;
    if (scratchWorkspace) {
      const decision = await confirmSave({
        title: `Save ${scratchWorkspace.name}?`,
        message: `${reason} Your scratch workspace exists only in memory until it is saved.`,
      });
      return resolveBulkDecision(decision, tabs.all().filter((t) => t.dirty));
    }
    const dirty: Tab[] = tabs.all().filter((t) => t.dirty);
    if (dirty.length === 1) {
      const t = dirty[0];
      const decision = await confirmSave({
        title: `Save changes to ${t.name}?`,
        message: `${reason} Your changes will be lost if you don't save them.`,
      });
      return resolveBulkDecision(decision, [t]);
    }
    const decision = await confirmSave({
      title: `Save changes to ${dirty.length} files?`,
      message: `${reason} Unsaved files:\n${dirty.map((t) => "  • " + t.name).join("\n")}`,
    });
    return resolveBulkDecision(decision, dirty);
  }

  async function resolveBulkDecision(decision: SaveDecision, dirty: Tab[]): Promise<boolean> {
    if (decision === "cancel") return false;
    if (decision === "discard") {
      await cleanupRunTempDir();
      return true;
    }
    if (scratchWorkspace) {
      const ok = await saveScratchWorkspace();
      if (ok) await cleanupRunTempDir();
      return ok;
    }
    // Save each. For untitled tabs the save dialog opens; cancel aborts.
    for (const t of dirty) {
      tabs.setActive(t.path);
      const ok = await saveActiveWithDialog();
      if (!ok) return false;
    }
    await cleanupRunTempDir();
    return true;
  }

  async function openFolderWithDialog() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (!picked || Array.isArray(picked)) return;
    await openWorkspace(picked);
  }

  async function openFileWithDialog() {
    saveDebug("openFileWithDialog:start");
    const picked = await openDialog({
      directory: false,
      multiple: false,
      filters: [
        { name: "Python", extensions: ["py", "pyi"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!picked || Array.isArray(picked)) {
      saveDebug("openFileWithDialog:cancelled");
      return;
    }
    saveDebug("openFileWithDialog:picked", { picked });
    if (!(await ensureWorkspaceForFile(picked))) {
      saveDebug("openFileWithDialog:ensure-workspace-fail");
      return;
    }
    try {
      await tabs.open(picked);
      saveDebug("openFileWithDialog:ok", { activeAfter: tabs.active()?.path ?? null });
    } catch (e) {
      saveDebug("openFileWithDialog:fail", { error: String(e) });
      terminal.log(`open file failed: ${String(e)}`);
    }
  }

  async function newFileCommand() {
    if (currentWorkspace || scratchWorkspace) {
      await explorer.beginCreate("file");
      return;
    }
    await createFileFromEmptyState();
  }

  /**
   * File menu → New Folder...
   * Must start a new folder-workspace outside the current browsing context
   * (scratch name prompt via createFolderFromEmptyState). Must NOT call
   * explorer.beginCreate — that is the Explorer sidebar in-place shortcut.
   */
  async function newFolderCommand() {
    newfolderDebug("file-menu.newFolder:start", {
      handler: "newFolderCommand",
      entry: "file-menu / file.newFolder",
      willCallBeginCreate: false,
      willCallCreateFolderFromEmptyState: true,
      note: "File menu must not reuse sidebar in-place create",
    });
    await createFolderFromEmptyState();
    newfolderDebug("file-menu.newFolder:done", {
      scratch: scratchWorkspace
        ? { root: scratchWorkspace.rootPath, name: scratchWorkspace.name }
        : null,
      workspace: currentWorkspace?.root ?? null,
    });
  }

  /** Explorer sidebar icon: in-place create under current tree selection / root. */
  async function explorerNewFolderInPlace() {
    newfolderDebug("sidebar.newFolder:start", {
      handler: "explorerNewFolderInPlace",
      entry: "explorer-sidebar-btn",
      willCallBeginCreate: true,
      locationDialog: false,
      note: "intended in-place create; no destination prompt",
    });
    if (currentWorkspace || scratchWorkspace) {
      await explorer.beginCreate("folder");
      newfolderDebug("sidebar.newFolder:beginCreate", {
        kind: "folder",
        workspaceRoot: currentWorkspace?.root ?? null,
        scratchRoot: scratchWorkspace?.rootPath ?? null,
      });
      return;
    }
    newfolderDebug("sidebar.newFolder:no-root", {
      note: "no workspace/scratch; in-place create skipped (empty-state uses File New Folder)",
    });
  }

  let handlingCloseRequest = false;

  async function closeWindowWithConfirm(): Promise<void> {
    if (handlingCloseRequest) return;
    handlingCloseRequest = true;
    try {
      if (!hasUnsavedWork() || await confirmDiscardAllUnsaved("The IDE is closing.")) {
        await cleanupRunTempDir();
        await getCurrentWindow().destroy();
      }
    } catch (e) {
      console.error("Could not close window", e);
    } finally {
      handlingCloseRequest = false;
    }
  }

  const commands = new CommandRegistry();
  const commandContext = {
    log: (message: string) => terminal.log(message),
  };

  commands.register({
    id: "file.newTextFile",
    label: "New Text File",
    shortcut: "Ctrl+N",
    run: () => {
      tabs.openUntitled();
    },
  });
  commands.register({
    id: "file.newFile",
    label: "New File...",
    run: () => newFileCommand(),
  });
  commands.register({
    id: "file.newFolder",
    label: "New Folder...",
    run: () => newFolderCommand(),
  });
  registerDisabledCommand(commands, "file.newWindow", "New Window", commandContext);
  commands.register({
    id: "file.openFile",
    label: "Open File...",
    shortcut: "Ctrl+O",
    run: () => openFileWithDialog(),
  });
  commands.register({
    id: "file.openFolder",
    label: "Open Folder...",
    shortcut: "Ctrl+K Ctrl+O",
    run: () => openFolderWithDialog(),
  });
  registerDisabledCommand(commands, "file.openWorkspaceFile", "Open Workspace from File...", commandContext);
  registerDisabledCommand(commands, "file.addFolderToWorkspace", "Add Folder to Workspace...", commandContext);
  registerDisabledCommand(commands, "file.saveWorkspaceAs", "Save Workspace As...", commandContext);
  registerDisabledCommand(commands, "file.duplicateWorkspace", "Duplicate Workspace", commandContext);
  commands.register({
    id: "file.save",
    label: "Save",
    shortcut: "Ctrl+S",
    enabled: () => Boolean(tabs.active() || scratchWorkspace),
    run: () => saveActiveWithDialog(),
  });
  commands.register({
    id: "file.saveAs",
    label: "Save As...",
    shortcut: "Ctrl+Shift+S",
    enabled: () => Boolean(tabs.active() || scratchWorkspace),
    run: () => saveActiveAs(),
  });
  commands.register({
    id: "file.saveAll",
    label: "Save All",
    shortcut: "Ctrl+K S",
    enabled: () => hasUnsavedWork(),
    run: () => saveAllDirtyTabs(),
  });
  registerDisabledCommand(commands, "file.autoSave", "Auto Save", commandContext);
  registerDisabledCommand(commands, "file.preferences", "Preferences", commandContext);
  registerDisabledCommand(commands, "file.revertFile", "Revert File", commandContext);
  commands.register({
    id: "file.closeEditor",
    label: "Close Editor",
    shortcut: "Ctrl+W",
    enabled: () => Boolean(tabs.active()),
    run: async () => {
      const active = tabs.active();
      if (active) await closeTabWithConfirm(active.path);
    },
  });
  registerDisabledCommand(commands, "file.closeFolder", "Close Folder", commandContext);
  commands.register({
    id: "file.closeWindow",
    label: "Close Window",
    shortcut: "Alt+F4",
    run: () => closeWindowWithConfirm(),
  });
  commands.register({
    id: "file.exit",
    label: "Exit",
    run: () => closeWindowWithConfirm(),
  });

  function recentProjectItems(): MenuItem[] {
    if (recentProjects.length === 0) {
      return [{ kind: "command", command: "file.openRecent.empty" }];
    }
    return recentProjects.map((project, index) => {
      const id = `file.openRecent.${index}`;
      if (!commands.get(id)) {
        commands.register({
          id,
          label: project.name,
          run: () => openWorkspace(project.path, true),
        });
      }
      const command = commands.get(id);
      if (command) {
        command.label = project.name;
        command.run = () => openWorkspace(project.path, true);
      }
      return { kind: "command", command: id };
    });
  }

  registerDisabledCommand(commands, "file.openRecent.empty", "No Recent Folders", commandContext);

  commands.register({
    id: "terminal.newTerminal",
    label: "New Terminal",
    shortcut: "Ctrl+Shift+`",
    run: async () => {
      showBottomPanel();
      await openShell({ focus: true });
    },
  });
  registerDisabledCommand(commands, "terminal.splitTerminal", "Split Terminal", commandContext);
  registerDisabledCommand(
    commands,
    "terminal.newTerminalWindow",
    "New Terminal Window",
    commandContext,
    "Ctrl+Shift+C",
  );
  registerDisabledCommand(commands, "terminal.runTask", "Run Task...", commandContext);
  registerDisabledCommand(commands, "terminal.runBuildTask", "Run Build Task...", commandContext);
  registerDisabledCommand(commands, "terminal.runActiveFile", "Run Active File", commandContext);
  registerDisabledCommand(commands, "terminal.runSelectedText", "Run Selected Text", commandContext);
  registerDisabledCommand(commands, "terminal.showRunningTasks", "Show Running Tasks...", commandContext);
  registerDisabledCommand(commands, "terminal.restartRunningTask", "Restart Running Task...", commandContext);
  registerDisabledCommand(commands, "terminal.terminateTask", "Terminate Task...", commandContext);
  registerDisabledCommand(commands, "terminal.configureTasks", "Configure Tasks...", commandContext);
  registerDisabledCommand(
    commands,
    "terminal.configureDefaultBuildTask",
    "Configure Default Build Task...",
    commandContext,
  );

  mountMenus($("menubar"), commands, [
    {
      id: "file",
      label: "File",
      items: () => [
        menuCommand("file.newTextFile"),
        menuCommand("file.newFile"),
        menuCommand("file.newFolder"),
        menuCommand("file.newWindow"),
        menuSeparator(),
        menuCommand("file.openFile"),
        menuCommand("file.openFolder"),
        menuCommand("file.openWorkspaceFile"),
        menuSubmenu("file.openRecent", "Open Recent", recentProjectItems),
        menuSeparator(),
        menuCommand("file.addFolderToWorkspace"),
        menuCommand("file.saveWorkspaceAs"),
        menuCommand("file.duplicateWorkspace"),
        menuSeparator(),
        menuCommand("file.save"),
        menuCommand("file.saveAs"),
        menuCommand("file.saveAll"),
        menuCommand("file.autoSave"),
        menuSeparator(),
        menuCommand("file.preferences"),
        menuSeparator(),
        menuCommand("file.revertFile"),
        menuCommand("file.closeEditor"),
        menuCommand("file.closeFolder"),
        menuCommand("file.closeWindow"),
        menuSeparator(),
        menuCommand("file.exit"),
      ],
    },
    {
      id: "terminal",
      label: "Terminal",
      items: () => [
        menuCommand("terminal.newTerminal"),
        menuCommand("terminal.splitTerminal"),
        menuCommand("terminal.newTerminalWindow"),
        menuSeparator(),
        menuCommand("terminal.runTask"),
        menuCommand("terminal.runBuildTask"),
        menuCommand("terminal.runActiveFile"),
        menuCommand("terminal.runSelectedText"),
        menuSeparator(),
        menuCommand("terminal.showRunningTasks"),
        menuCommand("terminal.restartRunningTask"),
        menuCommand("terminal.terminateTask"),
        menuSeparator(),
        menuCommand("terminal.configureTasks"),
        menuCommand("terminal.configureDefaultBuildTask"),
      ],
    },
  ]);

  explorer.onOpenFile((path) => {
    if (isTemporaryPath(path)) {
      openScratchFile(path);
      return;
    }
    tabs.open(path).catch((e) => {
      terminal.log(`open failed: ${String(e)}`, { newPrompt: true });
    });
  });
  explorer.onFileCreated((path) => {
    if (isTemporaryPath(path)) {
      openScratchFile(path);
      return;
    }
    tabs.open(path).catch((e) => terminal.log(`open failed: ${String(e)}`));
  });
  explorer.onRename((from, to, isDir) => {
    renameTabsForPath(from, to, isDir);
  });
  explorer.onDelete((path, isDir) => {
    closeTabsForDeletedPath(path, isDir);
  });
  explorer.onConfirmDelete(async (path, isDir) => {
    const temporary = isTemporaryPath(path);
    const decision = await confirmSave({
      title: `Delete ${basename(path)}?`,
      message: temporary
        ? "This temporary item exists only in memory and will be discarded."
        : isDir
          ? "This will permanently delete the folder and its contents."
          : "This will permanently delete the file.",
      saveLabel: "Delete",
      discardLabel: "Don't Delete",
    });
    return decision === "save";
  });
  explorer.onScratchRootRename((name) => {
    updateScratchWorkspaceName(name);
  });
  explorer.onScratchRootDelete(() => {
    confirmSave({
      title: `Delete ${scratchWorkspace?.name ?? "scratch workspace"}?`,
      message: "This scratch workspace exists only in memory. Delete it and close any temporary files?",
      saveLabel: "Delete",
      discardLabel: "Don't Delete",
    }).then((decision) => {
      if (decision === "save") discardScratchWorkspace();
    });
  });

  tabs.onCloseRequest((path) => {
    closeTabWithConfirm(path).catch(() => {});
  });

  const btnNewFile = document.getElementById("btn-new-file");
  if (btnNewFile) {
    btnNewFile.onclick = () => {
      commands.execute("file.newFile").catch((e) => terminal.log(`new file failed: ${String(e)}`));
    };
  }
  const btnNewFolder = document.getElementById("btn-new-folder");
  if (btnNewFolder) {
    btnNewFolder.onclick = () => {
      // Sidebar shortcut stays in-place; do not route through File → New Folder.
      explorerNewFolderInPlace().catch((e) => terminal.log(`new folder failed: ${String(e)}`));
    };
  }

  problems.onJump(async (path, line, col) => {
    await tabs.open(path);
    editor.jumpTo(line, col);
    showBottom("terminal", false); // hide problems so the editor jump is visible
  });

  search.onOpenFile(async (path, line, col, endCol) => {
    await tabs.open(path);
    if (line != null) {
      editor.jumpTo(line, col ?? 1, endCol);
    }
  });

  const btnEmptyOpenFolder = $("btn-empty-open-folder");
  if (btnEmptyOpenFolder) {
    btnEmptyOpenFolder.onclick = async () => {
      await commands.execute("file.openFolder");
    };
  }

  const btnEmptyNewFile = $("btn-empty-new-file");
  if (btnEmptyNewFile) {
    btnEmptyNewFile.onclick = () => {
      commands.execute("file.newFile").catch((e) => terminal.log(`new file failed: ${String(e)}`));
    };
  }

  const btnEmptyNewFolder = $("btn-empty-new-folder");
  if (btnEmptyNewFolder) {
    btnEmptyNewFolder.onclick = () => {
      commands.execute("file.newFolder").catch((e) => terminal.log(`new folder failed: ${String(e)}`));
    };
  }

  $("btn-save").onclick = async () => {
    await commands.execute("file.save");
  };

  const btnClearTerminal = $("btn-clear-terminal");
  if (btnClearTerminal) {
    btnClearTerminal.onclick = () => {
      terminal.clear();
    };
  }

  const btnCloseBottom = $("btn-close-bottom");
  if (btnCloseBottom) {
    btnCloseBottom.onclick = () => {
      hideBottomPanel();
    };
  }

  // Push current size to PTY whenever the terminal resizes.
  terminal.onResize((cols, rows) => {
    if (!activePtyId) return;
    ipc.ptyResize(activePtyId, cols, rows).catch(() => {});
  });

  $("btn-shell").onclick = async () => {
    await openShell();
  };

  $("btn-preview").onclick = async () => {
    if (!currentWorkspace) {
      terminal.log("Open a workspace folder to use Live Preview.", { newPrompt: true });
      return;
    }
    if (preview.isOpen()) {
      await preview.close();
      return;
    }
    const active = tabs.active();
    let target =
      active && isHtmlPath(active.path) && !isTemporaryPath(active.path)
        ? active.path
        : null;
    if (!target) {
      const htmlTab = tabs.all().find((t) => isHtmlPath(t.path) && !isTemporaryPath(t.path));
      target = htmlTab?.path ?? null;
    }
    if (!target) {
      terminal.log("Open an HTML file to preview.", { newPrompt: true });
      return;
    }
    try {
      await preview.open(target);
    } catch (err) {
      terminal.log(`preview failed: ${String(err)}`, { newPrompt: true });
    }
  };

  async function runFile(path: string) {
    // Remember prior mode before snapshot/cleanup so a restored shell isn't
    // mis-classified after prepareRunTempSnapshot touches PTYs.
    restoreShellAfterRun = activePtyKind === "shell";
    saveDebug("runFile:start", {
      path,
      temporary: isTemporaryPath(path),
      hasWorkspace: Boolean(currentWorkspace),
      hasScratch: Boolean(scratchWorkspace),
      isScratchFile: Boolean(scratchWorkspace && findScratchFile(path)),
    });

    const restoreShellIfNeeded = async () => {
      if (restoreShellAfterRun && activePtyKind !== "shell") {
        restoreShellAfterRun = false;
        await openShell();
      }
    };

    // Unsaved / in-memory tabs must hit disk (and a workspace) before Run —
    // the jailed run_temp snapshot lives under the open workspace.
    if (isTemporaryPath(path) || !currentWorkspace) {
      saveDebug("runFile:needs-save-or-workspace", {
        reason: isTemporaryPath(path) ? "temporary-path" : "no-workspace",
        path,
        workspace: currentWorkspace?.root ?? null,
        scratch: scratchWorkspace?.rootPath ?? null,
      });
      terminal.log("Save file first.", { newPrompt: true });
      const saved = await saveActiveWithDialog();
      if (!saved) {
        saveDebug("runFile:save-aborted", {
          workspace: currentWorkspace?.root ?? null,
          scratch: scratchWorkspace?.rootPath ?? null,
          activeAfter: tabs.active()?.path ?? null,
        });
        await restoreShellIfNeeded();
        return;
      }
      const savedActive = tabs.active();
      if (!savedActive || isTemporaryPath(savedActive.path)) {
        saveDebug("runFile:still-temporary-after-save", {
          activeAfter: savedActive?.path ?? null,
          scratch: scratchWorkspace?.rootPath ?? null,
          workspace: currentWorkspace?.root ?? null,
        });
        await restoreShellIfNeeded();
        return;
      }
      path = savedActive.path;
      if (!currentWorkspace) {
        saveDebug("runFile:still-no-workspace-after-save", {
          path,
          scratch: scratchWorkspace?.rootPath ?? null,
        });
        terminal.log("Open a workspace folder to run files.", { newPrompt: true });
        await restoreShellIfNeeded();
        return;
      }
      saveDebug("runFile:post-save-ok", {
        path,
        workspace: currentWorkspace.root,
        scratch: scratchWorkspace?.rootPath ?? null,
      });
    } else {
      saveDebug("runFile:already-runnable", { path, workspace: currentWorkspace.root });
    }

    // Frictionless run: snapshot open buffers into workspace/.h1code/run_temp_/
    // so dirty buffers run without overwriting project files.
    let snapshot: { runFile: string; runDir: string } | null;
    try {
      snapshot = await prepareRunTempSnapshot(path);
    } catch (e) {
      terminal.log(`run failed: ${String(e)}`, { newPrompt: true });
      await restoreShellIfNeeded();
      return;
    }
    if (!snapshot) {
      await restoreShellIfNeeded();
      return;
    }

    // Close any existing PTY before attaching the run session.
    if (activePtyId) {
      await stopActiveRunner();
    }

    showBottom("terminal");
    terminal.fit();
    try {
      const dims = terminal.dimensions();
      const { id } = await ipc.pythonRun(snapshot.runFile, [], dims, snapshot.runDir);
      activePtyId = id;
      activePtyKind = "run";
      terminal.attachSession(id, { kind: "run" });
      rememberRunTarget(currentWorkspace, path);
    } catch (e) {
      terminal.log(`run failed: ${String(e)}`);
      await restoreShellIfNeeded();
    }
  }

  runButton.onclick = async () => {
    hideRunTargetPopover();
    const active = tabs.active();
    if (!active) {
      terminal.log("No file open.", { newPrompt: true });
      return;
    }
    // HTML is previewed, not executed — button is disabled; guard for safety.
    if (isHtmlPath(active.path)) {
      terminal.log("Use Preview for HTML files.", { newPrompt: true });
      return;
    }
    if (!isTextTabKind(active.kind)) {
      terminal.log("Can't run this file type.", { newPrompt: true });
      return;
    }

    const decision = await chooseRunTarget(active, editor.getDoc(), currentWorkspace);
    if (decision.shouldPrompt && decision.suggestion) {
      showRunTargetPopover(active.path, decision.suggestion);
      return;
    }

    await runFile(active.path);
  };

  syncRunButton();

  $("btn-ruff").onclick = async () => {
    try {
      const ruffDiags = await ipc.ruffCheck([]);
      // Translate ruff's shape into the unified ProblemEntry list, layered
      // under any pyright diagnostics already in the store. We keep this
      // ephemeral (not stored in `diagnostics`) so pyright continues owning
      // the editor squiggles.
      const ruffEntries: ProblemEntry[] = ruffDiags.map((d) => ({
        path: d.filename,
        diagnostic: {
          severity: "warning",
          message: d.message,
          code: d.code,
          source: "ruff",
          range: {
            start: { line: Math.max(0, d.location.row - 1), character: Math.max(0, d.location.column - 1) },
            end: { line: Math.max(0, d.end_location.row - 1), character: Math.max(0, d.end_location.column - 1) },
          },
        },
      }));
      const live: ProblemEntry[] = [];
      for (const { path, items } of diagnostics.values()) {
        for (const d of items) live.push({ path, diagnostic: d });
      }
      problems.setEntries([...live, ...ruffEntries]);
      showBottom("problems");
    } catch (e) {
      terminal.log(`ruff failed: ${String(e)}`, { newPrompt: true });
      showBottom("terminal");
    }
  };

  // Activity rail
  document.querySelectorAll<HTMLElement>(".rail-btn").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".rail-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode!;
      document
        .querySelectorAll<HTMLElement>(".sidebar-view")
        .forEach((v) => v.classList.add("hidden"));
      $(`panel-${mode}`).classList.remove("hidden");
      if (mode === "search") search.focus();
    };
  });

  // Bottom tabs
  document.querySelectorAll<HTMLElement>(".bottom-tab").forEach((btn) => {
    btn.onclick = () => showBottom(btn.dataset.mode as "terminal" | "problems");
  });

  // Backend events
  recentDebug("before core event listener registration");
  await onCoreEvent((evt) => routeEvent(evt));
  recentDebug("after core event listener registration");

  function routeEvent(evt: CoreEvent) {
    terminal.applyEvent(evt);
    explorer.applyEvent(evt);
    search.applyEvent(evt);
    fileSync.handleEvent(evt);

    if (evt.kind === "process_exited" && evt.id === activePtyId) {
      activePtyId = null;
      const wasRun = activePtyKind === "run";
      activePtyKind = null;
      if (wasRun && restoreShellAfterRun) {
        restoreShellAfterRun = false;
        void openShell();
      }
    }

    if (evt.kind === "diagnostics" && evt.source === "pyright") {
      const key = normPath(evt.path);
      if (evt.items.length === 0) {
        diagnostics.delete(key);
      } else {
        diagnostics.set(key, { path: evt.path, items: evt.items });
      }
      // If this is the file currently shown, repaint the editor.
      const tab = tabs.active();
      if (tab && normPath(tab.path) === key) {
        editor.setDiagnostics(evt.items);
      }
      refreshProblems();
    }

    if (evt.kind === "workspace_closed") {
      void cleanupRunTempDir();
      preview.resetLocal();
      fileSync.clear();
      currentWorkspace = null;
      scratchWorkspace = null;
      explorer.clearScratchRoot();
      search.setWorkspaceRoot(null);
      diagnostics.clear();
      editor.setDiagnostics([]);
      refreshProblems();
      // Close disk-backed tabs; leave untitled/scratch alone if any.
      for (const tab of [...tabs.all()]) {
        if (!isTemporaryPath(tab.path)) tabs.close(tab.path);
      }
      renderEmptyState();
      updateWorkspaceUi(null);
    }

    if (evt.kind === "log") {
      // Only surface warnings/errors in the terminal. Info/debug (pyright started,
      // search index ready, …) used to be injected as `# …` shell comments and
      // tripped zsh on globs like `[INFO]` / `(python: …)`.
      if (evt.level !== "warn" && evt.level !== "error") return;
      const prefix = evt.level === "error" ? "ERR" : "WARN";
      terminal.log(`${prefix}: ${evt.message}`, { newPrompt: true });
    }
  }

  function showBottomPanel() {
    const app = $("app");
    app.classList.remove("bottom-collapsed");
    const saved = localStorage.getItem("h1code.bottomHeight");
    let height = saved ? parseInt(saved, 10) : 220;
    if (Number.isNaN(height)) height = 220;
    height = Math.max(80, Math.min(height, window.innerHeight - 150));
    app.style.gridTemplateRows = `35px 1fr 1px ${height}px 22px`;
    localStorage.setItem("h1code.bottomPanelVisible", "1");
    terminal.fit();
  }

  function hideBottomPanel() {
    const app = $("app");
    app.classList.add("bottom-collapsed");
    // Clear inline rows so #app.bottom-collapsed CSS can apply.
    app.style.gridTemplateRows = "";
    localStorage.setItem("h1code.bottomPanelVisible", "0");
  }

  function showBottom(mode: "terminal" | "problems", focus = true) {
    showBottomPanel();
    document
      .querySelectorAll<HTMLElement>(".bottom-tab")
      .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    document
      .querySelectorAll<HTMLElement>(".bottom-view")
      .forEach((v) => v.classList.add("hidden"));
    $(mode).classList.remove("hidden");
    if (focus) {
      $(mode).scrollTop = $(mode).scrollHeight;
      if (mode === "terminal") {
        terminal.fit();
        terminal.focus();
      }
    }
  }

  // Keyboard: Ctrl/Cmd+S = save, Ctrl/Cmd+N = new untitled file
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideRunTargetPopover();
    }
    if (terminalFocused || terminal.isFocused()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      commands.execute(e.shiftKey ? "file.saveAs" : "file.save").catch(() => {});
    }
    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      commands.execute("file.newTextFile").catch((err) => terminal.log(`new file failed: ${String(err)}`));
    }
    if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      commands.execute("file.openFile").catch((err) => terminal.log(`open file failed: ${String(err)}`));
    }
    if (mod && e.key.toLowerCase() === "w") {
      e.preventDefault();
      commands.execute("file.closeEditor").catch(() => {});
    }
  });

  // Zoom shortcuts — capture phase fires before xterm's own keydown listeners,
  // so Ctrl+Plus/Minus/0 are intercepted even when the terminal has focus.
  // stopPropagation() prevents the keys from reaching xterm and the PTY.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key;
    const zoomIn  = k === "+" || k === "="; // "=" = unshifted Plus key
    const zoomOut = k === "-";
    const reset   = k === "0";
    if (!zoomIn && !zoomOut && !reset) return;
    e.preventDefault();
    e.stopPropagation();
    if (zoomIn)       applyZoom(zoomLevel + ZOOM_STEP);
    else if (zoomOut) applyZoom(zoomLevel - ZOOM_STEP);
    else              applyZoom(1.0);
  }, /* capture */ true);

  document.addEventListener("mousedown", (e) => {
    const target = e.target as Node;
    if (runTargetPopover.classList.contains("hidden")) return;
    if (runTargetPopover.contains(target) || runButton.contains(target)) return;
    hideRunTargetPopover();
  });

  function initResizing() {
    const body = $("body");
    const app = $("app");
    const sidebarResizer = $("sidebar-resizer");
    const bottomResizer = $("bottom-resizer");

    const savedSidebarWidth = localStorage.getItem("h1code.sidebarWidth");
    let sidebarWidth = savedSidebarWidth ? parseInt(savedSidebarWidth, 10) : 260;
    sidebarWidth = Math.max(150, Math.min(sidebarWidth, 600));

    const savedBottomHeight = localStorage.getItem("h1code.bottomHeight");
    let bottomHeight = savedBottomHeight ? parseInt(savedBottomHeight, 10) : 220;
    bottomHeight = Math.max(80, Math.min(bottomHeight, window.innerHeight - 150));

    body.style.gridTemplateColumns = `${sidebarWidth}px 1px 1fr`;
    if (!app.classList.contains("bottom-collapsed")) {
      app.style.gridTemplateRows = `35px 1fr 1px ${bottomHeight}px 22px`;
    }

    sidebarResizer.onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("resizing");
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        let newWidth = startWidth + deltaX;
        newWidth = Math.max(150, Math.min(newWidth, 600));
        sidebarWidth = newWidth;
        body.style.gridTemplateColumns = `${newWidth}px 1px 1fr`;
      };

      const onMouseUp = () => {
        document.body.classList.remove("resizing");
        localStorage.setItem("h1code.sidebarWidth", sidebarWidth.toString());
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        terminal.fit();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    bottomResizer.onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("resizing");
      const startY = e.clientY;
      const startHeight = bottomHeight;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaY = moveEvent.clientY - startY;
        let newHeight = startHeight - deltaY;
        newHeight = Math.max(80, Math.min(newHeight, window.innerHeight - 150));
        bottomHeight = newHeight;
        app.style.gridTemplateRows = `35px 1fr 1px ${newHeight}px 22px`;
        terminal.fit();
      };

      const onMouseUp = () => {
        document.body.classList.remove("resizing");
        localStorage.setItem("h1code.bottomHeight", bottomHeight.toString());
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        terminal.fit();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("resize", () => {
      const maxBottomHeight = window.innerHeight - 150;
      if (bottomHeight > maxBottomHeight) {
        bottomHeight = Math.max(80, maxBottomHeight);
        if (!app.classList.contains("bottom-collapsed")) {
          app.style.gridTemplateRows = `35px 1fr 1px ${bottomHeight}px 22px`;
        }
      }
      terminal.fit();
    });
  }

  const startBottomCollapsed = localStorage.getItem("h1code.bottomPanelVisible") === "0";
  if (startBottomCollapsed) {
    $("app").classList.add("bottom-collapsed");
  }

  initResizing();
  refreshProblems(); // render empty placeholder
  await loadRecentProjects();
  renderEmptyState();

  // Default terminal mode: interactive shell (not a dead non-interactive pane).
  // Don't steal editor focus on boot.
  await openShell({ focus: false });
  // openShell → showBottom reveals the panel; restore collapsed if user left it closed.
  if (startBottomCollapsed) {
    hideBottomPanel();
  }

  // Block the window from closing if there are unsaved changes.
  // IMPORTANT: event.preventDefault() must be called synchronously before
  // any awaits — Tauri 2 checks it on the same tick, not after the promise
  // resolves. We therefore always prevent and call destroy() ourselves when
  // ready to close.
  try {
    const appWindow = getCurrentWindow();
    await appWindow.onCloseRequested(async (event) => {
      // Always take control; we'll call destroy() when it's safe to close.
      event.preventDefault();
      await closeWindowWithConfirm();
    });
  } catch (e) {
    console.error("Could not attach close handler", e);
  }

  // Check if a workspace is already open on startup
  ipc.workspaceInfo().then(async (info) => {
    recentDebug("startup.workspaceInfo", {
      workspace: info?.root ?? null,
      recentCount: recentProjects.length,
      recentPaths: recentProjects.map((p) => p.path),
    });
    if (info) {
      currentWorkspace = info;
      updateWorkspaceUi(info);
      explorer.setRoot(info.root).catch(() => {});
      recentDebug("startup.workspaceFound.addRecent", {
        path: info.root,
        name: info.name,
      });
      addToRecentProjects(info.root, info.name).catch(() => {});
    }
    renderEmptyState();

    // Diagnosis helper: New Folder → scratch file → Run/save → Save again.
    // Enable with ?reproScratchSave=1 or localStorage h1code.debug.reproScratchSave=1.
    // Force-parent via localStorage h1code.debug.saveScratchTo (default /tmp/h1code-repro-real).
    try {
      const params = new URLSearchParams(location.search);
      const wantRepro =
        params.get("reproScratchSave") === "1" ||
        localStorage.getItem("h1code.debug.reproScratchSave") === "1";
      if (wantRepro) {
        localStorage.setItem("h1code.debug.save", "1");
        localStorage.removeItem("h1code.debug.reproScratchSave");
        const forcedParent =
          localStorage.getItem("h1code.debug.saveScratchTo") ||
          params.get("saveScratchTo") ||
          "/tmp/h1code-repro-real";
        // Give shell/UI a beat, then drive the reported sequence without native dialogs.
        setTimeout(() => {
          void (async () => {
            saveDebug("repro:begin", { forcedParent });
            try {
              await cleanupRunTempDir();
              fileSync.clear();
              try {
                await ipc.workspaceClose();
              } catch {
                /* ignore */
              }
              for (const tab of tabs.all()) {
                tabs.close(tab.path);
              }
              currentWorkspace = null;
              scratchWorkspaceCounter += 1;
              scratchWorkspace = {
                id: scratchWorkspaceCounter,
                name: "Scratch Workspace",
                rootPath: `scratch:${scratchWorkspaceCounter}`,
                children: [],
              };
              explorer.setScratchRoot(
                scratchWorkspace.name,
                scratchWorkspace.rootPath,
                scratchWorkspace.children
              );
              search.setWorkspaceRoot(null);
              updateWorkspaceUi(null);
              saveDebug("repro:scratch-created");

              const fileName = "repro_run.py";
              const filePath = joinPath(scratchWorkspace.rootPath, fileName);
              const file: ScratchFile = {
                kind: "file",
                name: fileName,
                path: filePath,
                content: "print('scratch-repro')\n",
              };
              scratchWorkspace.children.unshift(file);
              explorer.setScratchRoot(
                scratchWorkspace.name,
                scratchWorkspace.rootPath,
                scratchWorkspace.children
              );
              openScratchFile(file.path);
              editor.setDoc(file.content, file.path);
              tabs.updateActiveContent(file.content);
              saveDebug("repro:file-created", { filePath });

              debugForcedScratchSaveParent = forcedParent;
              saveDebug("repro:run-1");
              await runFile(filePath);
              saveDebug("repro:after-run-1", {
                workspaceRoot: currentWorkspace ? (currentWorkspace as WorkspaceInfo).root : null,
                scratchRoot: scratchWorkspace ? scratchWorkspace.rootPath : null,
                active: tabs.active()?.path ?? null,
              });

              saveDebug("repro:save-2");
              const save2 = await saveActiveWithDialog();
              saveDebug("repro:after-save-2", {
                save2,
                workspaceRoot: currentWorkspace ? (currentWorkspace as WorkspaceInfo).root : null,
                scratchRoot: scratchWorkspace ? scratchWorkspace.rootPath : null,
                active: tabs.active()?.path ?? null,
              });
              saveDebug("repro:done");
            } catch (e) {
              saveDebug("repro:error", { error: String(e) });
            } finally {
              debugForcedScratchSaveParent = null;
              // Dump the in-memory trace so we can read it without DevTools.
              try {
                const w = window as unknown as { __saveDebugLog?: unknown[] };
                const dumpTargets = [
                  forcedParent,
                  "/tmp/h1code-repro-real",
                  "/home/andrewunknown/Documents/github/h1code",
                ];
                for (const dumpRoot of dumpTargets) {
                  try {
                    const dumpOk = await adoptWorkspaceRoot(dumpRoot);
                    if (!dumpOk) continue;
                    const dumpPath = joinPath(dumpRoot, "h1code-save-debug-trace.json");
                    await ipc.fsWrite(
                      dumpPath,
                      JSON.stringify(w.__saveDebugLog ?? [], null, 2) + "\n"
                    );
                    saveDebug("repro:trace-dumped", { dumpPath });
                    break;
                  } catch {
                    /* try next dump root */
                  }
                }
              } catch (dumpErr) {
                console.error("failed to dump save-debug trace", dumpErr);
              }
            }
          })();
        }, 800);
      }

      // Recent-projects diagnosis: ?reproRecent=write|read
      // write → open Music/lmao (or ?path=), persist, dump trace
      // read  → dump cold-start load/prune/render trace (load already ran)
      const recentPhase = params.get("reproRecent");
      if (recentPhase === "write" || recentPhase === "read") {
        localStorage.setItem("h1code.debug.recent", "1");
        const targetPath =
          params.get("path") ||
          localStorage.getItem("h1code.debug.reproRecentPath") ||
          "/home/andrewunknown/Music/lmao";
        setTimeout(() => {
          void (async () => {
            recentDebug("repro.phase", { phase: recentPhase, targetPath });
            try {
              if (recentPhase === "write") {
                // Close any leftover workspace so open path matches user Open Folder.
                try {
                  await ipc.workspaceClose();
                } catch {
                  /* ignore */
                }
                currentWorkspace = null;
                scratchWorkspace = null;
                explorer.clearScratchRoot();
                updateWorkspaceUi(null);
                recentDebug("repro.write.openWorkspace", { targetPath });
                const ok = await openWorkspace(targetPath, false, true);
                recentDebug("repro.write.afterOpen", {
                  ok,
                  // Cast: TS keeps null narrowing across await openWorkspace().
                  workspace: currentWorkspace
                    ? (currentWorkspace as WorkspaceInfo).root
                    : null,
                  recentPaths: recentProjects.map((p) => p.path),
                });
                // Close workspace so empty-state render can show recents in-session.
                try {
                  await ipc.workspaceClose();
                } catch {
                  /* ignore */
                }
                currentWorkspace = null;
                updateWorkspaceUi(null);
                explorer.clearScratchRoot();
                search.setWorkspaceRoot(null);
                renderEmptyState();
                recentDebug("repro.write.afterCloseForUi", {
                  recentPaths: recentProjects.map((p) => p.path),
                });
              } else {
                recentDebug("repro.read.snapshot", {
                  recentPaths: recentProjects.map((p) => p.path),
                  workspace: currentWorkspace?.root ?? null,
                });
                // Re-run load to capture a second pass with current jail state.
                await loadRecentProjects();
                renderEmptyState();
                recentDebug("repro.read.afterReload", {
                  recentPaths: recentProjects.map((p) => p.path),
                });
              }
            } catch (e) {
              recentDebug("repro.error", { phase: recentPhase, error: String(e) });
            } finally {
              try {
                const w = window as unknown as { __recentDebugLog?: unknown[] };
                const dumpTargets =
                  recentPhase === "write"
                    ? [targetPath, "/home/andrewunknown/Documents/github/h1code", "/tmp"]
                    : ["/home/andrewunknown/Documents/github/h1code", "/home/andrewunknown/Music/lmao", "/tmp"];
                for (const dumpRoot of dumpTargets) {
                  try {
                    // Prefer dumping into the already-open target without re-adding
                    // unrelated roots to recent when possible.
                    const alreadyOpen =
                      currentWorkspace &&
                      normPath(currentWorkspace.root) === normPath(dumpRoot);
                    if (!alreadyOpen) {
                      const dumpOk = await adoptWorkspaceRoot(dumpRoot);
                      if (!dumpOk) continue;
                    }
                    const dumpPath = joinPath(
                      dumpRoot,
                      recentPhase === "write"
                        ? "h1code-recent-debug-write.json"
                        : "h1code-recent-debug-read.json"
                    );
                    await ipc.fsWrite(
                      dumpPath,
                      JSON.stringify(w.__recentDebugLog ?? [], null, 2) + "\n"
                    );
                    recentDebug("repro.trace-dumped", { dumpPath });
                    break;
                  } catch {
                    /* try next */
                  }
                }
              } catch (dumpErr) {
                console.error("failed to dump recent-debug trace", dumpErr);
              }
            }
          })();
        }, 900);
      }
    } catch (e) {
      console.error("scratch-save repro setup failed", e);
    }

    // New-Folder diagnosis: ?reproNewFolder=menu|sidebar
    // menu → File-menu handler (must prompt / start scratch outside cwd)
    // sidebar → in-place beginCreate (contrast; intended no destination dialog)
    try {
      const params = new URLSearchParams(location.search);
      const nfPhase = params.get("reproNewFolder");
      if (nfPhase === "menu" || nfPhase === "sidebar") {
        localStorage.setItem("h1code.debug.newfolder", "1");
        setTimeout(() => {
          void (async () => {
            newfolderDebug("repro:begin", { phase: nfPhase });
            try {
              // Ensure a browsing context exists so the old buggy File-menu path
              // would have called beginCreate (in-cwd) — proving the split.
              if (!currentWorkspace && !scratchWorkspace) {
                scratchWorkspaceCounter += 1;
                scratchWorkspace = {
                  id: scratchWorkspaceCounter,
                  name: "repro-cwd",
                  rootPath: `scratch:${scratchWorkspaceCounter}`,
                  children: [],
                };
                explorer.setScratchRoot(
                  scratchWorkspace.name,
                  scratchWorkspace.rootPath,
                  scratchWorkspace.children
                );
                search.setWorkspaceRoot(null);
                updateWorkspaceUi(null);
                newfolderDebug("repro:seeded-scratch-cwd", {
                  scratchRoot: scratchWorkspace.rootPath,
                });
              }
              if (nfPhase === "menu") {
                debugForcedScratchWorkspaceName = "FileMenu New Folder Repro";
                try {
                  await commands.execute("file.newFolder");
                } finally {
                  debugForcedScratchWorkspaceName = null;
                }
                newfolderDebug("repro:menu-after", {
                  workspace: currentWorkspace?.root ?? null,
                  scratch: scratchWorkspace
                    ? { root: scratchWorkspace.rootPath, name: scratchWorkspace.name }
                    : null,
                  expect: "scratch outside prior cwd; no beginCreate",
                });
              } else {
                await explorerNewFolderInPlace();
                newfolderDebug("repro:sidebar-after", {
                  workspace: currentWorkspace?.root ?? null,
                  scratch: scratchWorkspace
                    ? { root: scratchWorkspace.rootPath, name: scratchWorkspace.name }
                    : null,
                  expect: "beginCreate in-place; no destination prompt",
                });
              }
            } catch (e) {
              newfolderDebug("repro:error", { phase: nfPhase, error: String(e) });
            } finally {
              try {
                const w = window as unknown as { __newfolderDebugLog?: unknown[] };
                const repo = "/home/andrewunknown/Documents/github/h1code";
                const dumpPath = joinPath(repo, "h1code-newfolder-debug-trace.json");
                // Scratch/no-workspace state cannot use jailed fsWrite — adopt repo for dump only.
                await adoptWorkspaceRoot(repo);
                await ipc.fsWrite(
                  dumpPath,
                  JSON.stringify(w.__newfolderDebugLog ?? [], null, 2) + "\n"
                );
                newfolderDebug("repro:trace-dumped", { dumpPath });
              } catch (dumpErr) {
                console.error("failed to dump newfolder-debug trace", dumpErr);
              }
            }
          })();
        }, 800);
      }
    } catch (e) {
      console.error("newfolder repro setup failed", e);
    }
  }).catch((e) => {
    console.error("Failed to query initial workspace", e);
    renderEmptyState();
  });
}

// Vite HMR: destroy the singleton EditorView before this module re-evaluates so
// keymaps / updateListeners never stack across hot reloads. Prefer a full
// `tauri dev` restart when validating editor input behavior.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    destroyEditor();
  });
}

bootstrap().catch((err) => {
  console.error(err);
  document.body.textContent = `Bootstrap failed: ${err}`;
});
