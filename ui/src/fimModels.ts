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
  /** llama-server `-ub` (micro-batch) size. */
  ub: number;
  /** llama-server `-b` (batch) size. */
  b: number;
}

export const CODEGEMMA_2B: FimModelOption = {
  id: "codegemma-2b-q4_k_m",
  label: "CodeGemma 2B (Q4_K_M)",
  dir: "codegemma-2b-GGUF",
  gguf: "codegemma-2b-Q4_K_M.gguf",
  ub: 512,
  b: 512,
};

export const QWEN25_CODER_15B: FimModelOption = {
  id: "qwen25-coder-1.5b-q4_k_m",
  label: "Qwen2.5-Coder 1.5B (Q4_K_M)",
  dir: "Qwen2.5-Coder-1.5B-GGUF",
  gguf: "Qwen2.5-Coder-1.5B.Q4_K_M.gguf",
  ub: 512,
  b: 512,
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

export function findFimModel(id: string): FimModelOption | undefined {
  return FIM_MODEL_CATALOG.find((m) => m.id === id);
}

/** Default catalog model when settings omit a selection. */
export function defaultFimModel(): FimModelOption {
  return CODEGEMMA_2B;
}

/** Derive llama-server `--port` from an autocomplete endpoint URL. */
export function portFromEndpoint(endpoint: string, fallback = 8081): number {
  try {
    const url = new URL(endpoint.trim());
    if (url.port) {
      const n = Number.parseInt(url.port, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (url.protocol === "https:") return 443;
    if (url.protocol === "http:") return 80;
  } catch {
    // fall through
  }
  return fallback;
}

/**
 * Example launch command for the selected model (relative GGUF path).
 * The IDE can spawn this automatically; kept for Settings hints / README.
 */
export function buildLlamaServerCommand(
  model: FimModelOption,
  endpoint: string
): string {
  const rel = relativeModelPath(model);
  const port = portFromEndpoint(endpoint);
  return `llama-server -m "./${rel}" --port ${port} -ngl 99 --ctx-size 0 -ub ${model.ub} -b ${model.b} --cache-reuse 256`;
}
