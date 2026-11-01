use crate::{
    live_log::{LineTail, LiveLog},
    native::Job,
    options,
    results::{self, RealEpoch},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const KEYS: &[&str] = &[
    "GNSS_PMode",
    "GNSS_RoveSampleTime",
    "GNSS_ARMode",
    "GNSS_ATXFile",
    "GNSS_DCBFile",
    "GNSS_bUseDCB",
    "GNSS_DCBMaxHoldDays",
    "GNSS_ShareEPHPath",
    "GNSS_bUsePPPAntenna",
    "GNSS_bSSRCodeOSB",
    "GNSS_bRecordRTCM3",
    "GNSS_bOutputNMEA",
    "GNSS_bOutputLOG",
    "IPSClient_bStatusLog",
    "GNSS_BasePoss",
    "GNSS_BaseSampleTime",
    "GNSS_bOutputULog",
    "GNSS_ULogLevel",
    "GNSS_ULogFileFilter",
    "GNSS_RefPoss",
    "NTRIP_RequestMode",
    "PRODUCT_NTRIP_Type",
    "ROVE_NTRIP_Format",
    "BASE_NTRIP_Format",
    "GNSS_ObsQuality",
    "GNSS_Dynamics",
    "GNSS_Domain",
    "GNSS_Environment",
];
const ROLES: &[&str] = &["ROVE", "BASE", "PRODUCT", "BIAS", "ATMO"];
const SUFFIXES: &[&str] = &["CasterHost", "Mountpoint", "Port", "UserID", "Password", "DataType"];
fn allowed(key: &str) -> bool {
    KEYS.contains(&key) || ROLES.iter().any(|r| SUFFIXES.iter().any(|s| key == format!("{r}_NTRIP_{s}")))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDocument {
    pub source_path: String,
    pub name: String,
    pub values: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveRequest {
    pub source_path: String,
    pub values: BTreeMap<String, String>,
    pub output_dir: String,
    pub label: Option<String>,
    pub station: Option<String>,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFile {
    pub name: String,
    pub path: String,
    pub role: String,
    pub bytes: u64,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub session_key: String,
    pub label: String,
    pub station: String,
    pub source_path: String,
    pub buffered_epochs: usize,
    pub analysis_config: std::collections::HashMap<String, String>,
    pub state: String,
    pub config_name: String,
    pub product_type: String,
    pub log_path: Option<String>,
    pub parse_error: Option<String>,
    pub log_updated_at: Option<String>,
    pub epoch_interval_seconds: Option<f64>,
    pub id: String,
    pub started_at: String,
    pub output_dir: String,
    pub process_id: Option<u32>,
    pub engine_commit: String,
    pub heartbeat: Value,
    pub epochs: Vec<RealEpoch>,
    pub metrics: Value,
    pub history: Vec<Value>,
    pub product_history: Vec<Value>,
    pub logs: Vec<Value>,
    pub error: Option<String>,
    pub reference_xyz: Option<[f64; 3]>,
    pub received_epochs: u64,
    pub solution_mode: String,
    pub log_version: u8,
    pub engine_build_id: String,
    pub ntrip_log_path: Option<String>,
    pub product_log_path: Option<String>,
    pub status_error: Option<String>,
    pub recording_files: Vec<RecordingFile>,
    /// Bumped whenever a buffer is cleared inside one run, so clients discard their copies.
    #[serde(skip)]
    pub generation: u64,
    /// Items ever appended to each buffer in this generation; the oldest kept item is `end - len`.
    #[serde(skip)]
    pub ends: BufferEnds,
}

/// Total items appended per live buffer; these are sequence numbers, not lengths.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferEnds {
    pub epochs: u64,
    pub history: u64,
    pub products: u64,
    pub logs: u64,
}

/// What a client already holds for one session.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCursor {
    pub run_id: String,
    pub generation: u64,
    pub ends: BufferEnds,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaRequest {
    pub session_id: String,
    pub cursor: Option<LiveCursor>,
    #[serde(default)]
    pub with_logs: bool,
}

/// Items with sequence numbers `from..end`; the client keeps its own items below `from`
/// and drops everything below `start`, which mirrors the server buffer exactly.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferSlice<T> {
    pub start: u64,
    pub from: u64,
    pub end: u64,
    pub items: Vec<T>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDelta {
    /// History-free session state, identical to one overview row.
    pub summary: LiveSnapshot,
    pub generation: u64,
    pub epochs: BufferSlice<RealEpoch>,
    pub history: BufferSlice<Value>,
    pub product_history: BufferSlice<Value>,
    pub logs: BufferSlice<Value>,
}

/// The last held item is always resent, because product rows may be replaced in place.
fn slice<T: Clone>(items: &[T], end: u64, held: Option<u64>) -> BufferSlice<T> {
    let start = end - items.len() as u64;
    let from = match held {
        Some(h) if h > start && h <= end => h - 1,
        _ => start,
    };
    BufferSlice { start, from, end, items: items[(from - start) as usize..].to_vec() }
}

/// History-free copy of one session for overviews and delta headers.
fn summary_of(d: &LiveSnapshot) -> LiveSnapshot {
    LiveSnapshot {
        session_key: d.session_key.clone(),
        label: d.label.clone(),
        station: d.station.clone(),
        source_path: d.source_path.clone(),
        buffered_epochs: d.epochs.len(),
        analysis_config: d.analysis_config.clone(),
        state: d.state.clone(),
        config_name: d.config_name.clone(),
        product_type: d.product_type.clone(),
        log_path: d.log_path.clone(),
        parse_error: d.parse_error.clone(),
        log_updated_at: d.log_updated_at.clone(),
        epoch_interval_seconds: recent_epoch_interval(&d.history),
        id: d.id.clone(),
        started_at: d.started_at.clone(),
        output_dir: d.output_dir.clone(),
        process_id: d.process_id,
        engine_commit: d.engine_commit.clone(),
        heartbeat: d.heartbeat.clone(),
        metrics: d.metrics.clone(),
        error: d.error.clone(),
        reference_xyz: d.reference_xyz,
        received_epochs: d.received_epochs,
        solution_mode: d.solution_mode.clone(),
        log_version: d.log_version,
        engine_build_id: d.engine_build_id.clone(),
        ntrip_log_path: d.ntrip_log_path.clone(),
        product_log_path: d.product_log_path.clone(),
        status_error: d.status_error.clone(),
        recording_files: d.recording_files.clone(),
        ..Default::default()
    }
}

/// Median epoch spacing also travels in the history-free overview.
fn recent_epoch_interval(history: &[Value]) -> Option<f64> {
    let tail = &history[history.len().saturating_sub(21)..];
    let mut steps: Vec<f64> = tail
        .windows(2)
        .filter_map(|pair| {
            let a = chrono::DateTime::parse_from_rfc3339(pair[0]["time"].as_str()?).ok()?;
            let b = chrono::DateTime::parse_from_rfc3339(pair[1]["time"].as_str()?).ok()?;
            let seconds = (b - a).num_milliseconds() as f64 / 1000.;
            (seconds > 0.).then_some(seconds)
        })
        .collect();
    steps.sort_by(f64::total_cmp);
    (steps.len() >= 2).then(|| steps[(steps.len() - 1) / 2])
}

#[cfg(test)]
mod delta_tests {
    use super::*;
    fn push(rt: &RealtimeRuntime, n: u64) {
        let mut d = rt.data.lock().unwrap();
        for _ in 0..n {
            let i = d.ends.history;
            d.history.push(json!({ "i": i }));
            d.ends.history += 1;
            if d.history.len() > 3600 {
                d.history.remove(0);
            }
        }
    }
    fn cursor(delta: &LiveDelta, run: &str) -> LiveCursor {
        LiveCursor {
            run_id: run.into(),
            generation: delta.generation,
            ends: BufferEnds {
                epochs: delta.epochs.end,
                history: delta.history.end,
                products: delta.product_history.end,
                logs: delta.logs.end,
            },
        }
    }
    #[test]
    fn first_read_is_full_then_only_new_rows_plus_the_last_held_one() {
        let rt = RealtimeRuntime::new(PathBuf::new(), PathBuf::new());
        rt.data.lock().unwrap().id = "run".into();
        push(&rt, 10);
        let full = rt.delta(None, false);
        assert_eq!((full.history.start, full.history.from, full.history.end), (0, 0, 10));
        assert_eq!(full.history.items.len(), 10);
        assert!(full.summary.history.is_empty() && full.summary.epochs.is_empty());
        push(&rt, 3);
        let next = rt.delta(Some(&cursor(&full, "run")), false);
        assert_eq!((next.history.from, next.history.end), (9, 13));
        assert_eq!(next.history.items[0]["i"], 9);
        assert_eq!(next.history.items.len(), 4);
    }
    #[test]
    fn rollover_new_run_and_generation_change_resend_the_buffer() {
        let rt = RealtimeRuntime::new(PathBuf::new(), PathBuf::new());
        rt.data.lock().unwrap().id = "run".into();
        push(&rt, 3600);
        let held = cursor(&rt.delta(None, false), "run");
        push(&rt, 4000);
        let behind = rt.delta(Some(&held), false);
        assert_eq!((behind.history.start, behind.history.from, behind.history.end), (4000, 4000, 7600));
        assert_eq!(behind.history.items.len(), 3600);
        let other_run = rt.delta(Some(&cursor(&behind, "previous")), false);
        assert_eq!(other_run.history.items.len(), 3600);
        rt.data.lock().unwrap().generation += 1;
        let cleared = rt.delta(Some(&cursor(&behind, "run")), false);
        assert_eq!(cleared.history.from, cleared.history.start);
    }
    #[test]
    fn logs_travel_only_when_requested() {
        let rt = RealtimeRuntime::new(PathBuf::new(), PathBuf::new());
        rt.log("one".into());
        assert!(rt.delta(None, false).logs.items.is_empty());
        assert_eq!(rt.delta(None, true).logs.items.len(), 1);
    }
}

#[cfg(test)]
mod cadence_tests {
    use super::*;
    #[test]
    fn overview_and_detail_keep_cadence_without_copying_history() {
        let runtime = RealtimeRuntime::new(PathBuf::new(), PathBuf::new());
        runtime.data.lock().unwrap().history = vec![
            serde_json::json!({"time":"2026-10-21T23:59:55Z"}),
            serde_json::json!({"time":"2026-10-22T00:00:00Z"}),
            serde_json::json!({"time":"2026-10-22T00:00:05Z"}),
            serde_json::json!({"time":"2026-10-22T00:01:05Z"}),
        ];
        assert_eq!(runtime.snapshot().epoch_interval_seconds, Some(5.));
        let overview = runtime.summary();
        assert_eq!(overview.epoch_interval_seconds, Some(5.));
        assert!(overview.history.is_empty());
        assert_eq!(recent_epoch_interval(&[]), None);
        assert_eq!(
            recent_epoch_interval(&[
                serde_json::json!({"time":"2026-10-22T00:00:00Z"}),
                serde_json::json!({"time":"2026-10-22T00:10:00Z"})
            ]),
            None
        );
    }
}

#[derive(Clone)]
pub struct RealtimeRuntime {
    data: Arc<Mutex<LiveSnapshot>>,
    stop: Arc<AtomicBool>,
    engine_dir: PathBuf,
    root: PathBuf,
    library: Option<Arc<crate::library::Library>>,
}
fn read_opt(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("opt")) {
        return Err("请选择 IPSClient .opt 配置".into());
    }
    if fs::metadata(p).map_err(|_| "实时配置文件不存在")?.len() > 1_048_576 {
        return Err("实时配置超过 1 MB".into());
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}
fn imported_values(text: &str) -> BTreeMap<String, String> {
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=').or_else(|| line.split_once(':')) else {
            continue;
        };
        let Some((v, _)) = v.split_once(';') else {
            continue;
        };
        let k = k.trim();
        let v = v.trim();
        let canonical = KEYS
            .iter()
            .map(|s| s.to_string())
            .chain(ROLES.iter().flat_map(|r| SUFFIXES.iter().map(move |s| format!("{r}_NTRIP_{s}"))))
            .find(|key| key.eq_ignore_ascii_case(options::canonical(k)));
        if let Some(key) = canonical {
            values.insert(key, v.into());
        }
        for alias in ["SSR", "HAS", "B2B"] {
            for suffix in SUFFIXES {
                if k.eq_ignore_ascii_case(&format!("{alias}_NTRIP_{suffix}")) {
                    values.insert(format!("PRODUCT_NTRIP_{suffix}"), v.into());
                    values.insert("PRODUCT_NTRIP_Type".into(), alias.into());
                }
            }
        }
        for alias in ["ATMO_NTRIP_", "ATMO_", "ION_NTRIP_", "ION_", "IONO_NTRIP_", "IONO_"] {
            for suffix in SUFFIXES {
                if k.eq_ignore_ascii_case(&format!("{alias}{suffix}")) {
                    values.insert(format!("ATMO_NTRIP_{suffix}"), v.into());
                }
            }
        }
        if ["PRODUCT_NTRIP_Type", "PRODUCT_NTRIP_Format", "GNSS_ProductType", "GNSS_ProductFormat"]
            .iter()
            .any(|key| k.eq_ignore_ascii_case(key))
        {
            values.insert("PRODUCT_NTRIP_Type".into(), v.into());
        }
    }
    if let Some(kind) = values.get_mut("PRODUCT_NTRIP_Type") {
        *kind = match kind.to_ascii_uppercase().as_str() {
            "0" => "SSR".into(),
            "1" => "HAS".into(),
            "2" | "BDS_B2B" => "B2B".into(),
            other => other.into(),
        };
    }
    values
}
pub fn import(path: String) -> Result<LiveDocument, String> {
    let text = read_opt(&path)?;
    let values = imported_values(&text);
    Ok(LiveDocument {
        source_path: options::display_path(Path::new(&path)),
        name: Path::new(&path).file_name().unwrap().to_string_lossy().into(),
        values,
    })
}
impl RealtimeRuntime {
    pub fn new(engine_dir: PathBuf, root: PathBuf) -> Self {
        Self {
            data: Arc::new(Mutex::new(LiveSnapshot { state: "idle".into(), ..Default::default() })),
            stop: Arc::new(AtomicBool::new(false)),
            engine_dir,
            root,
            library: None,
        }
    }
    pub fn with_library(mut self, library: Option<Arc<crate::library::Library>>) -> Self {
        self.library = library;
        self
    }
    pub fn snapshot(&self) -> LiveSnapshot {
        let mut s = self.data.lock().unwrap().clone();
        s.buffered_epochs = s.epochs.len();
        s.epoch_interval_seconds = recent_epoch_interval(&s.history);
        s
    }
    pub fn set_key(&self, key: &str) {
        let mut d = self.data.lock().unwrap();
        d.session_key = key.into();
        if d.label.is_empty() {
            d.label = format!("{} · {}", d.config_name, &key[..key.len().min(6)]);
        }
    }
    /// Overview never copies histories; four live sessions need only one full detail poll.
    pub fn summary(&self) -> LiveSnapshot {
        summary_of(&self.data.lock().unwrap())
    }
    /// Only the items the client lacks, so a 1 s poll costs the same after one hour as after one minute.
    pub fn delta(&self, cursor: Option<&LiveCursor>, with_logs: bool) -> LiveDelta {
        let d = self.data.lock().unwrap();
        let held = cursor.filter(|c| c.run_id == d.id && c.generation == d.generation).map(|c| c.ends);
        let logs = if with_logs {
            slice(&d.logs, d.ends.logs, held.map(|h| h.logs))
        } else {
            BufferSlice { start: d.ends.logs, from: d.ends.logs, end: d.ends.logs, items: vec![] }
        };
        LiveDelta {
            summary: summary_of(&d),
            generation: d.generation,
            epochs: slice(&d.epochs, d.ends.epochs, held.map(|h| h.epochs)),
            history: slice(&d.history, d.ends.history, held.map(|h| h.history)),
            product_history: slice(&d.product_history, d.ends.products, held.map(|h| h.products)),
            logs,
        }
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let mut d = self.data.lock().unwrap();
        if matches!(d.state.as_str(), "starting" | "running") {
            d.state = "stopping".into();
        }
    }
    fn log(&self, line: String) {
        let mut d = self.data.lock().unwrap();
        d.logs.push(json!({"time":Utc::now().to_rfc3339(),"line":line}));
        d.ends.logs += 1;
        if d.logs.len() > 500 {
            d.logs.remove(0);
        }
    }
    pub fn start(&self, request: LiveRequest) -> Result<String, String> {
        let mut d = self.data.lock().unwrap();
        if matches!(d.state.as_str(), "starting" | "running" | "stopping") {
            return Err("已有实时会话，请先停止".into());
        }
        let text = read_opt(&request.source_path)?;
        let mut values = options::parse(&text);
        values.extend(imported_values(&text));
        for (k, v) in &request.values {
            if !allowed(k) || v.contains([';', '\r', '\n']) || v.len() > 1024 {
                return Err("实时配置字段或值无效".into());
            }
            values.insert(k.clone(), v.clone());
        }
        validate(&values)?;
        let record_only = values.get("GNSS_PMode").is_some_and(|v| v == "0");
        if request.label.as_ref().is_some_and(|v| v.chars().count() > 512 || v.contains(['\r', '\n']))
            || request.station.as_ref().is_some_and(|v| v.chars().count() > 80 || v.contains(['\r', '\n']))
        {
            return Err("方案名须为 512 字以内、测站分组为 80 字以内的单行文字".into());
        }
        let reference = if record_only { None } else { reference(&values)? };
        let manifest: Value = serde_json::from_slice(
            &fs::read(self.engine_dir.join("manifest.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if manifest["client_sha256"].as_str()
            != Some(options::hash(&self.engine_dir.join("IPSClient.exe"))?.as_str())
        {
            return Err("IPSClient 与引擎构建记录不一致".into());
        }
        options::check_protocol(&manifest)?;
        let root = if request.output_dir.trim().is_empty() {
            self.root.clone()
        } else {
            let p = PathBuf::from(&request.output_dir);
            if !p.is_absolute() {
                return Err("会话目录须为绝对路径".into());
            }
            p
        };
        let id = uuid::Uuid::new_v4().to_string();
        let run = root.join(format!("live-{}-{id}", Utc::now().format("%Y%m%dT%H%M%S")));
        fs::create_dir_all(&run).map_err(|e| e.to_string())?;
        let stop_path = run.join("stop.request");
        let mut run_text = String::new();
        for line in text.lines() {
            let key = line.split_once('=').map(|(k, _)| k.trim()).unwrap_or("");
            if key.starts_with("RTIE_") || key.starts_with("UPLOAD_") || key.starts_with("IPSCLIENT_") {
                continue;
            }
            run_text.push_str(line);
            run_text.push('\n');
        }
        run_text.push_str("\n# FINDYOU session overrides; source configuration remains unchanged.\n");
        for (k, v) in &request.values {
            run_text.push_str(&format!("{k} = {v};\n"));
        }
        // Side effects stay inside this session; never share mutable ephemeris caches.
        let config_path = Path::new(&request.source_path);
        let parent = config_path.parent().unwrap_or(Path::new("."));
        let repo = if parent.file_name().is_some_and(|n| n == "opt" || n == "Data") {
            parent.parent().unwrap_or(parent)
        } else {
            parent
        };
        let (dcb, warnings) = options::dcb_overrides(&values, repo);
        for (k, v) in dcb {
            run_text.push_str(&format!("{k} = {v};\n"));
        }
        for warning in warnings {
            run_text.push_str(&format!("# {warning}\n"));
        }
        let cache = run.join("eph_cache");
        fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        if let Some(old) = values.get("GNSS_ShareEPHPath").filter(|s| !s.is_empty() && !record_only) {
            let old = options::absolute(repo, old);
            copy_cache(&old, &cache)?;
        }
        if let Some(atx) = values.get("GNSS_ATXFile").filter(|s| {
            !s.is_empty()
                && matches!(values.get("GNSS_PMode").map(String::as_str), Some("2" | "3"))
                && values.get("GNSS_bUsePPPAntenna").is_none_or(|v| v.eq_ignore_ascii_case("ON") || v == "1")
        }) {
            let p = options::absolute(repo, atx);
            if !p.is_file() {
                return Err("ANTEX 文件不存在".into());
            }
            run_text.push_str(&format!("GNSS_ATXFile = {};\n", options::engine_path(&p)?));
        }
        run_text.push_str(&format!("GNSS_ShareEPHPath = {};\nGNSS_bOutputLOG = ON;\nIPSClient_bStatusLog = ON;\nIPSClient_StopFile = {};\nRTIE_bSendSolDB = OFF;\nRTIE_bSiteInfoFromDB = OFF;\n",options::engine_path(&cache)?,options::engine_path(&stop_path)?));
        // Satellite details are an ordinary IPSClient output; older engines ignore the unknown key.
        if !record_only && manifest["capabilities"]["satellite_snapshot"] == SATELLITE_SNAPSHOT {
            run_text.push_str(&format!(
                "IPSClient_SatelliteFile = {};\n",
                options::engine_path(&run.join("satellites.json"))?
            ));
        }
        if record_only {
            run_text.push_str("GNSS_bRecordRTCM3 = ON;\nGNSS_bOutputLOG = OFF;\nGNSS_bOutputNMEA = OFF;\nGNSS_bOutputAccuracy = OFF;\n");
        }
        let run_opt = run.join("live.opt");
        fs::write(&run_opt, &run_text).map_err(|e| e.to_string())?;
        // The manifest intentionally omits OPT contents, user names, passwords and gateway fields.
        fs::write(run.join("manifest.json"),serde_json::to_vec_pretty(&json!({"schemaVersion":2,"id":id,"engineBuildId":manifest["build_id"],"protocols":manifest["protocols"],"sourceOptSha256":options::hash(config_path)?,"engineCommit":manifest["commit"],"clientSha256":manifest["client_sha256"],"productType":values.get("PRODUCT_NTRIP_Type"),"gatewayEnabled":false,"startedAt":Utc::now().to_rfc3339()})).unwrap()).map_err(|e|e.to_string())?;
        let secrets: Vec<_> = values
            .iter()
            .filter(|(k, v)| {
                (k.contains("Password") || k.contains("UserID") || k.contains("Token")) && !v.is_empty()
            })
            .map(|(_, v)| v.clone())
            .collect();
        self.stop.store(false, Ordering::SeqCst);
        *d = LiveSnapshot {
            label: request.label.unwrap_or_default(),
            station: request.station.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
                values.get("ROVE_NTRIP_Mountpoint").cloned().unwrap_or_else(|| "未指定测站".into())
            }),
            source_path: options::display_path(config_path),
            analysis_config: results::config_summary(&run_text),
            state: "starting".into(),
            solution_mode: if record_only {
                "RECORD".into()
            } else if matches!(values.get("GNSS_PMode").map(String::as_str), Some("6" | "7" | "8")) {
                "RTK".into()
            } else {
                "PPP".into()
            },
            log_version: 4,
            engine_build_id: manifest["build_id"].as_str().unwrap_or_default().into(),
            config_name: config_path.file_name().unwrap_or_default().to_string_lossy().into(),
            product_type: if record_only {
                "RECORD".into()
            } else if matches!(values.get("GNSS_PMode").map(String::as_str), Some("6" | "7" | "8")) {
                "RTK".into()
            } else {
                values.get("PRODUCT_NTRIP_Type").cloned().unwrap_or_else(|| "SSR".into())
            },
            id: id.clone(),
            started_at: Utc::now().to_rfc3339(),
            output_dir: options::display_path(&run),
            engine_commit: manifest["commit"].as_str().unwrap_or("").into(),
            ..Default::default()
        };
        drop(d);
        let rt = self.clone();
        thread::spawn(move || {
            if let Err(e) = rt.run(run, run_opt, stop_path, secrets, reference) {
                let mut d = rt.data.lock().unwrap();
                d.state = "failed".into();
                d.error = Some(e);
            }
        });
        Ok(id)
    }
    fn product_metric(&self, snapshot: &Value) {
        if let Some(metric) = results::product_metric(snapshot) {
            let mut d = self.data.lock().unwrap();
            // A replaced last row keeps its sequence number; deltas always resend the last held row.
            if d.product_history.last().is_some_and(|m| m["time"] == metric["time"]) {
                d.product_history.pop();
            } else {
                d.ends.products += 1;
            }
            d.product_history.push(metric);
            if d.product_history.len() > 3600 {
                d.product_history.remove(0);
            }
        }
    }
    fn run(
        &self,
        run: PathBuf,
        opt: PathBuf,
        stop: PathBuf,
        secrets: Vec<String>,
        reference: Option<[f64; 3]>,
    ) -> Result<(), String> {
        let console = run.join("console.log");
        let stdout = fs::File::create(&console).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(self.engine_dir.join("IPSClient.exe"));
        cmd.arg(options::engine_path(&opt)?)
            .current_dir(&run)
            .stdout(Stdio::from(stdout.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(stdout));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd.spawn().map_err(|e| format!("IPSClient 启动失败：{e}"))?;
        let job = match Job::attach(&child) {
            Ok(j) => j,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        {
            let mut d = self.data.lock().unwrap();
            d.process_id = Some(child.id());
            d.state = "running".into();
        }
        let record_only = self.data.lock().unwrap().solution_mode == "RECORD";
        self.log(
            if record_only {
                "IPSClient 原始流录制已启动；模式 0，不执行定位解算。"
            } else {
                "IPSClient 真实实时会话已启动；产品与观测由本机 NTRIP 接收。"
            }
            .into(),
        );
        let mut solution_tail = LineTail::default();
        let mut console_tail = LineTail::default();
        let mut ntrip_tail = LineTail::default();
        let mut product_tail = LineTail::default();
        let mut ntrip = crate::status_log::Parser::new("NTRIP");
        let mut product = crate::status_log::Parser::new("PRODUCT");
        let mut ntrip_path = None;
        let mut product_path = None;
        let mut parser = LiveLog::default();
        parser.origin = reference;
        let mut log_path = None;
        let mut ulog_path = None;
        let mut ulog_tail = LineTail::default();
        let mut stopped = None;
        let terminal = loop {
            // Check exit before draining files so the final flushed records cannot be missed.
            let exit_status = child.try_wait().map_err(|e| e.to_string())?;
            if self.stop.load(Ordering::SeqCst) && stopped.is_none() {
                fs::write(&stop, b"stop").map_err(|e| e.to_string())?;
                stopped = Some(Instant::now());
            }
            if ntrip_path.is_none() {
                ntrip_path = crate::status_log::find(&run, "NTRIP");
            }
            if product_path.is_none() {
                product_path = crate::status_log::find(&run, "PRODUCT");
            }
            let status_read = (|| -> Result<(), String> {
                if let Some(path) = &ntrip_path {
                    let (reset, lines) = ntrip_tail.read(path)?;
                    if reset {
                        ntrip = crate::status_log::Parser::new("NTRIP");
                    }
                    for line in lines {
                        ntrip.line(&line)?;
                    }
                }
                if let Some(path) = &product_path {
                    let (reset, lines) = product_tail.read(path)?;
                    if reset {
                        product = crate::status_log::Parser::new("PRODUCT");
                        let mut d = self.data.lock().unwrap();
                        d.product_history.clear();
                        d.ends.products = 0;
                        d.generation += 1;
                    }
                    for line in lines {
                        if let Some(previous) = product.line(&line)? {
                            self.product_metric(&previous);
                        }
                    }
                    if let Some(current) = product.snapshot() {
                        self.product_metric(&current);
                    }
                }
                Ok(())
            })();
            {
                let mut d = self.data.lock().unwrap();
                if d.solution_mode == "RECORD" {
                    d.recording_files = recording_files(&run);
                }
                d.ntrip_log_path = ntrip_path.as_deref().map(options::display_path);
                d.product_log_path = product_path.as_deref().map(options::display_path);
                d.heartbeat = crate::status_log::heartbeat(&ntrip, &product);
                d.status_error = status_read.err();
            }
            if log_path.is_none() && self.data.lock().unwrap().solution_mode != "RECORD" {
                log_path = results::find_solution_log(&run);
                if let Some(path) = &log_path {
                    self.data.lock().unwrap().log_path = Some(options::display_path(path));
                }
            }
            if let Some(path) = &log_path {
                let (reset, lines) = solution_tail.read(path)?;
                if reset {
                    parser = LiveLog::default();
                    parser.origin = reference;
                    let mut d = self.data.lock().unwrap();
                    d.epochs.clear();
                    d.history.clear();
                    d.ends.epochs = 0;
                    d.ends.history = 0;
                    d.generation += 1;
                    d.reference_xyz = None;
                    d.received_epochs = 0;
                    d.metrics = Value::Null;
                    d.parse_error = None;
                    d.log_updated_at = None;
                }
                for line in lines {
                    match parser.line(&line) {
                        Ok(Some((epoch, metrics))) => {
                            let mut d = self.data.lock().unwrap();
                            d.metrics = metrics.clone();
                            d.parse_error = None;
                            d.log_updated_at = Some(Utc::now().to_rfc3339());
                            d.history.push(metrics);
                            d.ends.history += 1;
                            d.received_epochs += 1;
                            if d.history.len() > 3600 {
                                d.history.remove(0);
                            }
                            if let Some(e) = epoch {
                                d.epochs.push(e);
                                d.ends.epochs += 1;
                                if d.epochs.len() > 3600 {
                                    d.epochs.remove(0);
                                }
                            }
                            d.reference_xyz = parser.origin;
                        }
                        Err(e) => {
                            self.data.lock().unwrap().parse_error = Some(e.clone());
                            self.log(e);
                        }
                        _ => {}
                    }
                }
            }
            if ulog_path.is_none() {
                ulog_path = find_ulog(&run);
            }
            if let Some(path) = &ulog_path {
                let (_, lines) = ulog_tail.read(path)?;
                for line in lines {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let safe = if secrets.iter().any(|s| line.contains(s)) {
                        "[已隐藏含连接凭据的日志行]".into()
                    } else {
                        format!("[ULog] {}", line.chars().take(2000).collect::<String>())
                    };
                    self.log(safe);
                }
            }
            if console.is_file() {
                let (_, lines) = console_tail.read(&console)?;
                for line in lines {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let safe = if secrets.iter().any(|s| line.contains(s)) {
                        "[已隐藏含连接凭据的日志行]".into()
                    } else {
                        line.chars().take(2000).collect()
                    };
                    self.log(safe);
                }
            }
            if let Some(status) = exit_status {
                let mut d = self.snapshot();
                d.state = if stopped.is_some() { "stopped" } else { "failed" }.into();
                if stopped.is_none() {
                    d.error = Some(format!(
                        "IPSClient 已退出（{}）；请检查连接及配置日志",
                        status.code().unwrap_or(-1)
                    ));
                }
                break d;
            }
            if stopped.is_some_and(|t| t.elapsed() > Duration::from_secs(8)) {
                let _ = child.kill();
                let _ = child.wait();
                self.log("连接尚未返回，已结束会话进程；逐历元日志已保留。".into());
                continue; // Drain the flushed tail once more after process termination.
            }
            thread::sleep(Duration::from_millis(500));
        };
        drop(job);
        fs::write(
            run.join("session-summary.json"),
            serde_json::to_vec_pretty(&terminal).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if let Some(lib) = &self.library {
            if terminal.buffered_epochs > 0 {
                if let Err(e) = lib.import(vec![options::display_path(&run)]) {
                    self.log(format!("结果文件已保留，历史索引未写入：{e}"));
                }
            }
        }
        // Keep start() blocked until this run has finished all file/index work.
        // Publishing a terminal state earlier lets an immediate restart replace its metadata.
        let mut d = self.data.lock().unwrap();
        d.state = terminal.state;
        d.error = terminal.error;
        Ok(())
    }
}
fn validate(v: &BTreeMap<String, String>) -> Result<(), String> {
    options::check_solver_options(v)?;
    let mode = v.get("GNSS_PMode").map(String::as_str).unwrap_or("");
    let record_only = mode == "0";
    let rtk = matches!(mode, "6" | "7" | "8");
    if !record_only && !rtk && !matches!(mode, "2" | "3") {
        return Err("实时支持仅录制(0)、PPP(2/3)及 RTK(6/7/8)".into());
    }
    let kind = v.get("PRODUCT_NTRIP_Type").map(String::as_str).unwrap_or("SSR");
    if !record_only && !rtk && !matches!(kind, "SSR" | "HAS" | "B2B") {
        return Err("当前 PPP 引擎支持 SSR、HAS、B2B".into());
    }
    if !record_only && !rtk && matches!(kind, "HAS" | "B2B") {
        for role in ["ROVE", "BIAS", "ATMO"] {
            if role != "ROVE" && v.get(&format!("{role}_NTRIP_Mountpoint")).is_none_or(|s| s.is_empty()) {
                continue;
            }
            if v.get(&format!("{role}_NTRIP_DataType")).is_some_and(|s| {
                s.split('|').any(|p| ["ORB", "CLK", "CODE_OSB", "PHASE_OSB"].contains(&p.trim()))
            }) {
                return Err(format!("{kind} 不可混用 {role} 流的 SSR 改正；广播星历请选择 EPH"));
            }
        }
    }
    for role in ROLES {
        if !record_only && ((rtk && !["ROVE", "BASE"].contains(role)) || (!rtk && *role == "BASE")) {
            continue;
        }
        let mount = v.get(&format!("{role}_NTRIP_Mountpoint")).map(String::as_str).unwrap_or("");
        if record_only && mount.is_empty() {
            continue;
        }
        if ["BIAS", "ATMO"].contains(role) && mount.is_empty() {
            continue;
        }
        let host = v.get(&format!("{role}_NTRIP_CasterHost")).filter(|s| !s.is_empty()).or_else(|| {
            if ["BIAS", "ATMO"].contains(role) {
                v.get("PRODUCT_NTRIP_CasterHost")
            } else {
                None
            }
        });
        if host.is_none_or(|s| s.is_empty()) || mount.is_empty() {
            return Err(format!("请填写 {role} 地址和挂载点"));
        }
        if v.get(&format!("{role}_NTRIP_Port")).and_then(|s| s.parse::<u16>().ok()).is_none_or(|p| p == 0) {
            return Err(format!("{role} 端口须为 1–65535"));
        }
    }
    if record_only
        && ROLES.iter().all(|r| v.get(&format!("{r}_NTRIP_Mountpoint")).is_none_or(|s| s.is_empty()))
    {
        return Err("仅录制模式至少配置一路挂载点".into());
    }
    if let Some(sample) = v.get("GNSS_RoveSampleTime").filter(|_| !record_only) {
        if sample.parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0. && *n <= 3600.).is_none() {
            return Err("采样间隔须大于 0 且不超过 3600 秒".into());
        }
    }
    Ok(())
}

fn recording_files(run: &Path) -> Vec<RecordingFile> {
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(run) else {
        return files;
    };
    for entry in entries.flatten() {
        let directory = entry.path();
        if !directory.is_dir() || !entry.file_name().to_string_lossy().starts_with("SESSION_") {
            continue;
        }
        let Ok(children) = fs::read_dir(directory) else {
            continue;
        };
        for file in children.flatten() {
            let path = file.path();
            if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("rtcm3")) {
                continue;
            }
            let Ok(meta) = file.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let name = file.file_name().to_string_lossy().to_string();
            let prefix = name.split('_').next().unwrap_or("");
            let role = if prefix == "PROD" { "PRODUCT" } else { prefix }.to_string();
            if ROLES.contains(&role.as_str()) {
                files.push(RecordingFile {
                    name,
                    path: options::display_path(&path),
                    role,
                    bytes: meta.len(),
                });
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

#[tauri::command]
pub fn create_live_document(
    values: BTreeMap<String, String>,
    paths: tauri::State<'_, crate::paths::RuntimePaths>,
) -> Result<LiveDocument, String> {
    validate(&values)?;
    if values.iter().any(|(k, v)| !allowed(k) || v.contains([';', '\r', '\n']) || v.len() > 1024) {
        return Err("实时配置字段或值无效".into());
    }
    let dir = Path::new(&paths.root).join("config/realtime-drafts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("manual-{}.opt", uuid::Uuid::new_v4()));
    let text = values.iter().map(|(k, v)| format!("{k} = {v};\n")).collect::<String>();
    fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(LiveDocument {
        source_path: options::display_path(&path), name: "手动实时配置.opt".into(), values
    })
}
fn copy_cache(source: &Path, target: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Ok(());
    }
    for e in fs::read_dir(source).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if p.is_file() && e.metadata().map(|m| m.len() < 4_194_304).unwrap_or(false) {
            fs::copy(&p, target.join(e.file_name())).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_ulog(root: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(root).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_ulog(&p) {
                return Some(found);
            }
        } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("ulog")) {
            return Some(p);
        }
    }
    None
}
fn reference(values: &BTreeMap<String, String>) -> Result<Option<[f64; 3]>, String> {
    let Some(text) = values.get("GNSS_RefPoss").filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    let v: Vec<f64> = text
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(str::parse)
        .collect::<Result<_, _>>()
        .map_err(|_| "参考坐标需要三个 ECEF 数值")?;
    if v == [0., 0., 0.] {
        return Ok(None);
    }
    if v.len() != 3 || v.iter().any(|n| !n.is_finite()) || v.iter().map(|n| n * n).sum::<f64>().sqrt() < 1e6 {
        return Err("参考坐标需要有效 ECEF XYZ，单位米".into());
    }
    Ok(Some([v[0], v[1], v[2]]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn record_only_accepts_any_configured_role_and_requires_one_valid_endpoint() {
        let mut v=options::parse("GNSS_PMode=0;\nPRODUCT_NTRIP_CasterHost=127.0.0.1;\nPRODUCT_NTRIP_Port=2101;\nPRODUCT_NTRIP_Mountpoint=raw;\nPRODUCT_NTRIP_Type=HAS;\nGNSS_RoveSampleTime=0;");
        assert!(validate(&v).is_ok());
        v.insert("PRODUCT_NTRIP_Port".into(), "65536".into());
        assert!(validate(&v).is_err());
        v.insert("PRODUCT_NTRIP_Mountpoint".into(), "".into());
        assert!(validate(&v).is_err());
    }
    #[test]
    fn recording_files_stay_in_session_and_survive_overview() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../runtime/cache/test-recording")
            .join(uuid::Uuid::new_v4().to_string());
        let session = root.join("SESSION_test");
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("PROD_mount_epoch.rtcm3"), [1, 2, 3]).unwrap();
        fs::write(session.join("ROVE_mount_epoch.rtcm3"), [4, 5]).unwrap();
        fs::write(session.join("ROVE_not_raw.log"), "log").unwrap();
        fs::write(root.join("ROVE_outside.rtcm3"), "outside").unwrap();
        let files = recording_files(&root);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].role, "PRODUCT");
        assert_eq!(files[0].bytes, 3);
        let runtime = RealtimeRuntime::new(PathBuf::new(), root);
        runtime.data.lock().unwrap().recording_files = files;
        assert_eq!(runtime.summary().recording_files.len(), 2);
    }
    #[test]
    fn realtime_aliases_keep_assignment_order_and_exclude_gateway() {
        let values=imported_values("HAS_NTRIP_CasterHost = first;\nPRODUCT_NTRIP_Type = SSR;\nRTIE_Gateway_Token = private;\nION_NTRIP_Mountpoint = ion;\nGNSS_ProductFormat = 2;");
        assert_eq!(values["PRODUCT_NTRIP_Type"], "B2B");
        assert_eq!(values["PRODUCT_NTRIP_CasterHost"], "first");
        assert_eq!(values["ATMO_NTRIP_Mountpoint"], "ion");
        assert!(!values.contains_key("RTIE_Gateway_Token"));
    }
    #[test]
    fn optional_mountpoint_and_supported_sources() {
        let mut v=options::parse("GNSS_PMode=2;\nROVE_NTRIP_CasterHost=127.0.0.1;\nROVE_NTRIP_Port=2101;\nROVE_NTRIP_Mountpoint=obs;\nPRODUCT_NTRIP_CasterHost=127.0.0.1;\nPRODUCT_NTRIP_Port=2101;\nPRODUCT_NTRIP_Mountpoint=prod;\nATMO_NTRIP_CasterHost=unused;");
        assert!(validate(&v).is_ok());
        v.insert("PRODUCT_NTRIP_Type".into(), "CLAS".into());
        assert!(validate(&v).is_err());
        v.insert("PRODUCT_NTRIP_Type".into(), "HAS".into());
        assert!(validate(&v).is_ok());
        v.insert("GNSS_RefPoss".into(), "6378137,0,0".into());
        assert_eq!(reference(&v).unwrap(), Some([6378137., 0., 0.]));
        v.insert("GNSS_RefPoss".into(), "1,2,3".into());
        assert!(reference(&v).is_err());
    }
    #[test]
    fn rtk_requires_its_own_base_and_does_not_require_ppp_products() {
        let mut v=options::parse("GNSS_PMode=6;\nROVE_NTRIP_CasterHost=127.0.0.1;\nROVE_NTRIP_Port=2101;\nROVE_NTRIP_Mountpoint=rover;\nPRODUCT_NTRIP_Type=unused;");
        assert!(validate(&v).unwrap_err().contains("BASE"));
        v.extend(options::parse(
            "BASE_NTRIP_CasterHost=127.0.0.1;\nBASE_NTRIP_Port=2102;\nBASE_NTRIP_Mountpoint=base;",
        ));
        for mode in ["6", "7", "8"] {
            v.insert("GNSS_PMode".into(), mode.into());
            assert!(validate(&v).is_ok());
        }
        v.insert("BASE_NTRIP_Port".into(), "0".into());
        assert!(validate(&v).is_err());
    }
}

impl RealtimeRuntime {
    pub fn satellites(&self, run_id: &str) -> Result<Value, String> {
        let (id, state, directory) = {
            let d = self.data.lock().unwrap();
            (d.id.clone(), d.state.clone(), d.output_dir.clone())
        };
        if id != run_id || directory.is_empty() {
            return Err("会话已改变".into());
        }
        if state != "running" {
            return Ok(Value::Null);
        }
        let capability: Value = serde_json::from_slice(
            &fs::read(self.engine_dir.join("manifest.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if capability["capabilities"]["satellite_snapshot"] != SATELLITE_SNAPSHOT {
            return Err("此引擎不支持卫星快照".into());
        }
        let file = Path::new(&directory).join("satellites.json");
        let Ok(meta) = fs::metadata(&file) else {
            return Ok(Value::Null);
        };
        if meta.len() > 262144 {
            return Err("卫星快照超过大小限制".into());
        }
        use std::io::Read;
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        fs::File::open(file)
            .map_err(|e| e.to_string())?
            .take(262145)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 262144 {
            return Err("卫星快照超过大小限制".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        validate_satellite_snapshot(&value)?;
        Ok(value)
    }
}
/// Engine capability for `IPSClient_SatelliteFile` (snapshot schemaVersion 2). Each run writes into its own
/// directory, so the snapshot carries no run id.
const SATELLITE_SNAPSHOT: u64 = 3;
fn validate_satellite_snapshot(value: &Value) -> Result<(), String> {
    if value["schemaVersion"] != 2
        || value["sequence"].as_u64().is_none_or(|n| n == 0)
        || value["week"].as_u64().is_none_or(|n| n > 9999)
        || value["publishedAt"].as_i64().is_none_or(|n| n <= 0 || n > Utc::now().timestamp() + 10)
        || value["tow"].as_f64().is_none_or(|v| !v.is_finite() || !(0.0..604800.0).contains(&v))
    {
        return Err("卫星快照版本、会话或历元无效".into());
    }
    let rows = value["satellites"].as_array().ok_or("卫星快照缺少列表")?;
    if rows.len() > 512 {
        return Err("卫星数量超限".into());
    }
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let prn = row["prn"].as_str().ok_or("无效 PRN")?;
        if prn.len() != 3
            || !matches!(prn.as_bytes()[0], b'G' | b'C' | b'E' | b'R' | b'J')
            || !prn.as_bytes()[1..].iter().all(u8::is_ascii_digit)
            || !seen.insert(prn)
        {
            return Err("无效或重复 PRN".into());
        }
        for (key, min, max) in [("azimuth", 0., 360.), ("elevation", 0., 90.)] {
            if !row[key].is_null() && row[key].as_f64().is_none_or(|v| !v.is_finite() || v < min || v > max) {
                return Err("无效卫星角度".into());
            }
        }
        let system = match prn.as_bytes()[0] {
            b'G' => "GPS",
            b'C' => "BDS",
            b'E' => "GAL",
            b'R' => "GLO",
            _ => "QZSS",
        };
        if row["system"] != system || (!row["used"].is_null() && !row["used"].is_boolean()) {
            return Err("无效星座或参与状态".into());
        }
        let signals = row["signals"].as_array().ok_or("无效卫星信号列表")?;
        if signals.len() > 16 {
            return Err("卫星信号数量超限".into());
        }
        let mut slots = std::collections::HashSet::new();
        for signal in signals {
            if signal["slot"].as_u64().is_none_or(|n| n > 15 || !slots.insert(n))
                || signal["band"].as_str().is_none_or(|s| {
                    s.is_empty() || s.len() > 12 || !s.bytes().all(|c| c.is_ascii_alphanumeric())
                })
                || signal["signal"]
                    .as_str()
                    .is_none_or(|s| s.len() != 2 || !s.bytes().all(|c| c.is_ascii_alphanumeric()))
                || (!signal["used"].is_null() && !signal["used"].is_boolean())
                || (!signal["cn0"].is_null()
                    && signal["cn0"].as_f64().is_none_or(|n| !n.is_finite() || !(0.0..=100.0).contains(&n)))
            {
                return Err("无效卫星频点或载噪比".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod satellite_tests {
    use super::*;
    #[test]
    fn rejects_partial_old_and_invalid_signal_snapshots() {
        let valid = json!({"schemaVersion":2,"sequence":1,"week":2440,"tow":100.,"publishedAt":Utc::now().timestamp(),"satellites":[{"prn":"G01","system":"GPS","azimuth":null,"elevation":null,"used":null,"signals":[{"slot":0,"band":"L1","signal":"1C","cn0":null,"used":null}]}]});
        assert!(validate_satellite_snapshot(&valid).is_ok());
        let mut v = valid.clone();
        v["schemaVersion"] = json!(1);
        assert!(validate_satellite_snapshot(&v).is_err());
        let mut v = valid.clone();
        v["satellites"][0]["signals"][0]["cn0"] = json!(999.);
        assert!(validate_satellite_snapshot(&v).is_err());
        let mut v = valid.clone();
        v["satellites"][0]["system"] = json!("BDS");
        assert!(validate_satellite_snapshot(&v).is_err());
        let mut v = valid.clone();
        v["satellites"].as_array_mut().unwrap().push(valid["satellites"][0].clone());
        assert!(validate_satellite_snapshot(&v).is_err());
        assert!(validate_satellite_snapshot(&json!({"schemaVersion":2})).is_err());
    }
}
