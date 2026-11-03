//! Rebuild SP3 / clock files or Bias-SINEX from recorded correction products (RTCM SSR streams, Galileo HAS, BeiDou
//! PPP-B2b) with the engine's read-only PMode=0 conversion. The engine owns the decoding and the application of the
//! corrections; FINDU only writes the option file, runs it and checks the result.
use crate::native::platform;
use crate::{native, options, paths};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// Engine capability `product_convert`: 1 = SSR to SP3 / CLK, 2 = also SSR biases to Bias-SINEX, 3 = also Galileo HAS
/// and BeiDou PPP-B2b.
const CONVERT_ORBIT: u64 = 1;
const CONVERT_BIAS: u64 = 2;
const CONVERT_AUGMENTATION: u64 = 3;
const TIMEOUT: Duration = Duration::from_secs(20 * 60);

#[derive(Deserialize, Debug, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Orbit and clock: SP3 and CLK from SSR plus broadcast ephemerides.
    #[default]
    Orbit,
    /// Code and phase biases: Bias-SINEX from the SSR and OSB streams.
    Bias,
}

/// What the recorded corrections are.
#[derive(Deserialize, Debug, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// RTCM SSR or IGS-SSR stream.
    #[default]
    Ssr,
    /// Galileo High Accuracy Service recording (page records, OEM log or Septentrio SBF).
    Has,
    /// BeiDou PPP-B2b private-frame log.
    B2b,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    #[serde(default)]
    pub kind: Kind,
    #[serde(default)]
    pub source: Source,
    /// Recorded correction product (SSR stream, HAS recording or B2b log). Required for orbits; for biases either this
    /// or `bias`.
    #[serde(default)]
    pub ssr: String,
    /// Separate OSB stream (biases only).
    #[serde(default)]
    pub bias: String,
    /// Broadcast ephemerides: a RINEX navigation file or an RTCM3 stream that carries them. Required for orbits; for
    /// biases it only gives the GPS week.
    #[serde(default)]
    pub navi: String,
    /// UTC "YYYY-MM-DD HH:MM:SS", needed when no RINEX navigation file gives the week.
    #[serde(default)]
    pub start_time: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub sp3: Option<String>,
    pub clk: Option<String>,
    pub bia: Option<String>,
    pub directory: String,
    pub log: String,
}

/// The engine reads option files as ANSI text, so a path with other characters is handed over as its 8.3 short name.
#[cfg(windows)]
fn ascii_path(path: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and the buffer length is passed along.
    let mut buffer = vec![0u16; 32768];
    let n = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
            wide.as_ptr(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
        )
    };
    if n == 0 || n as usize >= buffer.len() {
        return None;
    }
    String::from_utf16(&buffer[..n as usize]).ok().filter(|s| s.is_ascii())
}
#[cfg(not(windows))]
fn ascii_path(_: &Path) -> Option<String> {
    None
}

/// Option values end at ';' or a line break, so a path containing either cannot be written safely.
fn check_path(path: &str, label: &str) -> Result<(), String> {
    if path.chars().any(|c| matches!(c, ';' | '\r' | '\n' | '#')) {
        return Err(format!("{label}路径含有 OPT 分隔符：{path}"));
    }
    if !Path::new(path).exists() {
        return Err(format!("找不到{label}：{path}"));
    }
    Ok(())
}

