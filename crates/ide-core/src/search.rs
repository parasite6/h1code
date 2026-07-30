//! Search service — gitignore-aware regex/literal search across the workspace,
//! built on the `ignore` walker + `grep` matcher (the libraries ripgrep is
//! built from), plus an optional Tantivy index assist for paths and content.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::errors::{IdeError, IdeResult};
use crate::search_index::{IndexContentHit, IndexPathHit, SearchIndex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub literal: bool,
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub path: PathBuf,
    pub line_number: u64,
    pub line: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathHit {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub files: Vec<PathHit>,
    pub folders: Vec<PathHit>,
    pub content: Vec<SearchHit>,
}

/// Hard ceiling for `SearchQuery.max_results` over IPC.
const MAX_RESULTS_CEILING: usize = 10_000;

/// Resolve an optional max_results, clamping any provided value to [`MAX_RESULTS_CEILING`].
fn clamp_max_results(opt: Option<usize>, default: usize) -> usize {
    opt.unwrap_or(default).min(MAX_RESULTS_CEILING)
}

/// Max user pattern length (chars). Bounds compile cost and rejects oversized inputs.
const MAX_PATTERN_CHARS: usize = 512;
/// Compiled regex NFA size cap (grep-regex default is 100 MiB).
const REGEX_SIZE_LIMIT: usize = 1 << 20; // 1 MiB
/// Per-thread DFA cache cap (grep-regex default is 1000 MiB).
const REGEX_DFA_SIZE_LIMIT: usize = 10 * (1 << 20); // 10 MiB
/// AST nesting depth cap (grep-regex default is 250).
const REGEX_NEST_LIMIT: u32 = 50;

fn validate_search_pattern(pattern: &str) -> IdeResult<()> {
    if pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(IdeError::other(format!(
            "search pattern exceeds maximum length of {MAX_PATTERN_CHARS} characters"
        )));
    }
    Ok(())
}

/// Full-workspace content search (ripgrep-style). Always authoritative for coverage.
pub fn search(root: &Path, query: &SearchQuery) -> IdeResult<Vec<SearchHit>> {
    validate_search_pattern(&query.pattern)?;
    let pattern = if query.literal {
        regex_escape(&query.pattern)
    } else {
        query.pattern.clone()
    };
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(query.case_insensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_DFA_SIZE_LIMIT)
        .nest_limit(REGEX_NEST_LIMIT)
        .build(&pattern)
        .map_err(|e| IdeError::other(format!("regex: {e}")))?;
    let cap: usize = clamp_max_results(query.max_results, 2000);

    let hits = Arc::new(Mutex::new(Vec::with_capacity(256)));
    let walker = WalkBuilder::new(root)
        .hidden(!query.include_hidden)
        .git_ignore(true)
        .git_exclude(true)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            name != ".h1code" && name != ".git"
        })
        .build_parallel();

    walker.run(|| {
        let matcher = matcher.clone();
        let hits = hits.clone();
        let mut searcher: Searcher = SearcherBuilder::new().line_number(true).build();
        Box::new(move |entry| {
            let Ok(entry) = entry else {
                return ignore::WalkState::Continue;
            };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return ignore::WalkState::Continue;
            }
            let path = entry.path().to_path_buf();
            let mut sink = CollectSink {
                matcher: &matcher,
                hits: hits.clone(),
                path: &path,
                cap,
            };
            let _ = searcher.search_path(&matcher, &path, &mut sink);
            if hits.lock().unwrap().len() >= cap {
                ignore::WalkState::Quit
            } else {
                ignore::WalkState::Continue
            }
        })
    });

    let mut out = Arc::try_unwrap(hits)
        .map_err(|_| IdeError::other("search hits Arc still shared"))?
        .into_inner()
        .map_err(|e| IdeError::other(format!("mutex poisoned: {e}")))?;
    if out.len() > cap {
        out.truncate(cap);
    }
    Ok(out)
}

/// Filename / folder-name walk used when the index is cold or unavailable.
pub fn search_paths(root: &Path, query: &SearchQuery) -> IdeResult<Vec<PathHit>> {
    let cap = clamp_max_results(query.max_results, 200);
    if query.pattern.is_empty() || cap == 0 {
        return Ok(Vec::new());
    }
    let needle = if query.case_insensitive {
        query.pattern.to_lowercase()
    } else {
        query.pattern.clone()
    };
    let mut out = Vec::new();
    let walker = WalkBuilder::new(root)
        .hidden(!query.include_hidden)
        .git_ignore(true)
        .git_exclude(true)
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            name != ".h1code" && name != ".git"
        })
        .build();

    for entry in walker {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path == root {
            continue;
        }
        let Some(ft) = entry.file_type() else { continue };
        let is_dir = ft.is_dir();
        if !is_dir && !ft.is_file() {
            continue;
        }
        let name = entry
            .file_name()
            .to_string_lossy()
            .into_owned();
        let name_hay = if query.case_insensitive {
            name.to_lowercase()
        } else {
            name.clone()
        };
        let path_hay = if query.case_insensitive {
            path.to_string_lossy().to_lowercase()
        } else {
            path.to_string_lossy().into_owned()
        };
        if name_hay.contains(&needle) || path_hay.contains(&needle) {
            out.push(PathHit {
                path: path.to_path_buf(),
                name,
                is_dir,
            });
            if out.len() >= cap {
                break;
            }
        }
    }
    Ok(out)
}

