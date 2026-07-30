// Settings editor tab — sectioned, extensible; Autocomplete first.

import {
  ipc,
  type AutocompleteSettings,
  type FimModelOption,
  type LlamaServerStatus,
} from "./ipc";
import {
  FIM_MODEL_CATALOG,
  buildLlamaServerCommand,
  defaultFimModel,
} from "./fimModels";

export interface SettingsBinding {
  /** Reload settings from disk into the form. */
  open(): void;
  setWorkspaceRoot(root: string | null): void;
  /** Called after a successful settings save (e.g. reload editor autocomplete). */
  onSaved(handler: (settings: AutocompleteSettings) => void): void;
}

export function mountSettings(panel: HTMLElement): SettingsBinding {
  const emptyEl = panel.querySelector<HTMLElement>("#settings-empty")!;
  const bodyEl = panel.querySelector<HTMLElement>("#settings-body")!;
  const enabledEl = panel.querySelector<HTMLInputElement>("#settings-ac-enabled")!;
  const modelEl = panel.querySelector<HTMLSelectElement>("#settings-ac-model")!;
  const startEl = panel.querySelector<HTMLButtonElement>("#settings-ac-start")!;
  const stopEl = panel.querySelector<HTMLButtonElement>("#settings-ac-stop")!;
  const serverHintEl = panel.querySelector<HTMLElement>("#settings-ac-server-hint")!;
  const endpointEl = panel.querySelector<HTMLInputElement>("#settings-ac-endpoint")!;
  const llamaPathEl = panel.querySelector<HTMLInputElement>("#settings-ac-llama-path")!;
  const metaEl = panel.querySelector<HTMLElement>("#settings-ac-meta")!;
  const statusEl = panel.querySelector<HTMLElement>("#settings-status")!;

  let workspaceRoot: string | null = null;
  let models: FimModelOption[] = [...FIM_MODEL_CATALOG];
  let current: AutocompleteSettings | null = null;
  let serverStatus: LlamaServerStatus | null = null;
  let saving = false;
  let busy = false;
  let savedHandler: ((settings: AutocompleteSettings) => void) | null = null;

  function setStatus(message: string, kind: "info" | "error" = "info") {
    statusEl.textContent = message;
    statusEl.dataset.kind = kind;
  }

  function renderMeta(settings: AutocompleteSettings) {
    metaEl.textContent = [
      `debounce ${settings.debounceMs}ms`,
      `prefix ${settings.nPrefix}`,
      `suffix ${settings.nSuffix}`,
      `predict ${settings.nPredict}`,
    ].join(" · ");
  }

  function renderServerHint() {
    const model =
      models.find((m) => m.id === modelEl.value) ?? defaultFimModel();
    const endpoint = endpointEl.value.trim() || "http://127.0.0.1:8081";
    const cmd = buildLlamaServerCommand(model, endpoint);
    const pathHint = llamaPathEl.value.trim()
      ? `Binary: ${llamaPathEl.value.trim()}`
      : "Binary: auto-discover (PATH, ~/llama-cuda/llama-b*, …) or set path below";
    if (serverStatus?.lastError) {
      serverHintEl.textContent = `Error: ${serverStatus.lastError}`;
    } else if (serverStatus?.running) {
      serverHintEl.textContent = `${serverStatus.message}. Equivalent CLI: ${cmd}`;
    } else {
      serverHintEl.textContent = `${pathHint}. Auto-starts when autocomplete is enabled. CLI: ${cmd}`;
    }
  }

  function statusKindFromServer(): "info" | "error" {
    if (serverStatus?.lastError) return "error";
    if (serverStatus && !serverStatus.running && !serverStatus.message.includes("disabled")) {
      return "error";
    }
    return "info";
  }

  function populateModels(list: FimModelOption[]) {
    models = list.length > 0 ? list : [...FIM_MODEL_CATALOG];
    const previous = modelEl.value;
    modelEl.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      modelEl.appendChild(opt);
    }
    if (previous && models.some((m) => m.id === previous)) {
      modelEl.value = previous;
    } else if (models.length > 0) {
      modelEl.value = models[0].id;
    }
  }

  function applyToForm(settings: AutocompleteSettings) {
    current = settings;
    enabledEl.checked = settings.enabled;
    endpointEl.value = settings.endpoint;
    llamaPathEl.value = settings.llamaServerPath ?? "";
    if (models.some((m) => m.id === settings.model)) {
      modelEl.value = settings.model;
    } else if (models.length > 0) {
      modelEl.value = models[0].id;
    }
    renderMeta(settings);
    renderServerHint();
  }

  function showWorkspaceState() {
    const hasWorkspace = Boolean(workspaceRoot);
    emptyEl.classList.toggle("hidden", hasWorkspace);
    bodyEl.classList.toggle("hidden", !hasWorkspace);
    const locked = !hasWorkspace || saving || busy;
    enabledEl.disabled = locked;
    modelEl.disabled = locked;
    endpointEl.disabled = locked;
    llamaPathEl.disabled = locked;
    startEl.disabled = locked;
    // Stop only useful when we own the process (still allow click to refresh messaging).
    stopEl.disabled = locked;
    startEl.title = "Start llama-server for the selected model";
    stopEl.title = "Stop the IDE-managed llama-server (external servers are left alone)";
  }

  async function refreshServerStatus() {
    if (!workspaceRoot) {
      serverStatus = null;
      return;
    }
    try {
      serverStatus = await ipc.llamaServerStatus();
      renderServerHint();
    } catch {
      // ignore — status is best-effort
    }
  }

  async function load() {
    showWorkspaceState();
    if (!workspaceRoot) {
      current = null;
      setStatus("Open a folder to edit workspace settings.");
      return;
    }
    setStatus("Loading…");
    try {
      const [settings, listed] = await Promise.all([
        ipc.autocompleteSettingsGet(),
        ipc.fimModelsList().catch(() => [...FIM_MODEL_CATALOG]),
      ]);
      populateModels(listed);
      applyToForm(settings);
      await refreshServerStatus();
      const msg =
        serverStatus?.lastError ||
        serverStatus?.message ||
        "";
      setStatus(msg, statusKindFromServer());
    } catch (e) {
      setStatus(`Failed to load settings: ${String(e)}`, "error");
    }
  }

  async function persist(opts?: { startIfEnabled?: boolean }) {
    if (!workspaceRoot || saving) return;
    saving = true;
    showWorkspaceState();
    setStatus("Saving…");
    try {
      const updated = await ipc.autocompleteSettingsSet({
        enabled: enabledEl.checked,
        endpoint: endpointEl.value.trim() || "http://127.0.0.1:8081",
        model: modelEl.value || defaultFimModel().id,
        llamaServerPath: llamaPathEl.value.trim(),
      });
      applyToForm(updated);
      setStatus("Saved");
      savedHandler?.(updated);
      if (opts?.startIfEnabled && updated.enabled) {
        setStatus("Starting llama-server…");
        try {
          const status = await ipc.llamaServerStart();
          serverStatus = status;
          renderServerHint();
          setStatus(
            status.lastError || status.message,
            status.lastError || !status.running ? "error" : "info"
          );
        } catch (err) {
          setStatus(`Start failed: ${String(err)}`, "error");
        }
      } else {
        await refreshServerStatus();
        window.setTimeout(() => {
          if (statusEl.textContent === "Saved") setStatus("");
        }, 1200);
      }
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`, "error");
      if (current) applyToForm(current);
    } finally {
      saving = false;
      showWorkspaceState();
    }
  }

  enabledEl.addEventListener("change", () => {
    void persist({ startIfEnabled: enabledEl.checked });
  });

  modelEl.addEventListener("change", () => {
    renderServerHint();
    void persist();
  });

  endpointEl.addEventListener("change", () => {
    renderServerHint();
    void persist();
  });
  endpointEl.addEventListener("input", () => {
    renderServerHint();
  });

  llamaPathEl.addEventListener("change", () => {
    renderServerHint();
    void persist();
  });

  startEl.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!workspaceRoot || busy || saving) return;
    busy = true;
    showWorkspaceState();
    setStatus("Saving…");
    try {
      await ipc.autocompleteSettingsSet({
        enabled: enabledEl.checked,
        endpoint: endpointEl.value.trim() || "http://127.0.0.1:8081",
        model: modelEl.value || defaultFimModel().id,
        llamaServerPath: llamaPathEl.value.trim(),
      });
      setStatus("Starting llama-server…");
      const status = await ipc.llamaServerStart();
      serverStatus = status;
      renderServerHint();
      setStatus(
        status.lastError || status.message,
        status.lastError || !status.running ? "error" : "info"
      );
    } catch (err) {
      setStatus(`Start failed: ${String(err)}`, "error");
      await refreshServerStatus();
      if (serverStatus?.lastError) {
        setStatus(serverStatus.lastError, "error");
      }
    } finally {
      busy = false;
      showWorkspaceState();
    }
  });

  stopEl.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!workspaceRoot || busy) return;
    busy = true;
    showWorkspaceState();
    setStatus("Stopping…");
    try {
      const status = await ipc.llamaServerStop();
      serverStatus = status;
      renderServerHint();
      setStatus(status.message);
    } catch (err) {
      setStatus(`Stop failed: ${String(err)}`, "error");
    } finally {
      busy = false;
      showWorkspaceState();
    }
  });

  populateModels([...FIM_MODEL_CATALOG]);
  showWorkspaceState();
  renderServerHint();

  return {
    open() {
      void load();
    },
    setWorkspaceRoot(root: string | null) {
      workspaceRoot = root;
      showWorkspaceState();
      if (!root) {
        current = null;
        setStatus("Open a folder to edit workspace settings.");
        return;
      }
      // Refresh if the settings tab is currently shown.
      if (!panel.classList.contains("hidden")) {
        void load();
      }
    },
    onSaved(handler) {
      savedHandler = handler;
    },
  };
}
