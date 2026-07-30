//! Lifecycle for the FIM `llama-server` process.
//!
//! The IDE may spawn `llama-server` when autocomplete is enabled for a local
//! endpoint. Only an **owned** [`Child`] is terminated on Stop / IDE exit —
//! never a blind port-scan of foreign processes.

use std::collections::HashSet;
use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use url::Url;

use ide_core::autocomplete_settings::{self, AutocompleteSettings};
use ide_core::fim_models;

/// Default autocomplete endpoint port (see `autocomplete_settings` / README).
pub const FIM_DEFAULT_PORT: u16 = 8081;

const NGL: &str = "99";
const CTX_SIZE: &str = "0";
const CACHE_REUSE: &str = "256";
const HEALTH_WAIT: Duration = Duration::from_secs(45);
const HEALTH_POLL: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct LlamaServerState {
    /// Process we spawned (if any). Only this is killed on stop/exit.
    child: Option<Child>,
    port: Option<u16>,
    last_error: Option<String>,
    /// Tail of owned-child stderr (best-effort), for spawn/health failures.
    stderr_tail: Option<String>,
}

pub type LlamaHandle = Arc<Mutex<LlamaServerState>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlamaServerStatus {
    pub running: bool,
    /// True when the IDE spawned (and still owns) the process.
    pub owned: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
    pub message: String,
}

pub fn new_handle() -> LlamaHandle {
    Arc::new(Mutex::new(LlamaServerState::default()))
}

/// Called on IDE process exit — kill **only** the Child we own.
pub fn on_ide_exit(handle: &LlamaHandle) {
    let mut state = handle.lock();
    stop_owned_locked(&mut state, "IDE exit");
}

/// Snapshot status (reaps exited owned children).
pub fn status(handle: &LlamaHandle) -> LlamaServerStatus {
    let mut state = handle.lock();
    reap_locked(&mut state);
    status_locked(&state)
}

/// Start (or reuse) llama-server for the open workspace using current settings.
pub fn ensure_for_workspace(handle: &LlamaHandle, workspace_root: &Path) -> Result<LlamaServerStatus, String> {
    let settings = autocomplete_settings::load_autocomplete_settings(workspace_root);
    if !settings.enabled {
        return Ok(LlamaServerStatus {
            running: port_is_healthy(FIM_DEFAULT_PORT),
            owned: has_owned(handle),
            port: None,
            pid: owned_pid(handle),
            last_error: None,
            message: "Autocomplete disabled — llama-server not started".into(),
        });
    }
    let port = local_port_from_endpoint(&settings.endpoint)?;
    start_with_settings(handle, workspace_root, &settings, port)
}

/// Explicit Start from Settings (same path as auto-start).
pub fn start(handle: &LlamaHandle, workspace_root: &Path) -> Result<LlamaServerStatus, String> {
    let settings = autocomplete_settings::load_autocomplete_settings(workspace_root);
    let port = local_port_from_endpoint(&settings.endpoint)?;
    start_with_settings(handle, workspace_root, &settings, port)
}

/// Stop the IDE-owned Child only. External servers are left alone.
pub fn stop(handle: &LlamaHandle) -> Result<LlamaServerStatus, String> {
    let mut state = handle.lock();
    reap_locked(&mut state);
    if state.child.is_none() {
        let port = state.port.unwrap_or(FIM_DEFAULT_PORT);
        let msg = if port_is_healthy(port) {
            format!(
                "No IDE-managed llama-server to stop (port {port} has an external server)"
            )
        } else {
            "No IDE-managed llama-server is running".into()
        };
        state.last_error = None;
        return Ok(LlamaServerStatus {
            running: port_is_healthy(port),
            owned: false,
            port: Some(port),
            pid: None,
            last_error: None,
            message: msg,
        });
    }
    stop_owned_locked(&mut state, "Stop");
    Ok(status_locked(&state))
}

