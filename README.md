# `<h1code>`

A focused, lightweight desktop IDE aimed at HTML development. Built as a Rust core with a Tauri + TypeScript shell.

> **Status:** Still in active development. Currently stable only on **Linux**; may run on Windows (project originated there) but this is untested — other platforms are unsupported or untested.

The product is branded for HTML; the current engine still includes Python run/lint tooling from earlier work, and that surface remains available while the HTML-first direction continues.

## Features

- **Workspace management** — open folders, recent projects, and scratch workspaces with create / rename / delete in the explorer
- **CodeMirror editor** — tabbed editing with save flows for untitled and on-disk files
- **Workspace search** — ripgrep-backed search plus a size-capped Tantivy index (gitignore-aware, stored under `.h1code/search-index`)
- **Terminal** — interactive PTY shell in the bottom panel
- **Run / lint** — run the active Python file and lint with Ruff (Problems panel); interpreter status in the status bar
- **Empty-state start screen** — recent projects and quick actions when no file is open

## Architecture

| Piece | Role |
| --- | --- |
| `crates/ide-core` | Rust engine: filesystem, workspace, process/PTY, search index, settings, Python/Ruff/Pyright helpers |
| `crates/ide-shell` | Tauri 2 desktop app; thin IPC wrappers that forward `ide-core` events to the webview |
| `crates/ide-cli` | Headless driver to exercise `ide-core` without the UI |
| `ui/` | Vite + TypeScript frontend (CodeMirror, xterm.js, Tauri API) |

Commands flow UI → Tauri invoke → `ide-core`. The UI stays thin; business logic lives in Rust.

## Requirements

- **Rust** 1.80+ (workspace `rust-version`)
- **Node.js** + npm (for `ui/`)
- **Tauri CLI** 2.x (`npm install -g @tauri-apps/cli@^2`) plus [system prerequisites](https://v2.tauri.app/start/prerequisites/)
- Optional for Python features: a Python interpreter, then `pip install -r requirements.txt` (Ruff, Pyright, pytest, debugpy)

## Quick start

```bash
# Optional Python tooling (venv recommended)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Frontend deps
cd ui && npm install && cd ..

# Dev (from the Tauri app crate; starts Vite on port 5173 via beforeDevCommand)
cd crates/ide-shell
tauri dev
```

Production build:

```bash
cd crates/ide-shell
tauri build
```

`tauri` runs the configured `beforeDevCommand` / `beforeBuildCommand` and loads the UI from `ui/` / `ui/dist` per `crates/ide-shell/tauri.conf.json`.

## CLI (`ide-cli`)

Useful for exercising the engine without the desktop shell:

```bash
cargo run -p ide-cli -- open <path>
cargo run -p ide-cli -- ls <path>
cargo run -p ide-cli -- find <path> <pattern> [--literal] [--ignore-case]
cargo run -p ide-cli -- pyrun <path> <script.py> [args...]
cargo run -p ide-cli -- ruff <path> [files...]
cargo run -p ide-cli -- term <path>
cargo run -p ide-cli -- commands
cargo run -p ide-cli -- call <command> [json]
```

See `crates/ide-cli/src/main.rs` for the full command list.

## FIM autocomplete (opt-in)

Local fill-in-the-middle suggestions via `llama-server`. Off by default.

FIM client logic was adapted from [`vendor/llama.vscode`](vendor/llama.vscode/) ([ggml-org/llama.vscode](https://github.com/ggml-org/llama.vscode), **MIT**). Model GGUF trees live at the **workspace root** and are gitignored (not shipped on clone).

1. Place a FIM-capable GGUF under the workspace root (examples already used locally):

- `codegemma-2b-GGUF/codegemma-2b-Q4_K_M.gguf`
- `Qwen2.5-Coder-1.5B-GGUF/Qwen2.5-Coder-1.5B.Q4_K_M.gguf`

2. Put `llama-server` on your `PATH`, leave path empty for auto-discovery (`~/llama-cuda/llama-b*`, `~/llama-b*`, …), **or** set an absolute path in Settings (many llama.cpp installs are not on PATH):

```toml
# .h1code/settings.toml
autocomplete_enabled = true
# optional when not on PATH / not in common locations:
llama_server_path = "/home/you/llama-cuda/llama-b10189/llama-server"
# optional: autocomplete_endpoint = "http://127.0.0.1:8081"
# optional: autocomplete_model = "codegemma-2b-q4_k_m"
```

3. Enable autocomplete via the topbar **Settings** button (or **File → Settings** / `Ctrl+,`). On workspace open (and when you toggle Enable / click **Start**), the IDE spawns:

```bash
llama-server \
  -m "<workspace>/<model>.gguf" \
  --port 8081 -ngl 99 --ctx-size 0 -ub 512 -b 512 --cache-reuse 256
```

If a healthy server is already listening on the endpoint port, the IDE reuses it and does **not** claim ownership. **Start** / **Stop** spawn or kill only an IDE-owned process. Closing the IDE (or the workspace) stops an owned server; an externally started server is left alone.

Equivalent manual launch from the workspace root:

```bash
llama-server \
  -m "./codegemma-2b-GGUF/codegemma-2b-Q4_K_M.gguf" \
  --port 8081 -ngl 99 --ctx-size 0 -ub 512 -b 512 --cache-reuse 256
```

Ghost text appears after a short debounce; **Tab** accepts, otherwise Tab still indents.

HTML/CSS files discard completions that look like React/PHP/template injections (`useState`, `onChange={`, `<?php`, `{{`, `@foreach`).

Known model relative paths for Settings UI are listed in [`ui/src/fimModels.ts`](ui/src/fimModels.ts) / [`crates/ide-core/src/fim_models.rs`](crates/ide-core/src/fim_models.rs).

## Project layout

```
-h1code-/
├── Cargo.toml              # workspace
├── requirements.txt        # optional Python tooling
├── crates/
│   ├── ide-core/           # engine library
│   ├── ide-shell/          # Tauri binary (<h1code>)
│   └── ide-cli/            # CLI driver
├── ui/                     # Vite + TS frontend
│   ├── index.html
│   └── src/
├── vendor/
│   └── llama.vscode/       # FIM reference source (MIT; not a build dep)
├── codegemma-2b-GGUF/      # local GGUF (gitignored)
├── Qwen2.5-Coder-1.5B-GGUF/# local GGUF (gitignored)
└── docs/
    └── bug-tracker.md
```

## License

None yet 😅️

Third-party: `vendor/llama.vscode` is MIT (Copyright 2025 The llama.vscode contributors).
