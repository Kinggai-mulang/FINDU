//! Current IPSPOS Log=4 contract, shared by live and completed-file readers.
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct Header {
    pub columns: Vec<String>,
    pub mode: String,
    version: Option<u8>,
    ended: bool,
}

impl Header {
    pub fn line(&mut self, line: &str) -> Result<(), String> {
        if let Some(version) = line.split_whitespace().find_map(|s| s.strip_prefix("Log=")) {
            self.version = Some(version.parse().map_err(|_| "GNSS 日志版本无效")?);
            if self.version != Some(4) { return Err("仅接入最新 IPSPOS Log=4，请使用当前引擎重新运行".into()); }
        }
        if let Some((key, mode)) = line.split_once(':') {
            if key.trim()=="# Mode" {
                self.mode = match mode.split_whitespace().next().unwrap_or("") {
                    "PPP" | "PPP-AR" => "PPP", "RTK" => "RTK", "SPP" => "SPP",
                    _ => return Err("Log=4 解算模式未识别".into()),
                }.into();
            }
        }
        if line.starts_with("#Week ") {
            self.columns = line[1..].split_whitespace().map(String::from).collect();
            let unique: HashSet<_> = self.columns.iter().collect();
            if unique.len() != self.columns.len() { return Err("Log=4 列名重复".into()); }
        }
        if line.trim() == "# END OF HEADER" {
            if self.version != Some(4) || self.mode.is_empty() ||
                ["Week", "TOW", "UTC", "X", "Y", "Z", "Q"].iter().any(|k| !self.columns.iter().any(|c| c == k)) {
                return Err("需要完整的 IPSPOS Log=4 文件头、模式与定位列".into());
            }
            self.ended = true;
        }
        Ok(())
    }

    pub fn fields<'a>(&'a self, line: &'a str) -> Result<HashMap<&'a str, &'a str>, String> {
        if !self.ended { return Err("Log=4 文件头尚未完整读取".into()); }
        let values: Vec<_> = line.split_whitespace().collect();
        if values.len() != self.columns.len() {
            return Err(format!("Log=4 数据列数不匹配：期望 {}，实际 {}", self.columns.len(), values.len()));
        }
        Ok(self.columns.iter().map(String::as_str).zip(values).collect())
    }
}

/// Decode field-specific missing/overflow markers without discarding legitimate negative values.
pub fn number(key: &str, raw: &str) -> Option<f64> {
    let value = raw.parse::<f64>().ok().filter(|n| n.is_finite())?;
    let signed = matches!(key, "X"|"Y"|"Z"|"BaseX"|"BaseY"|"BaseZ"|"VX"|"VY"|"VZ"|"ZWD"|"ZWDUCor");
    let (missing, overflow) = match key {
        "X"|"Y"|"Z"|"BaseX"|"BaseY"|"BaseZ" => (-99999999.999, -99999998.999),
        "VX"|"VY"|"VZ" => (-999.999, -998.999),
        "ZWD" => (-999.9999, -998.9999), "ZWDUCor" => (-9., -8.), _ => (-1., -2.),
    };
    if known(key) && (value == missing || value == overflow || (!signed && value < 0.)) { return None; }
    if key == "ZWDUCor" && value.abs() > 1. { return None; }
    if matches!(key, "IAC50"|"IAC95") && !(0. ..=1.).contains(&value) { return None; }
    if count(key) && value.fract() != 0. { return None; }
    Some(value)
}

fn count(key: &str) -> bool {
    matches!(key, "Week"|"Q"|"VQ"|"AS"|"AC"|"Obs"|"OC"|"Com"|"IFBSup"|"Disc"|"PreP"|"PreL"|
        "SlS"|"SlL"|"AmbR"|"FltR"|"SppS"|"DopS"|"DopN"|"TcpS"|"TcpN"|"TdSl"|"FloIn"|"FloUse"|
        "UDS"|"SDS"|"DDS"|"nSIFB"|"nIFB"|"NP"|"NL"|"PDn"|"PRj"|"LDn"|"LRj"|"CanS"|"CanA"|
        "SchA"|"InstA"|"FixS"|"FixA"|"APN"|"ALN"|"ACN")
}

pub fn known(key: &str) -> bool {
    count(key) || matches!(key, "TOW"|"X"|"Y"|"Z"|"VX"|"VY"|"VZ"|"HDOP"|"VDOP"|"PNRMS"|"LNRMS"|
        "FPRMS"|"FLRMS"|"AHDOP"|"AVDOP"|"Ratio"|"ADOP"|"DPos"|"APRMS"|"ALRMS"|"PCR"|"ADR"|
        "BaseX"|"BaseY"|"BaseZ"|"BRAge"|"ZHD"|"ZWD"|"TrpSRMS"|"IonDRMS"|"ZWDUCor"|"IAC50"|"IAC95")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn signed_atmosphere_base_coordinates_and_markers_are_distinct() {
        assert_eq!(number("ZWDUCor", "-1"), Some(-1.));
        assert_eq!(number("ZWDUCor", "-0.65"), Some(-0.65));
        assert_eq!(number("ZWD", "-0.2"), Some(-0.2));
        for (key, raw) in [("ZWD","-999.9999"),("ZWD","-998.9999"),("ZWDUCor","-9"),
            ("ZWDUCor","-8"),("BaseX","-99999999.999"),("BaseY","-99999998.999"),("FloUse","2.5")] {
            assert_eq!(number(key,raw),None);
        }
        assert_eq!(number("BaseX","-2163970.125"),Some(-2163970.125));
        assert_eq!(number("ExtraSigned","-0.25"),Some(-0.25));
        assert_eq!(number("ExtraSigned","-1"),Some(-1.));
        assert_eq!(number("IAC50","1.1"),None);
    }
    #[test] fn rejects_legacy_and_duplicate_headers() {
        assert!(Header::default().line("# Program: IPSPOS Log=2").is_err());
        assert!(Header::default().line("#Week TOW X X").is_err());
    }
    #[test] fn model_description_cannot_replace_solution_mode() {
        let mut h=Header::default();
        h.line("# Mode : RTK AR=OFF").unwrap();
        h.line("# Model : SD_STATE/DD_UPDATE BaselineType=0").unwrap();
        assert_eq!(h.mode,"RTK");
    }
}
