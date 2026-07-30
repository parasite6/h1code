//! Workspace — the open project root + detected Python project metadata.
//!
//! Per the blueprint v1 project detection: plain folder of .py, pyproject.toml,
//! .venv, requirements.txt, uv-managed, pytest.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::errors::{IdeError, IdeResult};
use crate::python_env::{self, PythonEnv};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub root: PathBuf,
    pub name: String,
    pub has_pyproject: bool,
    pub has_requirements_txt: bool,
    pub has_local_venv: bool,
    pub has_uv_lock: bool,
    pub has_pytest_config: bool,
    pub python: Option<PythonEnv>,
    pub project_name: Option<String>,
}

#[derive(Clone)]
pub struct Workspace {
    inner: Arc<RwLock<Option<WorkspaceInfo>>>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

impl Workspace {
    pub fn new() -> Self {
        Self { inner: Arc::new(RwLock::new(None)) }
    }

    pub fn open(&self, root: impl AsRef<Path>) -> IdeResult<WorkspaceInfo> {
        let root = root.as_ref();
        if !root.is_dir() {
            return Err(IdeError::InvalidPath(root.display().to_string()));
        }
        let root = dunce_canonicalize(root)?;
        let info = scan(&root)?;
        *self.inner.write() = Some(info.clone());
        Ok(info)
    }

    pub fn close(&self) {
        *self.inner.write() = None;
    }

    pub fn current(&self) -> Option<WorkspaceInfo> {
        self.inner.read().clone()
    }

    pub fn root(&self) -> IdeResult<PathBuf> {
        self.inner
            .read()
            .as_ref()
            .map(|w| w.root.clone())
            .ok_or(IdeError::NoWorkspace)
    }
}

fn scan(root: &Path) -> IdeResult<WorkspaceInfo> {
    let has_pyproject = root.join("pyproject.toml").is_file();
    let has_requirements_txt = root.join("requirements.txt").is_file();
    let has_local_venv = root.join(".venv").is_dir() || root.join("venv").is_dir();
    let has_uv_lock = root.join("uv.lock").is_file();
    let has_pytest_config = root.join("pytest.ini").is_file()
        || root.join("tox.ini").is_file()
        || root.join("setup.cfg").is_file()
        || has_pyproject_table(root, "tool.pytest.ini_options");

    let project_name = if has_pyproject {
        read_project_name(&root.join("pyproject.toml")).ok().flatten()
    } else {
        None
    };

    let python = python_env::detect(root).ok();
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".to_string());

    Ok(WorkspaceInfo {
        root: root.to_path_buf(),
        name,
        has_pyproject,
        has_requirements_txt,
        has_local_venv,
        has_uv_lock,
        has_pytest_config,
        python,
        project_name,
    })
}

fn has_pyproject_table(root: &Path, dotted: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(root.join("pyproject.toml")) else {
        return false;
    };
    let Ok(v) = text.parse::<toml::Value>() else {
        return false;
    };
    let mut cur = &v;
    for part in dotted.split('.') {
        let Some(next) = cur.get(part) else {
            return false;
        };
        cur = next;
    }
    true
}

fn read_project_name(path: &Path) -> IdeResult<Option<String>> {
    let text = std::fs::read_to_string(path)?;
    let v: toml::Value = toml::from_str(&text)?;
    Ok(v.get("project")
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_string()))
}

// Minimal canonicalize that avoids `\\?\` UNC prefixes on Windows.
fn dunce_canonicalize(p: &Path) -> IdeResult<PathBuf> {
    let abs = std::fs::canonicalize(p)?;
    #[cfg(windows)]
    {
        let s = abs.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(stripped));
        }
    }
    Ok(abs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Mirrors what `saveScratchWorkspace` does before `adopt`/`openWorkspace`:
    /// it calls jailed `fsCreateDir(destRoot)` while no workspace is open.
    #[test]
    fn root_errors_without_open_workspace_like_scratch_save() {
        let ws = Workspace::new();
        let err = ws.root().expect_err("expected NoWorkspace");
        assert!(
            matches!(err, IdeError::NoWorkspace),
            "scratch save's first FS op must hit NoWorkspace; got {err:?}"
        );
        assert_eq!(err.to_string(), "workspace not open");
    }

    #[test]
    fn after_open_root_allows_nested_create_path_check() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new();
        ws.open(dir.path()).unwrap();
        let root = ws.root().unwrap();
        let dest = root.join("Scratch Workspace");
        // path_jail accepts non-existent leaves under an open root (create/write).
        let jailed = crate::path_jail::ensure_within_root(&root, &dest).unwrap();
        fs::create_dir_all(&jailed).unwrap();
        assert!(jailed.is_dir());
    }
}
