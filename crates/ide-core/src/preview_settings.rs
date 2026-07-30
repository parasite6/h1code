//! Workspace-local preview settings under `<workspace>/.h1code/settings.toml`.
//! Independent of the JSON `.ide/settings.json` store — do not migrate.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::errors::{IdeError, IdeResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PreviewEngine {
    #[default]
    Tauri,
    Chrome,
}

impl PreviewEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tauri => "tauri",
            Self::Chrome => "chrome",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PreviewSettings {
    pub engine: PreviewEngine,
    pub is_popped_out: bool,
}

const SETTINGS_DIR: &str = ".h1code";
const SETTINGS_FILE: &str = "settings.toml";
const PREVIEW_ENGINE_KEY: &str = "preview_engine";
const IS_POPPED_OUT_KEY: &str = "is_popped_out";

fn settings_path(workspace_root: &Path) -> std::path::PathBuf {
    workspace_root.join(SETTINGS_DIR).join(SETTINGS_FILE)
}

fn read_table(workspace_root: &Path) -> IdeResult<toml::map::Map<String, toml::Value>> {
    let path = settings_path(workspace_root);
    match fs::read_to_string(&path) {
        Ok(raw) => match raw.parse::<toml::Value>() {
            Ok(toml::Value::Table(t)) => Ok(t),
            Ok(_) => Ok(toml::map::Map::new()),
            Err(e) => Err(IdeError::Toml(e)),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(toml::map::Map::new()),
        Err(e) => Err(IdeError::Io(e)),
    }
}

fn write_table(
    workspace_root: &Path,
    table: &toml::map::Map<String, toml::Value>,
) -> IdeResult<()> {
    let dir = workspace_root.join(SETTINGS_DIR);
    fs::create_dir_all(&dir)?;
    let path = dir.join(SETTINGS_FILE);
    let serialized =
        toml::to_string_pretty(&toml::Value::Table(table.clone())).map_err(|e| IdeError::other(e.to_string()))?;
    fs::write(&path, serialized)?;
    Ok(())
}

/// Load preview settings from `.h1code/settings.toml`.
pub fn load_preview_settings(workspace_root: &Path) -> PreviewSettings {
    let Ok(table) = read_table(workspace_root) else {
        return PreviewSettings::default();
    };
    let engine = table
        .get(PREVIEW_ENGINE_KEY)
        .and_then(|v| v.as_str())
        .and_then(|s| match s {
            "tauri" => Some(PreviewEngine::Tauri),
            "chrome" => Some(PreviewEngine::Chrome),
            _ => None,
        })
        .unwrap_or_default();
    let is_popped_out = table
        .get(IS_POPPED_OUT_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    PreviewSettings {
        engine,
        is_popped_out,
    }
}

/// Load `preview_engine` only (compat helper).
pub fn load_preview_engine(workspace_root: &Path) -> PreviewEngine {
    load_preview_settings(workspace_root).engine
}

/// Persist `preview_engine`, creating `.h1code/` and merging with any existing keys.
pub fn save_preview_engine(workspace_root: &Path, engine: PreviewEngine) -> IdeResult<()> {
    let mut table = read_table(workspace_root)?;
    table.insert(
        PREVIEW_ENGINE_KEY.to_string(),
        toml::Value::String(engine.as_str().to_string()),
    );
    write_table(workspace_root, &table)
}

/// Persist `is_popped_out`, creating `.h1code/` and merging with any existing keys.
pub fn save_is_popped_out(workspace_root: &Path, is_popped_out: bool) -> IdeResult<()> {
    let mut table = read_table(workspace_root)?;
    table.insert(IS_POPPED_OUT_KEY.to_string(), toml::Value::Boolean(is_popped_out));
    write_table(workspace_root, &table)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_when_missing() {
        let dir = tempdir().unwrap();
        let s = load_preview_settings(dir.path());
        assert_eq!(s.engine, PreviewEngine::Tauri);
        assert!(!s.is_popped_out);
    }

    #[test]
    fn round_trip_engine_and_popped_out() {
        let dir = tempdir().unwrap();
        let settings_dir = dir.path().join(".h1code");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::write(
            settings_dir.join("settings.toml"),
            "other = 1\npreview_engine = \"tauri\"\n",
        )
        .unwrap();

        save_preview_engine(dir.path(), PreviewEngine::Chrome).unwrap();
        save_is_popped_out(dir.path(), true).unwrap();

        let s = load_preview_settings(dir.path());
        assert_eq!(s.engine, PreviewEngine::Chrome);
        assert!(s.is_popped_out);

        let raw = fs::read_to_string(settings_dir.join("settings.toml")).unwrap();
        assert!(raw.contains("other"));
        assert!(raw.contains("chrome"));
        assert!(raw.contains("is_popped_out"));
    }
}
