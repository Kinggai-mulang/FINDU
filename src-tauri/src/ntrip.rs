//! NTRIP source table browsing and a short mountpoint probe, used only to fill the realtime configuration.
//! Plain HTTP over `std::net`; the engine keeps its own NTRIP client for the real stream. Credentials are used
//! for one request and are never logged or stored.
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TABLE_DEADLINE: Duration = Duration::from_secs(12);
const TABLE_LIMIT: usize = 4 * 1024 * 1024;
const PROBE_WINDOW: Duration = Duration::from_secs(8);
const PROBE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Mountpoint {
    pub mountpoint: String,
    pub identifier: String,
    pub format: String,
    pub details: String,
    pub systems: String,
    pub network: String,
    pub country: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub nmea: bool,
    pub authentication: String,
    pub bitrate: Option<u32>,
    /// Message numbers announced in the format details, e.g. 1005, 1077.
    pub messages: Vec<u32>,
    /// OBS / EPH / SSR as far as the announced messages tell.
    pub kinds: Vec<&'static str>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ObservedMessage {
    pub id: u32,
    pub count: u32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub window_seconds: f64,
    pub bytes: usize,
    pub messages: Vec<ObservedMessage>,
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn clean(field: &str, label: &str) -> Result<(), String> {
    if field.chars().any(|c| c.is_control()) {
        return Err(format!("{label}含有不允许的字符"));
    }
    Ok(())
}

fn request(host: &str, port: u16, path: &str, user: &str, password: &str) -> Vec<u8> {
    let mut text = format!(
        "GET /{path} HTTP/1.0\r\nHost: {host}:{port}\r\nNtrip-Version: Ntrip/2.0\r\nUser-Agent: NTRIP FINDU\r\n"
    );
    if !user.is_empty() || !password.is_empty() {
        text += &format!("Authorization: Basic {}\r\n", base64(format!("{user}:{password}").as_bytes()));
    }
    text += "Connection: close\r\n\r\n";
    text.into_bytes()
}

fn connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|_| format!("无法解析服务器地址 {host}"))?
        .next()
        .ok_or("服务器地址没有可用的 IP")?;
    let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|e| format!("无法连接 {host}:{port}（{}）", e.kind()))?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    Ok(stream)
}

/// Splits the response head from the body and validates the status line.
fn split_response(data: &[u8]) -> Result<(String, &[u8]), String> {
    let end = data.windows(4).position(|w| w == b"\r\n\r\n").ok_or("服务器没有返回有效的响应")?;
    let head = String::from_utf8_lossy(&data[..end]).to_string();
    let status = head.lines().next().unwrap_or_default().to_string();
    let code = status.split_whitespace().nth(1).unwrap_or_default();
    if status.starts_with("SOURCETABLE 200") || status.starts_with("ICY 200") || code == "200" {
        return Ok((head, &data[end + 4..]));
    }
    Err(match code {
        "401" => "服务器要求用户名和密码，或认证未通过".into(),
        "403" => "服务器拒绝访问（账号无权限）".into(),
        "404" => "服务器上没有这个挂载点".into(),
        _ => format!("服务器返回：{}", status.chars().take(80).collect::<String>()),
    })
}

/// Decodes `Transfer-Encoding: chunked`; a truncated final chunk keeps what was received.
fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len());
    let mut at = 0;
    while let Some(line_end) = body[at..].windows(2).position(|w| w == b"\r\n") {
        let size_text = String::from_utf8_lossy(&body[at..at + line_end]);
        let Ok(size) = usize::from_str_radix(size_text.split(';').next().unwrap_or_default().trim(), 16)
        else {
            break;
        };
        at += line_end + 2;
        if size == 0 {
            break;
        }
        let end = (at + size).min(body.len());
        out.extend_from_slice(&body[at..end]);
        at = end + 2;
        if at >= body.len() {
            break;
        }
    }
    out
}

