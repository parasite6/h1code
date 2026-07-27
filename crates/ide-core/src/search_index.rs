//! Background Tantivy search index for workspace paths and file contents.
//!
//! The index is an assist: size-capped, gitignore-aware, and never the sole
//! source of truth for content search (ripgrep still covers the full tree).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use ignore::WalkBuilder;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, FuzzyTermQuery, Occur, Query, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TantivyDocument, TextFieldIndexing, TextOptions, Value,
    STORED, STRING,
};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

use crate::errors::{IdeError, IdeResult};
use crate::events::{Event, EventBus, LogLevel};

/// Default hard cap for the on-disk index directory.
pub const DEFAULT_MAX_INDEX_BYTES: u64 = 256 * 1024 * 1024;
/// Files larger than this are indexed as path/name only (no content).
pub const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Relative directory under the workspace root that holds the index.
pub const INDEX_DIR_NAME: &str = ".customide/search-index";

const WRITER_HEAP_BYTES: usize = 50_000_000;
const COMMIT_EVERY: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexPhase {
    Idle,
    Indexing,
    Ready,
    Capped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchIndexStatus {
    pub phase: IndexPhase,
    pub root: Option<PathBuf>,
    pub files_indexed: u64,
    pub dirs_indexed: u64,
    pub content_indexed: u64,
    pub index_bytes: u64,
    pub max_index_bytes: u64,
    pub message: Option<String>,
}

impl Default for SearchIndexStatus {
    fn default() -> Self {
        Self {
            phase: IndexPhase::Idle,
            root: None,
            files_indexed: 0,
            dirs_indexed: 0,
            content_indexed: 0,
            index_bytes: 0,
            max_index_bytes: DEFAULT_MAX_INDEX_BYTES,
            message: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PathEntry {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone)]
pub struct IndexPathHit {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone)]
pub struct IndexContentHit {
    pub path: PathBuf,
    pub line_number: u64,
    pub line: String,
    pub start: usize,
    pub end: usize,
}

struct SchemaFields {
    schema: Schema,
    path: Field,
    name: Field,
    kind: Field,
    content: Field,
}

fn build_schema() -> SchemaFields {
    let mut builder = Schema::builder();
    let path = builder.add_text_field("path", STRING | STORED);
    let name_opts = TextOptions::default().set_stored().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer("default")
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );
    let name = builder.add_text_field("name", name_opts);
    let kind = builder.add_text_field("kind", STRING | STORED);
    let content_opts = TextOptions::default().set_stored().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer("default")
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );
    let content = builder.add_text_field("content", content_opts);
    SchemaFields {
        schema: builder.build(),
        path,
        name,
        kind,
        content,
    }
}

fn index_dir_for(root: &Path) -> PathBuf {
    root.join(INDEX_DIR_NAME)
}

fn is_index_noise(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str();
        s == ".customide" || s == ".git"
    })
}

