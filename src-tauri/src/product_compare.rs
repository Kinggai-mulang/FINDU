//! Orbit and clock product comparison: one reference set of SP3 / RINEX clock files against any number of test sets.
//! Pure file analysis, no engine involved. Reference and test epochs are matched exactly; nothing is interpolated in
//! time, only the reference velocity (for the radial / along / cross frame) is derived from the reference orbit.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;

const C: f64 = 299_792_458.0;
const MAX_FILE: u64 = 600 * 1024 * 1024;
/// Earth's gravitational constant (m^3/s^2) and rotation rate (rad/s), for the orbit type of a satellite.
const MU: f64 = 3.986_004_418e14;
const EARTH_ROTATION: f64 = 7.292_115_146_7e-5;
/// Satellite-to-satellite clock steps above this (metres) between consecutive 30 s epochs count as a jump.
const JUMP_METRES: f64 = 0.5;
/// Unix time of the GPS epoch, 1980-01-06 00:00:00 UTC.
const GPS_UNIX: i64 = 315_964_800;
/// UTC dates on which a leap second was added after the GPS epoch; GPST-UTC grows by one on each.
const LEAP_DATES: [(i64, i64, i64); 18] = [
    (1981, 7, 1),
    (1982, 7, 1),
    (1983, 7, 1),
    (1985, 7, 1),
    (1988, 1, 1),
    (1990, 1, 1),
    (1991, 1, 1),
    (1992, 7, 1),
    (1993, 7, 1),
    (1994, 7, 1),
    (1996, 1, 1),
    (1997, 7, 1),
    (1999, 1, 1),
    (2006, 1, 1),
    (2009, 1, 1),
    (2012, 7, 1),
    (2015, 7, 1),
    (2017, 1, 1),
];

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProductSet {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sp3: Vec<String>,
    #[serde(default)]
    pub clk: Vec<String>,
    /// Legacy manual removal flag; orbit_mode takes precedence when supplied.
    #[serde(default)]
    pub apc: bool,
    #[serde(default)]
    pub orbit_mode: Option<OrbitMode>,
    #[serde(default)]
    pub orbit_source: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OrbitMode {
    Auto,
    Keep,
    Remove,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrbitDecision {
    mode: OrbitMode,
    applied: bool,
    reason: String,
    radial_offsets: BTreeMap<String, f64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompareRequest {
    pub reference: ProductSet,
    pub tests: Vec<ProductSet>,
    /// Satellites left out of every statistic, including the per-epoch clock datum taken from the others.
    #[serde(default)]
    pub exclude: Vec<String>,
}

/// Orbit and clock samples of one satellite. Times are milliseconds since the GPS epoch, in GPST.
#[derive(Default, Clone)]
struct Satellite {
    t: Vec<i64>,
    pos: Vec<[f64; 3]>,
    clk: Vec<Option<f64>>,
}

#[derive(Default)]
pub(crate) struct Products {
    orbits: BTreeMap<String, Satellite>,
    clocks: BTreeMap<String, Vec<(i64, f64)>>,
    time_system: String,
}

pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Milliseconds since the GPS epoch for a calendar time written in GPST.
fn gps_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: f64) -> i64 {
    let days = days_from_civil(y, mo, d) - days_from_civil(1980, 1, 6);
    ((days * 86_400 + h * 3600 + mi * 60) as f64 * 1000.0 + s * 1000.0).round() as i64
}

/// Unix milliseconds (UTC) of a GPST instant.
fn utc_unix_ms(gps_ms: i64) -> i64 {
    let seconds = gps_ms.div_euclid(1000);
    let mut offset = 0;
    for (i, (y, m, d)) in LEAP_DATES.iter().enumerate() {
        // The leap takes effect at UTC midnight, which is (i + 1) seconds later in GPST than the plain day count.
        let day = days_from_civil(*y, *m, *d) - days_from_civil(1980, 1, 6);
        if seconds >= day * 86_400 + (i as i64 + 1) {
            offset = i as i64 + 1;
        }
    }
    (GPS_UNIX + seconds - offset) * 1000 + gps_ms.rem_euclid(1000)
}

fn parse_sp3(text: &str, into: &mut Products) -> Result<(), String> {
    let mut t = None;
    let mut epochs = 0;
    for line in text.lines() {
        if line.starts_with("%c") && into.time_system.is_empty() {
            let system = line.get(9..12).unwrap_or("").trim();
            if !system.is_empty() && system != "ccc" {
                into.time_system = system.to_string();
            }
        } else if let Some(rest) = line.strip_prefix('*') {
            let p: Vec<&str> = rest.split_whitespace().collect();
            if p.len() < 6 {
                return Err(format!("SP3 历元行格式错误：{line}"));
            }
            let n = |i: usize| p[i].parse::<i64>().map_err(|_| format!("SP3 历元行格式错误：{line}"));
            let s = p[5].parse::<f64>().map_err(|_| format!("SP3 历元行格式错误：{line}"))?;
            t = Some(gps_ms(n(0)?, n(1)?, n(2)?, n(3)?, n(4)?, s));
            epochs += 1;
        } else if line.starts_with('P') && line.len() >= 46 {
            let Some(t) = t else { continue };
            let Some(sat) = line.get(1..4).map(|s| s.replace(' ', "0")) else { continue };
            let field =
                |i: usize| line.get(4 + 14 * i..18 + 14 * i).and_then(|s| s.trim().parse::<f64>().ok());
            let (Some(x), Some(y), Some(z)) = (field(0), field(1), field(2)) else { continue };
            if x == 0.0 && y == 0.0 && z == 0.0 {
                continue;
            }
            let clock = field(3).filter(|c| *c < 999_999.0).map(|c| c * 1e-6);
            let satellite = into.orbits.entry(sat).or_default();
            satellite.t.push(t);
            satellite.pos.push([x * 1e3, y * 1e3, z * 1e3]);
            satellite.clk.push(clock);
        }
    }
    if epochs == 0 {
        return Err("SP3 文件没有任何历元".into());
    }
    Ok(())
}

pub(crate) fn parse_clk(text: &str, into: &mut Products) {
    for line in text.lines() {
        if line.contains("TIME SYSTEM ID") && into.time_system.is_empty() {
            into.time_system = line.get(..60).unwrap_or(line).trim().to_string();
        }
        if !line.starts_with("AS ") {
            continue;
        }
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() < 10 {
            continue;
        }
        let n = |i: usize| p[i].parse::<i64>().ok();
        let (Some(y), Some(mo), Some(d), Some(h), Some(mi)) = (n(2), n(3), n(4), n(5), n(6)) else {
            continue;
        };
        let (Ok(s), Ok(value)) = (p[7].parse::<f64>(), p[9].replace(['D', 'd'], "E").parse::<f64>()) else {
            continue;
        };
        into.clocks.entry(p[1].to_string()).or_default().push((gps_ms(y, mo, d, h, mi, s), value));
    }
}

pub(crate) fn read(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".gz") || lower.ends_with(".z") {
        return Err(format!("{path}：请先解压 .gz / .Z 文件"));
    }
    let meta = fs::metadata(p).map_err(|_| format!("找不到文件：{path}"))?;
    if meta.len() > MAX_FILE {
        return Err(format!("{path}：文件超过 600 MiB"));
    }
    fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| format!("{path}：{e}"))
}