fn start_with_settings(
    handle: &LlamaHandle,
    workspace_root: &Path,
    settings: &AutocompleteSettings,
    port: u16,
) -> Result<LlamaServerStatus, String> {
    let model = fim_models::find_model(&settings.model)
        .ok_or_else(|| format!("Unknown FIM model id `{}`", settings.model))?;
    let model_path = resolve_model_file(workspace_root, &model).map_err(|e| {
        handle.lock().last_error = Some(e.clone());
        e
    })?;

    let binary = resolve_llama_binary(&settings.llama_server_path).map_err(|e| {
        handle.lock().last_error = Some(e.clone());
        e
    })?;

    let pid = {
        let mut state = handle.lock();
        reap_locked(&mut state);

        // Already own a live process on this port.
        if let Some(child) = state.child.as_ref() {
            if state.port == Some(port) && path_alive(child.id()) {
                let pid = child.id();
                return Ok(LlamaServerStatus {
                    running: true,
                    owned: true,
                    port: Some(port),
                    pid: Some(pid),
                    last_error: None,
                    message: format!(
                        "llama-server already running (owned, pid {pid}, port {port})"
                    ),
                });
            }
            stop_owned_locked(&mut state, "respawn");
        }

        // Healthy external (or leftover) server: reuse, do not claim ownership.
        if port_is_healthy(port) {
            state.port = Some(port);
            state.last_error = None;
            return Ok(LlamaServerStatus {
                running: true,
                owned: false,
                port: Some(port),
                pid: None,
                last_error: None,
                message: format!(
                    "Using existing healthy llama-server on port {port} (not owned by IDE)"
                ),
            });
        }

        if port_has_listener(port) {
            let msg = format!(
                "Port {port} is in use but llama-server is not healthy — free the port or change the endpoint"
            );
            state.last_error = Some(msg.clone());
            return Err(msg);
        }

        tracing::info!(
            binary = %binary.display(),
            model = %model_path.display(),
            port,
            "spawning llama-server"
        );

        let stderr_log = home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".cache")
            .join(format!(
                "h1code-llama-{}-{}.log",
                std::process::id(),
                port
            ));
        if let Some(parent) = stderr_log.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let stderr_stdio = fs::File::create(&stderr_log)
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());

        let mut cmd = Command::new(&binary);
        cmd.arg("-m")
            .arg(&model_path)
            .arg("--port")
            .arg(port.to_string())
            .arg("-ngl")
            .arg(NGL)
            .arg("--ctx-size")
            .arg(CTX_SIZE)
            .arg("-ub")
            .arg(model.ub.to_string())
            .arg("-b")
            .arg(model.b.to_string())
            .arg("--cache-reuse")
            .arg(CACHE_REUSE)
            // Keep cwd as the binary's directory so $ORIGIN RUNPATH resolves
            // bundled `.so`s (llama.cpp release layouts). Model path is absolute.
            .current_dir(binary.parent().unwrap_or(workspace_root))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr_stdio);

        let child = cmd.spawn().map_err(|e| {
            let msg = format!(
                "Failed to spawn llama-server (`{}`): {e}. Set `llama_server_path` in Settings / `.h1code/settings.toml` if discovery cannot find the binary.",
                binary.display()
            );
            state.last_error = Some(msg.clone());
            msg
        })?;

        let pid = child.id();
        state.child = Some(child);
        state.port = Some(port);
        state.last_error = None;
        state.stderr_tail = None;
        pid
    };

    let stderr_log = home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cache")
        .join(format!(
            "h1code-llama-{}-{}.log",
            std::process::id(),
            port
        ));

    // Wait for health outside the lock (model load can take a while).
    let deadline = Instant::now() + HEALTH_WAIT;
    while Instant::now() < deadline {
        {
            let mut state = handle.lock();
            reap_locked(&mut state);
            if state.child.is_none() {
                let detail = read_stderr_tail(&stderr_log);
                let msg = format!(
                    "llama-server exited before becoming healthy (pid {pid}, port {port}). Check the binary, GPU flags, and model path.{}",
                    detail
                );
                state.last_error = Some(msg.clone());
                state.stderr_tail = Some(detail);
                return Err(msg);
            }
        }
        if port_is_healthy(port) {
            let _ = fs::remove_file(&stderr_log);
            return Ok(LlamaServerStatus {
                running: true,
                owned: true,
                port: Some(port),
                pid: Some(pid),
                last_error: None,
                message: format!("llama-server started (pid {pid}, port {port})"),
            });
        }
        std::thread::sleep(HEALTH_POLL);
    }

    let detail = read_stderr_tail(&stderr_log);
    let msg = format!(
        "llama-server spawned (pid {pid}) but did not become healthy on port {port} within {}s{}",
        HEALTH_WAIT.as_secs(),
        detail
    );
    {
        let mut state = handle.lock();
        state.last_error = Some(msg.clone());
        state.stderr_tail = Some(detail);
    }
    Err(msg)
}

