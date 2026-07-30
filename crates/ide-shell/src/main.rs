//! Tauri shell — wires ide-core into a desktop app.
//! Commands are thin wrappers; events from the EventBus are forwarded to the
//! webview verbatim. No business logic lives in TypeScript.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod preview;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{Emitter, State};
use tracing_subscriber::EnvFilter;

use ide_core::events::{Event as CoreEvent, EventBus, LogLevel};
use ide_core::fs_service::{DirEntry, FileSniff, FileStat, FsService};
use ide_core::path_jail;
use ide_core::preview_settings::PreviewEngine;
use ide_core::process::ProcessRunner;
use ide_core::pty::{PtyManager, PtySpec};
use ide_core::pyright::PyrightManager;
use ide_core::python_env;
use ide_core::ruff;
use ide_core::search::{search_workspace, SearchQuery, SearchResponse};
use ide_core::search_index::{SearchIndexService, SearchIndexStatus};
use ide_core::settings::SettingsStore;
use ide_core::workspace::{Workspace, WorkspaceInfo};

use preview::{PreviewHandle, PreviewOpenResult, PreviewServerInfo, PreviewStateSnapshot};

struct AppState {
    bus: EventBus,
    workspace: Workspace,
    fs: FsService,
    runner: ProcessRunner,
    pty: PtyManager,
    pyright: PyrightManager,
    search_index: SearchIndexService,
    settings: SettingsStore,
    preview: PreviewHandle,
}

