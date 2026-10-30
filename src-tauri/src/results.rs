use crate::{
    gnss_log::{Field, Rule},
    table::{Cell, Table},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealEpoch {
    pub time: String,
    pub e: f64,
    pub n: f64,
    pub u: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub satellites: i32,
    pub solution: String,
    pub raw_quality: u8,
    pub gps_week: u32,
    pub tow: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealResult {
    pub id: String,
    pub name: String,
    pub station: String,
    pub source: String,
    pub epochs: Vec<RealEpoch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_xyz: Option<[f64; 3]>,
    pub reference_kind: String,
    pub total_rows: usize,
    pub rejected_rows: usize,
    pub quality_counts: HashMap<String, usize>,
    pub output_dir: String,
    pub log_path: String,
    pub engine_commit: String,
    #[serde(default)]
    pub diagnostics: Table,
    #[serde(default)]
    pub analysis_config: HashMap<String, String>,
    #[serde(default)]
    pub duplicate_rows: usize,
    #[serde(default)]
    pub is_live_cache: bool,
    #[serde(default)]
    pub product_history: Vec<serde_json::Value>,
    #[serde(default)]
    pub run_id: String,
    #[serde(default)]
    pub solution_mode: String,
    #[serde(default)]
    pub log_version: u8,
    #[serde(default)]
    pub engine_build_id: String,
    #[serde(default)]
    pub ntrip_log_path: Option<String>,
    #[serde(default)]
    pub product_log_path: Option<String>,
    #[serde(default)]
    pub client_status: serde_json::Value,
}

pub fn product_metric(v: &serde_json::Value) -> Option<serde_json::Value> {
    let stamp = v["arrivalUnix"].as_i64()?;
    let dt = chrono::DateTime::from_timestamp(stamp, 0)?;
    let mut metric = serde_json::Map::new();
    metric.insert("time".into(), serde_json::json!(dt.to_rfc3339()));
    for key in ["orbit", "clock", "code", "phase"] {
        let rows: Vec<_> =
            v["products"].as_array().into_iter().flatten().filter(|r| r["component"] == key).collect();
        let counts: Vec<_> = rows.iter().filter_map(|r| r["fresh"].as_u64()).collect();
        let count = if counts.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!(counts.iter().sum::<u64>())
        };
        let age = rows
            .iter()
            .filter(|r| r["fresh"].as_u64().is_some())
            .filter_map(|r| r["age"].as_f64())
            .filter(|v| v.is_finite())
            .min_by(|a, b| a.abs().total_cmp(&b.abs()));
        metric.insert(key.into(), count);
        metric.insert(format!("{key}Age"), serde_json::json!(age));
    }
    Some(serde_json::Value::Object(metric))
}

pub fn config_summary(text: &str) -> HashMap<String, String> {
    crate::options::parse(text)
        .into_iter()
        .filter(|(k, _)| {
            let lower = k.to_ascii_lowercase();
            !["password", "userid", "token", "secret", "user"].iter().any(|s| lower.contains(s))
                && ((k.starts_with("GNSS_") && !["GNSS_FilePath", "GNSS_ShareEPHPath"].contains(&k.as_str()))
                    || [
                        "PRODUCT_NTRIP_Type",
                        "ROVE_NTRIP_Mountpoint",
                        "ROVE_NTRIP_DataType",
                        "PRODUCT_NTRIP_DataType",
                        "BIAS_NTRIP_DataType",
                        "ATMO_NTRIP_DataType",
                    ]
                    .contains(&k.as_str()))
        })
        .collect()
}

/// Validated time and solution of one Log=4 row. Any invalid row rejects the whole log.
pub struct Stamp {
    pub week: u32,
    pub tow: f64,
    pub time: String,
    pub solution: &'static str,
}
pub fn stamp<'a>(get: impl Fn(&str) -> Option<&'a str>) -> Result<Stamp, String> {
    let q = get("Q").and_then(|s| s.parse::<u8>().ok()).filter(|q| *q <= 8).ok_or("未知解状态定义")?;
    let week = get("Week").and_then(|s| s.parse::<u32>().ok()).filter(|w| *w > 0).ok_or("GPS 周数无效")?;
    let tow = get("TOW")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|t| t.is_finite() && (0.0..604800.0).contains(t))
        .ok_or("GPS 周内秒无效")?;
    let dt = chrono::NaiveDateTime::parse_from_str(get("UTC").ok_or("缺少 UTC")?, "%Y%m%d%H%M%S%.f")
        .map_err(|_| "日志 UTC 格式无效")?;
    Ok(Stamp {
        week,
        tow,
        time: dt.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        solution: quality_name(q),
    })
}

