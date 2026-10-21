use std::{fs, io::Read};

/// Validate a drop without loading a potentially multi-gigabyte GNSS recording.
pub fn validate(path: &str, role: &str) -> Result<String, String> {
    if path.contains([';', '\r', '\n']) {return Err("路径不能包含 OPT 分隔符或换行".into());}
    let path = fs::canonicalize(path).map_err(|_| "路径不存在或无法访问")?;
    if role == "directory" {
        if !path.is_dir() {return Err("请拖入文件夹，而不是文件".into());}
    } else {
        if !path.is_file() {return Err("请拖入文件，而不是文件夹".into());}
        let name = path.file_name().unwrap().to_string_lossy().to_lowercase();
        if name.ends_with(".opt") {return Err("OPT 请拖入配置区域，以载入整份配置".into());}
        if name.ends_with(".gz") || name.ends_with(".z") || name.ends_with(".crx") {
            return Err("请先通过数据与下载准备／解压文件，再设置此路径".into());
        }
        let mut buf = [0_u8; 4096];
        let n = fs::File::open(&path).map_err(|e| e.to_string())?.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {return Err("文件为空，原路径未改变".into());}
        let header = String::from_utf8_lossy(&buf[..n]);
        let rinex = header.lines().next().unwrap_or("");
        let obs = rinex.contains("RINEX VERSION / TYPE") && (rinex.contains("OBSERVATION") || rinex.chars().nth(20)==Some('O'));
        let nav = rinex.contains("RINEX VERSION / TYPE") && (rinex.contains("NAVIGATION") || matches!(rinex.chars().nth(20),Some('N'|'G'|'H'|'J'|'L')));
        let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        let valid = match role {
            "GNSS_RoveFile"|"GNSS_BaseFile" => obs || (!nav && matches!(ext.as_str(),"rtcm"|"rtcm3"|"bin"|"raw"|"dat")),
            "GNSS_NaviFile" => nav,
            "GNSS_SP3File" => ext=="sp3" && header.starts_with('#'),
            "GNSS_CLKFile" => ext=="clk" && (header.contains("RINEX VERSION / TYPE")||header.lines().any(|l|l.starts_with("AS "))),
            "GNSS_BIAFile" => matches!(ext.as_str(),"bia"|"bsx"),
            "GNSS_ATXFile" => ext=="atx" && header.contains("ANTEX VERSION / SYST"),
            "GNSS_RefFile" => matches!(ext.as_str(),"ref"|"txt"),
            "GNSS_ProductFile"|"GNSS_BIASFile"|"GNSS_ShareEPHPath" => !obs && !nav && !matches!(ext.as_str(),"sp3"|"clk"|"bia"|"bsx"|"atx"),
            _ => false,
        };
        if !valid {return Err(format!("文件内容或类型与此输入项不符（{role}），原路径未改变"));}
    }
    Ok(crate::options::display_path(&path))
}

#[tauri::command]
pub fn validate_input_path(path:String,role:String)->Result<String,String>{validate(&path,&role)}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rinex_roles_and_wrong_drop_do_not_guess_from_rnx_extension(){
        let dir=std::env::temp_dir().join(format!("input-drop-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&dir).unwrap();
        let obs=dir.join("obs.rnx");let nav=dir.join("nav.rnx");
        fs::write(&obs,"     3.04           OBSERVATION DATA    M                   RINEX VERSION / TYPE\n").unwrap();
        fs::write(&nav,"     3.04           NAVIGATION DATA     M                   RINEX VERSION / TYPE\n").unwrap();
        assert!(validate(obs.to_str().unwrap(),"GNSS_RoveFile").is_ok());
        assert!(validate(obs.to_str().unwrap(),"GNSS_BaseFile").is_ok());
        assert!(validate(nav.to_str().unwrap(),"GNSS_RoveFile").is_err());
        assert!(validate(nav.to_str().unwrap(),"GNSS_NaviFile").is_ok());
        assert!(validate(obs.to_str().unwrap(),"GNSS_SP3File").is_err());
        assert!(validate(dir.to_str().unwrap(),"GNSS_RoveFile").is_err());
        assert!(validate(dir.to_str().unwrap(),"directory").is_ok());
        fs::remove_dir_all(dir).unwrap();
    }
}
