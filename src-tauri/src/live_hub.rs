use crate::{realtime::{LiveRequest,LiveSnapshot,RealtimeRuntime},results::RealResult};
use std::{collections::{BTreeMap,HashMap,HashSet},path::{Path,PathBuf},sync::Mutex};
pub struct LiveHub {sessions:Mutex<BTreeMap<String,RealtimeRuntime>>,latest:Mutex<Option<String>>,engine:PathBuf,root:PathBuf,library:Option<std::sync::Arc<crate::library::Library>>}
pub fn active(state:&str)->bool{matches!(state,"starting"|"running"|"stopping")}
impl LiveHub {
 pub fn new(engine:PathBuf,root:PathBuf)->Self{Self{sessions:Mutex::new(BTreeMap::new()),latest:Mutex::new(None),engine,root,library:None}}
 pub fn with_library(mut self,library:std::sync::Arc<crate::library::Library>)->Self{self.library=Some(library);self}
 pub fn start(&self,request:LiveRequest,key:Option<String>)->Result<String,String>{
  let key=key.unwrap_or_else(||uuid::Uuid::new_v4().to_string());if key.len()>80||!key.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_'){return Err("会话标识无效".into());}
  let mut sessions=self.sessions.lock().unwrap();
  if sessions.values().filter(|r|active(&r.summary().state)).count()>=5{return Err("首轮最多同时运行 5 路，请先停止其它会话".into());}
  if !sessions.contains_key(&key)&&sessions.len()>=16{return Err("最多保留 16 路记录，请先移除已结束会话".into());}
  let runtime=sessions.get(&key).cloned().unwrap_or_else(||RealtimeRuntime::new(self.engine.clone(),self.root.clone()).with_library(self.library.clone()));
  runtime.start(request)?;runtime.set_key(&key);sessions.insert(key.clone(),runtime);*self.latest.lock().unwrap()=Some(key.clone());Ok(key)
 }
 fn runtime(&self,key:Option<&str>)->Result<RealtimeRuntime,String>{let selected=key.map(str::to_string).or_else(||self.latest.lock().unwrap().clone()).ok_or("尚未创建实时会话")?;self.sessions.lock().unwrap().get(&selected).cloned().ok_or("会话不存在或已移除".into())}
 pub fn snapshot(&self,key:Option<&str>)->Result<LiveSnapshot,String>{if key.is_none()&&self.latest.lock().unwrap().is_none(){return Ok(LiveSnapshot{state:"idle".into(),..Default::default()});}Ok(self.runtime(key)?.snapshot())}
 pub fn overview(&self)->Vec<LiveSnapshot>{self.sessions.lock().unwrap().values().map(RealtimeRuntime::summary).collect()}
 pub fn stop(&self,key:Option<&str>)->Result<(),String>{self.runtime(key)?.stop();Ok(())}
 pub fn stop_all(&self){for rt in self.sessions.lock().unwrap().values(){rt.stop();}}
 pub fn remove(&self,key:&str)->Result<(),String>{let mut sessions=self.sessions.lock().unwrap();if sessions.get(key).is_some_and(|s|active(&s.summary().state)){return Err("请先停止此会话，再移除记录".into());}sessions.remove(key);let mut latest=self.latest.lock().unwrap();if latest.as_deref()==Some(key){*latest=sessions.keys().next_back().cloned();}Ok(())}
 pub fn directory(&self,key:Option<&str>)->Result<PathBuf,String>{Ok(Path::new(&self.runtime(key)?.summary().output_dir).to_path_buf())}
 pub fn results(&self,keys:&[String])->Result<Vec<RealResult>,String>{
  if keys.len()>5{return Err("实时对比一次最多选择 5 路".into());}
  let mut results=Vec::new();
  for key in keys {let snapshot=self.runtime(Some(key))?.snapshot();if snapshot.solution_mode!="RECORD"{results.push(comparison_snapshot(snapshot));}
  }Ok(results)
 }
}
fn comparison_snapshot(s:LiveSnapshot)->RealResult{let times:HashSet<String>=s.history.iter().filter_map(|m|m["time"].as_str().map(str::to_string)).collect();let epochs:Vec<_>=s.epochs.into_iter().filter(|e|times.contains(&e.time)).collect();let origin=s.reference_xyz;
   RealResult{id:format!("live-{}",s.session_key),name:s.label,station:s.station,source:"ipspos".into(),reference_xyz:origin,reference_kind:"first-valid".into(),total_rows:s.history.len(),rejected_rows:s.history.len().saturating_sub(epochs.len()),epochs,quality_counts:HashMap::new(),output_dir:s.output_dir,log_path:s.log_path.unwrap_or_default(),engine_commit:s.engine_commit,diagnostics:s.history,analysis_config:s.analysis_config,duplicate_rows:0,is_live_cache:true,product_history:s.product_history,run_id:s.id,solution_mode:s.solution_mode,log_version:s.log_version,engine_build_id:s.engine_build_id,ntrip_log_path:s.ntrip_log_path,product_log_path:s.product_log_path,client_status:s.heartbeat}
}
#[cfg(test)]mod tests{use super::*;#[test]fn idle_and_invalid_selection_do_not_target_another_session(){let hub=LiveHub::new(PathBuf::new(),PathBuf::new());assert_eq!(hub.snapshot(None).unwrap().state,"idle");assert!(hub.snapshot(Some("missing")).is_err());assert!(hub.stop(Some("missing")).is_err());assert!(hub.results(&vec![String::new();6]).is_err());hub.stop_all();assert!(hub.overview().is_empty());}}

#[cfg(test)] mod comparison_tests {
 use super::*;
 #[test] fn pending_solution_still_carries_its_own_diagnostics_and_products(){
  let s=LiveSnapshot{session_key:"pending".into(),id:"run-pending".into(),history:vec![serde_json::json!({"time":"2026-10-18T08:20:03Z","Obs":31,"OC":0})],product_history:vec![serde_json::json!({"time":"2026-10-18T08:20:03Z","orbit":12,"orbitAge":5})],..Default::default()};
  let result=comparison_snapshot(s);assert_eq!(result.id,"live-pending");assert!(result.epochs.is_empty());assert!(result.reference_xyz.is_none());assert_eq!(result.diagnostics[0]["Obs"],31);assert_eq!(result.product_history[0]["orbit"],12);let json=serde_json::to_value(result).unwrap();assert!(json.get("referenceXyz").is_none());
 }
}
