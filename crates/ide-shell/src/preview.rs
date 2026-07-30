//! Live preview: localhost static server + Chrome app-mode spawn/kill.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;

use ide_core::preview_server::PreviewServer;
use ide_core::preview_settings::{self, PreviewEngine};

#[derive(Default)]
pub struct PreviewState {
    pub server: Option<PreviewServer>,
    pub chrome: Option<Child>,
    pub engine: PreviewEngine,
    pub is_popped_out: bool,
    pub last_url: Option<String>,
    pub workspace_root: Option<PathBuf>,
}

pub type PreviewHandle = Arc<Mutex<PreviewState>>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServerInfo {
    pub port: u16,
    pub base_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOpenResult {
    pub url: String,
    pub engine: PreviewEngine,
    pub base_url: String,
    pub is_popped_out: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStateSnapshot {
    pub engine: PreviewEngine,
    pub port: Option<u16>,
    pub has_server: bool,
    pub chrome_running: bool,
    pub is_popped_out: bool,
}

pub fn new_handle() -> PreviewHandle {
    Arc::new(Mutex::new(PreviewState::default()))
}

/// Stop server + chrome when the workspace changes or closes.
pub fn clear_for_workspace_change(preview: &PreviewHandle) {
    let mut state = preview.lock();
    kill_chrome_locked(&mut state);
    if let Some(mut server) = state.server.take() {
        server.stop();
    }
    state.last_url = None;
    state.workspace_root = None;
    state.engine = PreviewEngine::default();
    state.is_popped_out = false;
}

pub fn ensure_server(
    preview: &PreviewHandle,
    workspace_root: &Path,
) -> Result<PreviewServerInfo, String> {
    let mut state = preview.lock();

    let root_changed = state
        .workspace_root
        .as_ref()
        .map(|r| r != workspace_root)
        .unwrap_or(true);

    if root_changed {
        kill_chrome_locked(&mut state);
        if let Some(mut server) = state.server.take() {
            server.stop();
        }
        state.workspace_root = Some(workspace_root.to_path_buf());
        let settings = preview_settings::load_preview_settings(workspace_root);
        state.engine = settings.engine;
        state.is_popped_out = settings.is_popped_out;
        state.last_url = None;
    }

    if state.server.is_none() {
        let server = PreviewServer::start(workspace_root.to_path_buf()).map_err(to_err)?;
        state.server = Some(server);
    }

    let server = state.server.as_ref().unwrap();
    Ok(PreviewServerInfo {
        port: server.port(),
        base_url: server.base_url(),
    })
}

pub fn open_file(
    preview: &PreviewHandle,
    workspace_root: &Path,
    file_path: &str,
) -> Result<PreviewOpenResult, String> {
    let info = ensure_server(preview, workspace_root)?;
    let mut state = preview.lock();
    let settings = preview_settings::load_preview_settings(workspace_root);
    state.engine = settings.engine;
    state.is_popped_out = settings.is_popped_out;

    let server = state
        .server
        .as_ref()
        .ok_or_else(|| "preview server not running".to_string())?;
    let url = server
        .url_for_file(Path::new(file_path))
        .map_err(to_err)?;
    state.last_url = Some(url.clone());

    Ok(PreviewOpenResult {
        url,
        engine: state.engine,
        base_url: info.base_url,
        is_popped_out: state.is_popped_out,
    })
}

pub fn close(preview: &PreviewHandle, stop_server: bool) -> Result<(), String> {
    let mut state = preview.lock();
    kill_chrome_locked(&mut state);
    if stop_server {
        if let Some(mut server) = state.server.take() {
            server.stop();
        }
    }
    state.last_url = None;
    Ok(())
}

pub fn set_engine(
    preview: &PreviewHandle,
    workspace_root: &Path,
    engine: PreviewEngine,
) -> Result<PreviewEngine, String> {
    preview_settings::save_preview_engine(workspace_root, engine).map_err(to_err)?;
    let mut state = preview.lock();
    state.engine = engine;
    // Docked Chrome uses the in-panel iframe; only pop-out may own a Chrome process.
    if engine != PreviewEngine::Chrome || !state.is_popped_out {
        kill_chrome_locked(&mut state);
    }
    Ok(engine)
}

pub fn set_is_popped_out(
    preview: &PreviewHandle,
    workspace_root: &Path,
    is_popped_out: bool,
) -> Result<bool, String> {
    preview_settings::save_is_popped_out(workspace_root, is_popped_out).map_err(to_err)?;
    let mut state = preview.lock();
    state.is_popped_out = is_popped_out;
    if !is_popped_out {
        kill_chrome_locked(&mut state);
    }
    Ok(is_popped_out)
}

pub fn spawn_chrome(preview: &PreviewHandle, url: &str) -> Result<(), String> {
    let mut state = preview.lock();
    let base_url = state
        .server
        .as_ref()
        .map(|s| s.base_url())
        .ok_or_else(|| "preview server not running".to_string())?;
    if !url_is_under_preview_base(&base_url, url) {
        return Err(format!(
            "url must start with the current preview base URL ({base_url})"
        ));
    }
    kill_chrome_locked(&mut state);
    let child = spawn_chrome_process(url)?;
    state.chrome = Some(child);
    state.last_url = Some(url.to_string());
    state.engine = PreviewEngine::Chrome;
    Ok(())
}

/// Accept only URLs under the live preview server's base (e.g. `http://127.0.0.1:PORT/…`).
/// Requires a `/` after the base so a longer port cannot prefix-match.
fn url_is_under_preview_base(base_url: &str, url: &str) -> bool {
    let base = base_url.trim_end_matches('/');
    url == base || url.starts_with(&format!("{base}/"))
}

pub fn kill_chrome(preview: &PreviewHandle) -> Result<(), String> {
    let mut state = preview.lock();
    kill_chrome_locked(&mut state);
    Ok(())
}

pub fn reload_url(
    preview: &PreviewHandle,
    workspace_root: &Path,
    file_path: &str,
) -> Result<String, String> {
    let result = open_file(preview, workspace_root, file_path)?;
    Ok(result.url)
}

pub fn get_state(preview: &PreviewHandle) -> PreviewStateSnapshot {
    let mut state = preview.lock();
    // Reap exited chrome so chrome_running stays accurate.
    if let Some(child) = state.chrome.as_mut() {
        if let Ok(Some(_)) = child.try_wait() {
            state.chrome = None;
        }
    }
    PreviewStateSnapshot {
        engine: state.engine,
        port: state.server.as_ref().map(|s| s.port()),
        has_server: state.server.is_some(),
        chrome_running: state.chrome.is_some(),
        is_popped_out: state.is_popped_out,
    }
}

fn kill_chrome_locked(state: &mut PreviewState) {
    if let Some(mut child) = state.chrome.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn spawn_chrome_process(url: &str) -> Result<Child, String> {
    const CANDIDATES: &[&str] = &[
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ];
    let app_arg = format!("--app={url}");
    let mut last_err = String::from("Chrome/Chromium not found");

    for bin in CANDIDATES {
        match Command::new(bin)
            .arg("--new-window")
            .arg(&app_arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(e) => last_err = format!("{bin}: {e}"),
        }
    }
    Err(last_err)
}

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::url_is_under_preview_base;

    #[test]
    fn accepts_urls_under_preview_base() {
        let base = "http://127.0.0.1:4567";
        assert!(url_is_under_preview_base(base, base));
        assert!(url_is_under_preview_base(base, "http://127.0.0.1:4567/"));
        assert!(url_is_under_preview_base(
            base,
            "http://127.0.0.1:4567/index.html"
        ));
        assert!(url_is_under_preview_base(
            "http://127.0.0.1:4567/",
            "http://127.0.0.1:4567/a/b.html"
        ));
    }

    #[test]
    fn rejects_urls_outside_preview_base() {
        let base = "http://127.0.0.1:4567";
        assert!(!url_is_under_preview_base(base, "http://127.0.0.1:45678/x"));
        assert!(!url_is_under_preview_base(base, "file:///etc/passwd"));
        assert!(!url_is_under_preview_base(base, "https://evil.example/"));
        assert!(!url_is_under_preview_base(base, "http://127.0.0.1:9999/"));
        assert!(!url_is_under_preview_base(
            base,
            "http://127.0.0.1:4567.evil/"
        ));
    }
}