fn load(set: &ProductSet) -> Result<Products, String> {
    if set.sp3.is_empty() {
        return Err("每组产品至少需要一个 SP3 轨道文件".into());
    }
    let mut products = Products::default();
    for path in &set.sp3 {
        parse_sp3(&read(path)?, &mut products).map_err(|e| format!("{path}：{e}"))?;
    }
    for path in &set.clk {
        parse_clk(&read(path)?, &mut products);
    }
    for satellite in products.orbits.values_mut() {
        let mut order: Vec<usize> = (0..satellite.t.len()).collect();
        order.sort_by_key(|&i| satellite.t[i]);
        order.dedup_by_key(|i| satellite.t[*i]);
        satellite.pos = order.iter().map(|&i| satellite.pos[i]).collect();
        satellite.clk = order.iter().map(|&i| satellite.clk[i]).collect();
        satellite.t = order.iter().map(|&i| satellite.t[i]).collect();
    }
    for series in products.clocks.values_mut() {
        series.sort_by_key(|x| x.0);
        series.dedup_by_key(|x| x.0);
    }
    Ok(products)
}

/// Satellite clock offsets in seconds, keyed by whole GPS seconds, from RINEX clock files; samples between whole
/// seconds are dropped because the bias products are sampled on whole seconds.
pub(crate) fn read_clocks(paths: &[String]) -> Result<BTreeMap<String, HashMap<i64, f64>>, String> {
    let mut products = Products::default();
    for path in paths {
        parse_clk(&read(path)?, &mut products);
    }
    if !paths.is_empty() && products.clocks.is_empty() {
        return Err("钟差文件里没有卫星钟差记录（AS 行）".into());
    }
    Ok(products
        .clocks
        .into_iter()
        .map(|(sat, series)| {
            (sat, series.into_iter().filter(|(t, _)| t % 1000 == 0).map(|(t, c)| (t / 1000, c)).collect())
        })
        .collect())
}

/// GEO, IGSO or MEO from the state of a satellite in its SP3 track: semi-major axis and inclination of the inertial
/// orbit, not the PRN, which says nothing about the orbit once a constellation renumbers or upgrades. The Earth
/// rotation angle is enough to get out of the Earth-fixed frame; precession would move the inclination by a few
/// hundredths of a degree.
fn classify_orbit(sat: &Satellite) -> Option<&'static str> {
    let index = (sat.t.len() / 2..sat.t.len()).find(|&i| velocity(sat, i).is_some())?;
    let (r, v) = (sat.pos[index], velocity(sat, index)?);
    let jd = utc_unix_ms(sat.t[index]) as f64 / 86_400_000.0 + 2_440_587.5;
    let angle = (0.779_057_273_264_0 + 1.002_737_811_911_354_48 * (jd - 2_451_545.0)).rem_euclid(1.0)
        * std::f64::consts::TAU;
    let (c, s) = (angle.cos(), angle.sin());
    let rotate = |p: [f64; 3]| [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
    let inertial_r = rotate(r);
    let inertial_v = rotate([v[0] - EARTH_ROTATION * r[1], v[1] + EARTH_ROTATION * r[0], v[2]]);
    let h = cross(inertial_r, inertial_v);
    let inclination = (h[2] / dot(h, h).sqrt()).acos().to_degrees();
    let radius = dot(inertial_r, inertial_r).sqrt();
    let axis = 1.0 / (2.0 / radius - dot(inertial_v, inertial_v) / MU);
    Some(if axis > 35.0e6 {
        if inclination < 10.0 {
            "GEO"
        } else {
            "IGSO"
        }
    } else {
        "MEO"
    })
}

/// Orbit type of every satellite in the given SP3 files.
pub(crate) fn orbit_classes(paths: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut products = Products::default();
    for path in paths {
        parse_sp3(&read(path)?, &mut products).map_err(|e| format!("{path}：{e}"))?;
    }
    for satellite in products.orbits.values_mut() {
        let mut order: Vec<usize> = (0..satellite.t.len()).collect();
        order.sort_by_key(|&i| satellite.t[i]);
        order.dedup_by_key(|i| satellite.t[*i]);
        satellite.pos = order.iter().map(|&i| satellite.pos[i]).collect();
        satellite.t = order.iter().map(|&i| satellite.t[i]).collect();
    }
    Ok(products
        .orbits
        .iter()
        .filter_map(|(sat, track)| Some((sat.clone(), classify_orbit(track)?.to_string())))
        .collect())
}

/// Clock samples of one satellite: the clock files when given, otherwise the SP3 clock column.
fn clock_series(products: &Products, sat: &str) -> Vec<(i64, f64)> {
    if !products.clocks.is_empty() {
        return products.clocks.get(sat).cloned().unwrap_or_default();
    }
    products
        .orbits
        .get(sat)
        .map_or(Vec::new(), |s| s.t.iter().zip(&s.clk).filter_map(|(t, c)| c.map(|c| (*t, c))).collect())
}

/// Velocity from a 9-point Lagrange derivative of the reference orbit; None near the file edges or across gaps.
fn velocity(sat: &Satellite, i: usize) -> Option<[f64; 3]> {
    if i < 4 || i + 4 >= sat.t.len() {
        return None;
    }
    let nodes = &sat.t[i - 4..=i + 4];
    let step = (nodes[8] - nodes[0]) as f64 / 8.0;
    if nodes.windows(2).any(|w| ((w[1] - w[0]) as f64 - step).abs() > 1.0) {
        return None;
    }
    let t = sat.t[i] as f64 / 1000.0;
    let xs: Vec<f64> = nodes.iter().map(|&x| x as f64 / 1000.0).collect();
    let mut v = [0.0; 3];
    for (k, xk) in xs.iter().enumerate() {
        let mut derivative = 0.0;
        for (j, xj) in xs.iter().enumerate() {
            if j == k {
                continue;
            }
            let mut product = 1.0 / (xk - xj);
            for (m, xm) in xs.iter().enumerate() {
                if m != k && m != j {
                    product *= (t - xm) / (xk - xm);
                }
            }
            derivative += product;
        }
        for (axis, value) in v.iter_mut().enumerate() {
            *value += sat.pos[i - 4 + k][axis] * derivative;
        }
    }
    Some(v)
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = dot(a, a).sqrt();
    [a[0] / n, a[1] / n, a[2] / n]
}