fn read_stderr_tail(path: &Path) -> String {
    let Ok(text) = fs::read_to_string(path) else {
        return String::new();
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(800)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!(" stderr: {tail}")
}

fn stop_owned_locked(state: &mut LlamaServerState, reason: &str) {
    if let Some(mut child) = state.child.take() {
        let pid = child.id();
        tracing::info!(pid, reason, "stopping owned llama-server");
        let _ = child.kill();
        let _ = child.wait();
    }
    state.last_error = None;
    state.stderr_tail = None;
}

fn reap_locked(state: &mut LlamaServerState) {
    let exited = state
        .child
        .as_mut()
        .and_then(|c| c.try_wait().ok().flatten())
        .is_some();
    if exited {
        state.child = None;
    }
}

fn status_locked(state: &LlamaServerState) -> LlamaServerStatus {
    let owned = state.child.is_some();
    let pid = state.child.as_ref().map(|c| c.id());
    let port = state.port.or(Some(FIM_DEFAULT_PORT));
    let healthy = port.map(port_is_healthy).unwrap_or(false);
    let message = if owned {
        format!(
            "IDE-managed llama-server running (pid {}, port {})",
            pid.unwrap_or(0),
            port.unwrap_or(FIM_DEFAULT_PORT)
        )
    } else if healthy {
        format!(
            "External llama-server healthy on port {}",
            port.unwrap_or(FIM_DEFAULT_PORT)
        )
    } else if let Some(err) = &state.last_error {
        err.clone()
    } else {
        "llama-server not running".into()
    };
    LlamaServerStatus {
        running: owned || healthy,
        owned,
        port,
        pid,
        last_error: state.last_error.clone(),
        message,
    }
}

fn has_owned(handle: &LlamaHandle) -> bool {
    let mut state = handle.lock();
    reap_locked(&mut state);
    state.child.is_some()
}

fn owned_pid(handle: &LlamaHandle) -> Option<u32> {
    let mut state = handle.lock();
    reap_locked(&mut state);
    state.child.as_ref().map(|c| c.id())
}

/// Resolve `llama-server` from settings path, PATH, or common install locations.
pub fn resolve_llama_binary(configured: &str) -> Result<PathBuf, String> {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        let p = PathBuf::from(trimmed);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!(
            "llama_server_path is set but not a file: `{trimmed}`"
        ));
    }
    if let Some(found) = find_on_path("llama-server") {
        return Ok(found);
    }
    if let Some(found) = discover_llama_binary() {
        tracing::info!(
            binary = %found.display(),
            "discovered llama-server outside PATH"
        );
        return Ok(found);
    }
    Err(
        "llama-server not found on PATH or common locations (`~/llama-cuda/llama-b*/`, `~/llama-b*/`, …). Set `llama_server_path` in Settings to the absolute path of your binary (e.g. `/home/you/llama-cuda/llama-b10189/llama-server`)."
            .into(),
    )
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_os = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_os) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Prefer newer `llama-b*` version folders; also check a few fixed layouts.
fn discover_llama_binary() -> Option<PathBuf> {
    let home = home_dir()?;
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Direct well-known paths (highest priority after PATH).
    for rel in [
        "llama-cuda/llama-b10189/llama-server",
        "llama-b10189/llama-server",
        "llama.cpp/build/bin/llama-server",
        ".local/bin/llama-server",
    ] {
        candidates.push(home.join(rel));
    }

    // Scan versioned release dirs: ~/llama-cuda/llama-b*, ~/llama-b*, ~/llama*/llama-b*
    for parent in [
        home.join("llama-cuda"),
        home.clone(),
        home.join("Downloads"),
    ] {
        push_llama_b_candidates(&parent, &mut candidates);
    }

    // Prefer lexically greatest llama-b* path (newer build numbers sort later).
    candidates.sort_by(|a, b| b.cmp(a));
    candidates.into_iter().find(|p| p.is_file())
}

fn push_llama_b_candidates(parent: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("llama-b") {
            continue;
        }
        let candidate = entry.path().join("llama-server");
        out.push(candidate);
    }
}

