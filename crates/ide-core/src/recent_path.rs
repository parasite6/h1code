//! Unjailed existence checks for recent-project folders.
//!
//! Recent projects are loaded before any workspace is open. Using workspace-jailed
//! FS IPC for prune incorrectly treats `NoWorkspace` as "path missing" and wipes
//! the saved list. These helpers check the filesystem directly and distinguish
//! missing paths from inaccessible / ambiguous errors.

use std::path::Path;

/// Outcome of checking whether a recent-project path is still a usable folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecentPathStatus {
    /// Absolute path exists and is a directory — keep.
    PresentDir,
    /// Path is absent, not a directory, empty, or not absolute — safe to drop.
    Missing,
    /// Could not determine (permissions, IO, …) — keep (fail closed).
    Inaccessible(String),
}

/// Check a recent-project folder path without requiring an open workspace.
pub fn check_recent_project_dir(path: &str) -> RecentPathStatus {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return RecentPathStatus::Missing;
    }
    let p = Path::new(trimmed);
    if !p.is_absolute() {
        return RecentPathStatus::Missing;
    }
    match std::fs::metadata(p) {
        Ok(meta) if meta.is_dir() => RecentPathStatus::PresentDir,
        Ok(_) => RecentPathStatus::Missing,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => RecentPathStatus::Missing,
        Err(e) => RecentPathStatus::Inaccessible(e.to_string()),
    }
}

/// Whether prune should retain this entry. Jail/NoWorkspace must never map here
/// as Missing — callers must use [`check_recent_project_dir`], not jailed FS IPC.
pub fn keep_recent_project(status: &RecentPathStatus) -> bool {
    !matches!(status, RecentPathStatus::Missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn present_directory_is_kept() {
        let dir = tempdir().unwrap();
        let status = check_recent_project_dir(dir.path().to_str().unwrap());
        assert_eq!(status, RecentPathStatus::PresentDir);
        assert!(keep_recent_project(&status));
    }

    #[test]
    fn missing_directory_is_dropped() {
        let dir = tempdir().unwrap();
        let gone = dir.path().join("does-not-exist");
        let status = check_recent_project_dir(gone.to_str().unwrap());
        assert_eq!(status, RecentPathStatus::Missing);
        assert!(!keep_recent_project(&status));
    }

    #[test]
    fn file_path_is_treated_as_missing_for_recent_folder() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("not-a-folder.txt");
        fs::write(&file, "x").unwrap();
        let status = check_recent_project_dir(file.to_str().unwrap());
        assert_eq!(status, RecentPathStatus::Missing);
        assert!(!keep_recent_project(&status));
    }

    #[test]
    fn relative_and_empty_paths_are_dropped() {
        assert_eq!(check_recent_project_dir(""), RecentPathStatus::Missing);
        assert_eq!(check_recent_project_dir("   "), RecentPathStatus::Missing);
        assert_eq!(
            check_recent_project_dir("relative/path"),
            RecentPathStatus::Missing
        );
        assert!(!keep_recent_project(&RecentPathStatus::Missing));
    }

    #[test]
    fn inaccessible_status_is_kept_fail_closed() {
        let status = RecentPathStatus::Inaccessible("permission denied".into());
        assert!(keep_recent_project(&status));
    }

    #[test]
    fn deleted_after_create_is_missing_not_inaccessible() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("soon-gone");
        fs::create_dir(&nested).unwrap();
        assert_eq!(
            check_recent_project_dir(nested.to_str().unwrap()),
            RecentPathStatus::PresentDir
        );
        fs::remove_dir(&nested).unwrap();
        assert_eq!(
            check_recent_project_dir(nested.to_str().unwrap()),
            RecentPathStatus::Missing
        );
    }
}