fn dir_size_bytes(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
        .sum()
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

fn read_text_if_indexable(path: &Path, max_file_bytes: u64) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max_file_bytes {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if looks_binary(&bytes) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Live Tantivy + in-memory path list for one workspace root.
pub struct SearchIndex {
    root: PathBuf,
    fields: SchemaFields,
    #[allow(dead_code)]
    index: Index, // kept so IndexWriter/reader stay tied to a live Index handle
    reader: IndexReader,
    writer: parking_lot::Mutex<IndexWriter>,
    paths: RwLock<Vec<PathEntry>>,
    files_indexed: AtomicU64,
    dirs_indexed: AtomicU64,
    content_indexed: AtomicU64,
    capped: AtomicBool,
    max_index_bytes: u64,
    max_file_bytes: u64,
}

impl SearchIndex {
    pub fn open_or_create(
        root: &Path,
        max_index_bytes: u64,
        max_file_bytes: u64,
    ) -> IdeResult<Self> {
        let dir = index_dir_for(root);
        fs::create_dir_all(&dir)?;
        let fields = build_schema();
        let index = if dir.join("meta.json").exists() {
            Index::open_in_dir(&dir).map_err(|e| IdeError::other(format!("tantivy open: {e}")))?
        } else {
            Index::create_in_dir(&dir, fields.schema.clone())
                .map_err(|e| IdeError::other(format!("tantivy create: {e}")))?
        };
        let writer = index
            .writer(WRITER_HEAP_BYTES)
            .map_err(|e| IdeError::other(format!("tantivy writer: {e}")))?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(|e| IdeError::other(format!("tantivy reader: {e}")))?;

        Ok(Self {
            root: root.to_path_buf(),
            fields,
            index,
            reader,
            writer: parking_lot::Mutex::new(writer),
            paths: RwLock::new(Vec::new()),
            files_indexed: AtomicU64::new(0),
            dirs_indexed: AtomicU64::new(0),
            content_indexed: AtomicU64::new(0),
            capped: AtomicBool::new(false),
            max_index_bytes,
            max_file_bytes,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_capped(&self) -> bool {
        self.capped.load(Ordering::Relaxed)
    }

    pub fn index_bytes(&self) -> u64 {
        dir_size_bytes(&index_dir_for(&self.root))
    }

    pub fn snapshot_status(&self, phase: IndexPhase, message: Option<String>) -> SearchIndexStatus {
        SearchIndexStatus {
            phase,
            root: Some(self.root.clone()),
            files_indexed: self.files_indexed.load(Ordering::Relaxed),
            dirs_indexed: self.dirs_indexed.load(Ordering::Relaxed),
            content_indexed: self.content_indexed.load(Ordering::Relaxed),
            index_bytes: self.index_bytes(),
            max_index_bytes: self.max_index_bytes,
            message,
        }
    }

    pub fn clear(&self) -> IdeResult<()> {
        {
            let mut writer = self.writer.lock();
            writer
                .delete_all_documents()
                .map_err(|e| IdeError::other(format!("tantivy delete_all: {e}")))?;
            writer
                .commit()
                .map_err(|e| IdeError::other(format!("tantivy commit: {e}")))?;
        }
        self.reader
            .reload()
            .map_err(|e| IdeError::other(format!("tantivy reload: {e}")))?;
        self.paths.write().clear();
        self.files_indexed.store(0, Ordering::Relaxed);
        self.dirs_indexed.store(0, Ordering::Relaxed);
        self.content_indexed.store(0, Ordering::Relaxed);
        self.capped.store(false, Ordering::Relaxed);
        Ok(())
    }

    fn budget_allows_content(&self) -> bool {
        if self.capped.load(Ordering::Relaxed) {
            return false;
        }
        let size = self.index_bytes();
        if size >= self.max_index_bytes {
            self.capped.store(true, Ordering::Relaxed);
            return false;
        }
        true
    }

    fn remove_path_locked(&self, writer: &mut IndexWriter, path: &Path) {
        let term = Term::from_field_text(self.fields.path, &path.to_string_lossy());
        writer.delete_term(term);
        self.paths.write().retain(|e| e.path != path);
    }

    pub fn remove_path(&self, path: &Path) -> IdeResult<()> {
        {
            let mut writer = self.writer.lock();
            self.remove_path_locked(&mut writer, path);
            writer
                .commit()
                .map_err(|e| IdeError::other(format!("tantivy commit: {e}")))?;
        }
        self.reader
            .reload()
            .map_err(|e| IdeError::other(format!("tantivy reload: {e}")))?;
        Ok(())
    }

    /// Upsert a file or directory. Returns whether content was stored.
    pub fn upsert_path(&self, path: &Path, commit: bool) -> IdeResult<bool> {
        if is_index_noise(path) {
            return Ok(false);
        }
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => {
                self.remove_path(path)?;
                return Ok(false);
            }
        };
        let is_dir = meta.is_dir();
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let path_str = path.to_string_lossy().into_owned();

        let mut content: Option<String> = None;
        let mut stored_content = false;
        if !is_dir && self.budget_allows_content() {
            if let Some(text) = read_text_if_indexable(path, self.max_file_bytes) {
                // Re-check budget after read; skip content if we'd blow the cap badly.
                if self.budget_allows_content() {
                    content = Some(text);
                    stored_content = true;
                } else {
                    self.capped.store(true, Ordering::Relaxed);
                }
            }
        } else if !is_dir && !self.budget_allows_content() {
            self.capped.store(true, Ordering::Relaxed);
        }

        {
            let mut writer = self.writer.lock();
            self.remove_path_locked(&mut writer, path);
            let mut document = doc!(
                self.fields.path => path_str.as_str(),
                self.fields.name => name.as_str(),
                self.fields.kind => if is_dir { "dir" } else { "file" },
            );
            if let Some(ref text) = content {
                document.add_text(self.fields.content, text);
            }
            writer
                .add_document(document)
                .map_err(|e| IdeError::other(format!("tantivy add: {e}")))?;
            if commit {
                writer
                    .commit()
                    .map_err(|e| IdeError::other(format!("tantivy commit: {e}")))?;
            }
        }
        if commit {
            self.reader
                .reload()
                .map_err(|e| IdeError::other(format!("tantivy reload: {e}")))?;
        }

        {
            let mut paths = self.paths.write();
            paths.retain(|e| e.path != path);
            paths.push(PathEntry {
                path: path.to_path_buf(),
                name: name.clone(),
                is_dir,
            });
        }

        if is_dir {
            self.dirs_indexed.fetch_add(1, Ordering::Relaxed);
        } else {
            self.files_indexed.fetch_add(1, Ordering::Relaxed);
            if stored_content {
                self.content_indexed.fetch_add(1, Ordering::Relaxed);
            }
        }
        Ok(stored_content)
    }

    pub fn commit(&self) -> IdeResult<()> {
        {
            let mut writer = self.writer.lock();
            writer
                .commit()
                .map_err(|e| IdeError::other(format!("tantivy commit: {e}")))?;
        }
        self.reader
            .reload()
            .map_err(|e| IdeError::other(format!("tantivy reload: {e}")))?;
        // After a full rebuild commit, refresh size-based capped flag.
        if self.index_bytes() >= self.max_index_bytes {
            self.capped.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    pub fn search_paths(
        &self,
        pattern: &str,
        case_insensitive: bool,
        max_results: usize,
    ) -> Vec<IndexPathHit> {
        if pattern.is_empty() || max_results == 0 {
            return Vec::new();
        }
        let needle = if case_insensitive {
            pattern.to_lowercase()
        } else {
            pattern.to_string()
        };
        let mut out = Vec::new();
        for entry in self.paths.read().iter() {
            let name_hay = if case_insensitive {
                entry.name.to_lowercase()
            } else {
                entry.name.clone()
            };
            let path_hay = if case_insensitive {
                entry.path.to_string_lossy().to_lowercase()
            } else {
                entry.path.to_string_lossy().into_owned()
            };
            if name_hay.contains(&needle) || path_hay.contains(&needle) {
                out.push(IndexPathHit {
                    path: entry.path.clone(),
                    name: entry.name.clone(),
                    is_dir: entry.is_dir,
                });
                if out.len() >= max_results {
                    break;
                }
            }
        }
        out
    }

    pub fn search_content(
        &self,
        pattern: &str,
        literal: bool,
        case_insensitive: bool,
        max_results: usize,
    ) -> IdeResult<Vec<IndexContentHit>> {
        if pattern.is_empty() || max_results == 0 {
            return Ok(Vec::new());
        }

        let searcher = self.reader.searcher();
        let tokens: Vec<String> = pattern
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
            .map(|t| {
                if case_insensitive {
                    t.to_lowercase()
                } else {
                    t.to_string()
                }
            })
            .collect();

        let query: Box<dyn Query> = if tokens.is_empty() {
            // No alphanumeric tokens — fall back to a fuzzy match on the raw pattern.
            let term = Term::from_field_text(self.fields.content, pattern);
            Box::new(FuzzyTermQuery::new(term, 1, true))
        } else {
            let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
            for tok in &tokens {
                let term = Term::from_field_text(self.fields.content, tok);
                clauses.push((Occur::Should, Box::new(TermQuery::new(term, IndexRecordOption::Basic))));
            }
            Box::new(BooleanQuery::new(clauses))
        };

        let top = searcher
            .search(&query, &TopDocs::with_limit((max_results * 4).clamp(20, 400)))
            .map_err(|e| IdeError::other(format!("tantivy search: {e}")))?;

        let line_re = build_line_regex(pattern, literal, case_insensitive)?;
        let mut hits = Vec::new();
        for (_score, addr) in top {
            let doc: TantivyDocument = searcher
                .doc(addr)
                .map_err(|e| IdeError::other(format!("tantivy doc: {e}")))?;
            let path = doc
                .get_first(self.fields.path)
                .and_then(|v| v.as_str())
                .map(PathBuf::from)
                .unwrap_or_default();
            let content = doc
                .get_first(self.fields.content)
                .and_then(|v| v.as_str())
                .unwrap_or("");
            for (idx, line) in content.lines().enumerate() {
                if let Some(m) = line_re.find(line) {
                    hits.push(IndexContentHit {
                        path: path.clone(),
                        line_number: (idx as u64) + 1,
                        line: line.to_string(),
                        start: m.start(),
                        end: m.end(),
                    });
                    if hits.len() >= max_results {
                        return Ok(hits);
                    }
                }
            }
        }
        Ok(hits)
    }
}

fn build_line_regex(
    pattern: &str,
    literal: bool,
    case_insensitive: bool,
) -> IdeResult<regex::Regex> {
    let body = if literal {
        regex::escape(pattern)
    } else {
        pattern.to_string()
    };
    let mut builder = regex::RegexBuilder::new(&body);
    builder.case_insensitive(case_insensitive);
    builder
        .build()
        .map_err(|e| IdeError::other(format!("regex: {e}")))
}

/// Manages the background indexer lifecycle for the open workspace.
#[derive(Clone)]
pub struct SearchIndexService {
    bus: EventBus,
    state: Arc<RwLock<ServiceState>>,
    max_index_bytes: u64,
    max_file_bytes: u64,
}

struct ServiceState {
    status: SearchIndexStatus,
    index: Option<Arc<SearchIndex>>,
    generation: u64,
    worker: Option<JoinHandle<()>>,
    event_worker: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
}

impl SearchIndexService {
    pub fn new(bus: EventBus) -> Self {
        Self {
            bus,
            state: Arc::new(RwLock::new(ServiceState {
                status: SearchIndexStatus::default(),
                index: None,
                generation: 0,
                worker: None,
                event_worker: None,
                stop: Arc::new(AtomicBool::new(false)),
            })),
            max_index_bytes: DEFAULT_MAX_INDEX_BYTES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        }
    }

    pub fn with_limits(mut self, max_index_bytes: u64, max_file_bytes: u64) -> Self {
        self.max_index_bytes = max_index_bytes;
        self.max_file_bytes = max_file_bytes;
        self
    }

    pub fn status(&self) -> SearchIndexStatus {
        self.state.read().status.clone()
    }

    pub fn index(&self) -> Option<Arc<SearchIndex>> {
        self.state.read().index.clone()
    }

    pub fn stop(&self) {
        let mut guard = self.state.write();
        guard.stop.store(true, Ordering::SeqCst);
        guard.generation = guard.generation.wrapping_add(1);
        if let Some(handle) = guard.worker.take() {
            drop(guard);
            let _ = handle.join();
            guard = self.state.write();
        }
        if let Some(handle) = guard.event_worker.take() {
            drop(guard);
            let _ = handle.join();
            guard = self.state.write();
        }
        guard.index = None;
        guard.stop = Arc::new(AtomicBool::new(false));
        guard.status = SearchIndexStatus::default();
        self.publish_status(&guard.status);
    }

    /// Start (or restart) background indexing for `root`.
    pub fn start(&self, root: impl AsRef<Path>) {
        self.stop();
        let root = root.as_ref().to_path_buf();
        let generation = {
            let mut guard = self.state.write();
            guard.generation = guard.generation.wrapping_add(1);
            guard.stop = Arc::new(AtomicBool::new(false));
            guard.status = SearchIndexStatus {
                phase: IndexPhase::Indexing,
                root: Some(root.clone()),
                max_index_bytes: self.max_index_bytes,
                ..SearchIndexStatus::default()
            };
            self.publish_status(&guard.status);
            guard.generation
        };

        let bus = self.bus.clone();
        let state = self.state.clone();
        let stop = self.state.read().stop.clone();
        let max_index_bytes = self.max_index_bytes;
        let max_file_bytes = self.max_file_bytes;
        let root_for_events = root.clone();

        let worker = thread::spawn(move || {
            let result = (|| -> IdeResult<Arc<SearchIndex>> {
                let index = Arc::new(SearchIndex::open_or_create(
                    &root,
                    max_index_bytes,
                    max_file_bytes,
                )?);
                index.clear()?;

                let mut pending = 0usize;
                let walker = WalkBuilder::new(&root)
                    .hidden(true)
                    .git_ignore(true)
                    .git_exclude(true)
                    .filter_entry(|e| {
                        let name = e.file_name().to_string_lossy();
                        name != ".customide" && name != ".git"
                    })
                    .build();

                for entry in walker {
                    if stop.load(Ordering::SeqCst) {
                        return Err(IdeError::other("indexing cancelled"));
                    }
                    let Ok(entry) = entry else { continue };
                    let ft = entry.file_type();
                    let Some(ft) = ft else { continue };
                    if !ft.is_file() && !ft.is_dir() {
                        continue;
                    }
                    // Skip the workspace root itself as a "dir" hit noise.
                    if entry.path() == root {
                        continue;
                    }
                    let _ = index.upsert_path(entry.path(), false);
                    pending += 1;
                    if pending >= COMMIT_EVERY {
                        index.commit()?;
                        pending = 0;
                        let phase = if index.is_capped() {
                            IndexPhase::Capped
                        } else {
                            IndexPhase::Indexing
                        };
                        let status = index.snapshot_status(phase, None);
                        {
                            let mut guard = state.write();
                            if guard.generation != generation {
                                return Err(IdeError::other("indexing superseded"));
                            }
                            guard.status = status.clone();
                        }
                        bus.publish(Event::SearchIndexStatus(status));
                    }
                }
                if pending > 0 {
                    index.commit()?;
                }
                Ok(index)
            })();

            match result {
                Ok(index) => {
                    let phase = if index.is_capped() {
                        IndexPhase::Capped
                    } else {
                        IndexPhase::Ready
                    };
                    let msg = if index.is_capped() {
                        Some(
                            "Index size limit reached; path/name kept, content capped. Full scan still runs."
                                .into(),
                        )
                    } else {
                        None
                    };
                    let status = index.snapshot_status(phase, msg);
                    {
                        let mut guard = state.write();
                        if guard.generation != generation {
                            return;
                        }
                        guard.index = Some(index);
                        guard.status = status.clone();
                    }
                    bus.publish(Event::SearchIndexStatus(status));
                    bus.publish(Event::Log {
                        level: LogLevel::Info,
                        message: "search index ready".into(),
                    });
                }
                Err(e) => {
                    let message = e.to_string();
                    if message.contains("cancelled") || message.contains("superseded") {
                        return;
                    }
                    let status = SearchIndexStatus {
                        phase: IndexPhase::Error,
                        root: Some(root),
                        message: Some(message.clone()),
                        max_index_bytes,
                        ..SearchIndexStatus::default()
                    };
                    {
                        let mut guard = state.write();
                        if guard.generation != generation {
                            return;
                        }
                        guard.status = status.clone();
                    }
                    bus.publish(Event::SearchIndexStatus(status));
                    bus.publish(Event::Log {
                        level: LogLevel::Warn,
                        message: format!("search index failed: {message}"),
                    });
                }
            }
        });

        // Event follower: apply incremental updates once index exists.
        let bus2 = self.bus.clone();
        let state2 = self.state.clone();
        let stop2 = self.state.read().stop.clone();
        let root2 = root_for_events;
        let event_worker = thread::spawn(move || {
            let rx = bus2.subscribe();
            while !stop2.load(Ordering::SeqCst) {
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(Event::FileCreated { path }) | Ok(Event::FileModified { path }) => {
                        if !path.starts_with(&root2) || is_index_noise(&path) {
                            continue;
                        }
                        let Some(index) = state2.read().index.clone() else {
                            continue;
                        };
                        let _ = index.upsert_path(&path, true);
                        let phase = if index.is_capped() {
                            IndexPhase::Capped
                        } else {
                            IndexPhase::Ready
                        };
                        let status = index.snapshot_status(phase, None);
                        state2.write().status = status.clone();
                        bus2.publish(Event::SearchIndexStatus(status));
                    }
                    Ok(Event::FileRemoved { path }) => {
                        let Some(index) = state2.read().index.clone() else {
                            continue;
                        };
                        let _ = index.remove_path(&path);
                    }
                    Ok(Event::FileRenamed { from, to }) => {
                        let Some(index) = state2.read().index.clone() else {
                            continue;
                        };
                        let _ = index.remove_path(&from);
                        if to.starts_with(&root2) && !is_index_noise(&to) {
                            let _ = index.upsert_path(&to, true);
                        }
                    }
                    Ok(Event::WorkspaceClosed) => break,
                    Ok(_) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        let mut guard = self.state.write();
        guard.worker = Some(worker);
        guard.event_worker = Some(event_worker);
    }

    fn publish_status(&self, status: &SearchIndexStatus) {
        self.bus
            .publish(Event::SearchIndexStatus(status.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn large_file_indexes_path_only() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let big = root.join("big.txt");
        {
            let mut f = fs::File::create(&big).unwrap();
            let chunk = vec![b'a'; 4096];
            for _ in 0..300 {
                f.write_all(&chunk).unwrap(); // ~1.2MB
            }
            writeln!(f, "needle_unique_xyz").unwrap();
        }
        let small = root.join("small.txt");
        fs::write(&small, "hello needle_unique_xyz world").unwrap();

        let index = SearchIndex::open_or_create(root, DEFAULT_MAX_INDEX_BYTES, 1024).unwrap();
        assert!(!index.upsert_path(&big, true).unwrap()); // no content
        assert!(index.upsert_path(&small, true).unwrap());

        let paths = index.search_paths("big", true, 10);
        assert!(paths.iter().any(|p| p.path.ends_with("big.txt")));

        let content = index
            .search_content("needle_unique_xyz", true, true, 20)
            .unwrap();
        assert!(content.iter().any(|h| h.path.ends_with("small.txt")));
        assert!(!content.iter().any(|h| h.path.ends_with("big.txt")));
    }

    #[test]
    fn customide_dir_is_noise() {
        let p = PathBuf::from("/proj/.customide/search-index/meta.json");
        assert!(is_index_noise(&p));
    }

    #[test]
    fn index_budget_marks_capped() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let index = SearchIndex::open_or_create(root, 8_000, 4096).unwrap();
        for i in 0..40 {
            let p = root.join(format!("f{i}.txt"));
            fs::write(&p, format!("content block {i} {}", "x".repeat(200))).unwrap();
            let _ = index.upsert_path(&p, true);
        }
        // Either capped already or size grew; force check.
        let _ = index.budget_allows_content();
        assert!(index.is_capped() || index.index_bytes() < 8_000);
    }
}
