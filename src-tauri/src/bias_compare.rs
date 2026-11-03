//! Observable-specific bias (OSB / DSB) comparison between Bias-SINEX products: one reference against any number of
//! test products. Pure file analysis. Absolute biases depend on a datum, so every comparison removes the common offset
//! of each constellation and signal at each epoch (circularly for phase) before the numbers are reported.
use crate::product_compare::{days_from_civil, orbit_classes, read_clocks, Outcome};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;

const C: f64 = 299_792_458.0;
const MAX_FILE: u64 = 300 * 1024 * 1024;
/// Time grid on which time-varying biases are sampled, in seconds.
const STEP: i64 = 300;
/// Seconds from the Unix epoch to the GPS epoch (1980-01-06), to label the grid.
const GPS_UNIX_OFFSET: i64 = 315_964_800;
/// Code residuals above this many times the constellation median (and the floor below) are called outliers.
const OUTLIER_FACTOR: f64 = 3.0;
const OUTLIER_FLOOR_NS: f64 = 0.5;
const OUTLIER_FLOOR_CYCLES: f64 = 0.15;
/// Wide-lane residuals under this many cycles keep integer ambiguity fixing consistent between two products.
const WL_TOLERANCE: f64 = 0.10;
/// Phase bias minus clock is the quantity that stays the same between consistent products: the corrected observation
/// is the observation minus the OSB, and the satellite clock enters the range with a minus sign.
const CLOCK_SIGN: f64 = 1.0;
const MAX_HINTS: usize = 20;
/// A signal tells the sign only when its code biases differ this much between satellites (ns), and the pooled
/// correlation with the reference must beat this magnitude to count as inverted.
const SIGN_MIN_SPREAD_NS: f64 = 0.5;
const SIGN_CORRELATION: f64 = 0.5;
/// The phase sign departs from the code sign only when the wide-lane gets this much smaller (ratio of RMS).
const SIGN_WIDE_LANE_GAIN: f64 = 0.8;

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BiasSet {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// Optional RINEX clock files of the same product; with them on both sides the narrow-lane is also compared
    /// together with the satellite clock.
    #[serde(default)]
    pub clocks: Vec<String>,
    /// Optional SP3 files, only to tell GEO, IGSO and MEO satellites apart for the satellite selection.
    #[serde(default)]
    pub orbits: Vec<String>,
    /// Sign convention of a test product: "auto" (default, decided against the reference), "keep" or "invert".
    #[serde(default)]
    pub sign: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BiasRequest {
    pub reference: BiasSet,
    pub tests: Vec<BiasSet>,
    /// Satellites left out of every statistic, including the datum that is removed from the others.
    #[serde(default)]
    pub exclude: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
struct Interval {
    start: i64,
    end: i64,
    value: f64,
}

#[derive(Default)]
struct Biases {
    /// (satellite, observable) -> sorted intervals, values in nanoseconds
    osb: BTreeMap<(String, String), Vec<Interval>>,
    time_system: String,
    /// satellite -> whole GPS seconds -> clock offset in seconds
    clocks: BTreeMap<String, HashMap<i64, f64>>,
}

/// Seconds since the GPS epoch for a Bias-SINEX time `YYYY:DDD:SSSSS`.
fn parse_time(text: &str) -> Option<i64> {
    let p: Vec<&str> = text.trim().split(':').collect();
    if p.len() != 3 {
        return None;
    }
    let (y, d, s) = (p[0].parse::<i64>().ok()?, p[1].parse::<i64>().ok()?, p[2].parse::<i64>().ok()?);
    Some((days_from_civil(y, 1, 1) + d - 1 - days_from_civil(1980, 1, 6)) * 86_400 + s)
}

fn column(line: &str, from: usize, to: usize) -> &str {
    line.get(from..to.min(line.len())).unwrap_or("").trim()
}

/// Satellite OSB lines only; receiver biases (a station code in columns 16-24) and DSB lines are not used here.
fn parse_bia(text: &str, into: &mut Biases) -> Result<(), String> {
    let mut in_solution = false;
    let mut records = 0;
    for line in text.lines() {
        if line.starts_with("+BIAS/SOLUTION") {
            in_solution = true;
        } else if line.starts_with("-BIAS/SOLUTION") {
            in_solution = false;
        } else if line.starts_with(" TIME_SYSTEM") && into.time_system.is_empty() {
            into.time_system = line.split_whitespace().nth(1).unwrap_or("").to_string();
        } else if in_solution && line.starts_with(" OSB ") {
            let (prn, station, signal, second) =
                (column(line, 11, 14), column(line, 15, 24), column(line, 25, 29), column(line, 30, 34));
            if !station.is_empty() || !second.is_empty() || prn.len() != 3 {
                continue;
            }
            let (Some(start), Some(end)) =
                (parse_time(column(line, 35, 49)), parse_time(column(line, 50, 64)))
            else {
                continue;
            };
            let scale = match column(line, 65, 69) {
                "ns" => 1.0,
                "m" => 1e9 / C,
                _ => continue,
            };
            let Ok(value) = column(line, 70, 91).parse::<f64>() else { continue };
            into.osb.entry((prn.to_string(), signal.to_string())).or_default().push(Interval {
                start,
                end,
                value: value * scale,
            });
            records += 1;
        }
    }
    if records == 0 {
        return Err("没有找到卫星 OSB 记录（需要 Bias-SINEX 的 +BIAS/SOLUTION 段）".into());
    }
    Ok(())
}

fn read(path: &str) -> Result<String, String> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".gz") || lower.ends_with(".z") {
        return Err(format!("{path}：请先解压 .gz / .Z 文件"));
    }
    let meta = fs::metadata(Path::new(path)).map_err(|_| format!("找不到文件：{path}"))?;
    if meta.len() > MAX_FILE {
        return Err(format!("{path}：文件超过 300 MiB"));
    }
    fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| format!("{path}：{e}"))
}

fn load(set: &BiasSet) -> Result<Biases, String> {
    if set.files.is_empty() {
        return Err("每组偏差产品至少需要一个 Bias-SINEX 文件（.BIA / .BSX）".into());
    }
    let mut biases = Biases::default();
    for path in &set.files {
        parse_bia(&read(path)?, &mut biases).map_err(|e| format!("{path}：{e}"))?;
    }
    for series in biases.osb.values_mut() {
        series.sort_by_key(|i| i.start);
    }
    biases.clocks = read_clocks(&set.clocks)?;
    Ok(biases)
}

fn value_at(series: &[Interval], t: i64) -> Option<f64> {
    let i = series.partition_point(|x| x.start <= t);
    let candidate = series.get(i.checked_sub(1)?)?;
    (t < candidate.end).then_some(candidate.value)
}

/// Carrier frequency in Hz of a RINEX band digit; GLONASS (FDMA) and NavIC are not supported.
fn frequency(system: u8, band: u8) -> Option<f64> {
    let mhz = match (system, band) {
        (b'G' | b'J', b'1') | (b'E', b'1') | (b'C', b'1') => 1575.42,
        (b'G' | b'J', b'2') => 1227.60,
        (b'G' | b'J' | b'E' | b'C', b'5') => 1176.45,
        (b'E', b'7') | (b'C', b'7') => 1207.14,
        (b'E', b'8') | (b'C', b'8') => 1191.795,
        (b'E', b'6') => 1278.75,
        (b'C', b'2') => 1561.098,
        (b'C', b'6') => 1268.52,
        _ => return None,
    };
    Some(mhz * 1e6)
}

/// Frequency pairs for the wide-lane check, as band digits, per constellation.
fn wide_lane_pairs(system: u8) -> &'static [(u8, u8)] {
    match system {
        b'G' | b'J' => &[(b'1', b'2'), (b'1', b'5')],
        b'E' => &[(b'1', b'5'), (b'1', b'7')],
        b'C' => &[(b'2', b'6'), (b'2', b'7'), (b'1', b'5')],
        _ => &[],
    }
}

fn wrap(x: f64) -> f64 {
    x - x.round()
}

/// Mean of cyclic fractions in cycles, so a common integer offset between products never counts as an error.
fn circular_mean(values: &[f64]) -> f64 {
    let (s, c) = values.iter().fold((0.0, 0.0), |(s, c), v| {
        let a = v * std::f64::consts::TAU;
        (s + a.sin(), c + a.cos())
    });
    s.atan2(c) / std::f64::consts::TAU
}

/// Robust centre of cyclic fractions: the circular mean, moved to the median of the wrapped offsets around it, so one
/// bad satellite does not drag every other satellite's difference with it.
fn circular_median(values: &[f64]) -> f64 {
    let centre = circular_mean(values);
    centre + median(values.iter().map(|v| wrap(v - centre)).collect())
}

const HISTOGRAM_BINS: usize = 50;