/// Resolve the GGUF for a catalog model: workspace-relative first, then a few
/// common sibling checkouts (so a project workspace can reuse models from an
/// h1code checkout without copying multi-GB files).
fn resolve_model_file(
    workspace_root: &Path,
    model: &fim_models::FimModelOption,
) -> Result<PathBuf, String> {
    let relative = model.relative_model_path();
    let in_workspace = workspace_root.join(&relative);
    if in_workspace.is_file() {
        return Ok(in_workspace);
    }

    if let Some(found) = discover_model_file(&relative) {
        tracing::info!(
            model = %found.display(),
            "using FIM model outside workspace root"
        );
        return Ok(found);
    }

    Err(format!(
        "Model file not found: {} (place `{}` under the workspace root, or keep a copy under ~/Documents/github/h1code/ — see README)",
        in_workspace.display(),
        relative
    ))
}

fn discover_model_file(relative: &str) -> Option<PathBuf> {
    let home = home_dir()?;
    let bases = [
        home.join("Documents/github/h1code"),
        home.join("Documents/h1code"),
        home.join("src/h1code"),
        home.join("code/h1code"),
        home.join("h1code"),
        home.join("Projects/h1code"),
    ];
    for base in bases {
        let candidate = base.join(relative);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Endpoint must be loopback HTTP(S); returns the port to bind/reuse.
pub fn local_port_from_endpoint(endpoint: &str) -> Result<u16, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(FIM_DEFAULT_PORT);
    }
    let url = Url::parse(trimmed).map_err(|e| format!("invalid endpoint URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("autocomplete endpoint must be http(s)".into());
    }
    let host = url.host_str().unwrap_or("");
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return Err(format!(
            "llama-server auto-start only supports loopback endpoints (got host `{host}`)"
        ));
    }
    if let Some(port) = url.port() {
        return Ok(port);
    }
    Ok(match url.scheme() {
        "https" => 443,
        _ => 80,
    })
}

fn port_is_healthy(port: u16) -> bool {
    // Prefer /health; fall back to TCP accept as a weak signal.
    let health = format!("http://127.0.0.1:{port}/health");
    match ureq::get(&health)
        .timeout(Duration::from_millis(800))
        .call()
    {
        Ok(resp) => (200..500).contains(&resp.status()),
        Err(_) => {
            // Some builds omit /health — try root.
            let root = format!("http://127.0.0.1:{port}/");
            match ureq::get(&root)
                .timeout(Duration::from_millis(800))
                .call()
            {
                Ok(resp) => (200..500).contains(&resp.status()),
                Err(_) => false,
            }
        }
    }
}

fn port_has_listener(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
        || !pids_listening_on_port(port).is_empty()
}

fn path_alive(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}

/// Best-effort: terminate `llama-server` processes listening on `port`.
///
/// **Not used for IDE exit** — only kept for diagnostics / future tooling.
#[allow(dead_code)]
pub fn stop_llama_server_on_port(port: u16) {
    let pids = pids_listening_on_port(port);
    if pids.is_empty() {
        for pid in llama_server_pids_advertising_port(port) {
            terminate_pid(pid);
        }
        return;
    }
    for pid in pids {
        if process_looks_like_llama_server(pid) {
            terminate_pid(pid);
        }
    }
}

fn terminate_pid(pid: u32) {
    tracing::info!(pid, "terminating llama-server pid");
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    std::thread::sleep(Duration::from_millis(400));
    if path_alive(pid) {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }
}

fn process_looks_like_llama_server(pid: u32) -> bool {
    let Ok(raw) = fs::read(format!("/proc/{pid}/cmdline")) else {
        return false;
    };
    let cmd = String::from_utf8_lossy(&raw);
    cmd.split('\0').any(|part| {
        let base = part.rsplit('/').next().unwrap_or(part);
        base == "llama-server" || base.starts_with("llama-server")
    })
}