/// A name the engine can open: the path itself when it is ASCII, else its short name, else a hard link (or a copy
/// when the files are on different volumes) with an ASCII name inside `stage`.
fn engine_path(path: &str, label: &str, stage: &Path) -> Result<String, String> {
    let p = Path::new(path);
    if path.is_ascii() {
        return Ok(options::display_path(p));
    }
    if let Some(short) = ascii_path(p) {
        return Ok(short);
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let extension: String =
        name.rsplit_once('.').map(|(_, e)| e).filter(|e| e.is_ascii()).unwrap_or("dat").into();
    let target = stage.join(format!("{}.{extension}", safe_name(label)));
    let _ = fs::remove_file(&target);
    fs::hard_link(p, &target)
        .or_else(|_| fs::copy(p, &target).map(|_| ()))
        .map_err(|e| format!("{label}路径含非英文字符，且无法准备英文路径的副本：{e}"))?;
    Ok(options::display_path(&target))
}

fn safe_name(name: &str) -> String {
    let words: Vec<String> = name
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    if words.is_empty() {
        "ssr".into()
    } else {
        words.join("_").chars().take(48).collect()
    }
}

/// Engine-readable input names, in the order of the request fields; empty stays empty.
struct Inputs {
    ssr: String,
    bias: String,
    navi: String,
}

fn opt_text(request: &ConvertRequest, inputs: &Inputs, output: &Path) -> Result<String, String> {
    let format = if request.kind == Kind::Bias { "BIA" } else { "SP3" };
    let mut text = format!("GNSS_PMode = 0;\nGNSS_DecodeFormat = {format};\n");
    match request.source {
        Source::Ssr => {}
        Source::Has => text += "GNSS_ProductType = HAS;\n",
        Source::B2b => text += "GNSS_ProductType = B2B;\n",
    }
    // HAS and B2b carry no separate bias stream
    let bias = if request.source == Source::Ssr { &inputs.bias } else { &String::new() };
    for (key, value) in
        [("GNSS_NaviFile", &inputs.navi), ("GNSS_ProductFile", &inputs.ssr), ("GNSS_BIASFile", bias)]
    {
        if !value.is_empty() {
            text += &format!("{key} = {value};\n");
        }
    }
    text += &format!("GNSS_DecodeOutput = {};\n", options::display_path(output));
    let start = request.start_time.trim();
    if !start.is_empty() && request.source == Source::Ssr {
        chrono::NaiveDateTime::parse_from_str(start, "%Y-%m-%d %H:%M:%S")
            .map_err(|_| "起始时间格式应为 UTC “YYYY-MM-DD HH:MM:SS”".to_string())?;
        text += &format!("GNSS_StartTime = {start};\n");
    }
    Ok(text)
}

fn require(request: &ConvertRequest) -> Result<(), String> {
    if request.source != Source::Ssr {
        // the recording carries its own time, so only the product and, for orbits, the ephemerides are needed
        return match request.kind {
            Kind::Orbit if request.ssr.is_empty() || request.navi.is_empty() => {
                Err("需要填写改正数据文件和广播星历".into())
            }
            Kind::Bias if request.ssr.is_empty() => Err("需要填写改正数据文件".into()),
            _ => Ok(()),
        };
    }
    match request.kind {
        Kind::Orbit if request.ssr.is_empty() || request.navi.is_empty() => {
            Err("需要填写 SSR 流和广播星历".into())
        }
        Kind::Bias if request.ssr.is_empty() && request.bias.is_empty() => {
            Err("偏差转换至少需要 SSR 流或偏差流之一".into())
        }
        Kind::Bias if request.navi.is_empty() && request.start_time.trim().is_empty() => {
            Err("偏差转换需要起始时间（UTC）或 RINEX 广播星历来确定 GPS 周".into())
        }
        _ => Ok(()),
    }
}

fn supports(engine_dir: &Path, kind: Kind, source: Source) -> Result<(), String> {
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(engine_dir.join("manifest.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let level = manifest["capabilities"]["product_convert"].as_u64().unwrap_or(0);
    if source != Source::Ssr && level < CONVERT_AUGMENTATION {
        return Err("当前引擎尚不支持 HAS / B2b 转换，请更换为包含该功能的 IPSPOS 引擎".into());
    }
    match kind {
        Kind::Orbit if level >= CONVERT_ORBIT => Ok(()),
        Kind::Bias if level >= CONVERT_BIAS => Ok(()),
        Kind::Orbit => Err("当前引擎尚不支持 SSR 转 SP3 / CLK，请更换为包含该功能的 IPSPOS 引擎".into()),
        Kind::Bias => Err("当前引擎尚不支持 SSR 偏差转 Bias-SINEX，请更换为包含该功能的 IPSPOS 引擎".into()),
    }
}

pub fn convert(engine_dir: &Path, root: &Path, request: &ConvertRequest) -> Result<ConvertResult, String> {
    supports(engine_dir, request.kind, request.source)?;
    require(request)?;
    for (path, label) in [(&request.ssr, "SSR 流"), (&request.bias, "偏差流"), (&request.navi, "广播星历")]
    {
        if !path.is_empty() {
            check_path(path, label)?;
        }
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    let directory: PathBuf =
        root.join("exports").join("ssr-products").join(format!("{stamp}_{}", safe_name(&request.name)));
    fs::create_dir_all(&directory).map_err(|e| format!("无法创建输出目录：{e}"))?;
    let base = directory.join("products");
    let opt = directory.join("convert.opt");
    let stage = ascii_path(&directory)
        .filter(|_| !directory.to_string_lossy().is_ascii())
        .map(PathBuf::from)
        .unwrap_or_else(|| directory.clone());
    if !stage.to_string_lossy().is_ascii() {
        return Err("程序所在路径含非英文字符，且无法转成短路径；请把 FINDU 放到英文路径".into());
    }
    let stage_one = |path: &str, label: &str| -> Result<String, String> {
        if path.is_empty() {
            Ok(String::new())
        } else {
            engine_path(path, label, &stage)
        }
    };
    let inputs = Inputs {
        ssr: stage_one(&request.ssr, "ssr")?,
        bias: stage_one(&request.bias, "bias")?,
        navi: stage_one(&request.navi, "navi")?,
    };
    let output = options::display_path(&stage.join("products"));
    fs::write(&opt, opt_text(request, &inputs, Path::new(&output))?).map_err(|e| e.to_string())?;

    let log_path = directory.join("convert.log");
    let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(engine_dir.join(platform::SOLVER));
    command
        .arg(&opt)
        .current_dir(&directory)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    platform::prepare(&mut command);
    let mut child = command.spawn().map_err(|e| format!("无法启动 IPSPOS：{e}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("转换超过 20 分钟，已中止".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let text = fs::read_to_string(&log_path).unwrap_or_default();
    let found = |extension: &str| {
        let path = base.with_extension(extension);
        path.is_file().then(|| options::display_path(&path))
    };
    let (sp3, clk, bia) = (found("sp3"), found("clk"), found("bia"));
    let produced = match request.kind {
        Kind::Orbit => sp3.is_some() && clk.is_some(),
        Kind::Bias => bia.is_some(),
    };
    if !status.success() || !produced {
        let reason: Vec<&str> =
            text.lines().filter(|l| l.contains("PMode=0:") && !l.contains("read-only")).collect();
        return Err(if reason.is_empty() {
            "转换失败，详见输出目录中的 convert.log".into()
        } else {
            reason.join("；")
        });
    }
    Ok(ConvertResult {
        sp3: sp3.filter(|_| request.kind == Kind::Orbit),
        clk: clk.filter(|_| request.kind == Kind::Orbit),
        bia: bia.filter(|_| request.kind == Kind::Bias),
        directory: options::display_path(&directory),
        log: text.lines().filter(|l| l.contains("PMode=0:")).collect::<Vec<_>>().join("\n"),
    })
}

#[tauri::command]
pub async fn convert_ssr_products(
    request: ConvertRequest,
    runtime: tauri::State<'_, native::NativeRuntime>,
    paths: tauri::State<'_, paths::RuntimePaths>,
) -> Result<ConvertResult, String> {
    let engine_dir = runtime.engine_dir.clone();
    let root = PathBuf::from(&paths.root);
    tauri::async_runtime::spawn_blocking(move || convert(&engine_dir, &root, &request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: Kind, start: &str) -> ConvertRequest {
        ConvertRequest {
            kind,
            source: Source::Ssr,
            ssr: "s".into(),
            bias: String::new(),
            navi: "n".into(),
            start_time: start.into(),
            name: "x".into(),
        }
    }

    fn inputs(ssr: &str, bias: &str, navi: &str) -> Inputs {
        Inputs { ssr: ssr.into(), bias: bias.into(), navi: navi.into() }
    }

    #[test]
    fn option_text_carries_the_inputs_and_an_optional_start_time() {
        let text = opt_text(
            &request(Kind::Orbit, ""),
            &inputs("D:/a/ssr.rtcm3", "", "D:/a/brdc.rnx"),
            Path::new("D:/out/products"),
        )
        .unwrap();
        assert!(text.contains("GNSS_PMode = 0;"));
        assert!(text.contains("GNSS_DecodeFormat = SP3;"));
        assert!(text.contains("GNSS_NaviFile = D:/a/brdc.rnx;"));
        assert!(text.contains("GNSS_ProductFile = D:/a/ssr.rtcm3;"));
        assert!(!text.contains("GNSS_BIASFile") && !text.contains("GNSS_StartTime"));
        let timed =
            opt_text(&request(Kind::Orbit, "2026-09-19 17:34:00"), &inputs("s", "", "n"), Path::new("o"))
                .unwrap();
        assert!(timed.contains("GNSS_StartTime = 2026-09-19 17:34:00;"));
        assert!(opt_text(&request(Kind::Orbit, "2026-09-19"), &inputs("s", "", "n"), Path::new("o")).is_err());
        assert!(opt_text(
            &request(Kind::Orbit, "19.09.2026 17:34:00"),
            &inputs("s", "", "n"),
            Path::new("o")
        )
        .is_err());
    }

    #[test]
    fn bias_options_use_the_bia_format_and_leave_unused_inputs_out() {
        let text = opt_text(
            &request(Kind::Bias, "2026-09-19 17:34:00"),
            &inputs("D:/a/ssr.rtcm3", "D:/a/osb.rtcm3", ""),
            Path::new("D:/out/products"),
        )
        .unwrap();
        assert!(text.contains("GNSS_DecodeFormat = BIA;"));
        assert!(text.contains("GNSS_ProductFile = D:/a/ssr.rtcm3;"));
        assert!(text.contains("GNSS_BIASFile = D:/a/osb.rtcm3;"));
        assert!(!text.contains("GNSS_NaviFile"));
    }

    #[test]
    fn requests_are_checked_for_what_each_kind_needs() {
        let mut r = request(Kind::Orbit, "");
        assert!(require(&r).is_ok());
        r.navi.clear();
        assert!(require(&r).unwrap_err().contains("广播星历"));
        let mut b = request(Kind::Bias, "");
        b.ssr.clear();
        assert!(require(&b).unwrap_err().contains("SSR 流或偏差流"));
        b.bias = "osb".into();
        assert!(require(&b).is_ok(), "a RINEX file or a start time is still missing, but navi is given");
        b.navi.clear();
        assert!(require(&b).unwrap_err().contains("起始时间"));
        b.start_time = "2026-09-19 17:34:00".into();
        assert!(require(&b).is_ok());
    }

    #[test]
    fn paths_with_option_separators_and_missing_files_are_refused() {
        assert!(check_path("a;b.rtcm3", "SSR 流").unwrap_err().contains("分隔符"));
        assert!(check_path("a\nb", "SSR 流").is_err());
        assert!(check_path("definitely-missing.rtcm3", "SSR 流").unwrap_err().contains("找不到"));
    }

    #[test]
    fn non_ascii_inputs_get_an_ascii_name_beside_the_output() {
        let dir = std::env::temp_dir().join(format!("convert-ascii-{}", uuid::Uuid::new_v4()));
        let source = dir.join("来源");
        fs::create_dir_all(&source).unwrap();
        let file = source.join("流数据.rtcm3");
        fs::write(&file, b"payload").unwrap();
        let path = engine_path(file.to_str().unwrap(), "ssr", &dir).unwrap();
        assert!(path.is_ascii(), "{path}");
        assert_eq!(fs::read(&path).unwrap(), b"payload");
        assert_eq!(engine_path("D:/plain/path.rnx", "navi", &dir).unwrap(), "D:/plain/path.rnx");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn names_become_safe_directory_parts() {
        assert_eq!(safe_name("WHU 实时/SSR"), "WHU_SSR");
        assert_eq!(safe_name(""), "ssr");
        assert_eq!(safe_name("..\\x"), "x");
        assert!(safe_name(&"a".repeat(200)).len() <= 48);
    }

    #[test]
    fn the_engine_capability_level_decides_which_conversions_are_offered() {
        let dir = std::env::temp_dir().join(format!("convert-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let write = |text: &str| fs::write(dir.join("manifest.json"), text).unwrap();
        write(r#"{"capabilities":{"observation_decode":2}}"#);
        assert!(supports(&dir, Kind::Orbit, Source::Ssr).unwrap_err().contains("尚不支持"));
        write(r#"{"capabilities":{"product_convert":1}}"#);
        assert!(supports(&dir, Kind::Orbit, Source::Ssr).is_ok());
        assert!(supports(&dir, Kind::Bias, Source::Ssr).unwrap_err().contains("偏差"));
        write(r#"{"capabilities":{"product_convert":2}}"#);
        assert!(
            supports(&dir, Kind::Orbit, Source::Ssr).is_ok()
                && supports(&dir, Kind::Bias, Source::Ssr).is_ok()
        );
        assert!(supports(&dir, Kind::Orbit, Source::Has).unwrap_err().contains("HAS / B2b"));
        write(r#"{"capabilities":{"product_convert":3}}"#);
        assert!(
            supports(&dir, Kind::Orbit, Source::Has).is_ok()
                && supports(&dir, Kind::Bias, Source::B2b).is_ok()
        );
        let err = convert(&dir, &dir, &request(Kind::Orbit, "")).unwrap_err();
        assert!(err.contains("找不到"), "{err}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn has_and_b2b_name_their_product_type_and_need_no_start_time_or_bias_stream() {
        let mut r = request(Kind::Orbit, "");
        r.source = Source::Has;
        let text =
            opt_text(&r, &inputs("D:/a/HAS.has", "D:/a/bias", "D:/a/rove.rtcm3"), Path::new("o")).unwrap();
        assert!(
            text.contains("GNSS_ProductType = HAS;") && text.contains("GNSS_ProductFile = D:/a/HAS.has;")
        );
        assert!(!text.contains("GNSS_BIASFile"), "{text}");
        r.source = Source::B2b;
        r.start_time = "not a time".into();
        assert!(opt_text(&r, &inputs("p", "", "n"), Path::new("o"))
            .unwrap()
            .contains("GNSS_ProductType = B2B;"));
        let ssr = opt_text(&request(Kind::Orbit, ""), &inputs("p", "", "n"), Path::new("o")).unwrap();
        assert!(!ssr.contains("GNSS_ProductType"), "an SSR stream keeps the default");
        // an orbit needs the ephemerides, biases do not
        r.navi.clear();
        assert!(require(&r).unwrap_err().contains("广播星历"));
        let mut b = request(Kind::Bias, "");
        b.source = Source::Has;
        b.navi.clear();
        assert!(require(&b).is_ok(), "no week reference is needed, the recording is timed");
        b.ssr.clear();
        assert!(require(&b).is_err());
    }

    #[test]
    fn requests_default_to_orbit_and_accept_the_bias_kind() {
        let r: ConvertRequest = serde_json::from_str(r#"{"ssr":"a","navi":"b"}"#).unwrap();
        assert_eq!((r.kind, r.source), (Kind::Orbit, Source::Ssr));
        let h: ConvertRequest = serde_json::from_str(r#"{"source":"has","ssr":"a","navi":"b"}"#).unwrap();
        assert_eq!(h.source, Source::Has);
        let r: ConvertRequest =
            serde_json::from_str(r#"{"kind":"bias","bias":"o","startTime":"2026-09-19 17:34:00"}"#).unwrap();
        assert_eq!(r.kind, Kind::Bias);
        assert!(r.ssr.is_empty() && r.navi.is_empty());
    }

    /// Manual check with a real engine: FINDU_CONVERT_ENGINE (directory with manifest), _KIND (orbit|bias), _SSR,
    /// _BIAS, _NAVI and _START (all optional where the kind allows).
    #[test]
    #[ignore]
    fn converts_with_a_real_engine() {
        let get = |k: &str| std::env::var(k).unwrap_or_default();
        let root = std::env::temp_dir().join("findu-convert-check");
        let kind = if get("FINDU_CONVERT_KIND") == "bias" { Kind::Bias } else { Kind::Orbit };
        let result = convert(
            Path::new(&get("FINDU_CONVERT_ENGINE")),
            &root,
            &ConvertRequest {
                kind,
                source: match get("FINDU_CONVERT_SOURCE").as_str() {
                    "has" => Source::Has,
                    "b2b" => Source::B2b,
                    _ => Source::Ssr,
                },
                ssr: get("FINDU_CONVERT_SSR"),
                bias: get("FINDU_CONVERT_BIAS"),
                navi: get("FINDU_CONVERT_NAVI"),
                start_time: get("FINDU_CONVERT_START"),
                name: "check".into(),
            },
        )
        .unwrap();
        println!("{result:?}");
    }
}
