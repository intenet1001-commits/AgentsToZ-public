use std::{io::{Read, Write}, net::{TcpListener, TcpStream}, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}, thread};

pub fn allowed(origin: &str, url: &str) -> bool {
    ["/fixture/personal", "/fixture/task", "/fixture.js", "/favicon.ico"].iter().any(|path| url == format!("{origin}{path}"))
}
pub struct Server { pub origin: String, pub root: PathBuf, stop: Arc<AtomicBool>, join: Option<thread::JoinHandle<()>> }
impl Server {
    pub fn start() -> Self {
        let root = std::env::temp_dir().join(format!("agentstoz-browser-spike-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let expected_host = listener.local_addr().unwrap().to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let signal = stop.clone();
        let join = thread::spawn(move || while !signal.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => serve(&mut stream, &expected_host),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(std::time::Duration::from_millis(10)),
                Err(_) => break,
            }
        });
        Self { origin, root, stop, join: Some(join) }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.take() { let _ = join.join(); }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn serve(stream: &mut TcpStream, expected_host: &str) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(500)));
    let mut buffer = [0; 4096];
    let Ok(count) = stream.read(&mut buffer) else { return; };
    let request = String::from_utf8_lossy(&buffer[..count]);
    let mut lines = request.lines();
    let first = lines.next().unwrap_or("");
    let headers: Vec<_> = lines.collect();
    if !headers.iter().any(|h| h.eq_ignore_ascii_case(&format!("Host: {expected_host}"))) { return; }
    let (status, mime, body) = match first {
        "GET /fixture/personal HTTP/1.1" => ("200 OK", "text/html; charset=utf-8", page("personal")),
        "GET /fixture/task HTTP/1.1" => ("200 OK", "text/html; charset=utf-8", page("task")),
        "GET /fixture.js HTTP/1.1" => ("200 OK", "application/javascript", include_str!("fixture.js").to_string()),
        "GET /favicon.ico HTTP/1.1" => ("204 No Content", "image/x-icon", String::new()),
        _ => ("404 Not Found", "text/plain", "fixture only".into()),
    };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'\r\n\r\n{body}", body.len());
}
fn page(role: &str) -> String {
    format!(r#"<!doctype html><html lang="ko"><meta charset="utf-8"><title>Fixture</title><style>body{{font:16px system-ui;background:#f6f3ec;color:#282522;margin:16px}}textarea{{box-sizing:border-box;display:block;width:100%;height:120px;font:17px system-ui}}label{{display:block;margin:8px 0}}p{{font-size:13px}}</style><body data-role="{role}"><strong>{role} · 실제 Chromium / 가상 계정</strong><label for="draft">문서 초안</label><textarea id="draft"></textarea><p id="identity"></p><script src="/fixture.js"></script></body></html>"#)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_prefix_and_other_local_services_are_rejected() {
        let origin = "http://127.0.0.1:12345";
        assert!(allowed(origin, &format!("{origin}/fixture/task")));
        for url in ["http://127.0.0.1:3001/api/ports", "http://127.0.0.1:12345.evil.test/fixture/task", "file:///etc/passwd", "tauri://localhost", "https://example.com/"] { assert!(!allowed(origin, url)); }
    }
}
