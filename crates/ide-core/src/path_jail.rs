//! Workspace path jail — contain FS paths under an open workspace root.
//!
//! Naive `canonicalize` + `Path::starts_with` is not enough on its own for
//! all FS ops: non-existent write targets can't be fully canonicalized, and
//! symlink parents must be resolved hop-by-hop so a link inside the workspace
//! that points outside cannot be used as a staging prefix.
//!
//! This module walks components, resolves symlinks as they are encountered,
//! and rejects any resolution that leaves the canonical workspace root.

use std::path::{Component, Path, PathBuf};

use crate::errors::{IdeError, IdeResult};

const MAX_SYMLINK_DEPTH: usize = 64;

/// Resolve `user_path` to a path proven to lie within canonical `root`.
///
/// - Absolute paths are checked as given; relative paths are joined to `root`.
/// - `..` cannot climb above `root`.
/// - Symlinks are followed; a link (or chain) that escapes `root` is rejected.
/// - Non-existent leaf paths are allowed when every existing prefix stays inside
///   `root` (needed for create/write).
pub fn ensure_within_root(root: &Path, user_path: &Path) -> IdeResult<PathBuf> {
    let root = dunce_canonicalize(root).map_err(|e| {
        IdeError::InvalidPath(format!("workspace root {}: {e}", root.display()))
    })?;
    if !root.is_dir() {
        return Err(IdeError::InvalidPath(format!(
            "workspace root is not a directory: {}",
            root.display()
        )));
    }

    let abs = if user_path.is_absolute() {
        user_path.to_path_buf()
    } else {
        root.join(user_path)
    };

    let resolved = resolve_beneath(&root, &abs, 0)?;
    // Final path must be inside the jail (ancestors of root are only tolerated
    // as intermediate walk states for absolute paths).
    if !is_within(&root, &resolved) {
        return Err(outside(&root, user_path));
    }
    Ok(resolved)
}

fn is_within(root: &Path, path: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// During a component walk of an absolute path, ancestors of `root` (e.g. `/`
/// and `/tmp` when root is `/tmp/ws`) are valid prefixes. Anything else must
/// already be inside the jail.
fn is_allowed_prefix(root: &Path, path: &Path) -> bool {
    path.as_os_str().is_empty() || is_within(root, path) || root.starts_with(path)
}

fn outside(root: &Path, path: &Path) -> IdeError {
    IdeError::InvalidPath(format!(
        "path {} is outside workspace {}",
        path.display(),
        root.display()
    ))
}

fn dunce_canonicalize(p: &Path) -> std::io::Result<PathBuf> {
    let abs = std::fs::canonicalize(p)?;
    Ok(strip_unc(abs))
}

fn strip_unc(abs: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = abs.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    abs
}

fn resolve_beneath(root: &Path, path: &Path, depth: usize) -> IdeResult<PathBuf> {
    if depth > MAX_SYMLINK_DEPTH {
        return Err(IdeError::InvalidPath("symlink cycle detected".into()));
    }

    let mut current = PathBuf::new();
    let mut comps = path.components();

    match comps.next() {
        Some(Component::Prefix(prefix)) => {
            current.push(prefix.as_os_str());
            if let Some(Component::RootDir) = comps.clone().next() {
                comps.next();
                current.push(Component::RootDir.as_os_str());
            }
        }
        Some(Component::RootDir) => {
            current.push(Component::RootDir.as_os_str());
        }
        Some(first) => {
            // Relative remainder — interpret against the jail root.
            return push_components(
                root,
                root.to_path_buf(),
                std::iter::once(first).chain(comps),
                depth,
            );
        }
        None => return Err(IdeError::InvalidPath("empty path".into())),
    }

    push_components(root, current, comps, depth)
}

fn push_components<'a>(
    root: &Path,
    mut current: PathBuf,
    comps: impl Iterator<Item = Component<'a>>,
    depth: usize,
) -> IdeResult<PathBuf> {
    for comp in comps {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !current.pop() {
                    return Err(outside(root, Path::new("..")));
                }
            }
            Component::Normal(seg) => {
                current.push(seg);
                current = advance_component(root, &current, depth)?;
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(IdeError::InvalidPath(
                    "unexpected absolute component in path".into(),
                ));
            }
        }
    }

    if !is_allowed_prefix(root, &current) {
        return Err(outside(root, &current));
    }
    Ok(current)
}

