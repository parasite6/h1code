//! Known local FIM model trees under the repo root (gitignored GGUF binaries).
//! Paths are relative to the `<h1code>` project root — not the open workspace.
//! Settings UI / launch helpers should resolve these against the app install or
//! checkout root; do not hardcode `/run/media/...` absolute paths.

use serde::Serialize;

/// A bundled (gitignored) model option for autocomplete settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FimModelOption {
    /// Stable id for settings persistence.
    pub id: &'static str,
    /// Human-readable label for dropdowns.
    pub label: &'static str,
    /// Directory under the project root (e.g. `codegemma-2b-GGUF`).
    pub dir: &'static str,
    /// GGUF filename inside [`Self::dir`].
    pub gguf: &'static str,
}

impl FimModelOption {
    /// Relative path from project root: `{dir}/{gguf}`.
    pub fn relative_model_path(self) -> String {
        format!("{}/{}", self.dir, self.gguf)
    }
}

/// CodeGemma 2B Q4_K_M (default FIM model for local testing).
pub const CODEGEMMA_2B: FimModelOption = FimModelOption {
    id: "codegemma-2b-q4_k_m",
    label: "CodeGemma 2B (Q4_K_M)",
    dir: "codegemma-2b-GGUF",
    gguf: "codegemma-2b-Q4_K_M.gguf",
};

/// Qwen2.5-Coder 1.5B Q4_K_M.
pub const QWEN25_CODER_15B: FimModelOption = FimModelOption {
    id: "qwen25-coder-1.5b-q4_k_m",
    label: "Qwen2.5-Coder 1.5B (Q4_K_M)",
    dir: "Qwen2.5-Coder-1.5B-GGUF",
    gguf: "Qwen2.5-Coder-1.5B.Q4_K_M.gguf",
};

/// Catalog for Settings model dropdown (order = display order).
pub const FIM_MODEL_CATALOG: &[FimModelOption] = &[CODEGEMMA_2B, QWEN25_CODER_15B];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_are_under_project_model_dirs() {
        assert_eq!(
            CODEGEMMA_2B.relative_model_path(),
            "codegemma-2b-GGUF/codegemma-2b-Q4_K_M.gguf"
        );
        assert_eq!(
            QWEN25_CODER_15B.relative_model_path(),
            "Qwen2.5-Coder-1.5B-GGUF/Qwen2.5-Coder-1.5B.Q4_K_M.gguf"
        );
        assert!(FIM_MODEL_CATALOG.len() >= 2);
    }
}
