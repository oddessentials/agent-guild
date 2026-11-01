//! Exits with a code other than 0 only before reading stdin: the agent-guild-report launchers then run the Node.js
//! reporter in its place, with the event still unread.

use std::io::{self, IsTerminal, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::ExitCode;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);
const MAX_ANSWER: usize = 1024 * 1024;
const USAGE: &str =
    "Usage: agent-guild-report --hook [--event NAME]   (reads a coding tool's hook event JSON from stdin)";

#[derive(Debug, PartialEq)]
struct Args {
    event: Option<String>,
}

fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Option<Args> {
    let mut hook = false;
    let mut event = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--hook" | "--claude-hook" => hook = true,
            "--event" => event = Some(args.next()?),
            _ => event = Some(arg.strip_prefix("--event=")?.to_string()),
        }
    }
    hook.then_some(Args { event })
}

fn main() -> ExitCode {
    let Some(args) = parse_args(std::env::args().skip(1)) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let (url, session, token) = (
        var("AGENT_GUILD_URL"),
        var("AGENT_GUILD_SESSION_ID"),
        var("AGENT_GUILD_REPORT_TOKEN"),
    );
    let event = read_stdin();
    let (Some(url), Some(session), Some(token)) = (url, session.as_deref(), token) else {
        if session.is_some() {
            eprintln!(
                "agent-guild-report: the session report token is missing; the tool may have removed AGENT_GUILD_REPORT_TOKEN from the environment"
            );
        }
        return ExitCode::SUCCESS;
    };
    if !starts_like_object(&event) {
        return ExitCode::SUCCESS;
    }
    let reporting = std::env::var("AGENT_GUILD_REPORTING").unwrap_or_default();
    match post(&url, session, &token, args.event.as_deref(), &reporting, &event) {
        Ok(answer) if (200..300).contains(&answer.status) => {
            if answer.body.contains("\"errors\"") {
                eprintln!("agent-guild-report: {}", answer.body.trim());
            }
        }
        Ok(answer) => eprintln!("agent-guild-report: HTTP {}: {}", answer.status, answer.body.trim()),
        Err(message) => eprintln!("agent-guild-report: {message}"),
    }
    ExitCode::SUCCESS
}

fn read_stdin() -> Vec<u8> {
    let stdin = io::stdin();
    let mut event = Vec::new();
    if !stdin.is_terminal() {
        let _ = stdin.lock().read_to_end(&mut event);
    }
    event
}

fn starts_like_object(bytes: &[u8]) -> bool {
    bytes.iter().find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r')) == Some(&b'{')
}

#[derive(Debug, PartialEq)]
struct Target {
    authority: String,
    base: String,
}

impl Target {
    fn parse(url: &str) -> Option<Target> {
        let rest = url.strip_prefix("http://")?;
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host_chars = |byte: u8| byte.is_ascii_alphanumeric() || b"-._:[]".contains(&byte);
        if authority.is_empty() || !authority.bytes().all(host_chars) {
            return None;
        }
        let path = path.trim_end_matches('/');
        if !path
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'?' && byte != b'#')
        {
            return None;
        }
        let base = if path.is_empty() {
            String::new()
        } else {
            format!("/{path}")
        };
        Some(Target {
            authority: authority.to_string(),
            base,
        })
    }

    fn socket_authority(&self) -> String {
        let host_end = self.authority.rfind(']').map_or(0, |at| at + 1);
        if self.authority[host_end..].contains(':') {
            self.authority.clone()
        } else {
            format!("{}:80", self.authority)
        }
    }
}

fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[derive(Debug, PartialEq)]
struct Answer {
    status: u16,
    body: String,
}

fn request(
    target: &Target,
    session: &str,
    token: &str,
    event: Option<&str>,
    reporting: &str,
    body: &[u8],
) -> Result<Vec<u8>, String> {
    if session.is_empty()
        || session.len() > 64
        || !session.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("AGENT_GUILD_SESSION_ID is not an Agent Guild session id".into());
    }
    if !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("AGENT_GUILD_REPORT_TOKEN is not a report token".into());
    }
    let mut path = format!(
        "{}/api/v1/sessions/{session}/hook?reporting={}",
        target.base,
        encode(reporting)
    );
    if let Some(event) = event {
        path.push_str("&event=");
        path.push_str(&encode(event));
    }
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Agent-Guild-Report-Token: {token}\r\nConnection: close\r\n\r\n",
        target.authority,
        body.len(),
    );
    let mut message = Vec::with_capacity(head.len() + body.len());
    message.extend_from_slice(head.as_bytes());
    message.extend_from_slice(body);
    Ok(message)
}