fn message_ids(details: &str) -> Vec<u32> {
    let mut ids = Vec::new();
    for token in details.split(',') {
        let numbers = token.split('(').next().unwrap_or_default();
        for part in numbers.split('/') {
            if let Ok(id) = part.trim().parse::<u32>() {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    ids
}

fn kinds(ids: &[u32]) -> Vec<&'static str> {
    let obs = |id: u32| {
        matches!(id, 1001..=1004 | 1009..=1012) || (1071..=1137).contains(&id) && (1..=7).contains(&(id % 10))
    };
    let eph = |id: u32| matches!(id, 1019 | 1020 | 1041..=1046);
    let ssr = |id: u32| matches!(id, 1057..=1068 | 1240..=1263 | 4076);
    let mut out = Vec::new();
    if ids.iter().any(|&id| obs(id)) {
        out.push("OBS");
    }
    if ids.iter().any(|&id| eph(id)) {
        out.push("EPH");
    }
    if ids.iter().any(|&id| ssr(id)) {
        out.push("SSR");
    }
    out
}

fn parse_table(text: &str) -> Vec<Mountpoint> {
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.trim().split(';').collect();
            if f.first() != Some(&"STR") || f.len() < 12 {
                return None;
            }
            let get = |i: usize| f.get(i).map(|s| s.trim().trim_matches('"').to_string()).unwrap_or_default();
            let number = |i: usize| get(i).parse::<f64>().ok().filter(|v| v.is_finite());
            let details = get(4);
            let messages = message_ids(&details);
            Some(Mountpoint {
                mountpoint: get(1),
                identifier: get(2),
                format: get(3),
                kinds: kinds(&messages),
                messages,
                details,
                systems: get(6),
                network: get(7),
                country: get(8),
                latitude: number(9).filter(|v| v.abs() <= 90.0),
                longitude: number(10).filter(|v| v.abs() <= 180.0),
                nmea: get(11) == "1",
                authentication: get(15),
                bitrate: get(17).parse().ok(),
            })
        })
        .filter(|m| !m.mountpoint.is_empty())
        .collect()
}

pub fn sourcetable(host: &str, port: u16, user: &str, password: &str) -> Result<Vec<Mountpoint>, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("请先填写服务器地址".into());
    }
    clean(host, "服务器地址")?;
    if host.chars().any(|c| c.is_whitespace() || c == '/') {
        return Err("服务器地址只填写主机名或 IP，不含路径".into());
    }
    clean(user, "用户名")?;
    clean(password, "密码")?;
    let mut stream = connect(host, port)?;
    stream
        .write_all(&request(host, port, "", user, password))
        .map_err(|e| format!("发送请求失败（{}）", e.kind()))?;
    let started = Instant::now();
    let mut data = Vec::new();
    let mut block = [0u8; 16 * 1024];
    while started.elapsed() < TABLE_DEADLINE && data.len() < TABLE_LIMIT {
        match stream.read(&mut block) {
            Ok(0) => break,
            Ok(n) => {
                data.extend_from_slice(&block[..n]);
                if data.windows(14).rev().take(64).any(|w| w == b"ENDSOURCETABLE") {
                    break;
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                if !data.is_empty() {
                    break;
                }
            }
            Err(e) => return Err(format!("接收源表失败（{}）", e.kind())),
        }
    }
    let (head, body) = split_response(&data)?;
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(body)
    } else {
        body.to_vec()
    };
    let table = parse_table(&String::from_utf8_lossy(&body));
    if table.is_empty() {
        return Err("服务器返回了空的源表".into());
    }
    Ok(table)
}

fn crc24q(data: &[u8]) -> u32 {
    let mut crc = 0u32;
    for &byte in data {
        crc ^= (byte as u32) << 16;
        for _ in 0..8 {
            crc <<= 1;
            if crc & 0x100_0000 != 0 {
                crc ^= 0x186_4CFB;
            }
        }
    }
    crc & 0xFF_FFFF
}

/// Counts RTCM 3 frames by message number; frames must pass the CRC, everything else is skipped.
fn scan_rtcm(data: &[u8]) -> Vec<ObservedMessage> {
    let mut counts: Vec<ObservedMessage> = Vec::new();
    let mut at = 0;
    while at + 6 <= data.len() {
        if data[at] != 0xD3 {
            at += 1;
            continue;
        }
        let length = ((data[at + 1] as usize & 3) << 8) | data[at + 2] as usize;
        let total = length + 6;
        if at + total > data.len() {
            break;
        }
        let frame = &data[at..at + total];
        let crc = (frame[total - 3] as u32) << 16 | (frame[total - 2] as u32) << 8 | frame[total - 1] as u32;
        if length >= 2 && crc24q(&frame[..total - 3]) == crc {
            let id = (frame[3] as u32) << 4 | (frame[4] as u32) >> 4;
            match counts.iter_mut().find(|m| m.id == id) {
                Some(m) => m.count += 1,
                None => counts.push(ObservedMessage { id, count: 1 }),
            }
            at += total;
        } else {
            at += 1;
        }
    }
    counts.sort_by_key(|m| m.id);
    counts
}

