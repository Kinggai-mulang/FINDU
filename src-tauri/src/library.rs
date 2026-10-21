use crate::{options,results::{self,RealResult}};
use serde::{Serialize,Deserialize};
use std::{path::{Path,PathBuf},fs,sync::Mutex};
use sha2::{Digest,Sha256};

// Equal log contents can belong to different runs with different sidecar
// configurations. Keep those runs distinct while deduplicating the same file.
fn log_id(path:&Path)->Result<String,String>{
    let canonical=fs::canonicalize(path).map_err(|e|e.to_string())?;
    let location=options::display_path(&canonical);
    let location=if cfg!(windows){location.to_lowercase()}else{location};
    let mut digest=Sha256::new();digest.update(location.as_bytes());digest.update([0]);digest.update(options::hash(path)?.as_bytes());
    Ok(format!("log-{}",&format!("{:x}",digest.finalize())[..24]))
}

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Entry {pub id:String,pub name:String,pub path:String,pub station:String,pub saved_at:String}
pub struct Library {index:PathBuf,lock:Mutex<()>}
impl Library {
    pub fn new(root:&Path)->Self {Self{index:root.join("config/analysis-index.json"),lock:Mutex::new(())}}
    fn entries(&self)->Result<Vec<Entry>,String>{if !self.index.exists(){return Ok(vec![]);}serde_json::from_slice(&fs::read(&self.index).map_err(|e|e.to_string())?).map_err(|e|format!("结果索引损坏，原结果文件未修改：{e}"))}
    pub fn catalog(&self)->Result<Vec<Entry>,String>{let _lock=self.lock.lock().unwrap();self.entries()}
    pub fn remember(&self,r:&RealResult)->Result<(),String>{
        let id=log_id(Path::new(&r.log_path))?;let _lock=self.lock.lock().unwrap();let mut entries=self.entries()?;entries.retain(|e|e.id!=id&&e.path!=r.log_path);entries.insert(0,Entry{id,name:r.name.clone(),path:r.log_path.clone(),station:r.station.clone(),saved_at:chrono::Utc::now().to_rfc3339()});entries.truncate(500);self.save(&entries)
    }
    fn save(&self,entries:&[Entry])->Result<(),String>{fs::create_dir_all(self.index.parent().unwrap()).map_err(|e|e.to_string())?;let tmp=self.index.with_extension("tmp");fs::write(&tmp,serde_json::to_vec_pretty(entries).unwrap()).map_err(|e|e.to_string())?;fs::rename(tmp,&self.index).map_err(|e|e.to_string())}
    pub fn import(&self,paths:Vec<String>)->Result<Vec<RealResult>,String>{
        if paths.is_empty()||paths.len()>16{return Err("一次请选择 1–16 个日志或会话目录".into());}
        let mut incoming=Vec::new();
        for path in paths {incoming.push(load(Path::new(&path))?);}
        let _lock=self.lock.lock().unwrap();let mut entries=self.entries()?;
        for r in &incoming {entries.retain(|e|e.id!=r.id&&e.path!=r.log_path);entries.insert(0,Entry{id:r.id.clone(),name:r.name.clone(),path:r.log_path.clone(),station:r.station.clone(),saved_at:chrono::Utc::now().to_rfc3339()});}
        entries.truncate(500);self.save(&entries)?;Ok(incoming)
    }
    pub fn open(&self,id:&str)->Result<RealResult,String>{let entry=self.catalog()?.into_iter().find(|e|e.id==id).ok_or("结果记录不存在")?;let mut r=load(Path::new(&entry.path))?;r.name=entry.name;r.station=entry.station;Ok(r)}
    pub fn forget(&self,id:&str)->Result<(),String>{let _lock=self.lock.lock().unwrap();let mut entries=self.entries()?;entries.retain(|e|e.id!=id);self.save(&entries)}
}
fn load(input:&Path)->Result<RealResult,String>{
    let path=if input.is_dir(){results::find_solution_log(input).ok_or("目录中未找到带文件头的 Log=4，请选择单个任务/会话目录")?}else{input.to_path_buf()};
    if !path.extension().is_some_and(|e|e.eq_ignore_ascii_case("log")){return Err("请选择 IPSPOS Log=4 .log 或单个结果目录".into());}
    let metadata=fs::metadata(&path).map_err(|_|"结果日志不存在或已被移动")?;
    if metadata.len()>256*1024*1024{return Err("单个日志超过 256 MiB，请按会话拆分后导入".into());}
    // Only recognized task/session markers delimit the metadata search.
    let mut run=None;
    for ancestor in path.ancestors().skip(1).take(5){if ancestor.join("run.opt").is_file()||ancestor.join("live.opt").is_file(){run=Some(ancestor.to_path_buf());break;}}
    let mut config=std::collections::HashMap::new();let mut commit=String::new();let mut name=path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    if let Some(root)=&run {
        for file in ["run.opt","live.opt"] {if let Ok(text)=fs::read_to_string(root.join(file)){config=results::config_summary(&text);break;}}
        if let Ok(bytes)=fs::read(root.join("manifest.json")){if let Ok(v)=serde_json::from_slice::<serde_json::Value>(&bytes){commit=v["engineCommit"].as_str().or_else(||v["engine"]["commit"].as_str()).unwrap_or_default().into();}}
        if let Ok(bytes)=fs::read(root.join("task.json")){if let Ok(v)=serde_json::from_slice::<serde_json::Value>(&bytes){if let Some(n)=v["name"].as_str(){name=n.into();}}}
    }
    let reference=config.get("GNSS_RefPoss").and_then(|s|{let v:Vec<f64>=s.split(|c:char|c==','||c.is_whitespace()).filter(|s|!s.is_empty()).map(str::parse::<f64>).collect::<Result<_,_>>().ok()?;if v.len()==3&&v.iter().all(|v|v.is_finite())&&v.iter().map(|v|v*v).sum::<f64>().sqrt()>1e6{Some([v[0],v[1],v[2]])}else{None}});
    let mut r=results::read_solution(&path,reference)?;
    r.id=log_id(&path)?;r.name=format!("{name} · {}",&r.id[4..10]);
    r.station=config.get("ROVE_NTRIP_Mountpoint").filter(|s|!s.is_empty()).cloned().or_else(||config.get("GNSS_RoveFile").and_then(|s|Path::new(s).file_stem()).map(|s|s.to_string_lossy().into())).unwrap_or_else(||"未指定测站".into());
    r.output_dir=options::display_path(run.as_deref().unwrap_or(path.parent().unwrap_or(Path::new("."))));r.log_path=options::display_path(&fs::canonicalize(&path).map_err(|e|e.to_string())?);r.engine_commit=commit;r.analysis_config=config;r.run_id=run.as_ref().and_then(|p|p.file_name()).map(|n|n.to_string_lossy().to_string()).unwrap_or_default();
    if let Some(root)=&run {
        if let Ok(bytes)=fs::read(root.join("session-summary.json")){if let Ok(v)=serde_json::from_slice::<serde_json::Value>(&bytes){if let Some(name)=v["label"].as_str().filter(|s|!s.is_empty()){r.name=format!("{} · {}",name,&r.id[4..10]);}if let Some(station)=v["station"].as_str().filter(|s|!s.is_empty()){r.station=station.into();}}}
        if let Ok(bytes)=fs::read(root.join("manifest.json")) {
            if let Ok(v)=serde_json::from_slice::<serde_json::Value>(&bytes) {
                r.engine_build_id=v["engineBuildId"].as_str().or_else(||v["engine"]["buildId"].as_str()).unwrap_or_default().into();
            }
        }
    }
    let status=crate::status_log::archive(path.parent().unwrap_or(Path::new(".")))?;
    r.product_history=status.product_history;r.ntrip_log_path=status.ntrip_path;
    r.product_log_path=status.product_path;r.client_status=status.heartbeat;
    Ok(r)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test]fn imports_are_persistent_read_only_and_forget_keeps_original(){
        let root=std::env::temp_dir().join(format!("findyou-library-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&root).unwrap();
        let path=root.join("sample.log");let text="# IPSPOS Log=4\n# Mode : PPP\n#Week TOW UTC X Y Z Q FloUse Ratio\n# END OF HEADER\n2438 1 20261001000000.00 6378137 0 0 5 12 -1\n";fs::write(&path,text).unwrap();
        let library=Library::new(&root);let r=library.import(vec![options::display_path(&path)]).unwrap();assert_eq!(r[0].diagnostics.len(),1);assert!(r[0].diagnostics[0]["Ratio"].is_null());
        let reopened=Library::new(&root);assert_eq!(reopened.open(&r[0].id).unwrap().epochs.len(),1);reopened.import(vec![options::display_path(&path)]).unwrap();assert_eq!(reopened.catalog().unwrap().len(),1);
        let second=root.join("another-run.log");fs::write(&second,text).unwrap();let other=reopened.import(vec![options::display_path(&second)]).unwrap();assert_ne!(r[0].id,other[0].id);assert_eq!(reopened.catalog().unwrap().len(),2);
        reopened.forget(&r[0].id).unwrap();assert_eq!(reopened.catalog().unwrap().len(),1);assert_eq!(fs::read_to_string(&path).unwrap(),text);
        // Only known generated files in this unique test directory are removed.
        fs::remove_file(path).unwrap();fs::remove_file(second).unwrap();fs::remove_file(root.join("config/analysis-index.json")).unwrap();fs::remove_dir(root.join("config")).unwrap();fs::remove_dir(root).unwrap();
    }
}