/// After appending one normal component: follow symlinks / canonicalize when
/// the path exists, always requiring the result to stay under `root` (or on
/// the ancestor chain while still walking toward it).
fn advance_component(root: &Path, path: &Path, depth: usize) -> IdeResult<PathBuf> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !is_allowed_prefix(root, path) {
                return Err(outside(root, path));
            }
            return Ok(path.to_path_buf());
        }
        Err(e) => return Err(e.into()),
    };

    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(path)?;
        let joined = if target.is_absolute() {
            target
        } else {
            path.parent()
                .map(|p| p.join(&target))
                .unwrap_or(target)
        };
        let resolved = resolve_beneath(root, &joined, depth + 1)?;
        if !is_allowed_prefix(root, &resolved) {
            return Err(outside(root, path));
        }
        return Ok(resolved);
    }

    // Existing real file/dir: canonicalize so subsequent joins use the true path.
    let canon = dunce_canonicalize(path)?;
    if !is_allowed_prefix(root, &canon) {
        return Err(outside(root, path));
    }
    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn allows_path_inside_workspace() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let file = root.join("src").join("main.py");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "print(1)\n").unwrap();

        let got = ensure_within_root(root, &file).unwrap();
        assert_eq!(got, dunce_canonicalize(&file).unwrap());
    }

    #[test]
    fn allows_nonexistent_leaf_inside_workspace() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let file = root.join("new_file.txt");
        let got = ensure_within_root(root, &file).unwrap();
        assert!(got.ends_with("new_file.txt"));
        assert!(is_within(&dunce_canonicalize(root).unwrap(), &got));
    }

    fn nested_workspace() -> (tempfile::TempDir, PathBuf) {
        let outer = tempdir().unwrap();
        let root = outer.path().join("workspace");
        fs::create_dir(&root).unwrap();
        (outer, root)
    }

    #[test]
    fn rejects_parent_traversal() {
        let (outer, root) = nested_workspace();
        fs::write(root.join("inside.txt"), "ok").unwrap();

        // Sibling of the workspace, still under the outer temp dir.
        let outside_file = outer.path().join("outside-secret.txt");
        fs::write(&outside_file, "secret").unwrap();

        let attack = root.join("..").join("outside-secret.txt");
        let err = ensure_within_root(&root, &attack).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("outside workspace"),
            "expected outside-workspace error, got: {msg}"
        );
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let (_outer, root) = nested_workspace();
        let err = ensure_within_root(&root, Path::new("/etc/passwd")).unwrap_err();
        assert!(err.to_string().contains("outside workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_pointing_outside_workspace() {
        let (outer, root) = nested_workspace();
        fs::write(root.join("inside.txt"), "ok").unwrap();

        let outside = outer.path().join("jail-escape-target.txt");
        fs::write(&outside, "secret").unwrap();

        let link = root.join("escape");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let err = ensure_within_root(&root, &link).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("outside workspace"),
            "expected symlink-out rejection, got: {msg}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_write_through_symlink_directory_outside() {
        let (outer, root) = nested_workspace();
        let outside_dir = outer.path().join("jail-escape-dir");
        fs::create_dir_all(&outside_dir).unwrap();

        let link = root.join("out_dir");
        std::os::unix::fs::symlink(&outside_dir, &link).unwrap();

        let attack = link.join("planted.txt");
        let err = ensure_within_root(&root, &attack).unwrap_err();
        assert!(err.to_string().contains("outside workspace"));
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_pointing_inside_workspace() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let real = root.join("real.txt");
        fs::write(&real, "hello").unwrap();
        let link = root.join("alias.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let got = ensure_within_root(root, &link).unwrap();
        assert_eq!(got, dunce_canonicalize(&real).unwrap());
    }
}
