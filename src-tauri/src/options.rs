use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const FILE_KEYS: &[&str] = &[
    "GNSS_RoveFile",
    "GNSS_BaseFile",
    "GNSS_NaviFile",
    "GNSS_SP3File",
    "GNSS_CLKFile",
    "GNSS_BIAFile",
    "GNSS_ATXFile",
    "GNSS_RefFile",
    "GNSS_ProductFile",
    "GNSS_BIASFile",
    "GNSS_CLASGridFile",
    "GNSS_PolyFile",
];
pub fn canonical(key: &str) -> &str {
    match key {
        "GNSS_SSRFile" => "GNSS_ProductFile",
        "GNSS_AllPreEphFile" => "GNSS_SP3File",
        "GNSS_AllPreClkFile" => "GNSS_CLKFile",
        "GNSS_ALLNavFile" => "GNSS_NaviFile",
        "GNSS_bOutputSessNMEA" => "GNSS_bOutputSessionNMEA",
        "GNSS_bOutputLog" => "GNSS_bOutputLOG",
        "GNSS_bOutputULOG" => "GNSS_bOutputULog",
        "GNSS_ULOGLevel" => "GNSS_ULogLevel",
        "GNSS_ULOGFileFilter" => "GNSS_ULogFileFilter",
        other => other,
    }
}
pub fn parse(text: &str) -> BTreeMap<String, String> {
    text.trim_start_matches('\u{feff}')
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=').or_else(|| line.split_once(':'))?;
            Some((canonical(key.trim()).to_string(), value.split_once(';')?.0.trim().to_string()))
        })
        .collect()
}
pub fn hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = [0_u8; 131072];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
pub fn absolute(base: &Path, value: &str) -> PathBuf {
    let p = PathBuf::from(value);
    if p.is_absolute() {
        p
    } else {
        base.join(p)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptDocument {
    pub source_path: String,
    pub name: String,
    pub text: String,
}
pub fn load(paths: Vec<String>) -> Result<Vec<OptDocument>, String> {
    if paths.is_empty() || paths.len() > crate::native::capacity::LIMITS.postprocess_runs {
        return Err(format!("一次导入 1–{} 个 .opt 文件", crate::native::capacity::LIMITS.postprocess_runs));
    }
    paths
        .into_iter()
        .map(|p| {
            let path = fs::canonicalize(p).map_err(|e| e.to_string())?;
            if !path.extension().is_some_and(|s| s.eq_ignore_ascii_case("opt")) {
                return Err("只接受单测站 .opt 文件".into());
            }
            if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 1_048_576 {
                return Err("配置超过 1 MB".into());
            }
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let values = parse(&text);
            if values.get("GNSS_RoveFile").is_none_or(|v| v.is_empty())
                || !values.contains_key("GNSS_PMode")
                || values.contains_key("GNSS_OBSFile")
            {
                return Err(
                    "需要单测站后处理配置（GNSS_RoveFile + GNSS_PMode），不支持列表或 GNSS_OBSFile 组合入口"
                        .into(),
                );
            }
            Ok(OptDocument {
                source_path: display_path(&path),
                name: path.file_name().unwrap().to_string_lossy().into(),
                text,
            })
        })
        .collect()
}
pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().trim_start_matches("\\\\?\\").to_string()
}

pub fn engine_path(path: &Path) -> Result<String, String> {
    let text = display_path(path);
    if text.is_ascii() || !cfg!(windows) {
        return Ok(text);
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut out = vec![0_u16; 32768];
        let n = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
                wide.as_ptr(),
                out.as_mut_ptr(),
                out.len() as u32,
            )
        };
        if n > 0 && (n as usize) < out.len() {
            let short = String::from_utf16_lossy(&out[..n as usize]);
            let short = short.trim_start_matches("\\\\?\\").to_string();
            if short.is_ascii() {
                return Ok(short);
            }
        }
    }
    Err(format!("IPSPOS 的 C 文件接口需要英文路径，且此路径无可用短文件名：{text}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_are_last_wins_and_case_sensitive() {
        let v = parse(
            "# X = y;\nGNSS_SSRFile = a;\nGNSS_ProductFile = b;\nGNSS_BIAFile = p;\nGNSS_BIASFile = q;",
        );
        assert_eq!(v["GNSS_ProductFile"], "b");
        assert_eq!(v["GNSS_BIAFile"], "p");
        assert_eq!(v["GNSS_BIASFile"], "q");
    }
    #[test]
    fn engine_identity_requires_the_current_protocol_pair() {
        let mut manifest = serde_json::json!({"build_id":"current-source","platform":crate::native::platform::TARGET,"protocols":{"gnss_log":4,"client_status":1}});
        assert!(check_protocol(&manifest).is_ok());
        manifest["protocols"]["gnss_log"] = serde_json::json!(2);
        assert!(check_protocol(&manifest).is_err());
        manifest["protocols"]["gnss_log"] = serde_json::json!(4);
        manifest["protocols"]["client_status"] = serde_json::Value::Null;
        assert!(check_protocol(&manifest).is_err());
    }
}