/// A round number (1, 2 or 5 times a power of ten) at or above `x`.
fn nice_limit(x: f64) -> f64 {
    if !(x > 0.0) || !x.is_finite() {
        return 1.0;
    }
    let e = 10f64.powf(x.log10().floor());
    let m = x / e;
    e * if m <= 1.0 {
        1.0
    } else if m <= 2.0 {
        2.0
    } else if m <= 5.0 {
        5.0
    } else {
        10.0
    }
}

/// Cyclic residuals always span one cycle; the others span a round limit just above their 99th percentile.
fn histogram(values: &[f64], cyclic: bool) -> Histogram {
    let limit = if cyclic {
        0.5
    } else {
        let mut magnitudes: Vec<f64> = values.iter().map(|v| v.abs()).collect();
        magnitudes.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p99 = magnitudes.get(((magnitudes.len().saturating_sub(1)) as f64 * 0.99) as usize).copied();
        nice_limit(p99.unwrap_or(0.0))
    };
    let width = 2.0 * limit / HISTOGRAM_BINS as f64;
    let mut counts = vec![0u32; HISTOGRAM_BINS];
    for v in values {
        let i = (((v + limit) / width).floor().max(0.0) as usize).min(HISTOGRAM_BINS - 1);
        counts[i] += 1;
    }
    Histogram { min: -limit, width, counts }
}

fn round5(x: f64) -> f64 {
    (x * 1e5).round() / 1e5
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    match v.len() {
        0 => f64::NAN,
        n if n % 2 == 1 => v[n / 2],
        n => (v[n / 2 - 1] + v[n / 2]) / 2.0,
    }
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BiasItem {
    pub sat: String,
    pub system: String,
    /// Signal such as `C1C` or `L2W`; wide-lane items are named `WL L1-L2`, code differences `DCB C1C-C2W`.
    pub signal: String,
    /// `code`, `phase`, `wl` or `dcb`.
    pub kind: String,
    /// Mean difference to the reference after the common offset was removed: ns for code and DCB, cycles otherwise.
    pub mean: f64,
    /// RMS of the difference over the compared epochs, same unit.
    pub rms: f64,
    /// Standard deviation over time (0 for daily constants): how steady the difference is during the day.
    pub temporal_std: f64,
    pub n: usize,
    pub outlier: bool,
    /// Residual per grid epoch (cycles) for wide-lane and narrow-lane items, so the page can draw it as a heat map.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<Vec<Option<f64>>>,
}

/// Distribution of the residuals of every satellite and epoch: `counts[i]` covers `[min + i*width, min + (i+1)*width)`,
/// values beyond the range are counted in the end bins.
#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Histogram {
    pub min: f64,
    pub width: f64,
    pub counts: Vec<u32>,
}

/// Per grid epoch: the RMS over satellites after the datum was removed, and the datum itself.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EpochSeries {
    pub rms: Vec<Option<f64>>,
    pub datum: Vec<Option<f64>>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BiasRow {
    pub system: String,
    pub signal: String,
    pub kind: String,
    pub unit: String,
    pub sats: usize,
    /// Datum offset that was removed (median over satellites); informative only. ns or cycles.
    pub offset: f64,
    /// RMS over satellites of the per-satellite mean difference.
    pub rms: f64,
    pub max: f64,
    /// Median over satellites of the temporal standard deviation.
    pub temporal_std: f64,
    /// Wide-lane rows: share of satellites within ±0.10 cycles; empty for the others.
    pub within_tolerance: Option<f64>,
    pub outliers: usize,
    /// RMS over all satellites and epochs: unlike `rms` it includes the scatter during the day.
    pub total_rms: f64,
    /// Cyclic rows: share of satellite-epochs within ±0.10 cycles.
    pub epoch_within: Option<f64>,
    pub histogram: Histogram,
    pub series: EpochSeries,
}

/// Which sign the biases of a test product were compared with: 1 as given, -1 inverted.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BiasSign {
    pub code: i8,
    pub phase: i8,
    /// Decided from the data (the default) and not by the user.
    pub auto: bool,
    /// Correlation of the code biases with the reference that decided the sign, when it was measurable.
    pub correlation: Option<f64>,
}

