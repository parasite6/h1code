//! PTY/terminal manager — backs the bottom-panel terminal. Each session has an
//! id, a pseudo-tty, and a child shell. Output is streamed as base64-free raw
//! strings via the event bus (UI can hand them straight to xterm.js).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::{IdeError, IdeResult};
use crate::events::{Event, EventBus, OutputStream};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySpec {
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

fn default_cols() -> u16 { 120 }
fn default_rows() -> u16 { 30 }

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    _child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone)]
pub struct PtyManager {
    bus: EventBus,
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
}

impl PtyManager {
    pub fn new(bus: EventBus) -> Self {
        Self { bus, sessions: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn open(&self, spec: PtySpec) -> IdeResult<String> {
        let pty_system = NativePtySystem::default();
        tracing::info!(
            target: "h1code::pty",
            cols = spec.cols,
            rows = spec.rows,
            cwd = ?spec.cwd,
            program = ?spec.program,
            args = ?spec.args,
            "PtyManager::open requested"
        );
        let pair = pty_system
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| IdeError::other(format!("pty open: {e}")))?;

        let program = spec.program.unwrap_or_else(default_shell);
        let display = if spec.args.is_empty() {
            program.clone()
        } else {
            format!("{} {}", program, spec.args.join(" "))
        };
        let mut cmd = CommandBuilder::new(&program);
        for a in &spec.args {
            cmd.arg(a);
        }
        if let Some(cwd) = &spec.cwd {
            cmd.cwd(cwd);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| IdeError::other(format!("pty spawn: {e}")))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| IdeError::other(format!("pty reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| IdeError::other(format!("pty writer: {e}")))?;
        tracing::info!(
            target: "h1code::pty",
            program = %program,
            cwd = ?spec.cwd,
            cols = spec.cols,
            rows = spec.rows,
            "PtyManager::open writer ready"
        );

        let id = Uuid::new_v4().to_string();
        let session = Arc::new(Mutex::new(Session {
            master: pair.master,
            writer,
            _child: child,
        }));
        self.sessions.lock().insert(id.clone(), session);
        tracing::info!(
            target: "h1code::pty",
            id = %id,
            program = %program,
            "PtyManager::open session inserted"
        );

        self.bus.publish(Event::ProcessStarted { id: id.clone(), cmd: display });

        let bus = self.bus.clone();
        let id_for_pump = id.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                        bus.publish(Event::ProcessOutput {
                            id: id_for_pump.clone(),
                            stream: OutputStream::Stdout,
                            line: chunk,
                        });
                    }
                    Err(_) => break,
                }
            }
            bus.publish(Event::ProcessExited { id: id_for_pump, code: None });
        });

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> IdeResult<()> {
        tracing::info!(
            target: "h1code::pty",
            id = %id,
            bytes = data.len(),
            "PtyManager::write requested"
        );
        let session = {
            let sessions = self.sessions.lock();
            let session = sessions.get(id).cloned();
            tracing::info!(
                target: "h1code::pty",
                id = %id,
                exists = session.is_some(),
                sessions = sessions.len(),
                "PtyManager::write session lookup"
            );
            session.ok_or_else(|| IdeError::other(format!("no pty session: {id}")))?
        };
        let mut s = session.lock();
        if let Err(err) = s.writer.write_all(data) {
            tracing::warn!(
                target: "h1code::pty",
                id = %id,
                error = %err,
                "PtyManager::write write_all failed"
            );
            return Err(err.into());
        }
        tracing::info!(
            target: "h1code::pty",
            id = %id,
            bytes = data.len(),
            "PtyManager::write write_all succeeded"
        );
        if let Err(err) = s.writer.flush() {
            tracing::warn!(
                target: "h1code::pty",
                id = %id,
                error = %err,
                "PtyManager::write flush failed"
            );
            return Err(err.into());
        }
        tracing::info!(
            target: "h1code::pty",
            id = %id,
            "PtyManager::write flush succeeded"
        );
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> IdeResult<()> {
        let session = self
            .sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| IdeError::other(format!("no pty session: {id}")))?;
        session
            .lock()
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| IdeError::other(format!("pty resize: {e}")))?;
        Ok(())
    }

    pub fn close(&self, id: &str) -> bool {
        self.sessions.lock().remove(id).is_some()
    }

    pub fn list(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}
