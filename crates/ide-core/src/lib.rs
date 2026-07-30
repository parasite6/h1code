//! ide-core: the Rust engine for a Python-focused IDE.
//!
//! The blueprint's "Rust Core" services live here. UI layers (Tauri + TS) and
//! external tooling drivers (Pyright, Ruff, debugpy, pytest, uv) sit on top of
//! these primitives via the command/event surface.

pub mod commands;
pub mod dap;
pub mod errors;
pub mod events;
pub mod fs_service;
pub mod lsp;
pub mod preview_server;
pub mod preview_settings;
pub mod process;
pub mod pty;
pub mod pyright;
pub mod python_env;
pub mod pytest;
pub mod ruff;
pub mod search;
pub mod search_index;
pub mod settings;
pub mod workspace;

pub use errors::{IdeError, IdeResult};
pub use events::{Event, EventBus};
pub use workspace::{Workspace, WorkspaceInfo};