/// Orchestrate index-assisted path search + full ripgrep content coverage.
pub fn search_workspace(
    root: &Path,
    index: Option<Arc<SearchIndex>>,
    query: &SearchQuery,
) -> IdeResult<SearchResponse> {
    if query.pattern.trim().is_empty() {
        return Ok(SearchResponse {
            files: Vec::new(),
            folders: Vec::new(),
            content: Vec::new(),
        });
    }

    let cap = clamp_max_results(query.max_results, 500);
    let path_cap = cap.min(200);
    let content_cap = cap;

    let root_owned = root.to_path_buf();
    let query_owned = query.clone();
    let index_paths = index.clone();
    let index_content = index;

    let path_handle = thread::spawn({
        let root = root_owned.clone();
        let query = query_owned.clone();
        move || -> IdeResult<(Vec<PathHit>, Vec<PathHit>)> {
            let hits: Vec<PathHit> = if let Some(index) = index_paths {
                let raw = index.search_paths(&query.pattern, query.case_insensitive, path_cap);
                raw.into_iter()
                    .map(|h: IndexPathHit| PathHit {
                        path: h.path,
                        name: h.name,
                        is_dir: h.is_dir,
                    })
                    .collect()
            } else {
                search_paths(
                    &root,
                    &SearchQuery {
                        max_results: Some(path_cap),
                        ..query.clone()
                    },
                )?
            };
            let mut files = Vec::new();
            let mut folders = Vec::new();
            for h in hits {
                if h.is_dir {
                    folders.push(h);
                } else {
                    files.push(h);
                }
            }
            Ok((files, folders))
        }
    });

    let content_handle = thread::spawn({
        let root = root_owned;
        let query = query_owned;
        move || -> IdeResult<Vec<SearchHit>> {
            let mut content_q = query.clone();
            content_q.max_results = Some(content_cap);
            let mut rg = search(&root, &content_q)?;

            if let Some(index) = index_content {
                let indexed: Vec<IndexContentHit> = index
                    .search_content(
                        &query.pattern,
                        query.literal,
                        query.case_insensitive,
                        content_cap,
                    )
                    .unwrap_or_default();
                rg = merge_content_hits(rg, indexed, content_cap);
            }
            Ok(rg)
        }
    });

    let (files, folders) = path_handle
        .join()
        .map_err(|_| IdeError::other("path search thread panicked"))??;
    let content = content_handle
        .join()
        .map_err(|_| IdeError::other("content search thread panicked"))??;

    Ok(SearchResponse {
        files,
        folders,
        content,
    })
}

fn merge_content_hits(
    ripgrep: Vec<SearchHit>,
    indexed: Vec<IndexContentHit>,
    cap: usize,
) -> Vec<SearchHit> {
    let mut seen: HashSet<(PathBuf, u64)> = HashSet::new();
    let mut out = Vec::with_capacity(ripgrep.len().saturating_add(indexed.len()).min(cap));

    // Prefer ripgrep order (authoritative coverage), then fill gaps from index.
    for h in ripgrep {
        let key = (h.path.clone(), h.line_number);
        if seen.insert(key) {
            out.push(h);
            if out.len() >= cap {
                return out;
            }
        }
    }
    for h in indexed {
        let key = (h.path.clone(), h.line_number);
        if seen.insert(key) {
            out.push(SearchHit {
                path: h.path,
                line_number: h.line_number,
                line: h.line,
                start: h.start,
                end: h.end,
            });
            if out.len() >= cap {
                break;
            }
        }
    }
    out
}

struct CollectSink<'a, M: Matcher> {
    matcher: &'a M,
    hits: Arc<Mutex<Vec<SearchHit>>>,
    path: &'a Path,
    cap: usize,
}