fn main() {
    // Prefer the XDG Desktop File Chooser portal (Adwaita/GNOME) over legacy
    // GTK3 file dialogs. Must run before Tauri/GTK dialog backends initialize.
    #[cfg(target_os = "linux")]
    // SAFETY: set at process start before any threads are spawned.
    unsafe {
        std::env::set_var("GTK_USE_PORTAL", "1");
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let bus = EventBus::new();
    let workspace = Workspace::new();
    let fs = FsService::new(bus.clone());
    let runner = ProcessRunner::new(bus.clone());
    let pty = PtyManager::new(bus.clone());
    let pyright = PyrightManager::new(bus.clone());
    let search_index = SearchIndexService::new(bus.clone());
    let settings = SettingsStore::new(SettingsStore::default_user_path())
        .expect("failed to initialize settings store");
    let preview = preview::new_handle();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            bus: bus.clone(),
            workspace,
            fs,
            runner,
            pty,
            pyright,
            search_index,
            settings,
            preview,
        })
        .setup(move |app| {
            // Bridge ide-core events -> webview events.
            let handle = app.handle().clone();
            let rx = bus.subscribe();
            std::thread::spawn(move || {
                while let Ok(evt) = rx.recv() {
                    let _ = handle.emit("core://event", &evt);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_workspace_open,
            cmd_workspace_close,
            cmd_workspace_info,
            cmd_recent_projects_get,
            cmd_recent_projects_set,
            cmd_workspace_last_active_file_get,
            cmd_workspace_last_active_file_set,
            cmd_workspace_open_files_get,
            cmd_workspace_open_files_set,
            cmd_fs_list,
            cmd_fs_read,
            cmd_fs_read_lossy,
            cmd_fs_read_bytes,
            cmd_fs_sniff,
            cmd_fs_write,
            cmd_fs_create_file,
            cmd_fs_create_dir,
            cmd_fs_rename,
            cmd_fs_remove,
            cmd_fs_stat,
            cmd_search,
            cmd_search_status,
            cmd_pty_open,
            cmd_python_run,
            cmd_process_kill,
            cmd_pty_write,
            cmd_pty_resize,
            cmd_pty_close,
            cmd_ruff_check,
            cmd_doc_did_open,
            cmd_doc_did_change,
            cmd_doc_did_save,
            cmd_doc_did_close,
            cmd_preview_ensure_server,
            cmd_preview_open,
            cmd_preview_close,
            cmd_preview_set_engine,
            cmd_preview_set_popped_out,
            cmd_preview_spawn_chrome,
            cmd_preview_kill_chrome,
            cmd_preview_reload_url,
            cmd_preview_get_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- Workspace ----------

#[tauri::command(async)]
fn cmd_workspace_open(state: State<'_, AppState>, path: String) -> Result<WorkspaceInfo, String> {
    // Tear down any prior session before swapping workspaces.
    // Do not publish WorkspaceClosed here — the UI may still be processing the
    // open response, and a late Closed event would wipe the new session.
    state.pyright.stop();
    state.search_index.stop();
    state.fs.stop_watching();
    preview::clear_for_workspace_change(&state.preview);
    let info = state.workspace.open(&path).map_err(to_err)?;
    state.settings.bind_workspace(&info.root).ok();
    state.bus.publish(CoreEvent::WorkspaceOpened {
        root: info.root.clone(),
    });

    // Recursive notify watches walk the whole tree up front (node_modules,
    // .git, …). Do that off the command path so "Open Folder" returns as soon
    // as the workspace root is known and the explorer can paint.
    {
        let fs = state.fs.clone();
        let root = info.root.clone();
        std::thread::spawn(move || {
            let _ = fs.watch(&root);
        });
    }

    // Background search indexer (paths + content, size-capped).
    state.search_index.start(&info.root);

    // Start Pyright off the command path. `initialize` is a blocking LSP
    // round-trip; keeping it here made opens feel laggy even after async IPC.
    if let Some(env) = info.python.clone() {
        let pyright = state.pyright.clone();
        let bus = state.bus.clone();
        let root = info.root.clone();
        std::thread::spawn(move || match pyright.start(&root, &env) {
            Ok(()) => bus.publish(CoreEvent::Log {
                level: LogLevel::Info,
                message: "pyright started".into(),
            }),
            Err(e) => bus.publish(CoreEvent::Log {
                level: LogLevel::Warn,
                message: format!(
                    "pyright not started ({}). Install with `npm i -g pyright` or `pip install pyright` to enable live diagnostics.",
                    e
                ),
            }),
        });
    } else {
        state.bus.publish(CoreEvent::Log {
            level: LogLevel::Warn,
            message: "no Python interpreter detected; live diagnostics disabled".into(),
        });
    }

    Ok(info)
}

#[tauri::command]
fn cmd_workspace_close(state: State<'_, AppState>) -> Result<(), String> {
    if state.workspace.current().is_none() {
        state.fs.stop_watching();
        preview::clear_for_workspace_change(&state.preview);
        return Ok(());
    }
    state.pyright.stop();
    state.search_index.stop();
    state.fs.stop_watching();
    preview::clear_for_workspace_change(&state.preview);
    state.workspace.close();
    state.bus.publish(CoreEvent::WorkspaceClosed);
    Ok(())
}

#[tauri::command]
fn cmd_workspace_info(state: State<'_, AppState>) -> Result<Option<WorkspaceInfo>, String> {
    Ok(state.workspace.current())
}

// ---------- Recent projects ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentProject {
    name: String,
    path: String,
    last_opened: u64,
}

const MAX_RECENT_PROJECTS: usize = 4;

#[tauri::command]
fn cmd_recent_projects_get(state: State<'_, AppState>) -> Result<Vec<RecentProject>, String> {
    let Some(value) = state.settings.get_user("recentProjects") else {
        tracing::debug!(
            target: "h1code::recent_projects",
            settings_path = %state.settings.user_path().display(),
            raw_count = 0,
            returned_count = 0,
            "recent projects loaded"
        );
        return Ok(vec![]);
    };
    let mut projects: Vec<RecentProject> = serde_json::from_value(value).map_err(to_err)?;
    let raw_count = projects.len();
    projects.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
    projects.truncate(MAX_RECENT_PROJECTS);
    tracing::debug!(
        target: "h1code::recent_projects",
        settings_path = %state.settings.user_path().display(),
        raw_count,
        returned_count = projects.len(),
        "recent projects loaded"
    );
    Ok(projects)
}

#[tauri::command]
fn cmd_recent_projects_set(
    state: State<'_, AppState>,
    projects: Vec<RecentProject>,
) -> Result<(), String> {
    let mut clean: Vec<RecentProject> = vec![];
    let incoming_count = projects.len();
    for project in projects {
        if project.name.trim().is_empty() || project.path.trim().is_empty() {
            continue;
        }
        if clean
            .iter()
            .any(|existing| same_path(&existing.path, &project.path))
        {
            continue;
        }
        clean.push(project);
        if clean.len() >= MAX_RECENT_PROJECTS {
            break;
        }
    }
    let value = serde_json::to_value(&clean).map_err(to_err)?;
    tracing::debug!(
        target: "h1code::recent_projects",
        settings_path = %state.settings.user_path().display(),
        incoming_count,
        saved_count = clean.len(),
        "recent projects saved"
    );
    state
        .settings
        .set_user("recentProjects", value)
        .map_err(to_err)
}

#[derive(Debug, Deserialize)]
struct LastActiveFileGetArgs {
    workspace: String,
}

#[derive(Debug, Deserialize)]
struct LastActiveFileSetArgs {
    workspace: String,
    file: String,
}

#[derive(Debug, Deserialize)]
struct OpenFilesGetArgs {
    workspace: String,
}

#[derive(Debug, Deserialize)]
struct OpenFilesSetArgs {
    workspace: String,
    files: Vec<String>,
}

#[tauri::command]
fn cmd_workspace_last_active_file_get(
    state: State<'_, AppState>,
    payload: LastActiveFileGetArgs,
) -> Result<Option<String>, String> {
    let Some(Value::Object(map)) = state.settings.get_user("workspaceLastActiveFiles") else {
        return Ok(None);
    };
    Ok(map
        .get(&settings_path_key(&payload.workspace))
        .and_then(Value::as_str)
        .map(str::to_string))
}

#[tauri::command]
fn cmd_workspace_last_active_file_set(
    state: State<'_, AppState>,
    payload: LastActiveFileSetArgs,
) -> Result<(), String> {
    if payload.workspace.trim().is_empty() || payload.file.trim().is_empty() {
        return Ok(());
    }

    let mut map = match state.settings.get_user("workspaceLastActiveFiles") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    map.insert(
        settings_path_key(&payload.workspace),
        Value::String(payload.file),
    );
    state
        .settings
        .set_user("workspaceLastActiveFiles", Value::Object(map))
        .map_err(to_err)
}

#[tauri::command]
fn cmd_workspace_open_files_get(
    state: State<'_, AppState>,
    payload: OpenFilesGetArgs,
) -> Result<Vec<String>, String> {
    let Some(Value::Object(map)) = state.settings.get_user("workspaceOpenFiles") else {
        return Ok(vec![]);
    };
    let Some(Value::Array(files)) = map.get(&settings_path_key(&payload.workspace)) else {
        return Ok(vec![]);
    };
    Ok(files
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect())
}

#[tauri::command]
fn cmd_workspace_open_files_set(
    state: State<'_, AppState>,
    payload: OpenFilesSetArgs,
) -> Result<(), String> {
    if payload.workspace.trim().is_empty() {
        return Ok(());
    }

    let mut files: Vec<Value> = vec![];
    for file in payload.files {
        if file.trim().is_empty() {
            continue;
        }
        if files.iter().any(|existing| {
            existing
                .as_str()
                .map(|path| same_path(path, &file))
                .unwrap_or(false)
        }) {
            continue;
        }
        files.push(Value::String(file));
    }

    let mut map = match state.settings.get_user("workspaceOpenFiles") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    map.insert(settings_path_key(&payload.workspace), Value::Array(files));
    state
        .settings
        .set_user("workspaceOpenFiles", Value::Object(map))
        .map_err(to_err)
}

fn settings_path_key(path: &str) -> String {
    if cfg!(windows) {
        path.replace('\\', "/").to_lowercase()
    } else {
        path.to_string()
    }
}

fn same_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

// ---------- FS ----------

/// Jail an FS IPC path under the open workspace root before any disk op.
fn jail_fs_path(state: &State<'_, AppState>, path: &str) -> Result<PathBuf, String> {
    let root = state.workspace.root().map_err(to_err)?;
    path_jail::ensure_within_root(&root, Path::new(path)).map_err(to_err)
}

#[tauri::command(async)]
fn cmd_fs_list(state: State<'_, AppState>, path: String) -> Result<Vec<DirEntry>, String> {
    let start = std::time::Instant::now();
    let path = jail_fs_path(&state, &path)?;
    let res = state.fs.list_dir(&path).map_err(to_err);
    tracing::info!(
        target: "h1code::fs",
        path = %path.display(),
        ok = res.is_ok(),
        elapsed_ms = start.elapsed().as_millis() as u64,
        "cmd_fs_list"
    );
    res
}

#[tauri::command(async)]
fn cmd_fs_read(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let start = std::time::Instant::now();
    let path = jail_fs_path(&state, &path)?;
    let res = state.fs.read(&path).map_err(to_err);
    tracing::info!(
        target: "h1code::fs",
        path = %path.display(),
        ok = res.is_ok(),
        bytes = res.as_ref().map(|s| s.len()).unwrap_or(0),
        elapsed_ms = start.elapsed().as_millis() as u64,
        "cmd_fs_read"
    );
    res
}

#[tauri::command(async)]
fn cmd_fs_read_lossy(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let start = std::time::Instant::now();
    let path = jail_fs_path(&state, &path)?;
    let res = state.fs.read_lossy(&path).map_err(to_err);
    tracing::info!(
        target: "h1code::fs",
        path = %path.display(),
        ok = res.is_ok(),
        bytes = res.as_ref().map(|s| s.len()).unwrap_or(0),
        elapsed_ms = start.elapsed().as_millis() as u64,
        "cmd_fs_read_lossy"
    );
    res
}

#[tauri::command(async)]
fn cmd_fs_sniff(state: State<'_, AppState>, path: String) -> Result<FileSniff, String> {
    let path = jail_fs_path(&state, &path)?;
    state.fs.sniff(&path).map_err(to_err)
}

/// Raw bytes for media preview (audio/image blob URLs). Goes through the
/// workspace jail — do not replace with convertFileSrc-only loading on Linux:
/// WebKitGTK/GStreamer cannot play `<audio>`/`<video>` from the `asset://` protocol.
#[tauri::command(async)]
fn cmd_fs_read_bytes(
    state: State<'_, AppState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let path = jail_fs_path(&state, &path)?;
    let bytes = state
        .fs
        .read_bytes(&path, ide_core::fs_service::FsService::MEDIA_BYTES_MAX)
        .map_err(to_err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
fn cmd_fs_write(state: State<'_, AppState>, path: String, contents: String) -> Result<(), String> {
    let path = jail_fs_path(&state, &path)?;
    state.fs.write(&path, &contents).map_err(to_err)
}

#[tauri::command(async)]
fn cmd_fs_create_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = jail_fs_path(&state, &path)?;
    state.fs.create_file(&path).map_err(to_err)
}

#[tauri::command(async)]
fn cmd_fs_create_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = jail_fs_path(&state, &path)?;
    state.fs.create_dir(&path).map_err(to_err)
}

#[tauri::command(async)]
fn cmd_fs_rename(state: State<'_, AppState>, from: String, to: String) -> Result<(), String> {
    let from = jail_fs_path(&state, &from)?;
    let to = jail_fs_path(&state, &to)?;
    state.fs.rename(&from, &to).map_err(to_err)
}

#[tauri::command(async)]
fn cmd_fs_remove(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = jail_fs_path(&state, &path)?;
    state.fs.remove(&path).map_err(to_err)
}

#[tauri::command(async)]
fn cmd_fs_stat(state: State<'_, AppState>, path: String) -> Result<FileStat, String> {
    let path = jail_fs_path(&state, &path)?;
    Ok(state.fs.stat(&path))
}

// ---------- Search ----------

#[tauri::command(async)]
fn cmd_search(state: State<'_, AppState>, query: SearchQuery) -> Result<SearchResponse, String> {
    let root = state
        .workspace
        .current()
        .ok_or_else(|| "workspace not open".to_string())?
        .root;
    let index = state.search_index.index();
    search_workspace(&root, index, &query).map_err(to_err)
}

#[tauri::command]
fn cmd_search_status(state: State<'_, AppState>) -> Result<SearchIndexStatus, String> {
    Ok(state.search_index.status())
}

// ---------- Python run ----------

#[derive(Debug, Serialize)]
struct PythonRunResult {
    id: String,
    interpreter: PathBuf,
}

#[derive(Debug, Deserialize)]
struct PtyRunArgs {
    file: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
    /// When set, the PTY cwd for the run. Defaults to the workspace root.
    #[serde(default)]
    cwd: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Default)]
struct PtyOpenArgs {
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
}

#[derive(Debug, Serialize)]
struct PtyOpenResult {
    id: String,
}

// Run File goes through the PTY so input() / interactive REPLs work.
// Returns the PTY session id as `id` (same shape as before) — the frontend
// reuses this id for cmd_pty_write / cmd_pty_resize / cmd_pty_close.
#[tauri::command(async)]
fn cmd_python_run(
    state: State<'_, AppState>,
    payload: PtyRunArgs,
) -> Result<PythonRunResult, String> {
    let workspace_root = state.workspace.root().map_err(to_err)?;
    // Same containment as FS IPC — reject scripts outside the open workspace
    // (XSS + fs_write would otherwise be an easy RCE path).
    let file = path_jail::ensure_within_root(&workspace_root, Path::new(&payload.file))
        .map_err(to_err)?;
    let cwd = match &payload.cwd {
        Some(c) => path_jail::ensure_within_root(&workspace_root, c).map_err(to_err)?,
        None => workspace_root.clone(),
    };
    let env = python_env::detect(&workspace_root).map_err(to_err)?;
    // `-u` keeps stdout/stderr unbuffered so prompts appear immediately even
    // inside ConPTY's chunking. Python still sees a real TTY (isatty=true).
    let mut args = vec!["-u".to_string(), file.to_string_lossy().into_owned()];
    args.extend(payload.args);
    let id = state
        .pty
        .open(PtySpec {
            program: Some(env.interpreter.to_string_lossy().into_owned()),
            args,
            cwd: Some(cwd),
            cols: payload.cols.unwrap_or(120),
            rows: payload.rows.unwrap_or(30),
            env: vec![],
        })
        .map_err(to_err)?;
    Ok(PythonRunResult {
        id,
        interpreter: env.interpreter,
    })
}

#[tauri::command(async)]
fn cmd_pty_open(
    state: State<'_, AppState>,
    payload: Option<PtyOpenArgs>,
) -> Result<PtyOpenResult, String> {
    let payload = payload.unwrap_or_default();
    let cwd = state
        .workspace
        .current()
        .map(|info| info.root)
        .or_else(|| std::env::current_dir().ok());
    let id = state
        .pty
        .open(PtySpec {
            program: None,
            args: vec![],
            cwd,
            cols: payload.cols.unwrap_or(120),
            rows: payload.rows.unwrap_or(30),
            env: vec![],
        })
        .map_err(to_err)?;
    Ok(PtyOpenResult { id })
}

// Non-interactive process kill (kept for ProcessRunner-spawned jobs). For PTY
// sessions call cmd_pty_close, which terminates the child via Drop.
#[tauri::command(async)]
fn cmd_process_kill(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    if state.runner.kill(&id).unwrap_or(false) {
        return Ok(true);
    }
    Ok(state.pty.close(&id))
}

// ---------- PTY input / sizing ----------

#[tauri::command(async)]
fn cmd_pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    tracing::debug!(
        target: "h1code::pty",
        id = %id,
        bytes = data.len(),
        "cmd_pty_write received"
    );
    state.pty.write(&id, data.as_bytes()).map_err(to_err)
}

#[tauri::command(async)]
fn cmd_pty_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty.resize(&id, cols, rows).map_err(to_err)
}

#[tauri::command(async)]
fn cmd_pty_close(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    Ok(state.pty.close(&id))
}

// ---------- Ruff ----------

#[derive(Debug, Deserialize, Default)]
struct RuffArgs {
    #[serde(default)]
    files: Vec<String>,
}

#[tauri::command(async)]
fn cmd_ruff_check(
    state: State<'_, AppState>,
    payload: Option<RuffArgs>,
) -> Result<Vec<ide_core::ruff::RuffDiagnostic>, String> {
    let root = state.workspace.root().map_err(to_err)?;
    let payload = payload.unwrap_or_default();
    let file_bufs: Vec<PathBuf> = payload.files.iter().map(PathBuf::from).collect();
    let file_refs: Vec<&Path> = file_bufs.iter().map(|p| p.as_path()).collect();
    let diags = ruff::check(&root, &file_refs).map_err(to_err)?;
    // The bus event is a signal that ruff ran; the response body carries the
    // actual diagnostics for the Problems panel. Live editor squiggles only
    // come from Pyright for now.
    state.bus.publish(CoreEvent::Diagnostics {
        path: root.clone(),
        source: "ruff".to_string(),
        items: vec![],
    });
    Ok(diags)
}

// ---------- Document lifecycle (forwarded to Pyright) ----------

#[tauri::command(async)]
fn cmd_doc_did_open(state: State<'_, AppState>, path: String, text: String) -> Result<(), String> {
    // Best-effort: never error the UI just because pyright isn't running.
    let _ = state.pyright.did_open(Path::new(&path), &text);
    Ok(())
}

#[tauri::command(async)]
fn cmd_doc_did_change(
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> Result<(), String> {
    let _ = state.pyright.did_change(Path::new(&path), &text);
    Ok(())
}

#[tauri::command(async)]
fn cmd_doc_did_save(
    state: State<'_, AppState>,
    path: String,
    text: Option<String>,
) -> Result<(), String> {
    let _ = state.pyright.did_save(Path::new(&path), text.as_deref());
    Ok(())
}

#[tauri::command(async)]
fn cmd_doc_did_close(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let _ = state.pyright.did_close(Path::new(&path));
    Ok(())
}

// ---------- Live preview ----------

fn require_workspace_root(state: &AppState) -> Result<PathBuf, String> {
    state.workspace.root().map_err(to_err)
}

#[tauri::command(async)]
fn cmd_preview_ensure_server(state: State<'_, AppState>) -> Result<PreviewServerInfo, String> {
    let root = require_workspace_root(&state)?;
    preview::ensure_server(&state.preview, &root)
}

#[tauri::command(async)]
fn cmd_preview_open(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<PreviewOpenResult, String> {
    let root = require_workspace_root(&state)?;
    preview::open_file(&state.preview, &root, &file_path)
}

#[tauri::command(async)]
fn cmd_preview_close(state: State<'_, AppState>) -> Result<(), String> {
    preview::close(&state.preview, true)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewEnginePayload {
    engine: PreviewEngine,
}

#[tauri::command(async)]
fn cmd_preview_set_engine(
    state: State<'_, AppState>,
    payload: PreviewEnginePayload,
) -> Result<PreviewEngine, String> {
    let root = require_workspace_root(&state)?;
    preview::set_engine(&state.preview, &root, payload.engine)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewPoppedOutPayload {
    is_popped_out: bool,
}

#[tauri::command(async)]
fn cmd_preview_set_popped_out(
    state: State<'_, AppState>,
    payload: PreviewPoppedOutPayload,
) -> Result<bool, String> {
    let root = require_workspace_root(&state)?;
    preview::set_is_popped_out(&state.preview, &root, payload.is_popped_out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewUrlPayload {
    url: String,
}

#[tauri::command(async)]
fn cmd_preview_spawn_chrome(
    state: State<'_, AppState>,
    payload: PreviewUrlPayload,
) -> Result<(), String> {
    preview::spawn_chrome(&state.preview, &payload.url)
}

#[tauri::command(async)]
fn cmd_preview_kill_chrome(state: State<'_, AppState>) -> Result<(), String> {
    preview::kill_chrome(&state.preview)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewFilePayload {
    file_path: String,
}

#[tauri::command(async)]
fn cmd_preview_reload_url(
    state: State<'_, AppState>,
    payload: PreviewFilePayload,
) -> Result<String, String> {
    let root = require_workspace_root(&state)?;
    preview::reload_url(&state.preview, &root, &payload.file_path)
}

#[tauri::command(async)]
fn cmd_preview_get_state(state: State<'_, AppState>) -> Result<PreviewStateSnapshot, String> {
    Ok(preview::get_state(&state.preview))
}

#[allow(dead_code)]
type _A = Arc<()>;