impl Default for BiasSign {
    fn default() -> Self {
        Self { code: 1, phase: 1, auto: false, correlation: None }
    }
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BiasComparison {
    pub name: String,
    pub time_system: String,
    /// First grid epoch as `YYYY-MM-DDTHH:MM:SS` in the products' time system; `epochs` samples every `step` seconds.
    pub start: String,
    pub step: i64,
    pub epochs: usize,
    /// Every satellite both products have, whether or not it was excluded; the page offers these for selection.
    pub satellites: Vec<String>,
    /// The requested exclusions that matched one of `satellites`.
    pub excluded: Vec<String>,
    pub sign: BiasSign,
    /// GEO / IGSO / MEO of satellites, from the SP3 files given to the page; empty without any.
    pub orbit_classes: BTreeMap<String, String>,
    pub rows: Vec<BiasRow>,
    pub items: Vec<BiasItem>,
    pub hints: Vec<String>,
    pub test_only: Vec<String>,
    pub reference_only: Vec<String>,
}

/// One quantity per satellite and sample time, already reduced to a comparable number (ns or cycles).
struct Quantity {
    system: u8,
    name: String,
    kind: &'static str,
    cyclic: bool,
    /// satellite -> (time, reference, test)
    sats: BTreeMap<String, Vec<(i64, f64, f64)>>,
}

fn grid(a: &[Interval], b: &[Interval]) -> Vec<i64> {
    let start = a.first().map_or(0, |x| x.start).max(b.first().map_or(0, |x| x.start));
    let end = a.iter().map(|x| x.end).max().unwrap_or(0).min(b.iter().map(|x| x.end).max().unwrap_or(0));
    let first = (start + STEP - 1).div_euclid(STEP) * STEP;
    (0..).map(|k| first + k * STEP).take_while(|t| *t < end).collect()
}

/// Multiply the code and / or phase biases of a product by -1 in place.
fn flip(biases: &mut Biases, code: bool, phase: bool) {
    for ((_, signal), series) in biases.osb.iter_mut() {
        let invert = match signal.as_bytes()[0] {
            b'C' => code,
            b'L' => phase,
            _ => false,
        };
        if invert {
            series.iter_mut().for_each(|i| i.value = -i.value);
        }
    }
}

/// How the daily code biases of the satellites of a test product line up with the reference: the median over
/// constellations and signals of the correlation after the datum (the median over satellites) is taken out. Close to
/// +1 for products that follow the same sign convention, close to -1 when one of them is inverted. None when no signal
/// varies enough between satellites.
fn code_correlation(reference: &Biases, test: &Biases, exclude: &BTreeSet<String>) -> Option<f64> {
    let mut groups: BTreeMap<(u8, &String), Vec<(f64, f64)>> = BTreeMap::new();
    for ((sat, signal), a) in &reference.osb {
        if signal.as_bytes()[0] != b'C' || exclude.contains(sat) {
            continue;
        }
        let Some(b) = test.osb.get(&(sat.clone(), signal.clone())) else { continue };
        let (mut x, mut y, mut n) = (0.0, 0.0, 0);
        for t in grid(a, b) {
            if let (Some(p), Some(q)) = (value_at(a, t), value_at(b, t)) {
                x += p;
                y += q;
                n += 1;
            }
        }
        if n > 0 {
            groups.entry((sat.as_bytes()[0], signal)).or_default().push((x / n as f64, y / n as f64));
        }
    }
    // one correlation per constellation and signal, then their median: a constellation whose code biases are defined
    // differently in the two products (BeiDou between centres) must not outvote the others by its size
    let mut correlations = Vec::new();
    for pairs in groups.values().filter(|p| p.len() >= 5) {
        let mx = median(pairs.iter().map(|p| p.0).collect());
        let my = median(pairs.iter().map(|p| p.1).collect());
        let spread = (pairs.iter().map(|p| (p.0 - mx).powi(2)).sum::<f64>() / pairs.len() as f64).sqrt();
        if spread < SIGN_MIN_SPREAD_NS {
            continue;
        }
        let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
        for (x, y) in pairs {
            sxy += (x - mx) * (y - my);
            sxx += (x - mx).powi(2);
            syy += (y - my).powi(2);
        }
        if sxx > 0.0 && syy > 0.0 {
            correlations.push(sxy / (sxx * syy).sqrt());
        }
    }
    (!correlations.is_empty()).then(|| median(correlations))
}

/// RMS of the wide-lane differences over all satellites and epochs: the quantity that tells the phase sign, because a
/// wide-lane needs the code and the phase biases to agree on it.
fn wide_lane_score(result: &BiasComparison) -> Option<f64> {
    let (mut sum, mut n) = (0.0, 0.0);
    for row in result.rows.iter().filter(|r| r.kind == "wl") {
        let count = row.histogram.counts.iter().sum::<u32>() as f64;
        sum += row.total_rms.powi(2) * count;
        n += count;
    }
    (n > 0.0).then(|| (sum / n).sqrt())
}

/// Decide the sign convention of `test` against the reference and apply it. The code biases follow the correlation;
/// the phase biases follow the code unless the wide-lane agrees clearly better the other way round.
fn detect_signs(reference: &Biases, test: &mut Biases, exclude: &BTreeSet<String>) -> BiasSign {
    let correlation = code_correlation(reference, test, exclude);
    let code = correlation.is_some_and(|r| r < -SIGN_CORRELATION);
    flip(test, code, code);
    let score =
        |test: &Biases| compare_without(reference, test, "", exclude).ok().as_ref().and_then(wide_lane_score);
    let default = score(test);
    flip(test, false, true);
    let other = score(test);
    let phase_differs = matches!((default, other), (Some(a), Some(b)) if b < SIGN_WIDE_LANE_GAIN * a);
    if !phase_differs {
        flip(test, false, true);
    }
    let sign = |inverted: bool| if inverted { -1 } else { 1 };
    BiasSign { code: sign(code), phase: sign(code != phase_differs), auto: true, correlation }
}

#[cfg(test)]
fn compare(reference: &Biases, test: &Biases, name: &str) -> Result<BiasComparison, String> {
    compare_without(reference, test, name, &BTreeSet::new())
}

fn compare_without(
    reference: &Biases,
    test: &Biases,
    name: &str,
    exclude: &BTreeSet<String>,
) -> Result<BiasComparison, String> {
    let sats = |b: &Biases| -> BTreeSet<String> { b.osb.keys().map(|k| k.0.clone()).collect() };
    let (ref_sats, test_sats) = (sats(reference), sats(test));
    let shared: BTreeSet<&String> = ref_sats.intersection(&test_sats).collect();
    if shared.is_empty() {
        return Err("参考与对比的偏差产品没有共同卫星，无法比较".into());
    }
    let common: BTreeSet<&String> = shared.iter().copied().filter(|s| !exclude.contains(*s)).collect();
    if common.is_empty() {
        return Err("剔除后没有剩余的卫星，请恢复一部分卫星".into());
    }
    let mut quantities: Vec<Quantity> = Vec::new();
    let mut by_sat: BTreeMap<&String, Vec<&String>> = BTreeMap::new();
    for (sat, signal) in reference.osb.keys() {
        if common.contains(sat) && test.osb.contains_key(&(sat.clone(), signal.clone())) {
            by_sat.entry(sat).or_default().push(signal);
        }
    }
    let mut signals: BTreeMap<(u8, String), Vec<(String, Vec<(i64, f64, f64)>)>> = BTreeMap::new();
    for (sat, list) in &by_sat {
        for signal in list {
            let key = ((*sat).clone(), (*signal).clone());
            let (a, b) = (&reference.osb[&key], &test.osb[&key]);
            let series: Vec<(i64, f64, f64)> =
                grid(a, b).into_iter().filter_map(|t| Some((t, value_at(a, t)?, value_at(b, t)?))).collect();
            if !series.is_empty() {
                signals
                    .entry((sat.as_bytes()[0], (*signal).clone()))
                    .or_default()
                    .push(((*sat).clone(), series));
            }
        }
    }
    if signals.is_empty() {
        return Err("两份产品覆盖的时间没有重叠，请确认是同一天的产品".into());
    }
    // single observables: code in ns, phase in cycles
    for ((system, signal), sats) in &signals {
        let kind = match signal.as_bytes()[0] {
            b'C' => "code",
            b'L' => "phase",
            _ => continue,
        };
        let scale = if kind == "phase" {
            match frequency(*system, signal.as_bytes()[1]) {
                Some(f) => f * 1e-9,
                None => continue,
            }
        } else {
            1.0
        };
        quantities.push(Quantity {
            system: *system,
            name: signal.clone(),
            kind,
            cyclic: kind == "phase",
            sats: sats
                .iter()
                .map(|(sat, s)| (sat.clone(), s.iter().map(|(t, a, b)| (*t, a * scale, b * scale)).collect()))
                .collect(),
        });
    }
    // code differences between two signals of the same satellite: no datum involved
    for system in signals.keys().map(|k| k.0).collect::<BTreeSet<u8>>() {
        let codes: Vec<&String> =
            signals.keys().filter(|k| k.0 == system && k.1.starts_with('C')).map(|k| &k.1).collect();
        let mut pairs: Vec<(usize, &String, &String)> = Vec::new();
        for (i, &a) in codes.iter().enumerate() {
            for &b in &codes[i + 1..] {
                let count = signals[&(system, a.clone())]
                    .iter()
                    .filter(|(sat, _)| signals[&(system, b.clone())].iter().any(|(s2, _)| s2 == sat))
                    .count();
                if count >= 5 && a.as_bytes()[1] != b.as_bytes()[1] {
                    pairs.push((count, a, b));
                }
            }
        }
        pairs.sort_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(y.1)).then(x.2.cmp(y.2)));
        for (_, a, b) in pairs.into_iter().take(8) {
            let sa = &signals[&(system, a.clone())];
            let sb: HashMap<&String, &Vec<(i64, f64, f64)>> =
                signals[&(system, b.clone())].iter().map(|(s, v)| (s, v)).collect();
            let mut sats = BTreeMap::new();
            for (sat, va) in sa {
                let Some(vb) = sb.get(sat) else { continue };
                let times: HashMap<i64, (f64, f64)> = vb.iter().map(|(t, x, y)| (*t, (*x, *y))).collect();
                let series: Vec<(i64, f64, f64)> =
                    va.iter().filter_map(|(t, x, y)| times.get(t).map(|(p, q)| (*t, x - p, y - q))).collect();
                if !series.is_empty() {
                    sats.insert(sat.clone(), series);
                }
            }
            quantities.push(Quantity {
                system,
                name: format!("DCB {a}-{b}"),
                kind: "dcb",
                cyclic: false,
                sats,
            });
        }
    }
    // wide-lane bias in cycles from code and phase biases of two bands, matched by tracking attribute
    let mut narrow_lane: BTreeSet<(u8, String)> = BTreeSet::new();
    let with_clocks = !reference.clocks.is_empty() && !test.clocks.is_empty();
    let mut hints = Vec::new();
    if reference.clocks.is_empty() != test.clocks.is_empty() {
        hints.push(
            "只有一份产品给了钟差文件，未计算带钟差的窄巷和码偏差；参考和对比产品都需要钟差".to_string(),
        );
    }
    let mut with_clock_rows = 0;
    for system in signals.keys().map(|k| k.0).collect::<BTreeSet<u8>>() {
        for (index, &(b1, b2)) in wide_lane_pairs(system).iter().enumerate() {
            let (Some(f1), Some(f2)) = (frequency(system, b1), frequency(system, b2)) else { continue };
            let attributes = |band: u8| -> Vec<u8> {
                let mut a: Vec<u8> = signals
                    .keys()
                    .filter(|k| k.0 == system && k.1.as_bytes()[0] == b'L' && k.1.as_bytes()[1] == band)
                    .map(|k| k.1.as_bytes()[2])
                    .filter(|x| signals.contains_key(&(system, format!("C{}{}", band as char, *x as char))))
                    .collect();
                a.sort_by_key(|x| {
                    std::cmp::Reverse(signals[&(system, format!("L{}{}", band as char, *x as char))].len())
                });
                a
            };
            let (Some(&a1), Some(&a2)) = (attributes(b1).first(), attributes(b2).first()) else { continue };
            let name =
                |kind: char, band: u8, attr: u8| (system, format!("{kind}{}{}", band as char, attr as char));
            let table = |key: (u8, String)| -> HashMap<String, HashMap<i64, (f64, f64)>> {
                signals[&key]
                    .iter()
                    .map(|(s, v)| (s.clone(), v.iter().map(|(t, a, b)| (*t, (*a, *b))).collect()))
                    .collect()
            };
            let (l1, l2, c1, c2) = (
                table(name('L', b1, a1)),
                table(name('L', b2, a2)),
                table(name('C', b1, a1)),
                table(name('C', b2, a2)),
            );
            let lambda = C / (f1 - f2);
            // metres: phase and code biases, ns * c; reference and test evaluated in the same way
            let wl = |l1: f64, l2: f64, c1: f64, c2: f64| {
                ((f1 * l1 - f2 * l2) / (f1 - f2) - (f1 * c1 + f2 * c2) / (f1 + f2)) * 1e-9 * C / lambda
            };
            // The clock products are ionosphere-free combinations of the first pair of a constellation (GPS L1/L2,
            // Galileo E1/E5a, BDS B1I/B3I). Every observable carries the satellite clock the same way, so a clock
            // offset between two products moves the code and phase biases with it. The narrow-lane that is invariant
            // to that is the ionosphere-free phase bias minus the clock, both in narrow-lane cycles, minus the
            // code-aided wide-lane that was fixed before; the codes alone are the bias minus the clock in ns.
            let joint = index == 0 && with_clocks;
            let clock = |clocks: &HashMap<i64, f64>, t: &i64| clocks.get(t).map(|c| CLOCK_SIGN * c);
            let narrow = |l1: f64, l2: f64, c1: f64, c2: f64, clk: f64| {
                1e-9 * (f1 * f1 * l1 - f2 * f2 * l2) / (f1 - f2)
                    - (f1 + f2) * clk
                    - f2 / (f1 - f2) * wl(l1, l2, c1, c2)
            };
            let mut sats = BTreeMap::new();
            let mut coupled = BTreeMap::new();
            for (sat, v1) in &l1 {
                let (Some(v2), Some(w1), Some(w2)) = (l2.get(sat), c1.get(sat), c2.get(sat)) else {
                    continue;
                };
                let series: Vec<(i64, f64, f64)> = v1
                    .iter()
                    .filter_map(|(t, (ra, rb))| {
                        let (p, q, r) = (v2.get(t)?, w1.get(t)?, w2.get(t)?);
                        Some((*t, wl(*ra, p.0, q.0, r.0), wl(*rb, p.1, q.1, r.1)))
                    })
                    .collect();
                if !series.is_empty() {
                    sats.insert(sat.clone(), series);
                }
                let (true, Some(rc), Some(tc)) = (joint, reference.clocks.get(sat), test.clocks.get(sat))
                else {
                    continue;
                };
                let narrow_series: Vec<(i64, f64, f64)> = v1
                    .iter()
                    .filter_map(|(t, (ra, rb))| {
                        let (p, q, r) = (v2.get(t)?, w1.get(t)?, w2.get(t)?);
                        let (x, y) = (clock(rc, t)?, clock(tc, t)?);
                        Some((*t, narrow(*ra, p.0, q.0, r.0, x), narrow(*rb, p.1, q.1, r.1, y)))
                    })
                    .collect();
                if !narrow_series.is_empty() {
                    coupled.insert(sat.clone(), narrow_series);
                }
            }
            if sats.len() >= 3 {
                narrow_lane.insert((system, format!("L{}{}", b1 as char, a1 as char)));
                quantities.push(Quantity {
                    system,
                    name: format!("WL L{}{}-L{}{}", b1 as char, a1 as char, b2 as char, a2 as char),
                    kind: "wl",
                    cyclic: true,
                    sats,
                });
            }
            if coupled.len() >= 3 {
                with_clock_rows += 1;
                quantities.push(Quantity {
                    system,
                    name: format!("NL+CLK L{}{}", b1 as char, a1 as char),
                    kind: "nlc",
                    cyclic: true,
                    sats: coupled,
                });
            }
        }
    }
    // The codes alone, every code signal: the bias minus the satellite clock in ns.
    if with_clocks {
        for ((system, signal), sats) in signals.iter().filter(|(k, _)| k.1.starts_with('C')) {
            let series: BTreeMap<String, Vec<(i64, f64, f64)>> = sats
                .iter()
                .filter_map(|(sat, s)| {
                    let (rc, tc) = (reference.clocks.get(sat)?, test.clocks.get(sat)?);
                    let series: Vec<(i64, f64, f64)> = s
                        .iter()
                        .filter_map(|(t, a, b)| {
                            Some((*t, a - CLOCK_SIGN * rc.get(t)? * 1e9, b - CLOCK_SIGN * tc.get(t)? * 1e9))
                        })
                        .collect();
                    (!series.is_empty()).then(|| (sat.clone(), series))
                })
                .collect();
            if series.len() >= 3 {
                with_clock_rows += 1;
                quantities.push(Quantity {
                    system: *system,
                    name: format!("{signal}+CLK"),
                    kind: "codec",
                    cyclic: false,
                    sats: series,
                });
            }
        }
    }
    if with_clocks && with_clock_rows == 0 {
        hints.push("钟差文件与偏差产品没有足够的共同卫星和历元，未计算带钟差的窄巷和码偏差".to_string());
    }
    // With the wide-lane fixed, the narrow-lane ambiguity is the integer N1 of the first frequency of the pair, so its
    // fractional bias is the phase bias of that signal in cycles; it is tied to the clock, like every phase bias.
    for (system, signal) in narrow_lane {
        let Some(f) = frequency(system, signal.as_bytes()[1]) else { continue };
        let Some(sats) = signals.get(&(system, signal.clone())) else { continue };
        if sats.len() >= 3 {
            quantities.push(Quantity {
                system,
                name: format!("NL {signal}"),
                kind: "nl",
                cyclic: true,
                sats: sats
                    .iter()
                    .map(|(sat, s)| {
                        (sat.clone(), s.iter().map(|(t, a, b)| (*t, a * f * 1e-9, b * f * 1e-9)).collect())
                    })
                    .collect(),
            });
        }
    }
    let mut rows = Vec::new();
    let mut items = Vec::new();
    // every sample lies on the STEP grid, so one shared epoch index serves all series
    let times = || quantities.iter().flat_map(|q| q.sats.values().flat_map(|s| s.iter().map(|x| x.0)));
    let first = times().min().unwrap_or(0);
    let epochs = times().max().map_or(0, |last| ((last - first) / STEP) as usize + 1);
    let slot = |t: i64| ((t - first) / STEP) as usize;
    for q in &quantities {
        // per-epoch common offset over the satellites that have this quantity
        let mut by_time: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
        for series in q.sats.values() {
            for (t, a, b) in series {
                by_time.entry(*t).or_default().push(b - a);
            }
        }
        let datum: HashMap<i64, f64> = by_time
            .iter()
            .map(|(t, v)| {
                (
                    *t,
                    if q.cyclic {
                        circular_median(&v.iter().map(|x| wrap(*x)).collect::<Vec<_>>())
                    } else {
                        median(v.clone())
                    },
                )
            })
            .collect();
        let mut group = Vec::new();
        let mut pooled: Vec<f64> = Vec::new();
        let mut squares = vec![(0.0, 0usize); epochs];
        let draws_map = matches!(q.kind, "wl" | "nl" | "nlc");
        // A narrow-lane is only defined up to an integer ambiguity and the clock reference of each product, so its
        // constant per satellite is arbitrary; what says whether ambiguities can be fixed is how it moves in the day.
        let demean = matches!(q.kind, "nl" | "nlc");
        for (sat, series) in &q.sats {
            let mut residual: Vec<f64> = series
                .iter()
                .map(|(t, a, b)| {
                    let d = b - a - datum[t];
                    if q.cyclic {
                        wrap(d)
                    } else {
                        d
                    }
                })
                .collect();
            let constant = if demean { circular_mean(&residual) } else { 0.0 };
            if demean {
                residual.iter_mut().for_each(|r| *r = wrap(*r - constant));
            }
            let mut map = draws_map.then(|| vec![None; epochs]);
            for ((t, _, _), r) in series.iter().zip(&residual) {
                let (sum, count) = &mut squares[slot(*t)];
                *sum += r * r;
                *count += 1;
                if let Some(map) = map.as_mut() {
                    map[slot(*t)] = Some(round5(*r));
                }
            }
            pooled.extend(&residual);
            let n = residual.len() as f64;
            let mean = residual.iter().sum::<f64>() / n;
            let rms = (residual.iter().map(|x| x * x).sum::<f64>() / n).sqrt();
            let temporal = if residual.len() > 1 {
                (residual.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
            } else {
                0.0
            };
            group.push(BiasItem {
                sat: sat.clone(),
                system: (q.system as char).to_string(),
                signal: q.name.clone(),
                kind: q.kind.into(),
                mean: if demean { constant } else { mean },
                rms,
                temporal_std: temporal,
                n: residual.len(),
                outlier: false,
                series: map,
            });
        }
        if group.is_empty() {
            continue;
        }
        // the size that counts: the difference itself, or for the narrow-lane its scatter in the day
        let size = |g: &BiasItem| if demean { g.rms } else { g.mean.abs() };
        let spread = median(group.iter().map(size).collect());
        let floor = if q.cyclic { OUTLIER_FLOOR_CYCLES } else { OUTLIER_FLOOR_NS };
        let limit = (OUTLIER_FACTOR * spread).max(floor);
        let unit = if q.cyclic { "cyc" } else { "ns" };
        for g in group.iter_mut() {
            g.outlier = size(g) > limit;
            if g.outlier {
                hints.push(if demean {
                    format!(
                        "{} {} 日内波动 {:.3} {unit}，超出同系统中位数 {:.3} {unit} 的 {OUTLIER_FACTOR:.0} 倍",
                        g.sat, g.signal, g.rms, spread
                    )
                } else {
                    format!(
                        "{} {} 与参考相差 {:+.3} {unit}，超出同系统中位数 {:.3} {unit} 的 {OUTLIER_FACTOR:.0} 倍",
                        g.sat, g.signal, g.mean, spread
                    )
                });
            }
        }
        let offset = if q.cyclic {
            circular_median(&datum.values().copied().collect::<Vec<_>>())
        } else {
            median(datum.values().copied().collect())
        };
        let mut datum_series = vec![None; epochs];
        for (t, v) in &datum {
            datum_series[slot(*t)] = Some(round5(*v));
        }
        rows.push(BiasRow {
            total_rms: (pooled.iter().map(|x| x * x).sum::<f64>() / pooled.len() as f64).sqrt(),
            epoch_within: q.cyclic.then(|| {
                pooled.iter().filter(|x| x.abs() < WL_TOLERANCE).count() as f64 / pooled.len() as f64
            }),
            histogram: histogram(&pooled, q.cyclic),
            series: EpochSeries {
                rms: squares
                    .iter()
                    .map(|(sum, count)| (*count > 0).then(|| round5((sum / *count as f64).sqrt())))
                    .collect(),
                datum: datum_series,
            },
            system: (q.system as char).to_string(),
            signal: q.name.clone(),
            kind: q.kind.into(),
            unit: unit.into(),
            sats: group.len(),
            offset,
            rms: (group.iter().map(|g| size(g).powi(2)).sum::<f64>() / group.len() as f64).sqrt(),
            max: group.iter().fold(0.0, |m: f64, g| m.max(size(g))),
            temporal_std: median(group.iter().map(|g| g.temporal_std).collect()),
            within_tolerance: (q.kind == "wl").then(|| {
                group.iter().filter(|g| g.mean.abs() < WL_TOLERANCE).count() as f64 / group.len() as f64
            }),
            outliers: group.iter().filter(|g| g.outlier).count(),
        });
        items.extend(group);
    }
    if rows.is_empty() {
        return Err("两份产品没有可以比较的共同信号".into());
    }
    if hints.len() > MAX_HINTS {
        let extra = hints.len() - MAX_HINTS;
        hints.truncate(MAX_HINTS);
        hints.push(format!("另有 {extra} 条类似提示，见各卫星页签中标红的条目"));
    }
    if !reference.time_system.is_empty()
        && !test.time_system.is_empty()
        && reference.time_system != test.time_system
    {
        hints.push(format!("时间系统不同：参考 {}，对比 {}", reference.time_system, test.time_system));
    }
    Ok(BiasComparison {
        name: name.to_string(),
        time_system: test.time_system.clone(),
        start: chrono::DateTime::from_timestamp(first + GPS_UNIX_OFFSET, 0)
            .map(|d| d.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_default(),
        step: STEP,
        epochs,
        satellites: shared.iter().map(|s| s.to_string()).collect(),
        excluded: shared.iter().filter(|s| exclude.contains(**s)).map(|s| s.to_string()).collect(),
        sign: BiasSign::default(),
        orbit_classes: BTreeMap::new(),
        rows,
        items,
        hints,
        test_only: test_sats.difference(&ref_sats).cloned().collect(),
        reference_only: ref_sats.difference(&test_sats).cloned().collect(),
    })
}

pub fn run(request: BiasRequest) -> Result<Outcome<BiasComparison>, String> {
    if request.tests.is_empty() {
        return Err("请至少添加一组对比产品".into());
    }
    if request.tests.len() > 8 {
        return Err("一次最多对比 8 组产品".into());
    }
    let reference = load(&request.reference).map_err(|e| format!("参考产品：{e}"))?;
    let exclude: BTreeSet<String> = request.exclude.iter().map(|s| s.trim().to_ascii_uppercase()).collect();
    let orbits: Vec<String> = std::iter::once(&request.reference)
        .chain(&request.tests)
        .flat_map(|set| set.orbits.iter().cloned())
        .collect();
    // The orbits only tell GEO / IGSO / MEO apart: an unreadable one costs the satellite classes, not the comparison.
    let (classes, class_error) = match orbit_classes(&orbits) {
        Ok(classes) => (classes, None),
        Err(e) => (Default::default(), Some(e)),
    };
    let mut outcome = Outcome::new();
    for (i, set) in request.tests.iter().enumerate() {
        let label = if set.name.is_empty() { format!("对比产品 {}", i + 1) } else { set.name.clone() };
        let one = compare_product(&reference, set, &label, &exclude).map(|mut result| {
            result.orbit_classes = classes.clone();
            if let Some(e) = &class_error {
                result.hints.push(format!("轨道文件没能读取，无法按 GEO / IGSO / MEO 筛选卫星：{e}"));
            }
            result
        });
        outcome.add(label, one);
    }
    Ok(outcome)
}

/// One test product against the reference, with the sign convention settled first.
fn compare_product(
    reference: &Biases,
    set: &BiasSet,
    label: &str,
    exclude: &BTreeSet<String>,
) -> Result<BiasComparison, String> {
    let mut test = load(set)?;
    let sign = match set.sign.trim().to_ascii_lowercase().as_str() {
        "keep" => BiasSign::default(),
        "invert" => {
            flip(&mut test, true, true);
            BiasSign { code: -1, phase: -1, auto: false, correlation: None }
        }
        _ => detect_signs(reference, &mut test, exclude),
    };
    let mut result = compare_without(reference, &test, label, exclude)?;
    if sign.code < 0 || sign.phase < 0 {
        let how = if sign.auto {
            format!(
                "检测到该产品的偏差符号与参考相反（码偏差与参考的相关系数 {}），",
                sign.correlation.map_or("—".to_string(), |r| format!("{r:.2}"))
            )
        } else {
            "按设置，".to_string()
        };
        let what = match (sign.code < 0, sign.phase < 0) {
            (true, true) => "已把码偏差和相位偏差整体取反后比较",
            (true, false) => "已把码偏差取反（相位偏差保持）后比较",
            _ => "已把相位偏差取反（码偏差保持）后比较",
        };
        result.hints.insert(0, format!("{how}{what}；可在产品名称旁改为“不取反”"));
    }
    result.sign = sign;
    Ok(result)
}

#[tauri::command]
pub async fn compare_biases(request: BiasRequest) -> Result<Outcome<BiasComparison>, String> {
    tauri::async_runtime::spawn_blocking(move || run(request)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One satellite OSB line in the Bias-SINEX column layout.
    fn line(prn: &str, signal: &str, start: &str, end: &str, unit: &str, value: f64) -> String {
        let mut bytes = vec![b' '; 104];
        let mut put = |at: usize, text: &str| bytes[at..at + text.len()].copy_from_slice(text.as_bytes());
        put(1, "OSB");
        put(6, &format!("{}0{}", &prn[..1], &prn[1..]));
        put(11, prn);
        put(25, signal);
        put(35, start);
        put(50, end);
        put(65, unit);
        put(70, &format!("{value:>21.12}"));
        put(92, "0.0100");
        String::from_utf8(bytes).unwrap().trim_end().to_string()
    }

    fn file(records: &[String]) -> String {
        let mut text =
            String::from("%=BIA 1.00 TST\n TIME_SYSTEM                             G\n+BIAS/SOLUTION\n");
        for r in records {
            text += r;
            text.push('\n');
        }
        text + "-BIAS/SOLUTION\n"
    }

    const DAY: (&str, &str) = ("2026:262:00000", "2026:263:00000");
    const SATS: [&str; 5] = ["G01", "G02", "G03", "G04", "G05"];

    /// Reference values: code and phase biases per satellite and signal, in ns.
    fn base(i: usize, signal: &str) -> f64 {
        let i = i as f64;
        match signal {
            "C1W" => 5.0 + i,
            "C2W" => 8.0 + 0.5 * i,
            "L1W" => 10.0 + 3.7 * i,
            _ => 12.0 + 2.9 * i,
        }
    }

    fn products(change: &dyn Fn(usize, &str, f64) -> f64) -> Biases {
        let mut records = Vec::new();
        for (i, sat) in SATS.iter().enumerate() {
            for signal in ["C1W", "C2W", "L1W", "L2W"] {
                records.push(line(sat, signal, DAY.0, DAY.1, "ns", change(i, signal, base(i, signal))));
            }
        }
        let mut b = Biases::default();
        parse_bia(&file(&records), &mut b).unwrap();
        b
    }

    fn row<'a>(c: &'a BiasComparison, signal: &str) -> &'a BiasRow {
        c.rows.iter().find(|r| r.signal == signal).unwrap_or_else(|| {
            panic!("no row {signal}: {:?}", c.rows.iter().map(|r| &r.signal).collect::<Vec<_>>())
        })
    }

    fn cycles_to_ns(c: f64) -> f64 {
        c / 1575.42e6 * 1e9
    }

    #[test]
    fn parses_satellite_osb_and_skips_stations_dsb_and_unknown_units() {
        let text = file(&[
            line("G01", "C1C", DAY.0, DAY.1, "ns", -5.9),
            line("G02", "C1C", "2026:262:00000", "2026:262:00030", "ns", 1.5),
            line("G02", "C1C", "2026:262:00030", "2026:262:00060", "ns", 1.6),
            line("G03", "C1C", DAY.0, DAY.1, "m", 0.299792458),
            line("G04", "C1C", DAY.0, DAY.1, "cyc", 0.1),
            format!(
                " OSB  G    G   ABMF      C1W       {} {} ns                 -0.0000      0.0004",
                DAY.0, DAY.1
            ),
            format!(
                " DSB  G001 G01           C1C  C1W   {} {} ns                  1.0000      0.0004",
                DAY.0, DAY.1
            ),
        ]);
        let mut b = Biases::default();
        parse_bia(&text, &mut b).unwrap();
        assert_eq!(b.time_system, "G");
        assert_eq!(b.osb.len(), 3, "{:?}", b.osb.keys().collect::<Vec<_>>());
        assert!(
            (b.osb[&("G03".to_string(), "C1C".to_string())][0].value - 1.0).abs() < 1e-9,
            "metres become ns"
        );
        let g02 = &b.osb[&("G02".to_string(), "C1C".to_string())];
        assert_eq!(g02.len(), 2);
        assert_eq!(g02[1].start - g02[0].start, 30);
        // 2026-09-19 is day 262; the GPS epoch is 1980-01-06
        assert_eq!(
            parse_time("2026:262:00000"),
            Some((days_from_civil(2026, 9, 19) - days_from_civil(1980, 1, 6)) * 86_400)
        );
        assert_eq!(value_at(g02, g02[0].start + 45), Some(1.6));
        assert_eq!(value_at(g02, g02[1].end), None);
        assert!(parse_bia("nothing here", &mut Biases::default()).is_err());
    }

    #[test]
    fn identical_products_agree_and_a_datum_shift_is_removed_but_reported() {
        let same = compare(&products(&|_, _, v| v), &products(&|_, _, v| v), "same").unwrap();
        assert!(same.rows.iter().all(|r| r.rms < 1e-9 && r.outliers == 0), "{:?}", same.rows);
        // +5 ns on every code bias of the constellation is a datum difference, not an error
        let shifted = compare(
            &products(&|_, _, v| v),
            &products(&|_, s, v| if s.starts_with('C') { v + 5.0 } else { v }),
            "datum",
        )
        .unwrap();
        let c1 = row(&shifted, "C1W");
        assert!(c1.rms < 1e-9, "{c1:?}");
        assert!((c1.offset - 5.0).abs() < 1e-9);
        assert!(shifted.items.iter().all(|i| !i.outlier));
    }

    #[test]
    fn a_single_bad_code_bias_is_found_without_disturbing_the_others() {
        let result = compare(
            &products(&|_, _, v| v),
            &products(&|i, s, v| if i == 2 && s == "C1W" { v + 2.0 } else { v }),
            "bad",
        )
        .unwrap();
        let bad: Vec<(&str, &str)> =
            result.items.iter().filter(|i| i.outlier).map(|i| (i.sat.as_str(), i.signal.as_str())).collect();
        assert!(bad.contains(&("G03", "C1W")), "{bad:?}");
        let g03 = result.items.iter().find(|i| i.sat == "G03" && i.signal == "C1W").unwrap();
        assert!((g03.mean - 2.0).abs() < 1e-9, "the median keeps the datum at zero");
        assert_eq!(row(&result, "C1W").outliers, 1);
        assert!(result.hints.iter().any(|h| h.contains("G03")));
    }

    #[test]
    fn code_differences_have_no_datum_and_show_up_in_both_signals_of_a_pair() {
        let result = compare(
            &products(&|_, _, v| v),
            &products(&|i, s, v| if i == 4 && s == "C2W" { v - 0.8 } else { v }),
            "dcb",
        )
        .unwrap();
        let dcb = result.items.iter().find(|i| i.kind == "dcb" && i.sat == "G05").unwrap();
        assert_eq!(dcb.signal, "DCB C1W-C2W");
        assert!(dcb.mean > 0.5 && dcb.outlier, "{dcb:?}");
        assert!(result
            .items
            .iter()
            .filter(|i| i.kind == "dcb" && i.sat != "G05")
            .all(|i| i.mean.abs() < 0.5));
    }

    #[test]
    fn phase_is_compared_in_cycles_modulo_one_and_a_common_fraction_is_free() {
        // every L1 shifted by 3.4 cycles (an integer and a common fraction), G04 additionally by 0.3 cycles
        let result = compare(
            &products(&|_, _, v| v),
            &products(&|i, s, v| {
                if s == "L1W" {
                    v + cycles_to_ns(3.4 + if i == 3 { 0.3 } else { 0.0 })
                } else {
                    v
                }
            }),
            "phase",
        )
        .unwrap();
        let l1 = row(&result, "L1W");
        assert_eq!(l1.unit, "cyc");
        let g04 = result.items.iter().find(|i| i.sat == "G04" && i.signal == "L1W").unwrap();
        assert!((g04.mean - 0.3).abs() < 0.07, "{g04:?}");
        assert!(g04.outlier);
        assert!(result
            .items
            .iter()
            .filter(|i| i.signal == "L1W" && i.sat != "G04")
            .all(|i| i.mean.abs() < 0.08));
    }

    #[test]
    fn wide_lane_shift_of_one_satellite_equals_the_phase_shift_in_cycles() {
        let result = compare(
            &products(&|_, _, v| v),
            &products(&|i, s, v| if i == 1 && s == "L1W" { v + cycles_to_ns(0.25) } else { v }),
            "wl",
        )
        .unwrap();
        let wl = result.rows.iter().find(|r| r.kind == "wl").expect("a wide-lane row");
        assert_eq!(wl.signal, "WL L1W-L2W");
        assert_eq!(wl.sats, 5);
        assert!((wl.within_tolerance.unwrap() - 0.8).abs() < 1e-9, "{wl:?}");
        let g02 = result.items.iter().find(|i| i.kind == "wl" && i.sat == "G02").unwrap();
        assert!((g02.mean - 0.25).abs() < 0.07, "{g02:?}");
    }

    #[test]
    fn narrow_lane_rows_and_histograms_follow_the_phase_residuals() {
        let result = compare(
            &products(&|_, _, v| v),
            &products(&|i, s, v| if i == 1 && s == "L1W" { v + cycles_to_ns(0.25) } else { v }),
            "nl",
        )
        .unwrap();
        assert_eq!((result.epochs, result.step), (288, 300));
        assert_eq!(result.start, "2026-09-19T00:00:00");
        let nl = row(&result, "NL L1W");
        assert_eq!((nl.kind.as_str(), nl.unit.as_str(), nl.sats), ("nl", "cyc", 5));
        let h = &nl.histogram;
        assert_eq!(h.counts.len(), 50);
        assert_eq!(h.counts.iter().sum::<u32>(), 5 * 288, "every satellite-epoch lands in a bin");
        let at = |x: f64| h.counts[((x - h.min) / h.width).floor() as usize];
        assert_eq!(
            at(0.0),
            5 * 288,
            "the constant of each satellite is taken out, so all sit in the middle bin"
        );
        assert_eq!(nl.epoch_within, Some(1.0));
        assert!(nl.total_rms < 1e-6 && nl.series.rms.len() == 288 && nl.series.datum.len() == 288);
        let g02 = result.items.iter().find(|i| i.kind == "nl" && i.sat == "G02").unwrap();
        assert!((g02.mean - 0.25).abs() < 0.07, "the removed constant stays visible: {g02:?}");
        assert!(g02.rms < 1e-6 && !g02.outlier);
        let series = g02.series.as_ref().expect("narrow-lane items carry their residual per epoch");
        assert_eq!(series.len(), 288);
        assert!(series[10].unwrap().abs() < 1e-6);
        assert!(result.items.iter().filter(|i| i.kind == "code").all(|i| i.series.is_none()));
        // a code row has a symmetric round range
        let code = row(&result, "C1W");
        assert!((code.histogram.min + code.histogram.width * 25.0).abs() < 1e-9);
    }

    #[test]
    fn time_varying_phase_is_sampled_and_its_temporal_scatter_reported() {
        let mut reference = Vec::new();
        let mut test = Vec::new();
        for (i, sat) in SATS.iter().enumerate() {
            for k in 0..20 {
                let (s, e) = (format!("2026:262:{:05}", k * 300), format!("2026:262:{:05}", (k + 1) * 300));
                reference.push(line(sat, "L2W", &s, &e, "ns", 3.0 + i as f64));
                let wobble = if i == 0 { 0.02 * (k % 2) as f64 } else { 0.0 };
                test.push(line(sat, "L2W", &s, &e, "ns", 3.0 + i as f64 + wobble));
            }
        }
        let (mut a, mut b) = (Biases::default(), Biases::default());
        parse_bia(&file(&reference), &mut a).unwrap();
        parse_bia(&file(&test), &mut b).unwrap();
        let result = compare(&a, &b, "series").unwrap();
        let g01 = result.items.iter().find(|i| i.sat == "G01" && i.signal == "L2W").unwrap();
        assert_eq!(g01.n, 20);
        assert!(g01.temporal_std > 1e-3, "{g01:?}");
        let g02 = result.items.iter().find(|i| i.sat == "G02" && i.signal == "L2W").unwrap();
        assert!(g02.temporal_std < 1e-6);
    }

    #[test]
    fn products_without_common_satellites_are_refused_and_json_names_are_stable() {
        let mut other = Biases::default();
        parse_bia(&file(&[line("E01", "C1C", DAY.0, DAY.1, "ns", 1.0)]), &mut other).unwrap();
        assert!(compare(&products(&|_, _, v| v), &other, "x").unwrap_err().contains("共同卫星"));
        let value = serde_json::to_value(
            compare(&products(&|_, _, v| v), &products(&|_, _, v| v + 1.0), "j").unwrap(),
        )
        .unwrap();
        let keys = |v: &serde_json::Value| -> Vec<String> {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(
            keys(&value),
            [
                "epochs",
                "excluded",
                "hints",
                "items",
                "name",
                "orbitClasses",
                "referenceOnly",
                "rows",
                "satellites",
                "sign",
                "start",
                "step",
                "testOnly",
                "timeSystem"
            ]
        );
        assert_eq!(
            keys(&value["rows"][0]),
            [
                "epochWithin",
                "histogram",
                "kind",
                "max",
                "offset",
                "outliers",
                "rms",
                "sats",
                "series",
                "signal",
                "system",
                "temporalStd",
                "totalRms",
                "unit",
                "withinTolerance"
            ]
        );
        assert_eq!(
            keys(&value["items"][0]),
            ["kind", "mean", "n", "outlier", "rms", "sat", "signal", "system", "temporalStd"]
        );
    }

    #[test]
    fn products_of_different_days_say_so() {
        let mut other_day = Biases::default();
        let records: Vec<String> =
            SATS.iter().map(|sat| line(sat, "C1W", "2026:263:00000", "2026:264:00000", "ns", 1.0)).collect();
        parse_bia(&file(&records), &mut other_day).unwrap();
        let err = compare(&products(&|_, _, v| v), &other_day, "x").unwrap_err();
        assert!(err.contains("没有重叠"), "{err}");
    }

    /// Clock offsets for every satellite on the 300 s grid of the test day; `shift` gives seconds added per satellite.
    fn with_clocks(mut b: Biases, shift: &dyn Fn(usize) -> f64) -> Biases {
        let start = parse_time(DAY.0).unwrap();
        for (i, sat) in SATS.iter().enumerate() {
            let series = (0..288).map(|k| (start + k * 300, 1e-4 * (i as f64 + 1.0) + shift(i))).collect();
            b.clocks.insert(sat.to_string(), series);
        }
        b
    }

    /// Seconds of clock that equal `cycles` of narrow-lane, (f1 + f2) of the GPS L1 / L2 pair.
    fn cycles_to_seconds(cycles: f64) -> f64 {
        cycles / (1575.42e6 + 1227.60e6)
    }

    #[test]
    fn excluded_satellites_leave_every_statistic_and_the_datum() {
        let reference = products(&|_, _, v| v);
        let test = products(&|i, s, v| if i == 2 && s == "C1W" { v + 2.0 } else { v });
        let all: BTreeSet<String> = BTreeSet::new();
        let full = compare_without(&reference, &test, "x", &all).unwrap();
        assert_eq!(row(&full, "C1W").sats, 5);
        assert!(full.items.iter().any(|i| i.sat == "G03" && i.outlier));
        let without = compare_without(&reference, &test, "x", &BTreeSet::from(["G03".to_string()])).unwrap();
        assert_eq!(row(&without, "C1W").sats, 4);
        assert!(row(&without, "C1W").rms < 1e-9, "{:?}", row(&without, "C1W"));
        assert!(without.items.iter().all(|i| i.sat != "G03"));
        assert_eq!(
            without.satellites,
            ["G01", "G02", "G03", "G04", "G05"],
            "the page still offers every satellite"
        );
        assert_eq!(without.excluded, ["G03"]);
        let unknown = compare_without(&reference, &test, "x", &BTreeSet::from(["E01".to_string()])).unwrap();
        assert!(unknown.excluded.is_empty());
        let everything: BTreeSet<String> = SATS.iter().map(|s| s.to_string()).collect();
        assert!(compare_without(&reference, &test, "x", &everything).unwrap_err().contains("没有剩余"));
    }

    #[test]
    fn the_requested_exclusions_are_cleaned_up() {
        let dir = std::env::temp_dir().join(format!("bias-exclude-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let records: Vec<String> = SATS.iter().map(|sat| line(sat, "C1W", DAY.0, DAY.1, "ns", 1.0)).collect();
        let (a, b) = (dir.join("a.bia"), dir.join("b.bia"));
        fs::write(&a, file(&records)).unwrap();
        fs::write(&b, file(&records)).unwrap();
        let set =
            |p: &std::path::Path| BiasSet { files: vec![p.to_string_lossy().into()], ..Default::default() };
        let result =
            run(BiasRequest { reference: set(&a), tests: vec![set(&b)], exclude: vec![" g02 ".into()] })
                .unwrap()
                .results;
        assert_eq!(result[0].excluded, ["G02"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_product_that_cannot_be_compared_is_reported_and_the_others_are_kept() {
        let dir = std::env::temp_dir().join(format!("bias-outcome-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let records: Vec<String> = SATS.iter().map(|sat| line(sat, "C1W", DAY.0, DAY.1, "ns", 1.0)).collect();
        let a = dir.join("a.bia");
        fs::write(&a, file(&records)).unwrap();
        let set = |name: &str, p: &std::path::Path| BiasSet {
            name: name.into(),
            files: vec![p.to_string_lossy().into()],
            ..Default::default()
        };
        let outcome = run(BiasRequest {
            reference: set("ref", &a),
            tests: vec![set("", &dir.join("missing.bia")), set("good", &a)],
            exclude: vec![],
        })
        .unwrap();
        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].name, "good");
        assert_eq!((outcome.failures.len(), outcome.failures[0].name.as_str()), (1, "对比产品 1"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_clock_difference_is_part_of_the_narrow_lane_with_clocks_and_not_of_the_bias() {
        // identical biases, but the test clock of G02 is a quarter of an L1 cycle off
        let reference = with_clocks(products(&|_, _, v| v), &|_| 0.0);
        let test =
            with_clocks(products(&|_, _, v| v), &|i| if i == 1 { cycles_to_seconds(0.25) } else { 0.0 });
        let result = compare(&reference, &test, "clock").unwrap();
        let plain = row(&result, "NL L1W");
        assert!(plain.rms < 1e-9, "the biases alone agree: {plain:?}");
        let joint = row(&result, "NL+CLK L1W");
        assert_eq!(joint.kind, "nlc");
        let g02 = result.items.iter().find(|i| i.kind == "nlc" && i.sat == "G02").unwrap();
        assert!((g02.mean.abs() - 0.25).abs() < 0.07, "the constant that was taken out: {g02:?}");
        assert!(g02.series.is_some());
        assert_eq!(joint.epoch_within, Some(1.0), "only the scatter in the day counts: {joint:?}");
    }

    #[test]
    fn a_clock_that_moves_with_its_bias_cancels() {
        // G02's phase bias and clock both moved by a quarter of a cycle: the pair is consistent
        let reference = with_clocks(products(&|_, _, v| v), &|_| 0.0);
        let test = with_clocks(
            products(&|i, s, v| if i == 1 && s == "L1W" { v + cycles_to_ns(0.25) } else { v }),
            &|i| if i == 1 { cycles_to_seconds(0.25) } else { 0.0 },
        );
        let result = compare(&reference, &test, "pair").unwrap();
        let alone = result.items.iter().find(|i| i.kind == "nl" && i.sat == "G02").unwrap();
        assert!((alone.mean - 0.25).abs() < 0.07, "the bias alone looks off: {alone:?}");
        let joint = row(&result, "NL+CLK L1W");
        let g02 = result.items.iter().find(|i| i.kind == "nlc" && i.sat == "G02").unwrap();
        assert!(g02.mean.abs() < 1e-6, "the clock and the bias moved together, nothing is left: {g02:?}");
        assert!(joint.rms < 1e-6 && joint.epoch_within == Some(1.0), "{joint:?}");
    }

    #[test]
    fn clocks_on_one_side_only_are_reported_and_never_guessed() {
        let reference = with_clocks(products(&|_, _, v| v), &|_| 0.0);
        let result = compare(&reference, &products(&|_, _, v| v), "one").unwrap();
        assert!(result.rows.iter().all(|r| r.kind != "nlc"));
        assert!(result.hints.iter().any(|h| h.contains("只有一份产品给了钟差")), "{:?}", result.hints);
        assert!(result.rows.iter().all(|r| r.kind != "codec"));
        // clocks without a common epoch with the biases
        let mut elsewhere = products(&|_, _, v| v);
        for sat in SATS {
            elsewhere.clocks.insert(sat.to_string(), HashMap::from([(1, 0.0)]));
        }
        let none = compare(&elsewhere, &elsewhere, "none").unwrap();
        assert!(none.hints.iter().any(|h| h.contains("没有足够的共同")), "{:?}", none.hints);
    }

    #[test]
    fn code_biases_that_move_with_the_clock_agree_once_the_clock_is_counted() {
        // G02's clock reference is 3 ns off in the test product and its code biases follow it
        let reference = with_clocks(products(&|_, _, v| v), &|_| 0.0);
        let test =
            with_clocks(products(&|i, s, v| if i == 1 && s.starts_with('C') { v + 3.0 } else { v }), &|i| {
                if i == 1 {
                    3e-9
                } else {
                    0.0
                }
            });
        let result = compare(&reference, &test, "code").unwrap();
        let g02 = |signal: &str| result.items.iter().find(|i| i.sat == "G02" && i.signal == signal).unwrap();
        assert!((g02("C1W").mean - 3.0).abs() < 1e-6, "the bias alone differs");
        assert_eq!(g02("C1W+CLK").kind, "codec");
        assert!(g02("C1W+CLK").mean.abs() < 1e-6, "{:?}", g02("C1W+CLK"));
        assert!(row(&result, "C2W+CLK").rms < 1e-6);
        assert!(result.items.iter().filter(|i| i.kind == "codec").all(|i| !i.outlier));
    }

    #[test]
    fn an_inverted_product_is_recognised_and_flipped_back() {
        let reference = products(&|_, _, v| v);
        let mut test = products(&|_, _, v| -v);
        let none = BTreeSet::new();
        let sign = detect_signs(&reference, &mut test, &none);
        assert_eq!((sign.code, sign.phase, sign.auto), (-1, -1, true));
        assert!(sign.correlation.unwrap() < -0.99, "{sign:?}");
        let result = compare(&reference, &test, "x").unwrap();
        assert!(result.rows.iter().all(|r| r.rms < 1e-9), "{:?}", result.rows);
        // a product that already agrees is left alone
        let mut same = products(&|_, _, v| v);
        let sign = detect_signs(&reference, &mut same, &none);
        assert_eq!((sign.code, sign.phase), (1, 1));
        assert!(sign.correlation.unwrap() > 0.99);
    }

    #[test]
    fn the_phase_sign_may_differ_from_the_code_sign_when_the_wide_lane_says_so() {
        let reference = products(&|_, _, v| v);
        let mut test = products(&|_, s, v| if s.starts_with('L') { -v } else { v });
        let sign = detect_signs(&reference, &mut test, &BTreeSet::new());
        assert_eq!((sign.code, sign.phase), (1, -1), "{sign:?}");
        assert!(compare(&reference, &test, "x").unwrap().rows.iter().all(|r| r.rms < 1e-9));
    }

    #[test]
    fn nothing_is_flipped_when_the_code_biases_say_nothing() {
        // every satellite has the same code bias: no spread, no correlation, the default stays
        let flat = |s: &str| -> Biases {
            let records: Vec<String> = SATS.iter().map(|sat| line(sat, s, DAY.0, DAY.1, "ns", 1.0)).collect();
            let mut b = Biases::default();
            parse_bia(&file(&records), &mut b).unwrap();
            b
        };
        assert_eq!(code_correlation(&flat("C1W"), &flat("C1W"), &BTreeSet::new()), None);
        let mut test = flat("C1W");
        let sign = detect_signs(&flat("C1W"), &mut test, &BTreeSet::new());
        assert_eq!((sign.code, sign.phase, sign.correlation), (1, 1, None));
    }

    #[test]
    fn requests_choose_the_sign_by_themselves_unless_told() {
        let dir = std::env::temp_dir().join(format!("bias-sign-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, f: &dyn Fn(usize, &str, f64) -> f64| {
            let mut records = Vec::new();
            for (i, sat) in SATS.iter().enumerate() {
                for signal in ["C1W", "C2W", "L1W", "L2W"] {
                    records.push(line(sat, signal, DAY.0, DAY.1, "ns", f(i, signal, base(i, signal))));
                }
            }
            let path = dir.join(name);
            fs::write(&path, file(&records)).unwrap();
            path.to_string_lossy().into_owned()
        };
        let (reference, inverted) = (write("a.bia", &|_, _, v| v), write("b.bia", &|_, _, v| -v));
        let set =
            |p: &str, sign: &str| BiasSet { files: vec![p.into()], sign: sign.into(), ..Default::default() };
        let request = |sign: &str| BiasRequest {
            reference: set(&reference, ""),
            tests: vec![set(&inverted, sign)],
            exclude: vec![],
        };
        let auto = run(request("")).unwrap().results.remove(0);
        assert_eq!((auto.sign.code, auto.sign.phase, auto.sign.auto), (-1, -1, true));
        assert!(auto.hints[0].contains("检测到该产品的偏差符号与参考相反"), "{:?}", auto.hints);
        assert!(auto.rows.iter().all(|r| r.rms < 1e-9));
        let keep = run(request("keep")).unwrap().results.remove(0);
        assert_eq!((keep.sign.code, keep.sign.auto), (1, false));
        assert!(keep.rows.iter().any(|r| r.rms > 1.0), "left as it is, the product disagrees");
        let forced = run(request("invert")).unwrap().results.remove(0);
        assert_eq!((forced.sign.code, forced.sign.phase, forced.sign.auto), (-1, -1, false));
        assert!(forced.hints[0].starts_with("按设置，"), "{:?}", forced.hints);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_compressed_or_missing_files() {
        assert!(read("a.bia.gz").unwrap_err().contains("解压"));
        assert!(read("missing.bia").unwrap_err().contains("找不到"));
        assert!(load(&BiasSet::default()).is_err());
    }

    /// Manual check on real files: FINDU_BIAS_REF / _TEST (biases), FINDU_BIAS_REF_CLK / _TEST_CLK (clocks) and
    /// FINDU_BIAS_EXCLUDE (satellites) are ';'-separated lists; FINDU_BIAS_JSON optionally receives the result as the
    /// page gets it.
    #[test]
    #[ignore]
    fn compares_real_bias_products() {
        let list = |k: &str| -> Vec<String> {
            std::env::var(k)
                .unwrap_or_default()
                .split(';')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        };
        let started = std::time::Instant::now();
        let result = run(BiasRequest {
            reference: BiasSet {
                name: "ref".into(),
                files: list("FINDU_BIAS_REF"),
                clocks: list("FINDU_BIAS_REF_CLK"),
                orbits: list("FINDU_BIAS_ORBITS"),
                ..Default::default()
            },
            tests: vec![BiasSet {
                name: "test".into(),
                files: list("FINDU_BIAS_TEST"),
                clocks: list("FINDU_BIAS_TEST_CLK"),
                sign: std::env::var("FINDU_BIAS_SIGN").unwrap_or_default(),
                ..Default::default()
            }],
            exclude: list("FINDU_BIAS_EXCLUDE"),
        })
        .unwrap()
        .results;
        println!(
            "{:.2} s, {} KiB of JSON",
            started.elapsed().as_secs_f64(),
            serde_json::to_vec(&result).unwrap().len() / 1024
        );
        if let Ok(path) = std::env::var("FINDU_BIAS_JSON") {
            fs::write(path, serde_json::to_vec(&result).unwrap()).unwrap();
        }
        for r in &result[0].rows {
            println!(
                "{} {:<14} {:<4} sats {:3} offset {:+8.3} rms {:7.3} max {:7.3} tstd {:6.3} {:?} out {} total {:6.3} within {:?}",
                r.system,
                r.signal,
                r.unit,
                r.sats,
                r.offset,
                r.rms,
                r.max,
                r.temporal_std,
                r.within_tolerance,
                r.outliers,
                r.total_rms,
                r.epoch_within
            );
        }
        println!("sign: {:?}", result[0].sign);
        let mut classes: BTreeMap<String, Vec<&str>> = BTreeMap::new();
        for (sat, class) in &result[0].orbit_classes {
            classes.entry(format!("{} {class}", &sat[..1])).or_default().push(sat);
        }
        for (key, sats) in classes {
            println!("class {key}: {}", sats.join(" "));
        }
        for h in result[0].hints.iter().take(10) {
            println!("hint: {h}");
        }
    }
}