/// Identity and protocol compatibility are separate from the human-readable engine version.
pub fn check_protocol(manifest: &serde_json::Value) -> Result<(), String> {
    if manifest["platform"].as_str().unwrap_or("windows-x64") != crate::native::platform::TARGET {
        return Err(format!("引擎平台不匹配，需要 {} 引擎", crate::native::platform::TARGET));
    }
    if manifest["protocols"]["gnss_log"] != 4
        || manifest["protocols"]["client_status"] != 1
        || manifest["build_id"].as_str().is_none()
    {
        return Err("需要最新 IPSPOS：Log=4、StatusLog=1 及可核验的引擎构建记录".into());
    }
    Ok(())
}

/// V0.604 reserves these four dimensions; it currently implements DEFAULT only.
pub fn check_solver_options(values: &BTreeMap<String, String>) -> Result<(), String> {
    for key in ["GNSS_ObsQuality", "GNSS_Dynamics", "GNSS_Domain", "GNSS_Environment"] {
        if values.get(key).is_some_and(|v| !v.eq_ignore_ascii_case("DEFAULT")) {
            return Err(format!("当前 IPSPOS 的 {key} 仅支持 DEFAULT，请核对配置；FINDU 不自动更改算法档位"));
        }
    }
    for key in ["GNSS_UserType", "GNSS_DeviceType", "GNSS_SceneType", "GNSS_Monitoring_Scenarios"] {
        if let Some(value) = values.get(key).filter(|v| !v.trim().is_empty()) {
            if key == "GNSS_Monitoring_Scenarios" || value.parse::<i32>().ok() != Some(0) {
                return Err(format!(
                    "IPSPOS V0.604 已移除 {key}；旧非默认设置不能直接沿用，请先核对最新引擎配置"
                ));
            }
        }
    }
    Ok(())
}

