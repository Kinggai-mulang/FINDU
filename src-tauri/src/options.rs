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
            Some((
                canonical(key.trim()).to_string(),
                value.split_once(';')?.0.trim().to_string(),
            ))
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
        return Err(format!("一次导入 1–{} 个 .opt 文件",crate::native::capacity::LIMITS.postprocess_runs));
    }
    paths.into_iter().map(|p|{
        let path=fs::canonicalize(p).map_err(|e|e.to_string())?;
        if !path.extension().is_some_and(|s|s.eq_ignore_ascii_case("opt")) {return Err("只接受单测站 .opt 文件".into());}
        if fs::metadata(&path).map_err(|e|e.to_string())?.len()>1_048_576 {return Err("配置超过 1 MB".into());}
        let text=fs::read_to_string(&path).map_err(|e|e.to_string())?;
        let values=parse(&text);
        if values.get("GNSS_RoveFile").is_none_or(|v|v.is_empty()) || !values.contains_key("GNSS_PMode") || values.contains_key("GNSS_OBSFile") {return Err("需要单测站后处理配置（GNSS_RoveFile + GNSS_PMode），不支持列表或 GNSS_OBSFile 组合入口".into());}
        Ok(OptDocument{source_path:display_path(&path),name:path.file_name().unwrap().to_string_lossy().into(),text})
    }).collect()
}
pub fn display_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_string()
}

pub fn engine_path(path: &Path) -> Result<String, String> {
    let text = display_path(path);
    if text.is_ascii() {
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
    Err(format!(
        "IPSPOS 的 C 文件接口需要英文路径，且此路径无可用短文件名：{text}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_are_last_wins_and_case_sensitive() {
        let v=parse("# X = y;\nGNSS_SSRFile = a;\nGNSS_ProductFile = b;\nGNSS_BIAFile = p;\nGNSS_BIASFile = q;");
        assert_eq!(v["GNSS_ProductFile"], "b");
        assert_eq!(v["GNSS_BIAFile"], "p");
        assert_eq!(v["GNSS_BIASFile"], "q");
    }
    #[test]
    fn engine_identity_requires_the_current_protocol_pair() {
        let mut manifest=serde_json::json!({"build_id":"current-source","protocols":{"gnss_log":4,"client_status":1}});
        assert!(check_protocol(&manifest).is_ok());
        manifest["protocols"]["gnss_log"]=serde_json::json!(2);assert!(check_protocol(&manifest).is_err());
        manifest["protocols"]["gnss_log"]=serde_json::json!(4);
        manifest["protocols"]["client_status"]=serde_json::Value::Null;assert!(check_protocol(&manifest).is_err());
    }
}

/// Identity and protocol compatibility are separate from the human-readable engine version.
pub fn check_protocol(manifest:&serde_json::Value)->Result<(),String>{
    if manifest["protocols"]["gnss_log"]!=4||manifest["protocols"]["client_status"]!=1||manifest["build_id"].as_str().is_none(){
        return Err("需要最新 IPSPOS：Log=4、StatusLog=1 及可核验的引擎构建记录".into());
    }
    Ok(())
}

/// V0.604 reserves these four dimensions; it currently implements DEFAULT only.
pub fn check_solver_options(values:&BTreeMap<String,String>)->Result<(),String>{
    for key in ["GNSS_ObsQuality","GNSS_Dynamics","GNSS_Domain","GNSS_Environment"] {
        if values.get(key).is_some_and(|v|!v.eq_ignore_ascii_case("DEFAULT")) {
            return Err(format!("当前 IPSPOS 的 {key} 仅支持 DEFAULT，请核对配置；FINDU 不自动更改算法档位"));
        }
    }
    for key in ["GNSS_UserType","GNSS_DeviceType","GNSS_SceneType","GNSS_Monitoring_Scenarios"] {
        if let Some(value)=values.get(key).filter(|v|!v.trim().is_empty()) {
            if key=="GNSS_Monitoring_Scenarios"||value.parse::<i32>().ok()!=Some(0) {
                return Err(format!("IPSPOS V0.604 已移除 {key}；旧非默认设置不能直接沿用，请先核对最新引擎配置"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    #[test] fn current_defaults_are_allowed_but_old_nondefault_profiles_are_not_silently_ignored(){
        assert!(check_solver_options(&parse("GNSS_ObsQuality=DEFAULT;\nGNSS_Dynamics=default;\nGNSS_UserType=0;")).is_ok());
        assert!(check_solver_options(&parse("GNSS_ObsQuality=NAVIGATION;")).is_err());
        assert!(check_solver_options(&parse("GNSS_UserType=4;")).is_err());
        assert!(check_solver_options(&parse("GNSS_Monitoring_Scenarios=0;")).is_err());
    }
}

#[cfg(test)]mod import_capacity_tests {use super::*;
 #[test]fn imports_thirty_two_documents_and_rejects_thirty_three(){let p=std::env::temp_dir().join(format!("findu-import-capacity-{}.opt",uuid::Uuid::new_v4()));fs::write(&p,"GNSS_PMode = 3;\nGNSS_RoveFile = sample.24o;\n").unwrap();let value=p.to_string_lossy().into_owned();assert_eq!(load(vec![value.clone();32]).unwrap().len(),32);assert!(load(vec![value;33]).err().unwrap().contains("32"));fs::remove_file(p).unwrap();}
}