/// Preserve all current native fields, including signed atmosphere and RTK coordinates.
pub fn diagnostic(fields: &HashMap<&str, &str>) -> Result<serde_json::Value, String> {
    let mut m = serde_json::Map::new();
    for (key, raw) in fields {
        if *key == "UTC" {
            continue;
        }
        let decoded = match Rule::of(key).field(raw) {
            Field::Number(v) => serde_json::json!(v),
            Field::Missing => serde_json::Value::Null,
            Field::Text(s) => serde_json::json!(s),
        };
        m.insert((*key).into(), decoded);
    }
    let s = stamp(|k| fields.get(k).copied())?;
    m.insert("Week".into(), serde_json::json!(s.week));
    m.insert("TOW".into(), serde_json::json!(s.tow));
    m.insert("time".into(), serde_json::json!(s.time));
    m.insert("solution".into(), serde_json::json!(s.solution));
    Ok(serde_json::Value::Object(m))
}

fn cell(field: Field) -> Cell {
    match field {
        Field::Number(v) => Cell::Number(v),
        Field::Missing => Cell::Null,
        Field::Text(s) => Cell::Text(s),
    }
}

/// Decoding rule and diagnostics column of every header column (none for UTC, which becomes `time`).
struct Layout {
    columns: Vec<(Rule, Option<usize>)>,
    position: HashMap<String, usize>,
    stamp: [usize; 4],
}
impl Layout {
    fn new(header: &[String], table: &mut Table) -> Self {
        Self {
            columns: header.iter().map(|k| (Rule::of(k), (k != "UTC").then(|| table.column(k)))).collect(),
            position: header.iter().enumerate().map(|(i, k)| (k.clone(), i)).collect(),
            stamp: ["Week", "TOW", "time", "solution"].map(|k| table.column(k)),
        }
    }
}

pub fn find_solution_logs(root: &Path) -> Vec<PathBuf> {
    let mut logs = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return logs;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_symlink()) {
            continue;
        }
        if p.is_dir() {
            logs.extend(find_solution_logs(&p));
        } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("log"))
            && p.file_name().is_some_and(|e| !e.eq_ignore_ascii_case("console.log"))
        {
            if let Ok(file) = fs::File::open(&p) {
                if BufReader::new(file)
                    .lines()
                    .take(256)
                    .map_while(Result::ok)
                    .any(|l| l.split_whitespace().any(|s| s == "Log=4"))
                {
                    logs.push(p);
                }
            }
        }
    }
    logs.sort();
    logs
}
pub fn find_solution_log(root: &Path) -> Option<PathBuf> {
    let mut paths = find_solution_logs(root);
    if paths.len() == 1 {
        paths.pop()
    } else {
        None
    }
}

pub fn quality_name(q: u8) -> &'static str {
    match q {
        0 => "NONE",
        1 => "SPP",
        2 => "SPP_EKF",
        3 => "PRE",
        4 => "CODE",
        5 => "FLOAT",
        6 => "FLOFIX",
        7 => "FIX",
        8 => "HOLD",
        _ => "UNKNOWN",
    }
}

pub fn enu(xyz: [f64; 3], origin: [f64; 3]) -> [f64; 3] {
    let [x, y, z] = origin;
    let lon = y.atan2(x);
    let p = x.hypot(y);
    let mut lat = z.atan2(p * (1.0 - 0.00669437999014));
    for _ in 0..10 {
        let radius = 6378137.0 / (1.0 - 0.00669437999014 * lat.sin().powi(2)).sqrt();
        lat = (z + 0.00669437999014 * radius * lat.sin()).atan2(p);
    }
    let [dx, dy, dz] = [xyz[0] - x, xyz[1] - y, xyz[2] - z];
    [
        -lon.sin() * dx + lon.cos() * dy,
        -lat.sin() * lon.cos() * dx - lat.sin() * lon.sin() * dy + lat.cos() * dz,
        lat.cos() * lon.cos() * dx + lat.cos() * lon.sin() * dy + lat.sin() * dz,
    ]
}

