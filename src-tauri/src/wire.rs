//! Binary transfer of analysis results to the page (`src/services/result-wire.ts` decodes it).
//!
//! As JSON a 47 h, 1 Hz result is ~180 MiB that WebView2 copies and then parses on the UI thread. Here every
//! epoch and diagnostic field travels as one little-endian column, and the page rebuilds the same row objects.
//! For the 47 h ALLOY logs this is ~60 MiB instead of ~370 MiB for two results.
//!
//! The encoding is lossless, checked per column over every value:
//! - fixed-decimal numbers (most Log=4 fields) become i16/i32 codes with a decimal `scale`;
//! - other numbers use f32 when each value round-trips exactly, otherwise f64;
//! - `time` strings travel as UTC milliseconds only when each is the canonical `…T…:…:….sssZ` form;
//! - text becomes label indices; anything else stays plain JSON.
//!
//! Layout: u32 header length, header JSON, zero padding to 8 bytes, then the columns, each 8-byte aligned.
//! Header: `{ results: [{ meta, epochs: Table, diagnostics: Table }] }`, where `meta` is the result without
//! its two tables and `Table = { rows, columns: [{ name, kind, offset?, scale?, labels?, values? }] }`.
//! Kinds: `i16` / `i32` (code / 10^scale; MIN = null), `f32` / `f64` (NaN = null), `time` (f64 ms,
//! NaN = null), `text` (u16 label index, 0xFFFF = null), `json` (`values` inline).
//! `tests/fixtures/result-wire.*` pins the format for both sides.
use crate::{
    results::RealResult,
    table::{Cell, Data, Table},
};
use serde_json::{json, Value};
use std::collections::HashMap;

const NULL_LABEL: u16 = u16::MAX;

/// Raw IPC body: `invoke` resolves with an ArrayBuffer instead of parsing JSON.
pub fn response(results: Vec<RealResult>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(encode(results))
}

