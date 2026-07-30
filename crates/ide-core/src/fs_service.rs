//! File-system service — owns reads/writes/rename/delete + a debounced watcher
//! that publishes [`Event::File*`] onto the [`EventBus`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{DebouncedEvent, new_debouncer};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::errors::{IdeError, IdeResult};
use crate::events::{Event, EventBus};

/// How long IDE-originated mutations suppress matching watcher events.
const EXPECTED_TTL: Duration = Duration::from_millis(2000);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStat {
    pub exists: bool,
    pub mtime_ms: Option<u64>,
    pub size: Option<u64>,
    pub is_dir: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SniffMedia {
    Audio,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSniff {
    pub looks_binary: bool,
    pub media: Option<SniffMedia>,
}

#[derive(Clone)]
pub struct FsService {
    bus: EventBus,
    watcher: Arc<Mutex<Option<WatcherHandle>>>,
    expected: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

struct WatcherHandle {
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::FileIdMap,
    >,
    root: PathBuf,
}

impl FsService {
    pub fn new(bus: EventBus) -> Self {
        Self {
            bus,
            watcher: Arc::new(Mutex::new(None)),
            expected: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn read(&self, path: &Path) -> IdeResult<String> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(text),
            // Non-UTF-8 content (binaries: .so, .pak, executables, …) surfaces
            // as InvalidData. Report a clean "not a text file" so the editor can
            // tell the user instead of failing silently.
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                Err(IdeError::NotTextFile)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Read any file as text, replacing invalid UTF-8 with the replacement
    /// character. Used when the user explicitly chooses to open a non-text file
    /// in the built-in editor anyway.
    pub fn read_lossy(&self, path: &Path) -> IdeResult<String> {
        let bytes = std::fs::read(path)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Max size for in-memory media previews (audio/images via blob URL).
    pub const MEDIA_BYTES_MAX: u64 = 64 * 1024 * 1024;

    /// Read raw file bytes for media preview. Rejects oversized files so a
    /// huge asset cannot blow up the webview process.
    pub fn read_bytes(&self, path: &Path, max_bytes: u64) -> IdeResult<Vec<u8>> {
        let meta = std::fs::metadata(path)?;
        if meta.is_dir() {
            return Err(IdeError::other("path is a directory"));
        }
        if meta.len() > max_bytes {
            return Err(IdeError::other(format!(
                "file too large for preview ({} bytes; max {} bytes)",
                meta.len(),
                max_bytes
            )));
        }
        Ok(std::fs::read(path)?)
    }

    /// Cheap head sniff for unknown extensions: null-byte heuristic + common
    /// image/audio magic. Does not load the whole file.
    pub fn sniff(&self, path: &Path) -> IdeResult<FileSniff> {
        use std::io::Read;
        let mut file = std::fs::File::open(path)?;
        let mut buf = [0u8; 8192];
        let n = file.read(&mut buf)?;
        let head = &buf[..n];
        Ok(FileSniff {
            looks_binary: head.iter().any(|&b| b == 0),
            media: sniff_media(head),
        })
    }

    pub fn write(&self, path: &Path, contents: &str) -> IdeResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = atomic_write_tmp_path(path);
        self.mark_expected(path);
        self.mark_expected(&tmp);
        atomic_write(path, contents.as_bytes())?;
        // Re-mark after the rename so a late debounced event still matches.
        self.mark_expected(path);
        self.mark_expected(&tmp);
        Ok(())
    }

    pub fn create_file(&self, path: &Path) -> IdeResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        self.mark_expected(path);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        self.mark_expected(path);
        Ok(())
    }

    pub fn create_dir(&self, path: &Path) -> IdeResult<()> {
        self.mark_expected(path);
        std::fs::create_dir_all(path)?;
        self.mark_expected(path);
        Ok(())
    }

    pub fn remove(&self, path: &Path) -> IdeResult<()> {
        self.mark_expected(path);
        // Retry/backoff so deletion can succeed when a just-finished runner
        // still briefly holds a file lock under the path (common on Windows).
        let mut delay = Duration::from_millis(40);
        let mut last_err: Option<std::io::Error> = None;
        for _ in 0..8 {
            if !path.exists() {
                return Ok(());
            }
            let result = if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            match result {
                Ok(()) => {
                    self.mark_expected(path);
                    return Ok(());
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => {
                    last_err = Some(e);
                    std::thread::sleep(delay);
                    delay = (delay.saturating_mul(2)).min(Duration::from_millis(800));
                }
            }
        }
        Err(last_err
            .map(Into::into)
            .unwrap_or_else(|| IdeError::other("remove failed")))
    }

    pub fn rename(&self, from: &Path, to: &Path) -> IdeResult<()> {
        self.mark_expected(from);
        self.mark_expected(to);
        std::fs::rename(from, to)?;
        self.mark_expected(from);
        self.mark_expected(to);
        Ok(())
    }

    /// Lightweight metadata for open-buffer baselines / checkup.
    pub fn stat(&self, path: &Path) -> FileStat {
        match std::fs::metadata(path) {
            Ok(meta) => FileStat {
                exists: true,
                mtime_ms: system_time_to_ms(meta.modified().ok()),
                size: Some(meta.len()),
                is_dir: Some(meta.is_dir()),
            },
            Err(_) => FileStat {
                exists: false,
                mtime_ms: None,
                size: None,
                is_dir: None,
            },
        }
    }

    /// Mark `path` as an IDE-originated mutation for [`EXPECTED_TTL`].
    pub fn mark_expected(&self, path: &Path) {
        let mut guard = self.expected.lock();
        prune_expected(&mut guard);
        guard.insert(path.to_path_buf(), Instant::now() + EXPECTED_TTL);
    }

    /// Whether watcher events for `path` should be suppressed right now.
    pub fn is_expected(&self, path: &Path) -> bool {
        let mut guard = self.expected.lock();
        prune_expected(&mut guard);
        guard.contains_key(path)
    }

    /// Gitignore-aware shallow listing of a single directory.
    pub fn list_dir(&self, dir: &Path) -> IdeResult<Vec<DirEntry>> {
        let mut out = Vec::new();
        for res in WalkBuilder::new(dir).max_depth(Some(1)).hidden(false).build() {
            let entry = match res {
                Ok(e) => e,
                Err(_) => continue,
            };
            if entry.path() == dir {
                continue;
            }
            let path = entry.path().to_path_buf();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(DirEntry { path, name, is_dir });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    /// Start (or replace) recursive watch on `root`. Events are debounced
    /// and translated into `Event::File*` on the bus.
    pub fn watch(&self, root: &Path) -> IdeResult<()> {
        let bus = self.bus.clone();
        let expected = self.expected.clone();
        let root_buf = root.to_path_buf();
        let mut debouncer = new_debouncer(
            Duration::from_millis(150),
            None,
            move |res: Result<Vec<DebouncedEvent>, Vec<notify::Error>>| {
                let Ok(events) = res else { return };
                for evt in events {
                    publish_event(&bus, &expected, &evt);
                }
            },
        )?;
        debouncer.watcher().watch(root, RecursiveMode::Recursive)?;
        *self.watcher.lock() = Some(WatcherHandle { _debouncer: debouncer, root: root_buf });
        Ok(())
    }

    pub fn stop_watching(&self) {
        *self.watcher.lock() = None;
    }

    pub fn watched_root(&self) -> Option<PathBuf> {
        self.watcher.lock().as_ref().map(|h| h.root.clone())
    }
}

fn prune_expected(map: &mut HashMap<PathBuf, Instant>) {
    let now = Instant::now();
    map.retain(|_, expiry| *expiry > now);
}

fn system_time_to_ms(t: Option<SystemTime>) -> Option<u64> {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

fn publish_event(
    bus: &EventBus,
    expected: &Mutex<HashMap<PathBuf, Instant>>,
    evt: &DebouncedEvent,
) {
    use notify::EventKind;

    let suppress = |path: &Path| -> bool {
        let mut guard = expected.lock();
        prune_expected(&mut guard);
        guard.contains_key(path)
    };

    let paths = evt.event.paths.clone();
    match evt.event.kind {
        EventKind::Create(_) => {
            for p in paths {
                if !suppress(&p) {
                    bus.publish(Event::FileCreated { path: p });
                }
            }
        }
        EventKind::Modify(notify::event::ModifyKind::Name(notify::event::RenameMode::Both)) => {
            if paths.len() == 2 {
                let from = &paths[0];
                let to = &paths[1];
                if suppress(from) || suppress(to) {
                    return;
                }
                bus.publish(Event::FileRenamed {
                    from: from.clone(),
                    to: to.clone(),
                });
            }
        }
        EventKind::Modify(_) => {
            for p in paths {
                if !suppress(&p) {
                    bus.publish(Event::FileModified { path: p });
                }
            }
        }
        EventKind::Remove(_) => {
            for p in paths {
                if !suppress(&p) {
                    bus.publish(Event::FileRemoved { path: p });
                }
            }
        }
        _ => {}
    }
}

fn sniff_media(head: &[u8]) -> Option<SniffMedia> {
    if head.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
        return Some(SniffMedia::Image);
    }
    if head.len() >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF {
        return Some(SniffMedia::Image);
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some(SniffMedia::Image);
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some(SniffMedia::Image);
    }
    if head.starts_with(b"BM") {
        return Some(SniffMedia::Image);
    }
    // ICO: reserved u16=0, type u16=1
    if head.len() >= 4 && head[0] == 0 && head[1] == 0 && head[2] == 1 && head[3] == 0 {
        return Some(SniffMedia::Image);
    }
    if head.starts_with(b"ID3") {
        return Some(SniffMedia::Audio);
    }
    // MPEG frame sync
    if head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0 {
        return Some(SniffMedia::Audio);
    }
    if head.starts_with(b"fLaC") || head.starts_with(b"OggS") {
        return Some(SniffMedia::Audio);
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Some(SniffMedia::Audio);
    }
    None
}

fn atomic_write_tmp_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    parent.join(format!(".{file_name}.tmp"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = atomic_write_tmp_path(path);
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn mark_expected_suppresses_until_expiry() {
        let fs = FsService::new(EventBus::new());
        let path = PathBuf::from("/tmp/h1code-expected-test");
        assert!(!fs.is_expected(&path));
        fs.mark_expected(&path);
        assert!(fs.is_expected(&path));
    }

    #[test]
    fn write_marks_path_and_tmp_expected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.txt");
        let fs = FsService::new(EventBus::new());
        fs.write(&path, "hello").unwrap();
        assert!(fs.is_expected(&path));
        assert!(fs.is_expected(&atomic_write_tmp_path(&path)));
        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn stat_reports_existing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("stat.txt");
        fs::write(&path, "abc").unwrap();
        let fs = FsService::new(EventBus::new());
        let st = fs.stat(&path);
        assert!(st.exists);
        assert_eq!(st.size, Some(3));
        assert_eq!(st.is_dir, Some(false));
        assert!(st.mtime_ms.is_some());
    }

    #[test]
    fn stat_missing_file() {
        let fs = FsService::new(EventBus::new());
        let st = fs.stat(Path::new("/definitely/does/not/exist-h1code"));
        assert!(!st.exists);
        assert!(st.mtime_ms.is_none());
        assert!(st.size.is_none());
    }

    #[test]
    fn sniff_detects_png_and_null_bytes() {
        let dir = tempdir().unwrap();
        let png = dir.path().join("x.bin");
        let mut bytes = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        bytes.extend_from_slice(&[0, 1, 2, 3]);
        fs::write(&png, &bytes).unwrap();
        let fs = FsService::new(EventBus::new());
        let sniff = fs.sniff(&png).unwrap();
        assert!(sniff.looks_binary);
        assert_eq!(sniff.media, Some(SniffMedia::Image));

        let text = dir.path().join("ok.txt");
        fs::write(&text, "hello world").unwrap();
        let sniff_text = fs.sniff(&text).unwrap();
        assert!(!sniff_text.looks_binary);
        assert!(sniff_text.media.is_none());
    }

    #[test]
    fn read_bytes_returns_content_and_rejects_oversized() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("tiny.bin");
        fs::write(&path, b"abc123").unwrap();
        let fs = FsService::new(EventBus::new());
        assert_eq!(fs.read_bytes(&path, 64).unwrap(), b"abc123");
        let err = fs.read_bytes(&path, 3).unwrap_err().to_string();
        assert!(err.contains("too large"), "unexpected err: {err}");
    }
}