fn llama_server_pids_advertising_port(port: u16) -> Vec<u32> {
    let Ok(proc) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in proc.flatten() {
        let name = ent.file_name();
        let Some(pid_str) = name.to_str() else {
            continue;
        };
        if !pid_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if !process_looks_like_llama_server(pid) {
            continue;
        }
        let Ok(raw) = fs::read(ent.path().join("cmdline")) else {
            continue;
        };
        let owned = String::from_utf8_lossy(&raw);
        let parts: Vec<&str> = owned.split('\0').filter(|s| !s.is_empty()).collect();
        let mut advertised: Option<u16> = None;
        for i in 0..parts.len() {
            if parts[i] == "--port" || parts[i] == "-p" {
                if let Some(v) = parts.get(i + 1).and_then(|s| s.parse().ok()) {
                    advertised = Some(v);
                }
            } else if let Some(rest) = parts[i].strip_prefix("--port=") {
                advertised = rest.parse().ok();
            }
        }
        if advertised == Some(port) {
            out.push(pid);
        }
    }
    out
}

fn pids_listening_on_port(port: u16) -> Vec<u32> {
    let mut inodes = HashSet::new();
    collect_listening_inodes("/proc/net/tcp", port, &mut inodes);
    collect_listening_inodes("/proc/net/tcp6", port, &mut inodes);
    if inodes.is_empty() {
        return Vec::new();
    }
    let mut pids = HashSet::new();
    let Ok(proc) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    for ent in proc.flatten() {
        let name = ent.file_name();
        let Some(pid_str) = name.to_str() else {
            continue;
        };
        if !pid_str.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        let fd_dir = ent.path().join("fd");
        let Ok(fds) = fs::read_dir(fd_dir) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(link) = fs::read_link(fd.path()) else {
                continue;
            };
            let s = link.to_string_lossy();
            if let Some(rest) = s.strip_prefix("socket:[") {
                if let Some(num) = rest.strip_suffix(']') {
                    if let Ok(inode) = num.parse::<u64>() {
                        if inodes.contains(&inode) {
                            pids.insert(pid);
                        }
                    }
                }
            }
        }
    }
    pids.into_iter().collect()
}

fn collect_listening_inodes(path: &str, port: u16, out: &mut HashSet<u64>) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    for (i, line) in text.lines().enumerate() {
        if i == 0 {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 10 {
            continue;
        }
        let local = cols[1];
        let Some((_addr, port_hex)) = local.rsplit_once(':') else {
            continue;
        };
        let Ok(p) = u16::from_str_radix(port_hex, 16) else {
            continue;
        };
        if p != port {
            continue;
        }
        if cols[3] != "0A" {
            continue;
        }
        if let Ok(inode) = cols[9].parse::<u64>() {
            if inode != 0 {
                out.insert(inode);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_inodes_tolerates_missing_proc() {
        let mut set = HashSet::new();
        collect_listening_inodes("/proc/net/tcp", FIM_DEFAULT_PORT, &mut set);
        let _ = set.len();
    }

    #[test]
    fn on_ide_exit_with_empty_handle_is_safe() {
        let h = new_handle();
        on_ide_exit(&h);
        let s = status(&h);
        assert!(!s.owned);
    }

    #[test]
    fn local_port_parses_default_endpoint() {
        assert_eq!(
            local_port_from_endpoint("http://127.0.0.1:8081").unwrap(),
            8081
        );
        assert!(local_port_from_endpoint("http://example.com:8081").is_err());
    }

    #[test]
    fn resolve_binary_rejects_missing_configured_path() {
        let err = resolve_llama_binary("/no/such/llama-server-xyz").unwrap_err();
        assert!(err.contains("llama_server_path"));
    }

    #[test]
    fn discover_finds_user_llama_cuda_layout_when_present() {
        // Soft check: on this developer machine the binary exists; elsewhere skip.
        let Some(home) = home_dir() else {
            return;
        };
        let expected = home.join("llama-cuda/llama-b10189/llama-server");
        if !expected.is_file() {
            return;
        }
        let found = discover_llama_binary().expect("should discover llama-cuda binary");
        assert!(found.is_file());
        assert_eq!(found.file_name().and_then(|s| s.to_str()), Some("llama-server"));
    }

    #[test]
    fn resolve_model_prefers_workspace_then_fallback() {
        let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
        let tmp = home.join(format!(
            ".cache/h1code-test-model-resolve-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("codegemma-2b-GGUF")).unwrap();
        let model = fim_models::CODEGEMMA_2B;
        let rel = model.relative_model_path();
        let path = tmp.join(&rel);
        fs::write(&path, b"fake").unwrap();
        let resolved = resolve_model_file(&tmp, &model).unwrap();
        assert_eq!(resolved, path);
        let _ = fs::remove_dir_all(&tmp);
    }
}
