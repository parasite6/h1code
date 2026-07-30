// Live HTML preview: docked iframe in the split pane; optional pop-out
// (Tauri WebviewWindow or system Chrome --app). Engine preference only
// chooses the pop-out host — docked content always stays in the panel.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ipc, type PreviewEngine } from "./ipc";

const WIDTH_KEY = "h1code.previewWidth";
const POPOUT_LABEL = "preview-popout";
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 220;
const MAX_WIDTH_RATIO = 0.7;

export interface PreviewBinding {
  isOpen(): boolean;
  open(filePath: string): Promise<void>;
  close(): Promise<void>;
  reload(filePath?: string): Promise<void>;
  currentFile(): string | null;
  setEngine(engine: PreviewEngine): Promise<void>;
  resetLocal(): void;
}

export interface PreviewMountOpts {
  centerEl: HTMLElement;
  paneEl: HTMLElement;
  resizerEl: HTMLElement;
  frameEl: HTMLIFrameElement;
  chromePlaceholderEl: HTMLElement;
  statusEl: HTMLElement;
  engineBtn: HTMLButtonElement;
  popoutBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  onLog?: (message: string) => void;
}

function cacheBust(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
}

export function mountPreview(opts: PreviewMountOpts): PreviewBinding {
  let open = false;
  let engine: PreviewEngine = "tauri";
  let currentFile: string | null = null;
  let currentUrl: string | null = null;
  let poppedOut = false;
  let previewWidth = loadWidth();

  applyWidth(previewWidth);
  opts.engineBtn.onclick = () => {
    void toggleEngine();
  };
  opts.popoutBtn.onclick = () => {
    void togglePopout();
  };
  opts.closeBtn.onclick = () => {
    void close();
  };
  wireResizer();

  function loadWidth(): number {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : DEFAULT_WIDTH;
    return Number.isFinite(n) ? Math.max(MIN_WIDTH, n) : DEFAULT_WIDTH;
  }

  function applyWidth(width: number) {
    previewWidth = width;
    opts.paneEl.style.setProperty("--preview-width", `${width}px`);
  }

  function setStatus(mode: "" | "docked" | "popout", useChrome: boolean) {
    opts.statusEl.replaceChildren();
    if (!mode) return;

    const label = document.createElement("span");
    label.className = "preview-status-label";
    label.textContent = mode === "docked" ? "Docked" : "Pop-out";
    opts.statusEl.appendChild(label);

    const sep = document.createElement("span");
    sep.className = "preview-status-sep";
    sep.textContent = "·";
    opts.statusEl.appendChild(sep);

    if (useChrome) {
      const img = document.createElement("img");
      img.src = "/chrome-logo.svg";
      img.alt = "Chrome";
      img.title = "Chrome";
      img.className = "preview-engine-logo";
      img.width = 12;
      img.height = 12;
      opts.statusEl.appendChild(img);
    } else {
      const img = document.createElement("img");
      img.src = "/tauri-icon.svg";
      img.alt = "Tauri";
      img.title = "Tauri";
      img.className = "preview-engine-logo";
      img.width = 12;
      img.height = 12;
      opts.statusEl.appendChild(img);
    }
  }

  function updateEngineButton() {
    opts.engineBtn.textContent = engine === "chrome" ? "Use Tauri" : "Use Chrome";
  }

  function updatePopoutButton() {
    opts.popoutBtn.textContent = poppedOut ? "Dock" : "Pop out";
  }

  function showPanel(visible: boolean) {
    open = visible;
    opts.centerEl.classList.toggle("preview-open", visible);
    opts.paneEl.classList.toggle("hidden", !visible);
    opts.resizerEl.classList.toggle("hidden", !visible);
  }

  function clearIframe() {
    opts.frameEl.removeAttribute("src");
    opts.frameEl.src = "about:blank";
  }

  function showDockedFrame(show: boolean) {
    // Placeholder only when Chrome is popped out (external window owns the view).
    const chromeExternal = poppedOut && engine === "chrome";
    opts.chromePlaceholderEl.classList.toggle("hidden", !chromeExternal);
    opts.frameEl.classList.toggle("hidden", chromeExternal || !show);
  }

  async function closePopoutWindow() {
    try {
      const existing = await WebviewWindow.getByLabel(POPOUT_LABEL);
      if (existing) await existing.close();
    } catch {
      // ignore
    }
  }

  async function persistPoppedOut(value: boolean) {
    poppedOut = value;
    updatePopoutButton();
    try {
      await ipc.previewSetPoppedOut(value);
    } catch (e) {
      opts.onLog?.(`Failed to save pop-out preference: ${String(e)}`);
    }
  }

  /** Show preview in the split-pane iframe (both engines when docked). */
  async function showDocked(url: string) {
    await ipc.previewKillChrome().catch(() => {});
    await closePopoutWindow();
    showDockedFrame(true);
    opts.frameEl.src = cacheBust(url);
    setStatus("docked", engine === "chrome");
  }

  /** Detached surface: Chrome app window or Tauri WebviewWindow. */
  async function showPoppedOut(url: string) {
    const busted = cacheBust(url);
    clearIframe();

    if (engine === "chrome") {
      await closePopoutWindow();
      showDockedFrame(false);
      await ipc.previewSpawnChrome(busted);
      setStatus("popout", true);
      return;
    }

    await ipc.previewKillChrome().catch(() => {});
    showDockedFrame(false);
    const existing = await WebviewWindow.getByLabel(POPOUT_LABEL);
    if (existing) await existing.close();

    const win = new WebviewWindow(POPOUT_LABEL, {
      url: busted,
      title: "Preview",
      width: 900,
      height: 700,
      focus: true,
    });
    win.once("tauri://error", (e) => {
      opts.onLog?.(
        `Preview pop-out failed: ${String((e as { payload?: unknown }).payload ?? e)}`
      );
      void persistPoppedOut(false).then(() => {
        if (currentUrl) void showDocked(currentUrl);
      });
    });
    win.once("tauri://destroyed", () => {
      if (!poppedOut) return;
      void persistPoppedOut(false).then(() => {
        if (open && currentUrl && engine === "tauri") {
          void showDocked(currentUrl);
        }
      });
    });
    setStatus("popout", false);
  }

  async function applyUrl(url: string) {
    currentUrl = url;
    if (poppedOut) {
      await showPoppedOut(url);
    } else {
      await showDocked(url);
    }
  }

  async function openFile(filePath: string): Promise<void> {
    const result = await ipc.previewOpen(filePath);
    engine = result.engine;
    poppedOut = result.isPoppedOut;
    currentFile = filePath;
    updateEngineButton();
    updatePopoutButton();
    showPanel(true);
    await applyUrl(result.url);
  }

  async function reload(filePath?: string): Promise<void> {
    if (!open) return;
    const path = filePath ?? currentFile;
    if (!path) return;
    const url = await ipc.previewReloadUrl(path);
    currentFile = path;
    await applyUrl(url);
  }

  async function close(): Promise<void> {
    await closePopoutWindow();
    await ipc.previewKillChrome().catch(() => {});
    await ipc.previewClose().catch(() => {});
    clearIframe();
    showDockedFrame(true);
    opts.chromePlaceholderEl.classList.add("hidden");
    opts.frameEl.classList.remove("hidden");
    showPanel(false);
    currentFile = null;
    currentUrl = null;
    setStatus("", false);
  }

  function resetLocal() {
    clearIframe();
    opts.chromePlaceholderEl.classList.add("hidden");
    opts.frameEl.classList.remove("hidden");
    showPanel(false);
    currentFile = null;
    currentUrl = null;
    poppedOut = false;
    updatePopoutButton();
    setStatus("", false);
  }

  async function toggleEngine(): Promise<void> {
    if (!open) return;
    const next: PreviewEngine = engine === "tauri" ? "chrome" : "tauri";
    try {
      engine = await ipc.previewSetEngine(next);
      updateEngineButton();
      if (currentUrl) await applyUrl(currentUrl);
    } catch (e) {
      opts.onLog?.(`Preview engine switch failed: ${String(e)}`);
    }
  }

  async function togglePopout(): Promise<void> {
    if (!open || !currentUrl) return;
    const next = !poppedOut;
    await persistPoppedOut(next);
    await applyUrl(currentUrl);
  }

  function wireResizer() {
    opts.resizerEl.onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("resizing");
      const startX = e.clientX;
      const startWidth = previewWidth;
      const centerRect = opts.centerEl.getBoundingClientRect();

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        const max = Math.floor(centerRect.width * MAX_WIDTH_RATIO);
        let next = startWidth + delta;
        next = Math.max(MIN_WIDTH, Math.min(next, max));
        applyWidth(next);
      };

      const onMouseUp = () => {
        document.body.classList.remove("resizing");
        localStorage.setItem(WIDTH_KEY, String(previewWidth));
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };
  }

  updateEngineButton();
  updatePopoutButton();

  return {
    isOpen: () => open,
    open: openFile,
    close,
    reload,
    currentFile: () => currentFile,
    setEngine: async (next) => {
      engine = await ipc.previewSetEngine(next);
      updateEngineButton();
      if (open && currentUrl) await applyUrl(currentUrl);
    },
    resetLocal,
  };
}