/// Optional DSB input never prevents the primary solver from starting.
pub fn validate_dcb_file(path: &Path) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|_| "DCB 文件不存在或不可读")?;
    if !meta.is_file() || meta.len() > 16 * 1024 * 1024 {
        return Err("DCB 文件无效或超过 16 MiB".into());
    }
    let text = fs::read_to_string(path).map_err(|_| "DCB 文件不可读")?;
    if !text.starts_with("%=BIA") || !text.trim_end().ends_with("%=ENDBIA") {
        return Err("DCB 需要完整的 Bias-SINEX 文件".into());
    }
    fn field(s: &str, a: usize, b: usize) -> &str {
        s.get(a..b.min(s.len())).unwrap_or("").trim()
    }
    let mut gps = false;
    let mut block = false;
    let mut count = 0;
    let mut intervals = BTreeMap::new();
    let mut pairs: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
    for line in text.lines() {
        if line.contains("TIME_SYSTEM") && !line.starts_with('*') {
            gps = matches!(field(line, 40, 48), "G" | "GPS");
            if !gps {
                return Err("DCB 必须明确使用 GPS 时标".into());
            }
        }
        if line.starts_with("+BIAS/SOLUTION") {
            block = true;
        }
        if line.starts_with("-BIAS/SOLUTION") {
            block = false;
        }
        if !block || !line.starts_with(" DSB ") || !field(line, 15, 24).is_empty() {
            continue;
        }
        let a = field(line, 25, 29);
        let b = field(line, 30, 34);
        if !a.starts_with('C') || !b.starts_with('C') {
            continue;
        }
        let prn = field(line, 11, 14);
        if prn.len() != 3
            || !matches!(prn.as_bytes()[0], b'G' | b'C' | b'E' | b'R' | b'J')
            || !prn.as_bytes()[1..].iter().all(u8::is_ascii_digit)
        {
            continue;
        }
        let signal = |s: &str| {
            s.len() == 3
                && s.as_bytes()[1].is_ascii_digit()
                && s.as_bytes()[1] != b'0'
                && s.as_bytes()[2].is_ascii_uppercase()
        };
        let number = |s: &str| s.replace(['D', 'd'], "E").parse::<f64>().ok().filter(|n| n.is_finite());
        let stamp = |s: &str| -> Option<chrono::NaiveDateTime> {
            let p = s.split(':').collect::<Vec<_>>();
            if p.len() != 3 {
                return None;
            }
            let d = chrono::NaiveDate::from_yo_opt(p[0].parse().ok()?, p[1].parse().ok()?)?;
            let sec = p[2].parse::<i64>().ok()?;
            if !(0..86400).contains(&sec) {
                return None;
            }
            d.and_hms_opt(0, 0, 0)?.checked_add_signed(chrono::Duration::seconds(sec))
        };
        let first = stamp(field(line, 35, 49));
        let last = stamp(field(line, 50, 64));
        if !signal(a)
            || !signal(b)
            || a == b
            || !matches!(field(line, 65, 69), "ns" | "m")
            || number(field(line, 70, 91)).is_none()
            || number(field(line, 92, 103)).is_none_or(|n| n < 0. || !(n * n).is_finite())
            || !field(line, 104, 125).is_empty()
            || first.is_none()
            || last.is_none()
            || first >= last
        {
            return Err("DCB 含不支持或无效的卫星码 DSB 记录".into());
        }
        let pair = if a < b { format!("{a}-{b}") } else { format!("{b}-{a}") };
        let scale = if field(line, 65, 69) == "ns" { 0.299792458 } else { 1. };
        let bias = number(field(line, 70, 91)).unwrap() * scale * if a < b { 1. } else { -1. };
        let sigma = number(field(line, 92, 103)).unwrap() * scale;
        let value = (last.unwrap(), bias, sigma * sigma);
        let key = (prn.to_string(), pair.clone(), first.unwrap());
        if let Some((end, old_bias, old_var)) = intervals.insert(key, value) {
            if end != value.0 || (old_bias - bias).abs() > 1e-9 || (old_var - value.2).abs() > 1e-12 {
                return Err("DCB 同一卫星通道区间存在冲突记录".into());
            }
        }
        let known = pairs.entry(prn.to_string()).or_default();
        known.insert(pair);
        if known.len() > 32 {
            return Err("DCB 每颗卫星的通道连接超过引擎容量".into());
        }
        count += 1;
    }
    if !gps || count == 0 {
        return Err("DCB 未包含 GPS 时标的卫星码 DSB；OSB 不能替代 DCB".into());
    }
    Ok(())
}

pub fn dcb_overrides(v: &BTreeMap<String, String>, base: &Path) -> (BTreeMap<String, String>, Vec<String>) {
    let mut out =
        BTreeMap::from([("GNSS_bUseDCB".into(), "OFF".into()), ("GNSS_DCBFile".into(), String::new())]);
    let mut warnings = Vec::new();
    let hold = v
        .get("GNSS_DCBMaxHoldDays")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && (0.0..=30.0).contains(n))
        .unwrap_or(15.);
    out.insert("GNSS_DCBMaxHoldDays".into(), hold.to_string());
    if matches!(v.get("GNSS_PMode").map(String::as_str), Some("0" | "6" | "7" | "8")) {
        return (out, warnings);
    }
    if let Some(value) = v.get("GNSS_DCBFile").filter(|s| !s.trim().is_empty()) {
        let path = absolute(base, value);
        match validate_dcb_file(&path).and_then(|_| engine_path(&path)) {
            Ok(path) if !path.contains([';', '\r', '\n']) && path.len() < 900 => {
                out.insert("GNSS_bUseDCB".into(), "ON".into());
                out.insert("GNSS_DCBFile".into(), path);
            }
            other => warnings
                .push(format!("DCB 未启用，继续解算：{}", other.err().unwrap_or_else(|| "路径无效".into()))),
        }
    }
    (out, warnings)
}