pub fn encode(results: Vec<RealResult>) -> Vec<u8> {
    // Results are encoded on their own threads with offsets local to their block, then placed one after another.
    let blocks: Vec<(Vec<u8>, Value)> = std::thread::scope(|s| {
        let jobs: Vec<_> = results.into_iter().map(|r| s.spawn(move || block(r))).collect();
        jobs.into_iter().map(|j| j.join().expect("result encoding panicked")).collect()
    });
    let mut data = Vec::new();
    let mut headers = Vec::new();
    for (bytes, mut header) in blocks {
        for table in ["epochs", "diagnostics"] {
            for c in header[table]["columns"].as_array_mut().into_iter().flatten() {
                if let Some(offset) = c["offset"].as_u64() {
                    c["offset"] = json!(offset as usize + data.len());
                }
            }
        }
        data.extend_from_slice(&bytes);
        headers.push(header);
    }
    let header = serde_json::to_vec(&json!({ "results": headers })).unwrap();
    let mut out = Vec::with_capacity(8 + header.len() + data.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.resize(out.len().next_multiple_of(8), 0);
    out.extend_from_slice(&data);
    out
}

/// One result's columns (8-byte padded, so blocks can be concatenated) and its header entry.
fn block(mut r: RealResult) -> (Vec<u8>, Value) {
    let mut data = Vec::new();
    let epochs = table(&mut data, &epoch_table(&r));
    let diagnostics = table(&mut data, &r.diagnostics);
    data.resize(data.len().next_multiple_of(8), 0);
    r.epochs = Vec::new();
    r.diagnostics = Table::default();
    (data, json!({ "meta": r, "epochs": epochs, "diagnostics": diagnostics }))
}

fn epoch_table(r: &RealResult) -> Table {
    let mut t = Table::default();
    let names =
        ["time", "e", "n", "u", "x", "y", "z", "satellites", "solution", "rawQuality", "gpsWeek", "tow"];
    let columns = names.map(|n| t.column(n));
    for e in &r.epochs {
        let numbers = [e.e, e.n, e.u, e.x, e.y, e.z, e.satellites as f64];
        t.put(columns[0], Cell::Text(&e.time));
        for (i, v) in numbers.into_iter().enumerate() {
            t.put(columns[i + 1], Cell::Number(v));
        }
        t.put(columns[8], Cell::Text(&e.solution));
        t.put(columns[9], Cell::Number(e.raw_quality as f64));
        t.put(columns[10], Cell::Number(e.gps_week as f64));
        t.put(columns[11], Cell::Number(e.tow));
        t.end_row();
    }
    t
}

fn table(data: &mut Vec<u8>, t: &Table) -> Value {
    let columns: Vec<Value> = t.columns().iter().map(|c| column(data, &c.name, &c.data)).collect();
    json!({ "rows": t.len(), "columns": columns })
}

fn column(data: &mut Vec<u8>, name: &str, values: &Data) -> Value {
    data.resize(data.len().next_multiple_of(8), 0);
    let offset = data.len();
    match values {
        Data::Numbers(v) => {
            let scaled = decimal(v);
            let short = |c: &Option<i32>| c.is_none_or(|c| c > i16::MIN as i32 && c <= i16::MAX as i32);
            if let Some((scale, codes)) = scaled.as_ref().filter(|(_, c)| c.iter().all(short)) {
                codes
                    .iter()
                    .for_each(|c| data.extend_from_slice(&c.map_or(i16::MIN, |c| c as i16).to_le_bytes()));
                json!({ "name": name, "kind": "i16", "offset": offset, "scale": scale })
            } else if v.iter().all(|x| x.is_nan() || (*x as f32) as f64 == *x) {
                v.iter().for_each(|x| data.extend_from_slice(&(*x as f32).to_le_bytes()));
                json!({ "name": name, "kind": "f32", "offset": offset })
            } else if let Some((scale, codes)) = scaled {
                codes.iter().for_each(|c| data.extend_from_slice(&c.unwrap_or(i32::MIN).to_le_bytes()));
                json!({ "name": name, "kind": "i32", "offset": offset, "scale": scale })
            } else {
                v.iter().for_each(|x| data.extend_from_slice(&x.to_le_bytes()));
                json!({ "name": name, "kind": "f64", "offset": offset })
            }
        }
        Data::Text(v) => {
            if let Some(ms) = times(v) {
                ms.iter().for_each(|x| data.extend_from_slice(&x.to_le_bytes()));
                return json!({ "name": name, "kind": "time", "offset": offset });
            }
            let mut labels: Vec<&str> = Vec::new();
            let mut index = HashMap::new();
            let mut codes = Vec::with_capacity(v.len());
            for s in v {
                codes.push(match s {
                    None => NULL_LABEL,
                    Some(s) => *index.entry(s.as_str()).or_insert_with(|| {
                        labels.push(s);
                        labels.len() as u16 - 1
                    }),
                });
                if labels.len() >= NULL_LABEL as usize {
                    return json!({ "name": name, "kind": "json", "values": v });
                }
            }
            codes.iter().for_each(|x| data.extend_from_slice(&x.to_le_bytes()));
            json!({ "name": name, "kind": "text", "offset": offset, "labels": labels })
        }
        Data::Values(v) => json!({ "name": name, "kind": "json", "values": v }),
    }
}

/// Exact powers of ten. The page divides by the same table; IEEE division is correctly rounded on both sides, so
/// `code / 10^scale` reproduces the double that parsing the log's fixed-decimal text gave.
const POW10: [f64; 10] = [1., 10., 100., 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];

/// The smallest decimal scale at which every value is an i32 code that divides back bit-exactly (`-0.0` and
/// values with more digits do not qualify); `None` entries are nulls.
fn decimal(values: &[f64]) -> Option<(usize, Vec<Option<i32>>)> {
    let code = |x: f64, scale: usize| {
        let c = (x * POW10[scale]).round();
        let c = (c > i32::MIN as f64 && c <= i32::MAX as f64).then_some(c as i32)?;
        ((c as f64 / POW10[scale]).to_bits() == x.to_bits()).then_some(c)
    };
    let mut scale = 0;
    for &x in values.iter().filter(|x| !x.is_nan()) {
        while code(x, scale).is_none() {
            scale += 1;
            if scale == POW10.len() {
                return None;
            }
        }
    }
    let codes = values.iter().map(|&x| if x.is_nan() { Some(None) } else { code(x, scale).map(Some) });
    Some((scale, codes.collect::<Option<Vec<_>>>()?))
}

/// UTC milliseconds, only when `new Date(ms).toISOString()` in the page gives back every string exactly.
fn times(values: &[Option<String>]) -> Option<Vec<f64>> {
    values
        .iter()
        .map(|s| match s {
            None => Some(f64::NAN),
            Some(s) => {
                let t = chrono::DateTime::parse_from_rfc3339(s).ok()?.to_utc();
                let canonical = t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                (canonical == *s && (0..=9999).contains(&chrono::Datelike::year(&t)))
                    .then_some(t.timestamp_millis() as f64)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::results::RealEpoch;

    fn header(bytes: &[u8]) -> (Value, &[u8]) {
        let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        let header = serde_json::from_slice(&bytes[4..4 + len]).unwrap();
        (header, &bytes[(4 + len).next_multiple_of(8)..])
    }

    /// One result touching every column kind; also the fixture for tests/result-wire.test.ts.
    fn sample() -> RealResult {
        let mut r: RealResult = serde_json::from_value(json!({
            "id": "log-1", "name": "KIN · 1", "station": "WHU", "source": "ipspos", "epochs": [],
            "referenceXyz": [-2267750.123, 5009154.456, 3221294.789], "referenceKind": "first-valid",
            "totalRows": 3, "rejectedRows": 1, "qualityCounts": {"FIX": 2}, "outputDir": "D:/out",
            "logPath": "D:/out/a.log", "engineCommit": "abc", "solutionMode": "PPP", "logVersion": 4,
            "productHistory": [{"time": "2026-10-01T00:00:00.000Z", "orbit": 12, "orbitAge": null}]
        }))
        .unwrap();
        r.diagnostics = Table::from_rows(
            json!([
                {"Obs": 31, "Ratio": 2.5, "PDOP": 1.13, "ZTD": 2.3456, "X": -2267750.1234, "ZWDUCor": -0.0,
                 "Big": 123456.789, "Fine": 0.1234567891, "time": "2026-10-01T00:00:00.000Z", "solution": "FIX",
                 "Note": "2026-10-01T00:00:00Z", "Week": 2438.0},
                {"Obs": null, "Ratio": 3.0, "PDOP": null, "ZTD": -0.0012, "X": 6378137.0001, "ZWDUCor": 0.5,
                 "Big": null, "Fine": 1e-12, "time": "2026-10-01T00:00:01.250Z", "solution": null, "Note": 4,
                 "Week": 2438.0}
            ])
            .as_array()
            .unwrap(),
        );
        r.epochs = vec![RealEpoch {
            time: "2026-10-01T00:00:00.000Z".into(),
            e: 0.0123,
            n: -0.5,
            u: 1.0 / 3.0,
            x: -2267750.1234,
            y: 5009154.4567,
            z: 3221294.789,
            satellites: 21,
            solution: "FIX".into(),
            raw_quality: 7,
            gps_week: 2438,
            tow: 345600.5,
        }];
        r
    }

    #[test]
    fn columns_pick_the_smallest_lossless_kind() {
        let bytes = encode(vec![sample()]);
        let (h, data) = header(&bytes);
        let d = &h["results"][0]["diagnostics"];
        assert_eq!(d["rows"], 2);
        assert!(h["results"][0]["meta"]["diagnostics"].as_array().unwrap().is_empty());
        let column =
            |name: &str| d["columns"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
        let kind = |name: &str| (column(name)["kind"].clone(), column(name)["scale"].clone());
        assert_eq!(kind("Obs"), (json!("i16"), json!(0)));
        assert_eq!(kind("Ratio"), (json!("i16"), json!(1)));
        assert_eq!(kind("PDOP"), (json!("i16"), json!(2)));
        assert_eq!(kind("ZTD"), (json!("i16"), json!(4)));
        assert_eq!(kind("Big"), (json!("i32"), json!(3)));
        assert_eq!(kind("Week"), (json!("i16"), json!(0)));
        // -0.0 cannot be an integer code, and these need more digits than an i32 holds.
        assert_eq!(kind("ZWDUCor").0, "f32");
        assert_eq!(kind("X").0, "f64");
        assert_eq!(kind("Fine").0, "f64");
        assert_eq!(kind("time").0, "time");
        assert_eq!(kind("solution").0, "text");
        assert_eq!(kind("Note").0, "json");
        let at = column("time")["offset"].as_u64().unwrap() as usize;
        assert_eq!(f64::from_le_bytes(data[at + 8..at + 16].try_into().unwrap()), 1790812801250.);
        let at = column("X")["offset"].as_u64().unwrap() as usize;
        assert_eq!(f64::from_le_bytes(data[at + 8..at + 16].try_into().unwrap()), 6378137.0001);
    }

    #[test]
    fn decimal_codes_divide_back_exactly() {
        let values = [0.1, 0.29, 1.005, -12.345, 2.3456, f64::NAN];
        let (scale, codes) = decimal(&values).unwrap();
        assert_eq!(scale, 4);
        for (x, c) in values.iter().zip(codes) {
            assert!(c.map_or(x.is_nan(), |c| (c as f64 / POW10[scale]).to_bits() == x.to_bits()));
        }
        assert!(decimal(&[-0.0]).is_none());
        assert!(decimal(&[1.0 / 3.0]).is_none());
    }

    /// tests/fixtures/result-wire.{bin,json}: the page decoder must turn these bytes into this JSON.
    /// Regenerate after a deliberate format change with `UPDATE_WIRE_FIXTURE=1 cargo test --bin findyou wire`.
    #[test]
    fn page_fixture_is_current() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let bytes = encode(vec![sample()]);
        let expected = serde_json::to_vec_pretty(&[sample()]).unwrap();
        if std::env::var_os("UPDATE_WIRE_FIXTURE").is_some() {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("result-wire.bin"), &bytes).unwrap();
            std::fs::write(dir.join("result-wire.json"), &expected).unwrap();
        }
        assert_eq!(std::fs::read(dir.join("result-wire.bin")).unwrap(), bytes);
        // Compared as JSON values: a checkout may convert the text fixture's line endings.
        let fixture: Value =
            serde_json::from_slice(&std::fs::read(dir.join("result-wire.json")).unwrap()).unwrap();
        assert_eq!(fixture, serde_json::from_slice::<Value>(&expected).unwrap());
    }
}
