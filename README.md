# AND-IDE

A focused, lightweight desktop IDE aimed at HTML development. Built as a Rust core with a Tauri + TypeScript shell.

The product is branded for HTML; the current engine still includes Python run/lint tooling from earlier work, and that surface remains available while the HTML-first direction continues.

## Features

- **Workspace management** — open folders, recent projects, and scratch workspaces with create / rename / delete in the explorer
- **CodeMirror editor** — tabbed editing with save flows for untitled and on-disk files
- **Workspace search** — ripgrep-backed search plus a size-capped Tantivy index (gitignore-aware, stored under `.customide/search-index`)
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
- **Tauri 2** system dependencies for your OS ([Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))
- Optional for Python features: a Python interpreter and [Ruff](https://docs.astral.sh/ruff/) on `PATH`

## Quick start

```bash
# Frontend deps
cd ui && npm install && cd ..

# Dev: Tauri starts Vite via beforeDevCommand (port 5173)
cargo run -p ide-shell
```

Production-style build:

```bash
cd ui && npm run build && cd ..
cargo build -p ide-shell --release
```

The built UI is served from `ui/dist` (`crates/ide-shell/tauri.conf.json`).

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

## Project layout

```
CustomIDE/
├── Cargo.toml              # workspace
├── crates/
│   ├── ide-core/           # engine library
│   ├── ide-shell/          # Tauri binary (AND-IDE)
│   └── ide-cli/            # CLI driver
├── ui/                     # Vite + TS frontend
│   ├── index.html
│   └── src/
└── docs/
    └── bug-tracker.md
```

## License

MIT