fn post(
    url: &str,
    session: &str,
    token: &str,
    event: Option<&str>,
    reporting: &str,
    body: &[u8],
) -> Result<Answer, String> {
    let target = Target::parse(url).ok_or_else(|| format!("AGENT_GUILD_URL is not an http:// address: {url}"))?;
    let message = request(&target, session, token, event, reporting, body)?;
    let mut stream = connect(&target)?;
    stream.write_all(&message).map_err(|err| describe(&err))?;
    read_answer(&mut stream).map_err(|err| describe(&err))
}

fn connect(target: &Target) -> Result<TcpStream, String> {
    let unreachable =
        |err: &io::Error| format!("could not reach the manager at {}: {}", target.authority, describe(err));
    let addresses = target
        .socket_authority()
        .to_socket_addrs()
        .map_err(|err| unreachable(&err))?;
    let mut last = io::Error::new(io::ErrorKind::NotFound, "no address");
    for address in addresses {
        match TcpStream::connect_timeout(&address, TIMEOUT) {
            Ok(stream) => {
                stream
                    .set_read_timeout(Some(TIMEOUT))
                    .map_err(|err| unreachable(&err))?;
                stream
                    .set_write_timeout(Some(TIMEOUT))
                    .map_err(|err| unreachable(&err))?;
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(err) => last = err,
        }
    }
    Err(unreachable(&last))
}

fn describe(err: &io::Error) -> String {
    match err.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => "the manager did not answer in time".into(),
        _ => err.to_string(),
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn read_answer<R: Read>(stream: &mut R) -> io::Result<Answer> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 8192];
    let body_start = loop {
        if let Some(at) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break at + 4;
        }
        if data.len() > 64 * 1024 {
            return Err(invalid("the manager's answer has no end to its headers"));
        }
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(invalid("the manager closed the connection without answering"));
        }
        data.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&data[..body_start]).into_owned();
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .filter(|_| head.starts_with("HTTP/1."))
        .ok_or_else(|| invalid("the manager's answer is not HTTP"))?;
    let length = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });
    let limit = length.unwrap_or(MAX_ANSWER).min(MAX_ANSWER);
    let mut body = data.split_off(body_start);
    while body.len() < limit {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => body.extend_from_slice(&chunk[..read]),
        }
    }
    body.truncate(limit);
    Ok(Answer {
        status,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn args(list: &[&str]) -> Option<Args> {
        parse_args(list.iter().map(|arg| arg.to_string()))
    }

    #[test]
    fn takes_only_the_hook_forms() {
        assert_eq!(args(&["--hook"]), Some(Args { event: None }));
        assert_eq!(args(&["--claude-hook"]), Some(Args { event: None }));
        assert_eq!(
            args(&["--hook", "--event", "Stop"]),
            Some(Args {
                event: Some("Stop".into())
            })
        );
        assert_eq!(
            args(&["--hook", "--event=PreInvocation"]),
            Some(Args {
                event: Some("PreInvocation".into())
            })
        );
        assert_eq!(
            args(&["--event", "Stop", "--hook"]),
            Some(Args {
                event: Some("Stop".into())
            })
        );
        assert_eq!(args(&[]), None);
        assert_eq!(args(&["--event", "Stop"]), None);
        assert_eq!(args(&["--hook", "--event"]), None);
        assert_eq!(args(&["--hook", "extra"]), None);
        assert_eq!(args(&["--model", "gpt-5"]), None);
        assert_eq!(args(&["--claude-statusline"]), None);
        assert_eq!(args(&["--help"]), None);
    }

    #[test]
    fn sends_only_what_starts_like_a_json_object() {
        assert!(starts_like_object(b" \r\n\t{\"hook_event_name\":\"Stop\"}"));
        assert!(!starts_like_object(b""));
        assert!(!starts_like_object(b"[]"));
        assert!(!starts_like_object(b"null"));
        assert!(
            !starts_like_object(b"\xef\xbb\xbf{}"),
            "JSON.parse refuses a byte order mark, and so does the reporter"
        );
    }

    #[test]
    fn reads_the_manager_address() {
        assert_eq!(
            Target::parse("http://127.0.0.1:47821"),
            Some(Target {
                authority: "127.0.0.1:47821".into(),
                base: String::new()
            })
        );
        assert_eq!(
            Target::parse("http://localhost:47821/"),
            Some(Target {
                authority: "localhost:47821".into(),
                base: String::new()
            })
        );
        assert_eq!(
            Target::parse("http://[::1]:5/guild/"),
            Some(Target {
                authority: "[::1]:5".into(),
                base: "/guild".into()
            })
        );
        assert_eq!(Target::parse("https://127.0.0.1:47821"), None);
        assert_eq!(Target::parse("http://"), None);
        assert_eq!(Target::parse("http://127.0.0.1:1\r\nX-Injected: yes"), None);
        assert_eq!(Target::parse("http://127.0.0.1:1/a b"), None);
        assert_eq!(
            Target::parse("http://127.0.0.1:1").unwrap().socket_authority(),
            "127.0.0.1:1"
        );
        assert_eq!(
            Target::parse("http://example.test").unwrap().socket_authority(),
            "example.test:80"
        );
        assert_eq!(Target::parse("http://[::1]").unwrap().socket_authority(), "[::1]:80");
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(encode("PreInvocation"), "PreInvocation");
        assert_eq!(encode(""), "");
        assert_eq!(encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
    }

    #[test]
    fn builds_the_hook_request() {
        let target = Target::parse("http://127.0.0.1:47821").unwrap();
        let message = request(&target, "0123abcd", "00ff", Some("Stop Now"), "claude", b"{}").unwrap();
        assert_eq!(
            String::from_utf8(message).unwrap(),
            "POST /api/v1/sessions/0123abcd/hook?reporting=claude&event=Stop%20Now HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nContent-Type: application/json\r\nContent-Length: 2\r\nX-Agent-Guild-Report-Token: 00ff\r\nConnection: close\r\n\r\n{}"
        );
        assert!(
            request(&target, "0123ABCD", "t", None, "", b"{}").is_err(),
            "a session id is lowercase hex"
        );
        assert!(request(&target, "01/../x", "t", None, "", b"{}").is_err());
        assert!(request(&target, "01", "t\r\nX-Injected: yes", None, "", b"{}").is_err());
        assert!(request(&target, &"a".repeat(65), "t", None, "", b"{}").is_err());
    }

    #[test]
    fn reads_the_answer() {
        let answer = |raw: &[u8]| read_answer(&mut &raw[..]);
        assert_eq!(
            answer(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}trailing").unwrap(),
            Answer {
                status: 200,
                body: "{\"ok\":true}".into()
            }
        );
        assert_eq!(
            answer(b"HTTP/1.1 409 Conflict\r\ncontent-length: 2\r\n\r\n{}").unwrap(),
            Answer {
                status: 409,
                body: "{}".into()
            }
        );
        assert_eq!(
            answer(b"HTTP/1.1 200 OK\r\n\r\nto the end").unwrap().body,
            "to the end",
            "no length: read to the end"
        );
        assert_eq!(
            answer(b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\ncut")
                .unwrap()
                .body,
            "cut",
            "cut short"
        );
        assert!(answer(b"").is_err());
        assert!(answer(b"SSH-2.0-OpenSSH\r\n\r\n").is_err());
        assert!(
            answer(b"HTTP/1.1 200 OK\r\nContent-Length: 2").is_err(),
            "the headers never end"
        );
    }

    #[test]
    fn posts_the_event_and_reads_the_status() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut chunk = [0u8; 4096];
            while !received.ends_with(b"{\"hook_event_name\":\"Stop\"}") {
                let read = socket.read(&mut chunk).unwrap();
                assert!(read > 0);
                received.extend_from_slice(&chunk[..read]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 60\r\n\r\n{\"ok\":true,\"errors\":[{\"status\":409,\"message\":\"has exited\"}]}").unwrap();
            String::from_utf8(received).unwrap()
        });
        let answer = post(&url, "ab12", "token", None, "", b"{\"hook_event_name\":\"Stop\"}").unwrap();
        assert_eq!(answer.status, 200);
        assert!(answer.body.contains("\"errors\""));
        let received = server.join().unwrap();
        assert!(
            received.starts_with("POST /api/v1/sessions/ab12/hook?reporting= HTTP/1.1\r\n"),
            "{received}"
        );
        assert!(received.contains("\r\nX-Agent-Guild-Report-Token: token\r\n"));
    }

    #[test]
    fn says_when_no_manager_listens() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let err = post(&url, "ab12", "token", None, "", b"{}").unwrap_err();
        assert!(err.starts_with("could not reach the manager at 127.0.0.1:"), "{err}");
    }
}
