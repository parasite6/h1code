//! Event bus — synchronous broadcast over crossbeam channels.
//!
//! Anything in the core that observes state changes (file watcher, process
//! runner, LSP/DAP) publishes typed [`Event`] values. UI layers subscribe with
//! [`EventBus::subscribe`] to receive a [`Receiver`] of cloned events.

use std::path::PathBuf;
use std::sync::Arc;

use crossbeam_channel::{Receiver, Sender, unbounded};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    WorkspaceOpened { root: PathBuf },
    WorkspaceClosed,
    FileCreated { path: PathBuf },
    FileModified { path: PathBuf },
    FileRemoved { path: PathBuf },
    FileRenamed { from: PathBuf, to: PathBuf },
    ProcessStarted { id: String, cmd: String },
    ProcessOutput { id: String, stream: OutputStream, line: String },
    ProcessExited { id: String, code: Option<i32> },
    /// Push of full diagnostic set for a single file from a single source
    /// (e.g. "pyright", "ruff"). An empty `items` clears that file+source pair.
    Diagnostics {
        path: PathBuf,
        source: String,
        items: Vec<Diagnostic>,
    },
    TestRunStarted { id: String },
    TestRunFinished { id: String, passed: usize, failed: usize },
    /// Background search index status (indexing / ready / capped / error).
    SearchIndexStatus(crate::search_index::SearchIndexStatus),
    Log { level: LogLevel, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub code: Option<String>,
    pub source: Option<String>,
    pub range: Range,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Default)]
pub struct EventBus {
    inner: Arc<RwLock<Vec<Sender<Event>>>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&self) -> Receiver<Event> {
        let (tx, rx) = unbounded();
        self.inner.write().push(tx);
        rx
    }

    pub fn publish(&self, evt: Event) {
        // Prune dead subscribers as we send.
        let mut guard = self.inner.write();
        guard.retain(|tx| tx.send(evt.clone()).is_ok());
    }
}
