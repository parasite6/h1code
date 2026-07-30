//! Workspace-local FIM autocomplete settings under `<workspace>/.h1code/settings.toml`.
//! Shares the same TOML file as preview settings; keys are merged independently.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::errors::{IdeError, IdeResult};

const SETTINGS_DIR: &str = ".h1code";
const SETTINGS_FILE: &str = "settings.toml";

const ENABLED_KEY: &str = "autocomplete_enabled";
const ENDPOINT_KEY: &str = "autocomplete_endpoint";
const DEBOUNCE_MS_KEY: &str = "autocomplete_debounce_ms";
const N_PREFIX_KEY: &str = "autocomplete_n_prefix";
const N_SUFFIX_KEY: &str = "autocomplete_n_suffix";
const N_PREDICT_KEY: &str = "autocomplete_n_predict";
const MAX_LINE_SUFFIX_KEY: &str = "autocomplete_max_line_suffix";
const RING_N_CHUNKS_KEY: &str = "autocomplete_ring_n_chunks";
const RING_CHUNK_SIZE_KEY: &str = "autocomplete_ring_chunk_size";
const RING_SCOPE_KEY: &str = "autocomplete_ring_scope";

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:8081";
const DEFAULT_DEBOUNCE_MS: u64 = 200;
const DEFAULT_N_PREFIX: u32 = 256;
const DEFAULT_N_SUFFIX: u32 = 64;
const DEFAULT_N_PREDICT: u32 = 128;
const DEFAULT_MAX_LINE_SUFFIX: u32 = 8;
const DEFAULT_RING_N_CHUNKS: u32 = 16;
const DEFAULT_RING_CHUNK_SIZE: u32 = 64;
const DEFAULT_RING_SCOPE: u32 = 1024;

/// Opt-in FIM autocomplete config (off by default).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutocompleteSettings {
    pub enabled: bool,
    pub endpoint: String,
    pub debounce_ms: u64,
    pub n_prefix: u32,
    pub n_suffix: u32,
    pub n_predict: u32,
    pub max_line_suffix: u32,
    pub ring_n_chunks: u32,
    pub ring_chunk_size: u32,
    pub ring_scope: u32,
}

impl Default for AutocompleteSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: DEFAULT_ENDPOINT.to_string(),
            debounce_ms: DEFAULT_DEBOUNCE_MS,
            n_prefix: DEFAULT_N_PREFIX,
            n_suffix: DEFAULT_N_SUFFIX,
            n_predict: DEFAULT_N_PREDICT,
            max_line_suffix: DEFAULT_MAX_LINE_SUFFIX,
            ring_n_chunks: DEFAULT_RING_N_CHUNKS,
            ring_chunk_size: DEFAULT_RING_CHUNK_SIZE,
            ring_scope: DEFAULT_RING_SCOPE,
        }
    }
}

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

fn u32_or(table: &toml::map::Map<String, toml::Value>, key: &str, default: u32) -> u32 {
    table
        .get(key)
        .and_then(|v| {
            v.as_integer()
                .and_then(|n| u32::try_from(n).ok())
                .or_else(|| v.as_float().map(|f| f as u32))
        })
        .unwrap_or(default)
}

fn u64_or(table: &toml::map::Map<String, toml::Value>, key: &str, default: u64) -> u64 {
    table
        .get(key)
        .and_then(|v| {
            v.as_integer()
                .and_then(|n| u64::try_from(n).ok())
                .or_else(|| v.as_float().map(|f| f as u64))
        })
        .unwrap_or(default)
}

/// Load autocomplete settings from `.h1code/settings.toml` (defaults when missing).
pub fn load_autocomplete_settings(workspace_root: &Path) -> AutocompleteSettings {
    let Ok(table) = read_table(workspace_root) else {
        return AutocompleteSettings::default();
    };
    let enabled = table
        .get(ENABLED_KEY)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let endpoint = table
        .get(ENDPOINT_KEY)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());

    AutocompleteSettings {
        enabled,
        endpoint,
        debounce_ms: u64_or(&table, DEBOUNCE_MS_KEY, DEFAULT_DEBOUNCE_MS),
        n_prefix: u32_or(&table, N_PREFIX_KEY, DEFAULT_N_PREFIX),
        n_suffix: u32_or(&table, N_SUFFIX_KEY, DEFAULT_N_SUFFIX),
        n_predict: u32_or(&table, N_PREDICT_KEY, DEFAULT_N_PREDICT),
        max_line_suffix: u32_or(&table, MAX_LINE_SUFFIX_KEY, DEFAULT_MAX_LINE_SUFFIX),
        ring_n_chunks: u32_or(&table, RING_N_CHUNKS_KEY, DEFAULT_RING_N_CHUNKS),
        ring_chunk_size: u32_or(&table, RING_CHUNK_SIZE_KEY, DEFAULT_RING_CHUNK_SIZE),
        ring_scope: u32_or(&table, RING_SCOPE_KEY, DEFAULT_RING_SCOPE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_when_missing() {
        let dir = tempdir().unwrap();
        let s = load_autocomplete_settings(dir.path());
        assert!(!s.enabled);
        assert_eq!(s.endpoint, DEFAULT_ENDPOINT);
        assert_eq!(s.debounce_ms, DEFAULT_DEBOUNCE_MS);
    }

    #[test]
    fn reads_enabled_and_endpoint_preserving_other_keys() {
        let dir = tempdir().unwrap();
        let settings_dir = dir.path().join(".h1code");
        fs::create_dir_all(&settings_dir).unwrap();
        fs::write(
            settings_dir.join("settings.toml"),
            "preview_engine = \"chrome\"\nautocomplete_enabled = true\nautocomplete_endpoint = \"http://127.0.0.1:8099\"\nautocomplete_debounce_ms = 150\n",
        )
        .unwrap();

        let s = load_autocomplete_settings(dir.path());
        assert!(s.enabled);
        assert_eq!(s.endpoint, "http://127.0.0.1:8099");
        assert_eq!(s.debounce_ms, 150);
    }
}