pub fn read_solution(path: &Path, reference: Option<[f64; 3]>) -> Result<RealResult, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut header = crate::gnss_log::Header::default();
    let mut epochs = Vec::new();
    let mut total = 0;
    let mut rejected = 0;
    let mut counts = HashMap::new();
    let mut origin = reference;
    let mut last_time = None;
    let mut diagnostics = Table::default();
    let mut layout: Option<Layout> = None;
    let mut diagnostic_keys = std::collections::HashSet::new();
    let mut duplicate_rows = 0;
    let mut reader = BufReader::new(file);
    let mut buffer = String::new();
    loop {
        buffer.clear();
        if reader.read_line(&mut buffer).map_err(|e| e.to_string())? == 0 {
            break;
        }
        let complete = buffer.ends_with('\n');
        let line = buffer.trim_end_matches(['\r', '\n']);
        if line.starts_with('#') {
            header.line(line)?;
            layout = None;
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let values = match header.values(line) {
            Ok(values) => values,
            Err(_) if !complete => break,
            Err(error) => return Err(error),
        };
        let layout = layout.get_or_insert_with(|| Layout::new(&header.columns, &mut diagnostics));
        let get = |key: &str| layout.position.get(key).map(|&i| values[i]);
        let number =
            |key: &str| layout.position.get(key).and_then(|&i| layout.columns[i].0.number(values[i]));
        total += 1;
        let stamp = stamp(get)?;
        let key = number("Week").zip(number("TOW")).map(|(w, t)| ((w * 604800. + t) * 1000.).round() as i64);
        if key.is_none_or(|k| diagnostic_keys.insert(k)) {
            for (i, (rule, column)) in layout.columns.iter().enumerate() {
                if let Some(c) = column {
                    diagnostics.put(*c, cell(rule.field(values[i])));
                }
            }
            let [week, tow, time, solution] = layout.stamp;
            diagnostics.put(week, Cell::Number(stamp.week as f64));
            diagnostics.put(tow, Cell::Number(stamp.tow));
            diagnostics.put(time, Cell::Text(&stamp.time));
            diagnostics.put(solution, Cell::Text(stamp.solution));
            diagnostics.end_row();
        } else {
            duplicate_rows += 1;
        }
        let q = number("Q").ok_or("缺少有效的 Q 列")?;
        if q.fract() != 0.0 || !(0.0..=8.0).contains(&q) {
            return Err("未知解状态定义".into());
        }
        let q = q as u8;
        *counts.entry(quality_name(q)).or_insert(0) += 1;
        let xyz = [
            number("X").unwrap_or(f64::NAN),
            number("Y").unwrap_or(f64::NAN),
            number("Z").unwrap_or(f64::NAN),
        ];
        if !matches!(q, 1 | 2 | 4 | 5 | 6 | 7 | 8)
            || xyz.iter().any(|v| !v.is_finite() || *v <= -99999998.0)
            || xyz.iter().map(|x| x * x).sum::<f64>().sqrt() < 1e6
        {
            rejected += 1;
            continue;
        }
        let week = number("Week").ok_or("缺少 Week")?;
        let tow = number("TOW").ok_or("缺少 TOW")?;
        if week.fract() != 0.0 || !(0.0..604800.0).contains(&tow) {
            return Err("GPS 时间无效".into());
        }
        let gps = week * 604800.0 + tow;
        if last_time.is_some_and(|t| gps < t) {
            return Err("解算日志时间倒退，不能合并绘图".into());
        }
        if last_time == Some(gps) {
            rejected += 1;
            continue;
        }
        last_time = Some(gps);
        let origin = *origin.get_or_insert(xyz);
        let [e, n, u] = enu(xyz, origin);
        epochs.push(RealEpoch {
            time: stamp.time,
            e,
            n,
            u,
            x: xyz[0],
            y: xyz[1],
            z: xyz[2],
            satellites: number("FloUse").or_else(|| number("SppS")).unwrap_or(0.0).max(0.0) as i32,
            solution: quality_name(q).into(),
            raw_quality: q,
            gps_week: week as u32,
            tow,
        });
    }
    diagnostics.sort_columns();
    let reference_xyz = origin.ok_or("日志没有有效定位历元")?;
    if epochs.is_empty() {
        return Err("日志没有有效定位历元".into());
    }
    Ok(RealResult {
        id: String::new(),
        name: String::new(),
        station: String::new(),
        source: "ipspos".into(),
        epochs,
        reference_xyz: Some(reference_xyz),
        reference_kind: if reference.is_some() { "configured" } else { "first-valid" }.into(),
        total_rows: total,
        rejected_rows: rejected,
        quality_counts: counts.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        output_dir: String::new(),
        log_path: path.to_string_lossy().into(),
        engine_commit: String::new(),
        diagnostics,
        analysis_config: HashMap::new(),
        duplicate_rows,
        is_live_cache: false,
        product_history: Vec::new(),
        run_id: String::new(),
        solution_mode: header.mode,
        log_version: 4,
        engine_build_id: String::new(),
        ntrip_log_path: None,
        product_log_path: None,
        client_status: serde_json::Value::Null,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn product_snapshots_distinguish_zero_and_unknown_without_inventing_receive_time() {
        let v = serde_json::json!({"arrivalUnix":1792195200,"products":[{"component":"orbit","fresh":0,"age":12.}]});
        let m = product_metric(&v).unwrap();
        assert_eq!(m["orbit"], 0);
        assert_eq!(m["orbitAge"], 12.);
        assert!(m["clock"].is_null());
        assert!(product_metric(&serde_json::json!({"week":2440,"tow":100})).is_none());
    }
    #[test]
    fn product_counts_and_age_do_not_turn_unknown_into_zero_or_hide_valid_age() {
        let m=product_metric(&serde_json::json!({"arrivalUnix":1792195200,"products":[{"component":"orbit","fresh":null,"age":-1},{"component":"orbit","fresh":8,"age":5.},{"component":"clock","fresh":null,"age":-1}]})).unwrap();
        assert_eq!(m["orbit"], 8);
        assert_eq!(m["orbitAge"], 5.);
        assert!(m["clock"].is_null());
        assert!(m["clockAge"].is_null());
    }
    #[test]
    fn comparison_metadata_never_copies_connection_credentials() {
        let m=config_summary("GNSS_ARMode=2;\nGNSS_SP3File=D:/product.sp3;\nGNSS_UserPassword=private;\nROVE_NTRIP_UserID=private;\nROVE_NTRIP_Password=private;\nPRODUCT_NTRIP_Type=SSR;");
        assert_eq!(m.len(), 3);
        assert!(!serde_json::to_string(&m).unwrap().contains("private"));
    }
    #[test]
    fn future_product_age_retains_its_native_sign() {
        let m = product_metric(&serde_json::json!({"arrivalUnix":1792195200,"products":[
            {"component":"orbit","fresh":8,"age":-2.},{"component":"orbit","fresh":4,"age":5.}]}))
        .unwrap();
        assert_eq!(m["orbit"], 12);
        assert_eq!(m["orbitAge"], -2.);
    }
    #[test]
    fn ecef_to_local_has_known_axes() {
        let p = enu([6378138.0, 2.0, 3.0], [6378137.0, 0.0, 0.0]);
        assert_eq!(p, [2.0, 3.0, 1.0]);
    }
    #[test]
    fn preserves_partial_fixed_and_hold() {
        assert_eq!(quality_name(6), "FLOFIX");
        assert_eq!(quality_name(8), "HOLD");
    }
    #[test]
    fn named_log_parser_excludes_invalid_startup_without_inventing_time() {
        let path = std::env::temp_dir().join(format!("findyou-log-{}.log", uuid::Uuid::new_v4()));
        let header = "# Program: IPSPOS Log=4\n# Mode : PPP\n#Week TOW UTC X Y Z Q FloUse\n# END OF HEADER\n";
        let rows="2086 0 20200102000000.00 -99999999.999 -99999999.999 -99999999.999 0 0\n2438 1 20261001000000.00 6378137 0 0 6 20\n2438 2 20261001000001.00 6378138 2 3 8 21\n";
        fs::write(&path, format!("{header}{rows}")).unwrap();
        let result = read_solution(&path, None).unwrap();
        assert_eq!(result.total_rows, 3);
        assert_eq!(result.rejected_rows, 1);
        assert_eq!(result.epochs.len(), 2);
        assert_eq!(result.epochs[0].time, "2026-10-01T00:00:00.000Z");
        assert_eq!(result.epochs[0].solution, "FLOFIX");
        assert_eq!(result.epochs[1].solution, "HOLD");
        assert_eq!([result.epochs[1].e, result.epochs[1].n, result.epochs[1].u], [2.0, 3.0, 1.0]);
        fs::write(&path, format!("{header}{rows}bad complete row\n")).unwrap();
        assert!(read_solution(&path, None).is_err());
        fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod filename_tests {
    use super::*;
    #[test]
    fn case_names_and_uppercase_extension_are_content_discovered() {
        let root = std::env::temp_dir().join(format!("named-results-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let first = root.join("rover_STA_BetaV0.611.LOG");
        fs::write(&first, "# Program : IPSPOS BetaV0.611 Log=4\n").unwrap();
        fs::write(root.join("NTRIP.log"), "# StatusLog=1").unwrap();
        assert_eq!(find_solution_log(&root), Some(first.clone()));
        let second = root.join("rover_KIN_BetaV0.611.log");
        fs::write(&second, "# Program : IPSPOS Log=4\n").unwrap();
        assert_eq!(find_solution_logs(&root).len(), 2);
        assert!(find_solution_log(&root).is_none());
        for p in [first, second, root.join("NTRIP.log")] {
            fs::remove_file(p).unwrap();
        }
        fs::remove_dir(root).unwrap();
    }
}