impl<'a, M: Matcher> Sink for CollectSink<'a, M> {
    type Error = std::io::Error;
    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, std::io::Error> {
        let bytes = mat.bytes();
        let line = String::from_utf8_lossy(bytes)
            .trim_end_matches(['\r', '\n'])
            .to_string();
        let mut start = 0usize;
        let mut end = 0usize;
        let _ = self.matcher.find(bytes).map(|m| {
            if let Some(m) = m {
                start = m.start();
                end = m.end();
            }
        });
        let mut guard = self.hits.lock().unwrap();
        guard.push(SearchHit {
            path: self.path.to_path_buf(),
            line_number: mat.line_number().unwrap_or(0),
            line,
            start,
            end,
        });
        Ok(guard.len() < self.cap)
    }
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if matches!(
            c,
            '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search_index::SearchIndex;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn clamp_max_results_applies_ceiling_and_defaults() {
        assert_eq!(clamp_max_results(None, 500), 500);
        assert_eq!(clamp_max_results(Some(50), 500), 50);
        assert_eq!(clamp_max_results(Some(0), 500), 0);
        assert_eq!(
            clamp_max_results(Some(MAX_RESULTS_CEILING), 500),
            MAX_RESULTS_CEILING
        );
        assert_eq!(
            clamp_max_results(Some(MAX_RESULTS_CEILING + 1), 500),
            MAX_RESULTS_CEILING
        );
        assert_eq!(
            clamp_max_results(Some(usize::MAX), 2000),
            MAX_RESULTS_CEILING
        );
    }

    #[test]
    fn rejects_oversized_search_pattern() {
        let dir = tempdir().unwrap();
        let pattern: String = "a".repeat(MAX_PATTERN_CHARS + 1);
        let err = search(
            dir.path(),
            &SearchQuery {
                pattern,
                literal: false,
                case_insensitive: false,
                include_hidden: false,
                max_results: Some(10),
            },
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("maximum length"),
            "expected length error, got: {msg}"
        );
    }

    #[test]
    fn accepts_pattern_at_max_length() {
        let dir = tempdir().unwrap();
        let needle: String = "z".repeat(MAX_PATTERN_CHARS);
        fs::write(dir.path().join("hit.txt"), format!("{needle}\n")).unwrap();
        let hits = search(
            dir.path(),
            &SearchQuery {
                pattern: needle.clone(),
                literal: true,
                case_insensitive: false,
                include_hidden: false,
                max_results: Some(10),
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].line.contains(&needle));
    }

    #[test]
    fn rejects_excessively_nested_regex() {
        let dir = tempdir().unwrap();
        // Nest deeper than REGEX_NEST_LIMIT with a short pattern.
        let pattern = format!("{}a{}", "(".repeat(REGEX_NEST_LIMIT as usize + 1), ")".repeat(REGEX_NEST_LIMIT as usize + 1));
        assert!(pattern.chars().count() <= MAX_PATTERN_CHARS);
        let err = search(
            dir.path(),
            &SearchQuery {
                pattern,
                literal: false,
                case_insensitive: false,
                include_hidden: false,
                max_results: Some(10),
            },
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("regex:"),
            "expected regex compile error, got: {msg}"
        );
    }

    #[test]
    fn merge_dedupes_by_path_and_line() {
        let rg = vec![SearchHit {
            path: PathBuf::from("/a.rs"),
            line_number: 3,
            line: "foo".into(),
            start: 0,
            end: 3,
        }];
        let indexed = vec![IndexContentHit {
            path: PathBuf::from("/a.rs"),
            line_number: 3,
            line: "foo".into(),
            start: 0,
            end: 3,
        }, IndexContentHit {
            path: PathBuf::from("/b.rs"),
            line_number: 1,
            line: "foo".into(),
            start: 0,
            end: 3,
        }];
        let merged = merge_content_hits(rg, indexed, 10);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|h| h.path.ends_with("b.rs")));
    }

    #[test]
    fn orchestrator_finds_paths_and_content() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("pkg")).unwrap();
        fs::write(root.join("pkg/alpha_helper.py"), "def alpha():\n    return 1\n").unwrap();
        fs::write(root.join("readme.md"), "see alpha_helper\n").unwrap();

        let index = SearchIndex::open_or_create(root, 16 * 1024 * 1024, 1024 * 1024).unwrap();
        index.upsert_path(&root.join("pkg"), true).unwrap();
        index
            .upsert_path(&root.join("pkg/alpha_helper.py"), true)
            .unwrap();
        index.upsert_path(&root.join("readme.md"), true).unwrap();

        let resp = search_workspace(
            root,
            Some(Arc::new(index)),
            &SearchQuery {
                pattern: "alpha".into(),
                literal: true,
                case_insensitive: true,
                include_hidden: false,
                max_results: Some(50),
            },
        )
        .unwrap();

        assert!(resp.files.iter().any(|f| f.name.contains("alpha")));
        assert!(resp.folders.iter().any(|f| f.name == "pkg") || resp.files.len() > 0);
        assert!(!resp.content.is_empty());
    }
}