pub fn probe(host: &str, port: u16, mountpoint: &str, user: &str, password: &str) -> Result<Probe, String> {
    let host = host.trim();
    if host.is_empty() || mountpoint.is_empty() {
        return Err("请先填写服务器地址并选择挂载点".into());
    }
    if mountpoint.chars().any(|c| c.is_control() || c.is_whitespace() || c == '/') {
        return Err("挂载点名称不合法".into());
    }
    clean(host, "服务器地址")?;
    if host.chars().any(|c| c.is_whitespace() || c == '/') {
        return Err("服务器地址只填写主机名或 IP，不含路径".into());
    }
    clean(user, "用户名")?;
    clean(password, "密码")?;
    let mut stream = connect(host, port)?;
    stream
        .write_all(&request(host, port, mountpoint, user, password))
        .map_err(|e| format!("发送请求失败（{}）", e.kind()))?;
    let started = Instant::now();
    let mut data = Vec::new();
    let mut block = [0u8; 32 * 1024];
    while started.elapsed() < PROBE_WINDOW && data.len() < PROBE_LIMIT {
        match stream.read(&mut block) {
            Ok(0) => break,
            Ok(n) => data.extend_from_slice(&block[..n]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return Err(format!("接收数据失败（{}）", e.kind())),
        }
    }
    let window_seconds = started.elapsed().as_secs_f64();
    if data.starts_with(b"SOURCETABLE") {
        return Err("服务器返回了源表而不是数据流：挂载点不存在，或需要认证".into());
    }
    let (head, body) = split_response(&data)?;
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(body)
    } else {
        body.to_vec()
    };
    let messages = scan_rtcm(&body);
    if messages.is_empty() {
        return Err(
            "在探测时间内没有收到有效的 RTCM 3 数据（该挂载点可能需要发送位置，或不是 RTCM 3）".into()
        );
    }
    Ok(Probe { window_seconds, bytes: body.len(), messages })
}