pub fn check_post_options(v: &BTreeMap<String, String>) -> Result<(), String> {
    let kind = v
        .get("GNSS_ProductType")
        .or_else(|| v.get("GNSS_ProductFormat"))
        .map(String::as_str)
        .unwrap_or("SSR");
    if matches!(kind, "CLAS" | "QZSS_CLAS" | "4") {
        for key in ["GNSS_ProductFile", "GNSS_CLASGridFile"] {
            if v.get(key).is_none_or(|s| s.is_empty()) {
                return Err(format!("CLAS 需要 {key}"));
            }
        }
        for key in ["GNSS_SP3File", "GNSS_CLKFile", "GNSS_BIAFile", "GNSS_BIASFile"] {
            if v.get(key).is_some_and(|s| !s.is_empty()) {
                return Err(format!("CLAS 不可同时配置 {key}，请清空该项"));
            }
        }
        for (key, min, max) in [
            ("GNSS_CLASNetwork", 1., 31.),
            ("GNSS_CLASWeek", 0., 9999.),
            ("GNSS_CLASFirstTow", 0., 604799.999),
        ] {
            if v.get(key).and_then(|s| s.parse::<f64>().ok()).is_none_or(|n| {
                !n.is_finite() || n < min || n > max || (key != "GNSS_CLASFirstTow" && n.fract() != 0.)
            }) {
                return Err(format!("CLAS 的 {key} 缺失或超出范围"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    #[test]
    fn current_defaults_are_allowed_but_old_nondefault_profiles_are_not_silently_ignored() {
        assert!(check_solver_options(&parse(
            "GNSS_ObsQuality=DEFAULT;\nGNSS_Dynamics=default;\nGNSS_UserType=0;"
        ))
        .is_ok());
        assert!(check_solver_options(&parse("GNSS_ObsQuality=NAVIGATION;")).is_err());
        assert!(check_solver_options(&parse("GNSS_UserType=4;")).is_err());
        assert!(check_solver_options(&parse("GNSS_Monitoring_Scenarios=0;")).is_err());
    }
}

#[cfg(test)]
mod import_capacity_tests {
    use super::*;
    #[test]
    fn imports_thirty_two_documents_and_rejects_thirty_three() {
        let p = std::env::temp_dir().join(format!("findu-import-capacity-{}.opt", uuid::Uuid::new_v4()));
        fs::write(&p, "GNSS_PMode = 3;\nGNSS_RoveFile = sample.24o;\n").unwrap();
        let value = p.to_string_lossy().into_owned();
        assert_eq!(load(vec![value.clone(); 32]).unwrap().len(), 32);
        assert!(load(vec![value; 33]).err().unwrap().contains("32"));
        fs::remove_file(p).unwrap();
    }
}

#[cfg(test)]
mod dcb_tests {
    use super::*;
    #[test]
    fn optional_dcb_never_blocks_missing_or_disabled_modes() {
        let base = std::env::temp_dir();
        let (v, w) = dcb_overrides(&parse("GNSS_PMode=2;\nGNSS_DCBFile=missing-product.bia;"), &base);
        assert_eq!(v["GNSS_bUseDCB"], "OFF");
        assert!(v["GNSS_DCBFile"].is_empty());
        assert_eq!(w.len(), 1);
        let (v, w) = dcb_overrides(&parse("GNSS_PMode=6;\nGNSS_DCBFile=missing-product.bia;"), &base);
        assert_eq!(v["GNSS_bUseDCB"], "OFF");
        assert!(w.is_empty());
    }
    #[test]
    fn osb_is_not_dcb() {
        let file = std::env::temp_dir().join(format!("dcb-{}.bia", uuid::Uuid::new_v4()));
        fs::write(&file, "%=BIA\n+BIAS/SOLUTION\n OSB \n-BIAS/SOLUTION\n%=ENDBIA\n").unwrap();
        assert!(validate_dcb_file(&file).is_err());
        fs::remove_file(file).unwrap();
    }
    #[test]
    fn clas_conflicts_are_reported_before_start() {
        let mut v=parse("GNSS_ProductType=CLAS;\nGNSS_ProductFile=input.l6;\nGNSS_CLASGridFile=grid.def;\nGNSS_CLASNetwork=9;\nGNSS_CLASWeek=2297;\nGNSS_CLASFirstTow=86400;");
        assert!(check_post_options(&v).is_ok());
        v.insert("GNSS_SP3File".into(), "orbit.sp3".into());
        assert!(check_post_options(&v).unwrap_err().contains("GNSS_SP3File"));
    }
}
