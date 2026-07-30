// Known local FIM model trees under the <h1code> project root (gitignored GGUFs).
// Relative paths only — never hardcode /run/media/... absolute machine paths.
// Source reference for FIM client logic: vendor/llama.vscode/ (MIT).

export interface FimModelOption {
  id: string;
  label: string;
  /** Directory under the project root. */
  dir: string;
  /** GGUF filename inside `dir`. */
  gguf: string;
}

export const CODEGEMMA_2B: FimModelOption = {
  id: "codegemma-2b-q4_k_m",
  label: "CodeGemma 2B (Q4_K_M)",
  dir: "codegemma-2b-GGUF",
  gguf: "codegemma-2b-Q4_K_M.gguf",
};

export const QWEN25_CODER_15B: FimModelOption = {
  id: "qwen25-coder-1.5b-q4_k_m",
  label: "Qwen2.5-Coder 1.5B (Q4_K_M)",
  dir: "Qwen2.5-Coder-1.5B-GGUF",
  gguf: "Qwen2.5-Coder-1.5B.Q4_K_M.gguf",
};

/** Catalog for Settings model dropdown (display order). */
export const FIM_MODEL_CATALOG: readonly FimModelOption[] = [
  CODEGEMMA_2B,
  QWEN25_CODER_15B,
];

/** Relative path from project root: `{dir}/{gguf}`. */
export function relativeModelPath(model: FimModelOption): string {
  return `${model.dir}/${model.gguf}`;
}