#[tauri::command]
pub async fn ntrip_sourcetable(
    host: String,
    port: u16,
    user: String,
    password: String,
) -> Result<Vec<Mountpoint>, String> {
    tauri::async_runtime::spawn_blocking(move || sourcetable(&host, port, &user, &password))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ntrip_probe(
    host: String,
    port: u16,
    mountpoint: String,
    user: String,
    password: String,
) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || probe(&host, port, &mountpoint, &user, &password))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"user:pass"), "dXNlcjpwYXNz");
    }

    #[test]
    fn parses_stream_lines_and_ignores_the_rest() {
        let text = "SOURCETABLE 200 OK\r\nCAS;caster.example;2101;Name;Op;0;CHN;30.5;114.3;0.0.0.0;0;\r\n\
            STR;MOUNT1;Wuhan;RTCM 3.2;1005(10),1077(1),1087(1),1097(1),1019(30);2;GPS+GLO+GAL;NET;CHN;30.53;114.36;1;0;Gen;none;B;N;9600;misc\r\n\
            STR;SSR1;Ssr;RTCM 3.3;1057(5),1058(5),4076(5);2;GPS;NET;DEU;50.1;8.6;0;0;Gen;none;N;N;2400;\r\n\
            STR;;broken\r\nNET;x;y\r\nENDSOURCETABLE\r\n";
        let table = parse_table(text);
        assert_eq!(table.len(), 2);
        assert_eq!(table[0].mountpoint, "MOUNT1");
        assert_eq!(table[0].messages, vec![1005, 1077, 1087, 1097, 1019]);
        assert_eq!(table[0].kinds, vec!["OBS", "EPH"]);
        assert_eq!(table[0].latitude, Some(30.53));
        assert!(table[0].nmea);
        assert_eq!(table[0].authentication, "B");
        assert_eq!(table[0].bitrate, Some(9600));
        assert_eq!(table[1].kinds, vec!["SSR"]);
        assert!(!table[1].nmea);
    }

    #[test]
    fn message_numbers_accept_slashes_and_skip_text() {
        assert_eq!(message_ids("1005/1006(5),1074(1),MSM"), vec![1005, 1006, 1074]);
        assert_eq!(kinds(&[1005]), Vec::<&str>::new());
        assert_eq!(kinds(&[1074]), vec!["OBS"]);
        assert_eq!(kinds(&[1070, 1078]), Vec::<&str>::new());
    }

    #[test]
    fn status_lines_become_readable_errors() {
        assert!(split_response(b"HTTP/1.1 401 Unauthorized\r\n\r\n").unwrap_err().contains("认证"));
        assert!(split_response(b"HTTP/1.0 404 Not Found\r\n\r\n").unwrap_err().contains("挂载点"));
        let (_, body) = split_response(b"ICY 200 OK\r\n\r\nxyz").unwrap();
        assert_eq!(body, b"xyz");
        assert!(split_response(b"no head").is_err());
    }

    #[test]
    fn chunked_bodies_are_joined_and_truncation_is_tolerated() {
        assert_eq!(dechunk(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"), b"hello world");
        assert_eq!(dechunk(b"5\r\nhello\r\n6\r\n wo"), b"hello wo");
    }

    fn frame(id: u32) -> Vec<u8> {
        let mut payload = vec![(id >> 4) as u8, ((id & 15) << 4) as u8, 0, 0];
        let mut out = vec![0xD3, 0, payload.len() as u8];
        out.append(&mut payload);
        let crc = crc24q(&out);
        out.extend_from_slice(&[(crc >> 16) as u8, (crc >> 8) as u8, crc as u8]);
        out
    }

    #[test]
    fn counts_only_frames_with_a_valid_crc() {
        let mut stream = b"garbage".to_vec();
        stream.extend(frame(1077));
        stream.extend(frame(1005));
        stream.extend(frame(1077));
        let mut broken = frame(1087);
        *broken.last_mut().unwrap() ^= 1;
        stream.extend(broken);
        assert_eq!(
            scan_rtcm(&stream),
            vec![ObservedMessage { id: 1005, count: 1 }, ObservedMessage { id: 1077, count: 2 }]
        );
    }

    fn serve(response: Vec<u8>) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut seen = [0u8; 1024];
            let n = socket.read(&mut seen).unwrap();
            let request = String::from_utf8_lossy(&seen[..n]).to_string();
            assert!(request.starts_with("GET /"), "{request}");
            assert!(request.contains("Authorization: Basic dXNlcjpwYXNz"), "{request}");
            socket.write_all(&response).unwrap();
        });
        port
    }

    #[test]
    fn reads_a_source_table_over_a_socket() {
        let body = "STR;MOUNT1;Wuhan;RTCM 3.2;1005(10),1077(1);2;GPS;NET;CHN;30.5;114.3;0;0;G;none;B;N;5000;\r\nENDSOURCETABLE\r\n";
        let head = format!("SOURCETABLE 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        let port = serve(head.into_bytes());
        let table = sourcetable("127.0.0.1", port, "user", "pass").unwrap();
        assert_eq!(table.len(), 1);
        assert_eq!(table[0].kinds, vec!["OBS"]);
    }

    #[test]
    fn probes_a_stream_over_a_socket() {
        let mut response = b"ICY 200 OK\r\n\r\n".to_vec();
        for id in [1005, 1077, 1077] {
            response.extend(frame(id));
        }
        let port = serve(response);
        let probe = probe("127.0.0.1", port, "MOUNT1", "user", "pass").unwrap();
        assert_eq!(
            probe.messages,
            vec![ObservedMessage { id: 1005, count: 1 }, ObservedMessage { id: 1077, count: 2 }]
        );
    }

    /// Manual check against a real caster: `FINDU_TEST_CASTER=host:port cargo test ntrip -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_the_source_table_of_a_real_caster() {
        let target = std::env::var("FINDU_TEST_CASTER").expect("set FINDU_TEST_CASTER=host:port");
        let (host, port) = target.rsplit_once(':').unwrap();
        let user = std::env::var("FINDU_TEST_USER").unwrap_or_default();
        let password = std::env::var("FINDU_TEST_PASSWORD").unwrap_or_default();
        let table = sourcetable(host, port.parse().unwrap(), &user, &password).unwrap();
        println!("{} mountpoints", table.len());
        for m in table.iter().take(5) {
            println!("{} {} {:?} {:?}", m.mountpoint, m.format, m.kinds, m.latitude);
        }
        assert!(!table.is_empty());
    }

    #[test]
    fn control_characters_in_credentials_are_rejected() {
        assert!(clean("host\r\nX: y", "地址").is_err());
        assert!(clean("pass word", "密码").is_ok());
    }
}