/// SISRE weights (radial, along/cross squared) for the satellite's constellation and orbit type.
fn sisre_weights(sat: &str) -> (f64, f64) {
    let prn: u32 = sat[1..].parse().unwrap_or(0);
    match sat.as_bytes()[0] {
        b'G' | b'J' => (0.98, 1.0 / 49.0),
        b'R' => (0.98, 1.0 / 45.0),
        b'E' => (0.98, 1.0 / 61.0),
        b'C' if prn <= 5 || prn >= 59 || matches!(prn, 6..=10 | 13 | 16 | 31 | 38..=40 | 56) => {
            (0.99, 1.0 / 126.0)
        }
        b'C' => (0.98, 1.0 / 54.0),
        _ => (0.98, 1.0 / 54.0),
    }
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Moments {
    pub mean: f64,
    pub rms: f64,
    pub std: f64,
    pub max: f64,
    pub n: usize,
}

fn moments(v: &[f64]) -> Moments {
    if v.is_empty() {
        return Moments::default();
    }
    let n = v.len() as f64;
    let mean = v.iter().sum::<f64>() / n;
    let rms = (v.iter().map(|x| x * x).sum::<f64>() / n).sqrt();
    let std = if v.len() > 1 {
        (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
    } else {
        0.0
    };
    Moments { mean, rms, std, max: v.iter().fold(0.0, |m: f64, x| m.max(x.abs())), n: v.len() }
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SatelliteResult {
    pub sat: String,
    pub system: String,
    pub r: Moments,
    pub a: Moments,
    pub c: Moments,
    pub d3: Moments,
    /// Clock difference in metres after the per-epoch constellation median was removed.
    pub clock: Moments,
    pub clock_jumps: usize,
    pub sisre: Option<f64>,
    /// Compared orbit epochs divided by the test file's epochs of this satellite.
    pub coverage: f64,
    pub outlier: bool,
    pub r_series: Vec<Option<f32>>,
    pub a_series: Vec<Option<f32>>,
    pub c_series: Vec<Option<f32>>,
    pub clock_series: Vec<Option<f32>>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemResult {
    pub system: String,
    pub sats: usize,
    pub orbit_epochs: usize,
    /// Per-satellite medians, the figure usually quoted for a product.
    pub d3_median: f64,
    pub r_median: f64,
    pub a_median: f64,
    pub c_median: f64,
    /// RMS over every compared satellite epoch.
    pub d3_rms: f64,
    pub r_mean: f64,
    pub clock_std_median: Option<f64>,
    pub sisre_median: Option<f64>,
    pub coverage: f64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub name: String,
    pub time_system: String,
    /// Orbit epochs shared with the reference, Unix milliseconds in UTC; every series is aligned to this list.
    pub epochs: Vec<i64>,
    pub step_seconds: f64,
    pub systems: Vec<SystemResult>,
    pub satellites: Vec<SatelliteResult>,
    /// The radial constant of each satellite was taken out because the orbit refers to the antenna phase centre.
    pub apc: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orbit_decision: Option<OrbitDecision>,
    /// GEO / IGSO / MEO of the satellites of the reference orbit, by orbit shape.
    pub orbit_classes: BTreeMap<String, String>,
    /// Every satellite both products have orbits for, excluded or not; the page offers these for selection.
    pub candidates: Vec<String>,
    /// The requested exclusions that matched one of `candidates`.
    pub excluded: Vec<String>,
    /// Per constellation and GPST hour: orbit 3D RMS in metres.
    pub hourly: Vec<HourResult>,
    pub hints: Vec<String>,
    pub test_only: Vec<String>,
    pub reference_only: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HourResult {
    pub system: String,
    pub time: i64,
    pub d3_rms: f64,
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    match v.len() {
        0 => f64::NAN,
        n if n % 2 == 1 => v[n / 2],
        n => (v[n / 2 - 1] + v[n / 2]) / 2.0,
    }
}

fn r4(x: f64) -> Option<f32> {
    x.is_finite().then(|| ((x * 1e4).round() / 1e4) as f32)
}

#[cfg(test)]
fn compare(reference: &Products, test: &Products, name: &str) -> Result<Comparison, String> {
    compare_without(reference, test, name, &BTreeSet::new())
}

#[cfg(test)]
fn compare_without(
    reference: &Products,
    test: &Products,
    name: &str,
    exclude: &BTreeSet<String>,
) -> Result<Comparison, String> {
    compare_with(reference, test, name, exclude, false)
}

fn compare_with(
    reference: &Products,
    test: &Products,
    name: &str,
    exclude: &BTreeSet<String>,
    apc: bool,
) -> Result<Comparison, String> {
    #[derive(Default)]
    struct Work {
        keys: Vec<i64>,
        r: Vec<f64>,
        a: Vec<f64>,
        c: Vec<f64>,
        d3: Vec<f64>,
        clock: Vec<(i64, f64)>,
    }
    let mut work: BTreeMap<String, Work> = BTreeMap::new();
    let mut step = 0;
    let candidates: Vec<String> =
        test.orbits.keys().filter(|s| reference.orbits.contains_key(*s)).cloned().collect();
    for (sat, t) in &test.orbits {
        let Some(r) = reference.orbits.get(sat) else { continue };
        if exclude.contains(sat) {
            continue;
        }
        let index: HashMap<i64, usize> = r.t.iter().enumerate().map(|(i, t)| (*t, i)).collect();
        if step == 0 && r.t.len() > 1 {
            step = r.t[1] - r.t[0];
        }
        let entry = work.entry(sat.clone()).or_default();
        for (k, key) in t.t.iter().enumerate() {
            let Some(&i) = index.get(key) else { continue };
            let Some(v) = velocity(r, i) else { continue };
            let along = unit(v);
            let cross_track = unit(cross(r.pos[i], v));
            let radial = cross(along, cross_track);
            let d = [t.pos[k][0] - r.pos[i][0], t.pos[k][1] - r.pos[i][1], t.pos[k][2] - r.pos[i][2]];
            entry.keys.push(*key);
            entry.r.push(dot(d, radial));
            entry.a.push(dot(d, along));
            entry.c.push(dot(d, cross_track));
            entry.d3.push(dot(d, d).sqrt());
        }
    }
    work.retain(|_, w| !w.keys.is_empty());
    if work.is_empty() && !candidates.is_empty() && candidates.iter().all(|s| exclude.contains(s)) {
        return Err("剔除后没有剩余的卫星，请恢复一部分卫星".into());
    }
    if work.is_empty() {
        return Err(
            "参考与对比产品没有共同的卫星和历元，无法比较；请确认两者覆盖同一时段并使用相同的采样间隔".into(),
        );
    }
    // shortcut: radial mean removal can also erase real constant errors; use ANTEX plus attitude for physical APC conversion.
    let mut offsets: BTreeMap<u8, Vec<f64>> = BTreeMap::new();
    if apc {
        for (sat, w) in work.iter_mut() {
            let mean = w.r.iter().sum::<f64>() / w.r.len() as f64;
            for i in 0..w.r.len() {
                w.r[i] -= mean;
                w.d3[i] = (w.r[i].powi(2) + w.a[i].powi(2) + w.c[i].powi(2)).sqrt();
            }
            offsets.entry(sat.as_bytes()[0]).or_default().push(mean);
        }
    }
    let grid: Vec<i64> =
        work.values().flat_map(|w| w.keys.iter().copied()).collect::<BTreeSet<_>>().into_iter().collect();
    let slot: HashMap<i64, usize> = grid.iter().enumerate().map(|(i, k)| (*k, i)).collect();

    // Clocks: test minus reference in metres, then the per-epoch median of each constellation is removed.
    let mut epochs: HashMap<(u8, i64), Vec<(String, f64)>> = HashMap::new();
    for sat in work.keys() {
        let (rc, tc) = (clock_series(reference, sat), clock_series(test, sat));
        let reference_index: HashMap<i64, f64> = rc.into_iter().collect();
        for (key, value) in tc {
            if let Some(r) = reference_index.get(&key) {
                epochs.entry((sat.as_bytes()[0], key)).or_default().push((sat.clone(), (value - r) * C));
            }
        }
    }
    for ((_, key), values) in &epochs {
        if values.len() < 4 {
            continue;
        }
        let m = median(values.iter().map(|v| v.1).collect());
        for (sat, value) in values {
            work.get_mut(sat).unwrap().clock.push((*key, value - m));
        }
    }

    let mut satellites = Vec::new();
    let mut hourly: BTreeMap<(String, i64), (f64, usize)> = BTreeMap::new();
    for (sat, w) in work.iter_mut() {
        w.clock.sort_by_key(|x| x.0);
        let clock_values: Vec<f64> = w.clock.iter().map(|x| x.1).collect();
        let clock = moments(&clock_values);
        let jumps = w
            .clock
            .windows(2)
            .filter(|p| p[1].0 - p[0].0 <= 31_000 && (p[1].1 - p[0].1).abs() > JUMP_METRES)
            .count();
        let by_key: HashMap<i64, f64> = w.clock.iter().copied().collect();
        let (wr, wac) = sisre_weights(sat);
        let mut sisre_sq = Vec::new();
        let mut series =
            (vec![None; grid.len()], vec![None; grid.len()], vec![None; grid.len()], vec![None; grid.len()]);
        for (i, key) in w.keys.iter().enumerate() {
            let s = slot[key];
            series.0[s] = r4(w.r[i]);
            series.1[s] = r4(w.a[i]);
            series.2[s] = r4(w.c[i]);
            if let Some(c) = by_key.get(key) {
                series.3[s] = r4(*c);
                // The per-satellite mean is a signal-definition offset, not an error of the product.
                let dc = c - clock.mean;
                sisre_sq.push((wr * w.r[i] - dc).powi(2) + wac * (w.a[i].powi(2) + w.c[i].powi(2)));
            }
            let hour = key.div_euclid(3_600_000) * 3_600_000;
            let h = hourly.entry((sat[..1].to_string(), hour)).or_default();
            h.0 += w.d3[i].powi(2);
            h.1 += 1;
        }
        let compared = w.keys.len();
        let in_test = test.orbits[sat].t.len().max(1);
        satellites.push(SatelliteResult {
            sat: sat.clone(),
            system: sat[..1].to_string(),
            r: moments(&w.r),
            a: moments(&w.a),
            c: moments(&w.c),
            d3: moments(&w.d3),
            clock,
            clock_jumps: jumps,
            sisre: (!sisre_sq.is_empty())
                .then(|| (sisre_sq.iter().sum::<f64>() / sisre_sq.len() as f64).sqrt()),
            coverage: compared as f64 / in_test as f64,
            outlier: false,
            r_series: series.0,
            a_series: series.1,
            c_series: series.2,
            clock_series: series.3,
        });
    }

    let mut systems = Vec::new();
    let mut hints = Vec::new();
    for (system, values) in &offsets {
        hints.push(format!(
            "已逐星去径向常量（非完整 ANTEX 改正）：{} 各卫星的径向常数已去掉（中位数 {:+.2} m）",
            *system as char,
            median(values.clone())
        ));
    }
    for system in ["G", "R", "E", "C", "J"] {
        let list: Vec<usize> = (0..satellites.len()).filter(|&i| satellites[i].system == system).collect();
        if list.is_empty() {
            continue;
        }
        let pick =
            |f: &dyn Fn(&SatelliteResult) -> f64| median(list.iter().map(|&i| f(&satellites[i])).collect());
        let all_sq: f64 =
            list.iter().map(|&i| satellites[i].d3.rms.powi(2) * satellites[i].d3.n as f64).sum();
        let n: usize = list.iter().map(|&i| satellites[i].d3.n).sum();
        let (d3_median, r_median, a_median, c_median) =
            (pick(&|s| s.d3.rms), pick(&|s| s.r.rms), pick(&|s| s.a.rms), pick(&|s| s.c.rms));
        let clock_std = list
            .iter()
            .filter(|&&i| satellites[i].clock.n > 10)
            .map(|&i| satellites[i].clock.std)
            .collect::<Vec<_>>();
        let sisre = list.iter().filter_map(|&i| satellites[i].sisre).collect::<Vec<_>>();
        let r_mean = list.iter().map(|&i| satellites[i].r.mean).sum::<f64>() / list.len() as f64;
        // A stable radial offset may indicate a reference-point mismatch, but cannot prove it.
        let spread = pick(&|s| s.r.std);
        let coverage = list.iter().map(|&i| satellites[i].coverage).sum::<f64>() / list.len() as f64;
        if r_mean.abs() > 0.15 && r_mean.abs() > 3.0 * spread {
            hints.push(format!(
                "{system} 系统径向平均偏差 {:+.2} m，而离散度仅 {:.2} m：这像是两份产品的参考点不同（天线相位中心与质心）；若对比产品是 HAS / B2b 这类加在广播星历上的改正，可在轨道参考点中选择“去径向常量”复核（非完整 ANTEX 改正）",
                r_mean, spread
            ));
        }
        for &i in &list {
            if satellites[i].d3.rms > (3.0 * d3_median).max(0.10) {
                satellites[i].outlier = true;
                hints.push(format!(
                    "{} 轨道三维 RMS {:.1} cm，是 {system} 系统中位数 {:.1} cm 的 {:.1} 倍",
                    satellites[i].sat,
                    satellites[i].d3.rms * 100.0,
                    d3_median * 100.0,
                    satellites[i].d3.rms / d3_median
                ));
            }
            if satellites[i].clock_jumps > 0 {
                hints.push(format!(
                    "{} 钟差有 {} 处阶跃（>{:.1} m），常见于广播星历切换或钟差基准变化，整段标准差会因此偏大",
                    satellites[i].sat, satellites[i].clock_jumps, JUMP_METRES
                ));
            }
        }
        systems.push(SystemResult {
            system: system.to_string(),
            sats: list.len(),
            orbit_epochs: n,
            d3_median,
            r_median,
            a_median,
            c_median,
            d3_rms: (all_sq / n.max(1) as f64).sqrt(),
            r_mean,
            clock_std_median: (!clock_std.is_empty()).then(|| median(clock_std)),
            sisre_median: (!sisre.is_empty()).then(|| median(sisre)),
            coverage,
        });
    }
    if reference.time_system != test.time_system
        && !reference.time_system.is_empty()
        && !test.time_system.is_empty()
    {
        hints.push(format!(
            "时间系统不同：参考 {}，对比 {}，请确认都是 GPST",
            reference.time_system, test.time_system
        ));
    }
    let test_only =
        test.orbits.keys().filter(|s| !work.contains_key(*s) && !exclude.contains(*s)).cloned().collect();
    let reference_only = reference
        .orbits
        .keys()
        .filter(|s| {
            !work.contains_key(*s)
                && !exclude.contains(*s)
                && systems.iter().any(|x| x.system.as_bytes()[0] == s.as_bytes()[0])
        })
        .cloned()
        .collect();
    Ok(Comparison {
        name: name.to_string(),
        time_system: test.time_system.clone(),
        epochs: grid.iter().map(|k| utc_unix_ms(*k)).collect(),
        step_seconds: step as f64 / 1000.0,
        systems,
        satellites,
        excluded: candidates.iter().filter(|s| exclude.contains(*s)).cloned().collect(),
        apc,
        orbit_decision: None,
        orbit_classes: candidates
            .iter()
            .filter_map(|s| Some((s.clone(), classify_orbit(reference.orbits.get(s)?)?.to_string())))
            .collect(),
        candidates,
        hourly: hourly
            .into_iter()
            .map(|((system, time), (sq, n))| HourResult {
                system,
                time: utc_unix_ms(time),
                d3_rms: (sq / n as f64).sqrt(),
            })
            .collect(),
        hints,
        test_only,
        reference_only,
    })
}

/// A test product that could not be compared, and why.
#[derive(Serialize, Debug)]
pub struct Failure {
    pub name: String,
    pub error: String,
}

/// The products that were compared and those that were not: one product with a bad file or another day does not take
/// the others down with it.
#[derive(Serialize, Debug)]
pub struct Outcome<T> {
    pub results: Vec<T>,
    pub failures: Vec<Failure>,
}

impl<T> Outcome<T> {
    pub fn new() -> Self {
        Outcome { results: Vec::new(), failures: Vec::new() }
    }

    pub fn add(&mut self, name: String, result: Result<T, String>) {
        match result {
            Ok(r) => self.results.push(r),
            Err(error) => self.failures.push(Failure { name, error }),
        }
    }
}

fn apc_source(set: &ProductSet) -> bool {
    if matches!(set.orbit_source.as_deref(), Some("has" | "b2b")) {
        return true;
    }
    // Names are only a source clue; the numerical gate must independently pass for every constellation.
    !set.sp3.is_empty()
        && set.sp3.iter().all(|p| {
            p.rsplit(['/', '\\'])
                .next()
                .unwrap_or(p)
                .to_ascii_uppercase()
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|token| token == "HAS" || token == "B2B" || token.starts_with("SSRA"))
        })
}

fn auto_orbit_decision(plain: &Comparison, source: bool) -> (bool, String) {
    if plain.systems.iter().all(|s| s.r_mean.abs() <= 0.15) {
        return (false, "未发现明显径向常量偏移，保持原值；这不等于已确认质心参考点。".into());
    }
    if !source {
        return (
            false,
            "待确认：存在径向偏移，但缺少 HAS/B2B/SSRA 来源线索，保持原值以保留可能的真实轨道误差。".into(),
        );
    }
    let span = plain.epochs.last().copied().unwrap_or(0) - plain.epochs.first().copied().unwrap_or(0);
    let consistent = span >= 3_600_000
        && !plain.systems.is_empty()
        && plain.systems.iter().all(|system| {
            let sats: Vec<_> =
                plain.satellites.iter().filter(|s| s.system == system.system && s.r.n >= 12).collect();
            if sats.len() < 6 {
                return false;
            }
            let mean = median(sats.iter().map(|s| s.r.mean).collect());
            let spread = median(sats.iter().map(|s| s.r.std).collect());
            let across = median(sats.iter().map(|s| (s.r.mean - mean).abs()).collect());
            let transverse =
                median(sats.iter().map(|s| (s.a.rms.powi(2) + s.c.rms.powi(2)).sqrt()).collect());
            let same_sign = sats.iter().filter(|s| s.r.mean * mean > 0.0).count();
            (0.5..=3.0).contains(&mean.abs())
                && spread <= 0.15
                && mean.abs() > 5.0 * spread
                && across <= 0.35
                && mean.abs() > 2.0 * transverse
                && same_sign * 5 >= sats.len() * 4
        });
    if consistent {
        (true, "来源线索与各系统稳定、同向的径向偏移一致，推断为参考点差异，已逐星去径向常量；这不是完整 ANTEX 改正，真实常量误差仍可能被消除，可切换保持原值复核。".into())
    } else {
        (false, "待确认：来源有 APC 线索，但共同样本不足或偏移不够稳定、一致，保持原值；请检查来源、时段和真实轨道误差。".into())
    }
}

fn compare_selected(
    reference: &Products,
    test: &Products,
    name: &str,
    exclude: &BTreeSet<String>,
    set: &ProductSet,
) -> Result<Comparison, String> {
    let mode = set.orbit_mode.unwrap_or(if set.apc { OrbitMode::Remove } else { OrbitMode::Keep });
    let plain = compare_with(reference, test, name, exclude, false)?;
    let (applied, reason) = match mode {
        OrbitMode::Auto => auto_orbit_decision(&plain, apc_source(set)),
        OrbitMode::Keep => (false, "按手动设置保持原始轨道差异，不去除径向常量。".into()),
        OrbitMode::Remove => {
            (true, "按手动设置逐星去径向常量；仅作 APC 参考点差异近似处理，不是完整 ANTEX 改正。".into())
        }
    };
    let radial_offsets = if applied {
        plain.satellites.iter().map(|s| (s.sat.clone(), s.r.mean)).collect()
    } else {
        BTreeMap::new()
    };
    let mut result = if applied { compare_with(reference, test, name, exclude, true)? } else { plain };
    result.orbit_decision = Some(OrbitDecision { mode, applied, reason, radial_offsets });
    Ok(result)
}

pub fn run(request: CompareRequest) -> Result<Outcome<Comparison>, String> {
    if request.tests.is_empty() {
        return Err("请至少添加一组对比产品".into());
    }
    if request.tests.len() > 8 {
        return Err("一次最多对比 8 组产品".into());
    }
    let reference = load(&request.reference).map_err(|e| format!("参考产品：{e}"))?;
    let exclude: BTreeSet<String> = request.exclude.iter().map(|s| s.trim().to_ascii_uppercase()).collect();
    let mut outcome = Outcome::new();
    for (i, set) in request.tests.iter().enumerate() {
        let label = if set.name.is_empty() { format!("对比产品 {}", i + 1) } else { set.name.clone() };
        let one = load(set).and_then(|test| compare_selected(&reference, &test, &label, &exclude, set));
        outcome.add(label, one);
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn compare_products(request: CompareRequest) -> Result<Outcome<Comparison>, String> {
    tauri::async_runtime::spawn_blocking(move || run(request)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const RADIUS: f64 = 26_560_000.0;
    const OMEGA: f64 = 1.4586e-4;

    fn state(sat: usize, t: f64, radial: f64, along: f64) -> [f64; 3] {
        let phase = OMEGA * t + sat as f64 * 0.7;
        let r = RADIUS + radial;
        let angle = phase + along / RADIUS;
        [r * angle.cos(), r * angle.sin() * 0.8, r * angle.sin() * 0.6]
    }

    /// SP3 text with `sats` circular orbits every 300 s for `epochs` epochs; `shift` perturbs (radial, along) per satellite.
    fn sp3(sats: &[&str], epochs: usize, shift: &dyn Fn(usize, usize) -> (f64, f64, f64)) -> String {
        let mut text = String::from(
            "#dP2026  9 19  0  0  0.00000000     12   u+U IGS20 FIT  WHU\n%c M  cc GPS ccc cccc\n",
        );
        for e in 0..epochs {
            let t = e as f64 * 300.0;
            text += &format!("*  2026  9 19  {:2} {:2}  0.00000000\n", (e * 5) / 60, (e * 5) % 60);
            for (i, sat) in sats.iter().enumerate() {
                let (radial, along, clock) = shift(i, e);
                let p = state(i, t, radial, along);
                text += &format!(
                    "P{sat}{:14.6}{:14.6}{:14.6}{:14.6}\n",
                    p[0] * 1e-3,
                    p[1] * 1e-3,
                    p[2] * 1e-3,
                    clock
                );
            }
        }
        text
    }

    fn products(text: &str, clk: Option<&str>) -> Products {
        let mut p = Products::default();
        parse_sp3(text, &mut p).unwrap();
        if let Some(c) = clk {
            parse_clk(c, &mut p);
        }
        for s in p.orbits.values_mut() {
            assert!(s.t.windows(2).all(|w| w[0] < w[1]));
        }
        p
    }

    #[test]
    fn parses_sp3_with_missing_markers_and_clock_units() {
        let text = "#dP2026  9 19  0  0  0.00000000      2   u+U IGS20 FIT  WHU\n%c M  cc GPS ccc cccc\n\
            *  2026  9 19  0  0  0.00000000\n\
            PG01   9407.225211 -18247.910002 -16812.254335    169.166667\n\
            PG02      0.000000      0.000000      0.000000 999999.999999\n\
            PG03   1000.000000   2000.000000   3000.000000 999999.999999\n";
        let p = products(text, None);
        assert_eq!(p.time_system, "GPS");
        assert_eq!(p.orbits.len(), 2);
        let g1 = &p.orbits["G01"];
        for (got, want) in g1.pos[0].iter().zip([9_407_225.211, -18_247_910.002, -16_812_254.335]) {
            assert!((got - want).abs() < 1e-6, "{got} vs {want}");
        }
        assert!((g1.clk[0].unwrap() - 169.166667e-6).abs() < 1e-12);
        assert_eq!(p.orbits["G03"].clk[0], None);
    }

    #[test]
    fn parses_rinex_clock_records() {
        let mut p = Products::default();
        parse_clk(
            "   GPS                                                      TIME SYSTEM ID\n\
             AS G01  2026  9 19  0  0  0.000000  1    0.169166666594E-03\n\
             AS C20  2026  9 19  0  0 30.000000  1   -0.400000000000D-06\n\
             AR ABMF 2026  9 19  0  0  0.000000  1    0.1E-03\n",
            &mut p,
        );
        assert_eq!(p.time_system, "GPS");
        assert_eq!(p.clocks.len(), 2);
        let day0 = gps_ms(2026, 9, 19, 0, 0, 0.0);
        assert_eq!(p.clocks["G01"][0], (day0, 0.169166666594e-3));
        assert_eq!(p.clocks["C20"][0], (day0 + 30_000, -0.4e-6));
    }

    #[test]
    fn excluded_satellites_leave_the_statistics_but_are_still_offered() {
        let sats = ["G01", "G02", "G03", "G04", "G05", "G06"];
        let reference = products(&sp3(&sats, 14, &|_, _| (0.0, 0.0, 0.0)), None);
        let test = products(&sp3(&sats, 14, &|i, _| (if i == 2 { 1.0 } else { 0.02 }, 0.0, 0.0)), None);
        let full = compare(&reference, &test, "t").unwrap();
        assert_eq!(full.satellites.len(), 6);
        assert!(full.satellites.iter().any(|s| s.sat == "G03" && s.outlier));
        let skipped = BTreeSet::from(["G03".to_string()]);
        let without = compare_without(&reference, &test, "t", &skipped).unwrap();
        assert_eq!(without.satellites.len(), 5);
        assert!(without.satellites.iter().all(|s| s.sat != "G03" && !s.outlier));
        assert_eq!(without.systems[0].sats, 5);
        assert!(without.systems[0].d3_rms < 0.05, "{:?}", without.systems[0]);
        assert_eq!(without.candidates, sats);
        assert_eq!(without.excluded, ["G03"]);
        assert!(without.test_only.is_empty() && without.reference_only.is_empty());
        let unknown = compare_without(&reference, &test, "t", &BTreeSet::from(["E01".to_string()])).unwrap();
        assert!(unknown.excluded.is_empty());
        let everything: BTreeSet<String> = sats.iter().map(|s| s.to_string()).collect();
        assert!(compare_without(&reference, &test, "t", &everything).unwrap_err().contains("没有剩余"));
    }

    #[test]
    fn the_clock_datum_is_taken_from_the_satellites_that_stay() {
        // five satellites carry a clock 4 microseconds off, four do not: the median follows the majority, so the four
        // good ones look wrong until the five are excluded
        let sats = ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09"];
        let reference = products(&sp3(&sats, 14, &|_, _| (0.0, 0.0, 0.0)), None);
        let test = products(&sp3(&sats, 14, &|i, _| (0.0, 0.0, if i >= 4 { 4.0 } else { 0.0 })), None);
        let clock = |r: &Comparison, sat: &str| r.satellites.iter().find(|s| s.sat == sat).unwrap().clock.rms;
        let full = compare(&reference, &test, "t").unwrap();
        assert!(clock(&full, "G01") > 1000.0, "{}", clock(&full, "G01"));
        let bad: BTreeSet<String> = sats[4..].iter().map(|s| s.to_string()).collect();
        let without = compare_without(&reference, &test, "t", &bad).unwrap();
        assert!(clock(&without, "G01") < 1e-6, "{}", clock(&without, "G01"));
        assert_eq!(without.satellites.len(), 4);
    }

    /// A circular orbit of the given radius and inclination (degrees) as Earth-fixed SP3 samples every 300 s.
    fn track(radius: f64, inclination: f64, nodal_phase: f64) -> Satellite {
        let rate = (MU / radius.powi(3)).sqrt();
        let start = gps_ms(2026, 9, 19, 0, 0, 0.0);
        let mut sat = Satellite::default();
        for k in 0..14 {
            let t = start + k * 300_000;
            let dt = k as f64 * 300.0;
            let (u, i) = (nodal_phase + rate * dt, inclination.to_radians());
            let inertial = [radius * u.cos(), radius * u.sin() * i.cos(), radius * u.sin() * i.sin()];
            let jd = utc_unix_ms(t) as f64 / 86_400_000.0 + 2_440_587.5;
            let era = (0.779_057_273_264_0 + 1.002_737_811_911_354_48 * (jd - 2_451_545.0)).rem_euclid(1.0)
                * std::f64::consts::TAU;
            let (c, s) = (era.cos(), era.sin());
            sat.t.push(t);
            sat.pos.push([
                c * inertial[0] + s * inertial[1],
                -s * inertial[0] + c * inertial[1],
                inertial[2],
            ]);
            sat.clk.push(None);
        }
        sat
    }

    #[test]
    fn orbit_types_come_from_the_shape_of_the_orbit_and_not_from_the_prn() {
        assert_eq!(classify_orbit(&track(42_164_000.0, 0.5, 1.0)), Some("GEO"));
        assert_eq!(classify_orbit(&track(42_164_000.0, 55.0, 2.0)), Some("IGSO"));
        assert_eq!(classify_orbit(&track(27_906_000.0, 55.0, 0.3)), Some("MEO"));
        assert_eq!(classify_orbit(&track(26_560_000.0, 55.0, 4.0)), Some("MEO"));
        let mut short = track(42_164_000.0, 55.0, 0.0);
        short.t.truncate(6);
        short.pos.truncate(6);
        short.clk.truncate(6);
        assert_eq!(classify_orbit(&short), None, "too few epochs for a velocity");
    }

    #[test]
    fn orbit_classes_of_a_comparison_cover_the_candidates() {
        let sats = ["G01", "G02", "G03", "G04", "G05"];
        let reference = products(&sp3(&sats, 14, &|_, _| (0.0, 0.0, 0.0)), None);
        let result = compare(&reference, &reference, "t").unwrap();
        assert_eq!(result.orbit_classes.len(), 5);
        // the synthetic tracks are not physical orbits, so only the shape of the answer is checked
        assert!(result.orbit_classes.values().all(|c| ["GEO", "IGSO", "MEO"].contains(&c.as_str())));
    }

    #[test]
    fn an_orbit_at_the_antenna_phase_centre_loses_its_radial_constant_when_asked() {
        // every satellite sits 1.3 m lower than its centre of mass: a constant radial offset of the test orbit
        let sats = ["G01", "G02", "G03", "G04", "G05", "G06"];
        let reference = products(&sp3(&sats, 14, &|_, _| (0.0, 0.0, 0.0)), None);
        let test = products(&sp3(&sats, 14, &|i, _| (-1.3 + 0.01 * i as f64, 0.02, 0.0)), None);
        let plain = compare(&reference, &test, "t").unwrap();
        assert!(plain.systems[0].d3_median > 1.2 && !plain.apc, "{:?}", plain.systems[0]);
        assert!(plain.hints.iter().any(|h| h.contains("去径向常量")), "{:?}", plain.hints);
        let corrected = compare_with(&reference, &test, "t", &BTreeSet::new(), true).unwrap();
        assert!(corrected.apc);
        assert!(corrected.systems[0].d3_median < 0.05, "{:?}", corrected.systems[0]);
        assert!(
            corrected.systems[0].r_median < 1e-3,
            "nothing radial is left but the numerical noise of the synthetic orbit: {:?}",
            corrected.systems[0]
        );
        assert!((corrected.systems[0].a_median - 0.02).abs() < 1e-3, "the other axes are left alone");
        assert!(corrected.hints.iter().any(|h| h.contains("已逐星去径向常量") && h.contains("-1.2")));
        assert!(corrected.satellites.iter().all(|s| s.r.mean.abs() < 1e-9 && !s.outlier));
    }

    #[test]
    fn gps_to_utc_uses_the_leap_second_table() {
        // 2026-09-19 00:00:00 GPST is 2026-09-18 23:59:42 UTC (18 s).
        let gps = gps_ms(2026, 9, 19, 0, 0, 0.0);
        let utc = utc_unix_ms(gps);
        assert_eq!(utc, (days_from_civil(2026, 9, 19) * 86_400 - 18) * 1000);
        // GPST-UTC was 17 s between 2015-07-01 and 2017-01-01, and 0 at the GPS epoch.
        let g2016 = gps_ms(2016, 6, 1, 0, 0, 0.0);
        assert_eq!(utc_unix_ms(g2016), (days_from_civil(2016, 6, 1) * 86_400 - 17) * 1000);
        assert_eq!(utc_unix_ms(gps_ms(1980, 1, 6, 0, 0, 0.0)), GPS_UNIX * 1000);
    }

    #[test]
    fn automatic_radial_removal_requires_source_and_stable_sufficient_samples() {
        let sats = ["G01", "G02", "G03", "G04", "G05", "G06"];
        let reference = products(&sp3(&sats, 36, &|_, _| (0.0, 0.0, 0.0)), None);
        let shifted = products(&sp3(&sats, 36, &|i, _| (-1.3 + i as f64 * 0.01, 0.02, 0.0)), None);
        let mut set = ProductSet {
            sp3: vec!["2026_HAS.sp3".into()],
            orbit_mode: Some(OrbitMode::Auto),
            ..Default::default()
        };
        let run = |test: &Products, set: &ProductSet| {
            compare_selected(&reference, test, "test", &BTreeSet::new(), set).unwrap()
        };
        let corrected = run(&shifted, &set);
        assert!(corrected.apc);
        assert!(corrected.systems[0].d3_median < 0.05);
        assert_eq!(corrected.orbit_decision.unwrap().radial_offsets.len(), 6);
        set.sp3 = vec!["unknown.sp3".into()];
        let unknown = run(&shifted, &set);
        assert!(!unknown.apc);
        assert!(unknown.orbit_decision.unwrap().reason.contains("待确认"));
        set.orbit_source = Some("has".into());
        assert!(run(&shifted, &set).apc, "converter provenance survives generic filenames");
        let short = products(&sp3(&sats, 14, &|_, _| (-1.3, 0.02, 0.0)), None);
        assert!(!run(&short, &set).apc);
        let few = products(&sp3(&sats[..5], 36, &|_, _| (-1.3, 0.02, 0.0)), None);
        assert!(!run(&few, &set).apc);
        let unstable = products(&sp3(&sats, 36, &|_, e| (-1.3 + (e as f64).sin(), 0.02, 0.0)), None);
        assert!(!run(&unstable, &set).apc);
        let inconsistent =
            products(&sp3(&sats, 36, &|i, _| (if i < 3 { 1.3 } else { -1.3 }, 0.02, 0.0)), None);
        assert!(!run(&inconsistent, &set).apc);
        assert!(!run(&reference, &set).apc);
        set.orbit_mode = Some(OrbitMode::Keep);
        assert!(!run(&shifted, &set).apc, "manual choice takes precedence");
        set.orbit_mode = Some(OrbitMode::Remove);
        set.orbit_source = None;
        assert!(run(&shifted, &set).apc);
        set.orbit_mode = None;
        assert!(!run(&shifted, &set).apc, "legacy false retains raw orbits");
        set.apc = true;
        assert!(run(&shifted, &set).apc, "legacy true retains removal");
    }

    #[test]
    fn velocity_matches_the_analytic_derivative() {
        let sats = ["G01"];
        let p = products(&sp3(&sats, 12, &|_, _| (0.0, 0.0, 0.0)), None);
        let sat = &p.orbits["G01"];
        let v = velocity(sat, 6).unwrap();
        let t = 6.0 * 300.0;
        let expect = [
            -RADIUS * OMEGA * (OMEGA * t + 0.0).sin(),
            RADIUS * 0.8 * OMEGA * (OMEGA * t).cos(),
            RADIUS * 0.6 * OMEGA * (OMEGA * t).cos(),
        ];
        for k in 0..3 {
            assert!((v[k] - expect[k]).abs() < 1e-3, "{k}: {} vs {}", v[k], expect[k]);
        }
        assert!(velocity(sat, 2).is_none(), "edges have no velocity");
    }

    #[test]
    fn identical_products_have_zero_error_and_a_known_radial_offset_is_recovered() {
        let sats = ["G01", "G02", "G03", "G04", "G05"];
        let reference = products(&sp3(&sats, 14, &|_, _| (0.0, 0.0, 0.0)), None);
        let same = compare(&reference, &reference, "same").unwrap();
        assert!(same.systems[0].d3_rms < 1e-6);
        let shifted = products(&sp3(&sats, 14, &|i, _| (0.30 + 0.01 * i as f64, -0.02, 0.0)), None);
        let result = compare(&reference, &shifted, "shifted").unwrap();
        let g = &result.systems[0];
        assert_eq!(g.sats, 5);
        let sat = &result.satellites[0];
        assert!((sat.r.mean - 0.30).abs() < 1e-3, "radial {}", sat.r.mean);
        assert!((sat.a.mean + 0.02).abs() < 1e-3);
        assert!(sat.c.mean.abs() < 1e-3);
        assert!((sat.d3.rms - (0.30f64.powi(2) + 0.02f64.powi(2)).sqrt()).abs() < 1e-3);
        // the radial offset is nearly constant in all satellites: a datum hint is raised
        assert!(result.hints.iter().any(|h| h.contains("参考点")), "{:?}", result.hints);
        assert_eq!(result.satellites[0].r_series.iter().flatten().count(), 14 - 8);
    }

    #[test]
    fn outliers_and_missing_satellites_are_reported() {
        let sats = ["G01", "G02", "G03", "G04", "G05", "G06"];
        let reference = products(&sp3(&sats, 14, &|_, _| (0.0, 0.0, 0.0)), None);
        let test = products(
            &sp3(&sats[..5], 14, &|i, _| if i == 2 { (0.0, 0.5, 0.0) } else { (0.01, 0.0, 0.0) }),
            None,
        );
        let result = compare(&reference, &test, "t").unwrap();
        assert_eq!(result.reference_only, vec!["G06".to_string()]);
        let flagged: Vec<&str> =
            result.satellites.iter().filter(|s| s.outlier).map(|s| s.sat.as_str()).collect();
        assert_eq!(flagged, vec!["G03"]);
    }

    #[test]
    fn clock_comparison_removes_the_common_offset_and_counts_jumps() {
        let sats = ["G01", "G02", "G03", "G04", "G05"];
        let mut clk = String::new();
        for e in 0..240 {
            let (min, sec) = ((e * 30) / 60, (e * 30) % 60);
            for (i, sat) in sats.iter().enumerate() {
                let common = 2.0e-8; // 6 m shared by every satellite in the epoch
                let own = i as f64 * 1e-10 + if i == 1 && e >= 100 { 3e-9 } else { 0.0 };
                clk +=
                    &format!("AS {sat}  2026  9 19  0 {min:2} {sec:2}.000000  1    {:.12E}\n", common + own);
            }
        }
        let mut reference_clk = String::new();
        for e in 0..240 {
            let (min, sec) = ((e * 30) / 60, (e * 30) % 60);
            for sat in &sats {
                reference_clk +=
                    &format!("AS {sat}  2026  9 19  0 {min:2} {sec:2}.000000  1    0.000000000000E+00\n");
            }
        }
        let orbit = sp3(&sats, 14, &|_, _| (0.0, 0.0, 0.0));
        let reference = products(&orbit, Some(&reference_clk));
        let test = products(&orbit, Some(&clk));
        let result = compare(&reference, &test, "clock").unwrap();
        let g2 = result.satellites.iter().find(|s| s.sat == "G02").unwrap();
        // the 3 ns (0.9 m) step of G02 is the only structure left after the common 6 m is gone
        assert_eq!(g2.clock_jumps, 1);
        assert!(g2.clock.std > 0.3);
        let g3 = result.satellites.iter().find(|s| s.sat == "G03").unwrap();
        assert!(g3.clock.std < 0.05 && g3.clock.mean.abs() < 0.5, "{:?}", g3.clock);
        // a perfect orbit with only the shared offset and a tiny median shift gives a negligible SISRE
        assert!(g3.sisre.unwrap() < 0.05);
    }

    #[test]
    fn sisre_combines_radial_clock_and_the_along_cross_part() {
        let (wr, wac) = sisre_weights("G05");
        assert_eq!((wr, wac), (0.98, 1.0 / 49.0));
        assert_eq!(sisre_weights("C03").0, 0.99);
        assert_eq!(sisre_weights("C20").1, 1.0 / 54.0);
        assert_eq!(sisre_weights("E11").1, 1.0 / 61.0);
        let value = ((wr * 0.1 - 0.05f64).powi(2) + wac * (0.2f64.powi(2) + 0.1f64.powi(2))).sqrt();
        assert!((value - 0.0573).abs() < 1e-3);
    }

    #[test]
    fn json_names_match_the_typescript_contract() {
        let sats = ["G01", "G02", "G03", "G04", "G05"];
        let reference = products(&sp3(&sats, 14, &|_, _| (0.0, 0.0, 0.0)), None);
        let test = products(&sp3(&sats, 14, &|_, _| (0.01, 0.0, 0.0)), None);
        let value = serde_json::to_value(compare(&reference, &test, "t").unwrap()).unwrap();
        let keys = |v: &serde_json::Value| -> Vec<String> {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(
            keys(&value),
            [
                "apc",
                "candidates",
                "epochs",
                "excluded",
                "hints",
                "hourly",
                "name",
                "orbitClasses",
                "referenceOnly",
                "satellites",
                "stepSeconds",
                "systems",
                "testOnly",
                "timeSystem"
            ]
        );
        assert_eq!(
            keys(&value["satellites"][0]),
            [
                "a",
                "aSeries",
                "c",
                "cSeries",
                "clock",
                "clockJumps",
                "clockSeries",
                "coverage",
                "d3",
                "outlier",
                "r",
                "rSeries",
                "sat",
                "sisre",
                "system"
            ]
        );
        assert_eq!(keys(&value["satellites"][0]["d3"]), ["max", "mean", "n", "rms", "std"]);
        assert_eq!(
            keys(&value["systems"][0]),
            [
                "aMedian",
                "cMedian",
                "clockStdMedian",
                "coverage",
                "d3Median",
                "d3Rms",
                "orbitEpochs",
                "rMean",
                "rMedian",
                "sats",
                "sisreMedian",
                "system"
            ]
        );
        assert_eq!(keys(&value["hourly"][0]), ["d3Rms", "system", "time"]);
        assert_eq!(
            value["satellites"][0]["rSeries"].as_array().unwrap().len(),
            value["epochs"].as_array().unwrap().len()
        );
    }

    #[test]
    fn rejects_unreadable_or_compressed_input() {
        assert!(read("x.sp3.gz").unwrap_err().contains("解压"));
        assert!(read("definitely-missing.sp3").unwrap_err().contains("找不到"));
        assert!(load(&ProductSet::default()).is_err());
    }

    #[test]
    fn a_product_that_cannot_be_compared_is_reported_and_the_others_are_kept() {
        let dir = std::env::temp_dir().join(format!("product-outcome-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.sp3");
        fs::write(&path, sp3(&["G01", "G02", "G03"], 14, &|_, _| (0.0, 0.0, 0.0))).unwrap();
        let set = |name: &str, file: &std::path::Path| ProductSet {
            name: name.into(),
            sp3: vec![file.to_string_lossy().into()],
            ..Default::default()
        };
        let outcome = run(CompareRequest {
            reference: set("ref", &path),
            tests: vec![set("", &dir.join("missing.sp3")), set("good", &path)],
            exclude: vec![],
        })
        .unwrap();
        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].name, "good");
        assert_eq!((outcome.failures.len(), outcome.failures[0].name.as_str()), (1, "对比产品 1"));
        assert!(outcome.failures[0].error.contains("找不到"), "{:?}", outcome.failures);
        let missing = run(CompareRequest {
            reference: set("ref", &dir.join("missing.sp3")),
            tests: vec![set("good", &path)],
            exclude: vec![],
        });
        assert!(missing.unwrap_err().starts_with("参考产品："));
        fs::remove_dir_all(dir).unwrap();
    }

    /// Manual check on real files: FINDU_CMP_REF_SP3 / _REF_CLK / _SP3 / _CLK are ';'-separated path lists.
    #[test]
    #[ignore]
    fn compares_real_products() {
        let list = |k: &str| {
            std::env::var(k)
                .unwrap_or_default()
                .split(';')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        };
        let request = CompareRequest {
            reference: ProductSet {
                name: "ref".into(),
                sp3: list("FINDU_CMP_REF_SP3"),
                clk: list("FINDU_CMP_REF_CLK"),
                apc: false,
                ..Default::default()
            },
            tests: vec![ProductSet {
                name: "test".into(),
                sp3: list("FINDU_CMP_SP3"),
                clk: list("FINDU_CMP_CLK"),
                apc: std::env::var("FINDU_CMP_APC").is_ok(),
                ..Default::default()
            }],
            exclude: list("FINDU_CMP_EXCLUDE"),
        };
        let started = std::time::Instant::now();
        let result = run(request).unwrap().results;
        println!("{:.1} s", started.elapsed().as_secs_f64());
        for s in &result[0].systems {
            println!("{s:?}");
        }
        for h in &result[0].hints {
            println!("hint: {h}");
        }
    }
}
