//! Tiny localhost static file server for the live HTML preview.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::errors::{IdeError, IdeResult};

pub struct PreviewServer {
    root: PathBuf,
    port: u16,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl PreviewServer {
    /// Bind `127.0.0.1:0` and serve files under `root` on a background thread.
    pub fn start(root: PathBuf) -> IdeResult<Self> {
        let root = root
            .canonicalize()
            .map_err(|e| IdeError::InvalidPath(format!("{}: {e}", root.display())))?;
        if !root.is_dir() {
            return Err(IdeError::InvalidPath(root.display().to_string()));
        }

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let serve_root = root.clone();

        let join = std::thread::Builder::new()
            .name("preview-server".into())
            .spawn(move || accept_loop(listener, serve_root, stop_flag))
            .map_err(IdeError::Io)?;

        Ok(Self {
            root,
            port,
            stop,
            join: Some(join),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Absolute `file` path → `http://127.0.0.1:<port>/<rel>` URL.
    pub fn url_for_file(&self, file: &Path) -> IdeResult<String> {
        let file = crate::path_jail::ensure_within_root(&self.root, file)?;
        let rel = file
            .strip_prefix(&self.root)
            .map_err(|_| IdeError::InvalidPath(file.display().to_string()))?;
        let mut url = self.base_url();
        url.push('/');
        let mut first = true;
        for comp in rel.components() {
            let std::path::Component::Normal(os) = comp else {
                continue;
            };
            let seg = os.to_string_lossy();
            if !first {
                url.push('/');
            }
            first = false;
            url.push_str(&percent_encode_path_segment(&seg));
        }
        Ok(url)
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for PreviewServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept_loop(listener: TcpListener, root: PathBuf, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let root = root.clone();
                std::thread::spawn(move || {
                    if let Err(e) = handle_client(stream, &root) {
                        tracing::debug!(target: "h1code::preview", "preview request error: {e}");
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => break,
        }
    }
}

fn handle_client(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();

    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf)?;
    if n == 0 {
        return Ok(());
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = parse_request_path(&req).unwrap_or_else(|| "/".to_string());

    let decoded = percent_decode(&path);
    let rel = decoded.trim_start_matches('/');

    if rel.is_empty() {
        let index = root.join("index.html");
        if index.is_file() {
            return respond_file(&mut stream, &index);
        }
        return respond_status(&mut stream, 404, "text/plain; charset=utf-8", b"Not Found");
    }

    let candidate = root.join(rel);
    // Use path_jail (not canonicalize+starts_with) so a workspace-internal
    // symlink that resolves outside the root is refused.
    let Ok(canon) = crate::path_jail::ensure_within_root(root, &candidate) else {
        return respond_status(&mut stream, 403, "text/plain; charset=utf-8", b"Forbidden");
    };
    if !canon.is_file() {
        return respond_status(&mut stream, 404, "text/plain; charset=utf-8", b"Not Found");
    }
    respond_file(&mut stream, &canon)
}

fn parse_request_path(req: &str) -> Option<String> {
    let line = req.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    if !method.eq_ignore_ascii_case("GET") && !method.eq_ignore_ascii_case("HEAD") {
        return None;
    }
    let target = parts.next()?;
    let path = target.split('?').next().unwrap_or(target);
    Some(path.to_string())
}

fn respond_file(stream: &mut TcpStream, path: &Path) -> std::io::Result<()> {
    let bytes = std::fs::read(path)?;
    let mime = mime_for_path(path);
    respond_status(stream, 200, mime, &bytes)
}

fn respond_status(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    // No Access-Control-Allow-Origin: clients load via iframe/Chrome navigation,
    // not cross-origin fetch. A wildcard would let any page read workspace files.
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push(hex(b >> 4));
                out.push(hex(b & 0xf));
            }
        }
    }
    out
}

fn hex(n: u8) -> char {
    b"0123456789ABCDEF"[n as usize] as char
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpStream;
    use tempfile::tempdir;

    #[test]
    fn serves_html_and_blocks_traversal() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("index.html"), b"<h1>hi</h1>").unwrap();
        std::fs::write(root.join("style.css"), b"body{}").unwrap();

        let server = PreviewServer::start(root.clone()).unwrap();
        let port = server.port();

        let mut stream =
            TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect preview");
        stream
            .write_all(b"GET /index.html HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        assert!(resp.contains("200 OK"));
        assert!(resp.contains("<h1>hi</h1>"));
        assert!(
            !resp.to_ascii_lowercase().contains("access-control-allow-origin"),
            "preview must not emit wildcard CORS (cross-origin fetch of workspace files)"
        );

        let mut stream =
            TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect preview");
        stream
            .write_all(b"GET /../Cargo.toml HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        assert!(resp.contains("403") || resp.contains("404"));

        let url = server.url_for_file(&root.join("style.css")).unwrap();
        assert!(url.ends_with("/style.css"));
        assert!(url.starts_with(&format!("http://127.0.0.1:{port}/")));
    }

    #[test]
    fn responses_omit_cors_allow_origin() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("index.html"), b"INDEX").unwrap();
        let server = PreviewServer::start(root).unwrap();
        let port = server.port();

        let mut stream =
            TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect preview");
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        assert!(resp.contains("INDEX"));
        assert!(
            !resp.to_ascii_lowercase().contains("access-control-allow-origin"),
            "expected no Access-Control-Allow-Origin header, got:\n{resp}"
        );
    }

    #[test]
    fn root_serves_index() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("index.html"), b"INDEX").unwrap();
        let server = PreviewServer::start(root).unwrap();
        let port = server.port();

        let mut stream =
            TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect preview");
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        assert!(resp.contains("INDEX"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_that_resolves_outside_root() {
        let outer = tempdir().unwrap();
        let root = outer.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("index.html"), b"ok").unwrap();

        let secret = outer.path().join("secret.txt");
        std::fs::write(&secret, b"top-secret").unwrap();
        let link = root.join("escape.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let server = PreviewServer::start(root).unwrap();
        let port = server.port();

        let mut stream =
            TcpStream::connect(format!("127.0.0.1:{port}")).expect("connect preview");
        stream
            .write_all(b"GET /escape.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        assert!(
            resp.contains("403"),
            "symlink-out must be forbidden, got:\n{resp}"
        );
        assert!(
            !resp.contains("top-secret"),
            "must not leak symlink target body"
        );
    }
}
