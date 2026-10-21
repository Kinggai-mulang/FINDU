use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use std::{fs,path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},collections::HashMap,time::Duration,process::{Command,Stdio}};
use crate::{options, native::Job};
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Request {pub observation:String,pub centers:Vec<String>,pub grade:String,pub mode:String,pub motion:String,pub download_antenna:bool,pub antenna_path:String,pub local_root:String,pub switch_source:bool,pub offline:bool,pub workers:usize,pub timeout:u64,pub attempts:usize}
impl Request {fn validate(&self)->Result<(),String>{
 if !Path::new(&self.observation).is_file(){return Err("观测文件不存在".into());}
 if self.centers.is_empty()||self.centers.len()>3||self.centers.iter().any(|c| !["WHU","COD","GFZ"].contains(&c.as_str())){return Err("请选择有效产品中心".into());}
 if !["final","rapid","ultra","rts","best"].contains(&self.grade.as_str())||!["ar","float"].contains(&self.mode.as_str())||!["static","kinematic"].contains(&self.motion.as_str()){return Err("产品策略无效".into());}
 if self.grade=="rts"&&self.centers.iter().any(|c|c!="WHU"){return Err("实时归档目前仅支持 WHU".into());}
 if !(1..=8).contains(&self.workers)||!(5..=300).contains(&self.timeout)||!(1..=4).contains(&self.attempts){return Err("并行数、超时或重试次数超出范围".into());}
 if !self.local_root.is_empty()&&!Path::new(&self.local_root).is_dir(){return Err("本地产品目录不存在".into());}
 Ok(())}}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProductJob {pub id:String,pub name:String,pub status:String,pub created_at:String,pub request:Request,pub directory:String,pub error:Option<String>}
struct Inner {jobs:Vec<ProductJob>,cancel:HashMap<String,Arc<AtomicBool>>}
#[derive(Clone)] pub struct Products {root:PathBuf,tools:PathBuf,python:PathBuf,data:Arc<Mutex<Inner>>,gate:Arc<Mutex<()>>}
fn active(s:&str)->bool{["queued","running"].contains(&s)}
fn read(path:&Path)->Value{fs::read(path).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)}
fn persist(job:&ProductJob){if let Ok(bytes)=serde_json::to_vec_pretty(job){let p=Path::new(&job.directory).join("job.json");let t=p.with_extension("tmp");if fs::write(&t,bytes).is_ok(){let _=fs::rename(t,p);}}}
impl Products {
 pub fn new(root:PathBuf,tools:PathBuf,python:PathBuf)->Self{
 let dir=root.join("downloads");let _=fs::create_dir_all(&dir);let mut jobs=Vec::new();
 if let Ok(entries)=fs::read_dir(&dir){for entry in entries.flatten(){let p=entry.path();if !p.is_dir()||p.join(".queue-removed").exists(){continue;}if let Ok(mut job)=serde_json::from_value::<ProductJob>(read(&p.join("job.json"))){
 // A restored record cannot redirect retries outside this owned folder.
 if uuid::Uuid::parse_str(&job.id).is_err()||p.file_name().and_then(|s|s.to_str())!=Some(&job.id){continue;}
 job.directory=options::display_path(&p);if active(&job.status){job.status="interrupted".into();job.error=Some("上次运行中断，可重试以复用缓存".into());persist(&job);}jobs.push(job);}}}
 jobs.sort_by(|a,b|b.created_at.cmp(&a.created_at));
 Self{root,tools,python,data:Arc::new(Mutex::new(Inner{jobs,cancel:HashMap::new()})),gate:Arc::new(Mutex::new(()))}}
 pub fn start(&self,request:Request)->Result<String,String>{request.validate()?;if !self.python.is_file()||!self.tools.join("findyou_products.py").is_file(){return Err("产品下载组件缺失，请使用完整便携包".into());}
 let mut d=self.data.lock().unwrap();if d.jobs.iter().filter(|j|active(&j.status)).count()>=10{return Err("准备队列最多 10 项，请等待或取消".into());}
 let id=uuid::Uuid::new_v4().to_string();let path=self.root.join("downloads").join(&id);fs::create_dir_all(&path).map_err(|e|e.to_string())?;
 let job=ProductJob{id:id.clone(),name:Path::new(&request.observation).file_name().unwrap().to_string_lossy().into(),created_at:chrono::Utc::now().to_rfc3339(),status:"queued".into(),request,directory:options::display_path(&path),error:None};
 persist(&job);d.jobs.insert(0,job);drop(d);self.dispatch(id.clone());Ok(id)}
 pub fn retry(&self,id:&str)->Result<(),String>{let mut d=self.data.lock().unwrap();if d.jobs.iter().filter(|j|active(&j.status)).count()>=10{return Err("准备队列已满".into());}let j=d.jobs.iter_mut().find(|j|j.id==id).ok_or("任务不存在")?;if active(&j.status){return Err("任务尚未结束".into());}j.request.validate()?;j.status="queued".into();j.error=None;persist(j);drop(d);self.dispatch(id.into());Ok(())}
 fn update(&self,id:&str,status:&str,error:Option<String>){let mut d=self.data.lock().unwrap();if let Some(j)=d.jobs.iter_mut().find(|j|j.id==id){j.status=status.into();j.error=error;persist(j);}if !active(status){d.cancel.remove(id);}}
 fn dispatch(&self,id:String){let cancelled=Arc::new(AtomicBool::new(false));self.data.lock().unwrap().cancel.insert(id.clone(),cancelled.clone());let rt=self.clone();std::thread::spawn(move||{
 let guard=loop{if cancelled.load(Ordering::SeqCst){rt.update(&id,"cancelled",None);return;}if let Ok(g)=rt.gate.try_lock(){break g;}std::thread::sleep(Duration::from_millis(100));};
 if cancelled.load(Ordering::SeqCst){rt.update(&id,"cancelled",None);return;}
 rt.update(&id,"running",None);
 let result=rt.execute(&id,&cancelled);
 if cancelled.load(Ordering::SeqCst){rt.update(&id,"cancelled",None);}else{match result {Ok(0)=>rt.update(&id,"ready",None),Ok(3)=>rt.update(&id,"incomplete",Some("部分产品缺失或未通过覆盖校验；展开查看详情后重试".into())),Ok(code)=>rt.update(&id,"failed",Some(format!("产品准备失败（{code}），请查看诊断"))),Err(e)=>rt.update(&id,"failed",Some(e))}}
 rt.data.lock().unwrap().cancel.remove(&id);drop(guard);
 });}
 fn execute(&self,id:&str,cancelled:&AtomicBool)->Result<i32,String>{let job=self.data.lock().unwrap().jobs.iter().find(|j|j.id==id).cloned().ok_or("任务不存在")?;
 let dir=PathBuf::from(&job.directory);let mut value=serde_json::to_value(&job.request).map_err(|e|e.to_string())?;value["cache"]=json!(options::display_path(&self.root.join("cache/products")));
 fs::write(dir.join("request.json"),serde_json::to_vec_pretty(&value).unwrap()).map_err(|e|e.to_string())?;
 let stderr=fs::File::create(dir.join("worker.log")).map_err(|e|e.to_string())?;let stdout=stderr.try_clone().map_err(|e|e.to_string())?;
 let mut cmd=Command::new(&self.python);cmd.args(["-I","-B"]).arg(self.tools.join("findyou_products.py")).arg(dir.join("request.json")).current_dir(&dir).env("TEMP",self.root.join("cache/temp")).env("TMP",self.root.join("cache/temp")).env("PYTHONDONTWRITEBYTECODE","1").env("PYTHONUTF8","1").stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
 #[cfg(windows)]{use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000);}
 let mut child=cmd.spawn().map_err(|e|format!("无法启动产品准备组件：{e}"))?;let _job=match Job::attach(&child){Ok(j)=>j,Err(e)=>{let _=child.kill();let _=child.wait();return Err(e);}};
 loop{if cancelled.load(Ordering::SeqCst){let _=child.kill();let _=child.wait();return Ok(-1);}match child.try_wait(){Ok(Some(s))=>{let code=s.code().unwrap_or(-1);if code!=0&&code!=3{let log=fs::read_to_string(dir.join("worker.log")).unwrap_or_default();if let Some(message)=log.lines().rev().filter_map(|l|serde_json::from_str::<Value>(l).ok()).find_map(|v|v["message"].as_str().map(str::to_owned)){return Err(message);}}return Ok(code);},Ok(None)=>std::thread::sleep(Duration::from_millis(150)),Err(e)=>return Err(e.to_string())}}
 }
 pub fn cancel(&self,id:&str)->Result<(),String>{let d=self.data.lock().unwrap();let flag=d.cancel.get(id).ok_or("任务已结束")?;flag.store(true,Ordering::SeqCst);Ok(())}
 pub fn stop_all(&self){for flag in self.data.lock().unwrap().cancel.values(){flag.store(true,Ordering::SeqCst);}}
 pub fn dismiss(&self,ids:Option<Vec<String>>)->Result<(),String>{let mut d=self.data.lock().unwrap();let selected=ids.unwrap_or_else(||d.jobs.iter().filter(|j|!active(&j.status)).map(|j|j.id.clone()).collect());if d.jobs.iter().any(|j|selected.contains(&j.id)&&active(&j.status)){return Err("请先取消任务，结束后再移除".into());}for j in d.jobs.iter().filter(|j|selected.contains(&j.id)){fs::write(Path::new(&j.directory).join(".queue-removed"),b"removed; outputs retained").map_err(|e|e.to_string())?;}d.jobs.retain(|j|!selected.contains(&j.id));for id in selected{d.cancel.remove(&id);}Ok(())}
 pub fn directory(&self,id:&str)->Result<PathBuf,String>{self.data.lock().unwrap().jobs.iter().find(|j|j.id==id).map(|j|PathBuf::from(&j.directory)).ok_or("任务不存在".into())}
 pub fn snapshot(&self)->Value{let jobs=self.data.lock().unwrap().jobs.clone();json!(jobs.iter().take(100).map(|j|{let dir=PathBuf::from(&j.directory);let log=fs::read_to_string(dir.join("worker.log")).unwrap_or_default();let log=log.lines().rev().take(35).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");let plan=read(&dir.join("work/plan.json"));let mut m=if !active(&j.status){read(&dir.join("work/manifest.json"))}else{Value::Null};if let Some(rows)=m.get_mut("results").and_then(Value::as_array_mut){for row in rows{if row["status"]=="ready"&&!row["opt"].as_str().is_some_and(|p|Path::new(p).is_file()){row["status"]=json!("failed");row["opt"]=Value::Null;row["check"]["warnings"]=json!(["已生成的 OPT 已移动或在重试中失效，请重试复用产品缓存"]);}}}let compact=if m.is_null(){Value::Null}else{json!({"ready":m["ready"],"warnings":m["execution"]["progressWarnings"].as_array().cloned().unwrap_or_default(),"results":m["results"].as_array().map(|rs|rs.iter().map(|r|json!({"id":r["id"],"status":r["status"],"bundle":r["bundle"],"opt":r["opt"],"preparationLevel":r["preparationLevel"],"effectiveMode":r["effectiveMode"],"check":{"errors":r["check"]["errors"].as_array().cloned().unwrap_or_default(),"warnings":r["check"]["warnings"].as_array().cloned().unwrap_or_default()},"skipped":r["skipped"].as_array().cloned().unwrap_or_default(),"failed_tasks":r["failed_tasks"]})).collect::<Vec<_>>()).unwrap_or_default()})};json!({"job":j,"plan":{"observation":plan["observation"],"tasks":plan["tasks"]},"progress":read(&dir.join("work/progress.json")),"manifest":compact,"log":log})}).collect::<Vec<_>>())}

}
#[tauri::command] pub fn product_jobs(rt:tauri::State<'_,Products>)->Value{rt.snapshot()}
#[tauri::command] pub fn start_product(request:Request,rt:tauri::State<'_,Products>)->Result<String,String>{rt.start(request)}
#[tauri::command] pub fn retry_product(id:String,rt:tauri::State<'_,Products>)->Result<(),String>{rt.retry(&id)}
#[tauri::command] pub fn cancel_product(id:String,rt:tauri::State<'_,Products>)->Result<(),String>{rt.cancel(&id)}
#[tauri::command] pub fn open_product_folder(id:String,rt:tauri::State<'_,Products>)->Result<(),String>{crate::open_folder(&rt.directory(&id)?)}
#[tauri::command] pub fn create_post_document(text:String,paths:tauri::State<'_,crate::paths::RuntimePaths>)->Result<options::OptDocument,String>{
 if text.len()>1_048_576||!options::parse(&text).contains_key("GNSS_PMode"){return Err("配置无效或大于 1 MiB".into());}
 let dir=Path::new(&paths.root).join("config/post-drafts");fs::create_dir_all(&dir).map_err(|e|e.to_string())?;let path=dir.join(format!("manual-{}.opt",uuid::Uuid::new_v4()));fs::write(&path,&text).map_err(|e|e.to_string())?;
 Ok(options::OptDocument{source_path:options::display_path(&path),name:path.file_name().unwrap().to_string_lossy().into(),text})
}
#[cfg(test)] mod tests {
 use super::*;
 fn request(obs:&Path)->Request {Request{observation:options::display_path(obs),centers:vec!["WHU".into()],grade:"final".into(),mode:"ar".into(),motion:"static".into(),download_antenna:true,antenna_path:String::new(),local_root:String::new(),switch_source:true,offline:true,workers:4,timeout:10,attempts:2}}
 #[test] fn rejects_unsupported_profiles_before_launch(){let root=std::env::temp_dir().join(format!("products-test-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&root).unwrap();let obs=root.join("obs.24o");fs::write(&obs,"test").unwrap();let mut r=request(&obs);assert!(r.validate().is_ok());r.grade="rts".into();r.centers.push("COD".into());assert!(r.validate().is_err());r.centers=vec!["WHU".into()];r.workers=0;assert!(r.validate().is_err());fs::remove_file(obs).unwrap();fs::remove_dir(root).unwrap();}
 #[test] fn restoration_marks_interrupted_and_pins_owned_path(){let root=std::env::temp_dir().join(format!("products-recovery-{}",uuid::Uuid::new_v4()));let id=uuid::Uuid::new_v4().to_string();let dir=root.join("downloads").join(&id);fs::create_dir_all(&dir).unwrap();let obs=dir.join("keep.24o");fs::write(&obs,"input unchanged").unwrap();let j=ProductJob{id:id.clone(),name:"recover".into(),status:"running".into(),created_at:"2026-10-17".into(),request:request(&obs),directory:"C:/untrusted".into(),error:None};fs::write(dir.join("job.json"),serde_json::to_vec(&j).unwrap()).unwrap();let rt=Products::new(root.clone(),root.clone(),root.clone());let snap=rt.snapshot();assert_eq!(snap[0]["job"]["status"],"interrupted");assert_eq!(rt.directory(&id).unwrap(),dir);assert_eq!(fs::read_to_string(obs).unwrap(),"input unchanged");}
 #[test] fn terminal_queue_removal_survives_restart_without_deleting_outputs(){let root=std::env::temp_dir().join(format!("products-dismiss-{}",uuid::Uuid::new_v4()));let id=uuid::Uuid::new_v4().to_string();let dir=root.join("downloads").join(&id);fs::create_dir_all(&dir).unwrap();let obs=dir.join("keep.24o");fs::write(&obs,"input").unwrap();let job=ProductJob{id:id.clone(),name:"remove".into(),status:"incomplete".into(),created_at:"2026-10-18".into(),request:request(&obs),directory:options::display_path(&dir),error:None};persist(&job);let rt=Products::new(root.clone(),root.clone(),root.clone());rt.dismiss(None).unwrap();assert_eq!(rt.snapshot(),json!([]));assert_eq!(Products::new(root.clone(),root.clone(),root).snapshot(),json!([]));assert!(obs.is_file());}
 #[test] fn failed_job_still_delivers_existing_completed_opt_but_never_a_stale_path(){
  let root=std::env::temp_dir().join(format!("products-partial-{}",uuid::Uuid::new_v4()));let id=uuid::Uuid::new_v4().to_string();let dir=root.join("downloads").join(&id);fs::create_dir_all(dir.join("work")).unwrap();let obs=dir.join("obs.24o");fs::write(&obs,"input").unwrap();let opt=dir.join("work/valid.opt");fs::write(&opt,"GNSS_PMode=2;").unwrap();
  let job=ProductJob{id,name:"partial".into(),status:"failed".into(),created_at:"2026-10-18".into(),request:request(&obs),directory:options::display_path(&dir),error:Some("other product failed".into())};persist(&job);fs::write(dir.join("work/manifest.json"),serde_json::to_vec(&json!({"ready":false,"results":[{"id":"usable","status":"ready","opt":options::display_path(&opt)},{"id":"stale","status":"ready","opt":options::display_path(&dir.join("missing.opt"))}]})).unwrap()).unwrap();
  let rt=Products::new(root.clone(),root.clone(),root);let s=rt.snapshot();assert_eq!(s[0]["manifest"]["results"][0]["status"],"ready");assert_eq!(s[0]["manifest"]["results"][1]["status"],"failed");assert!(s[0]["manifest"]["results"][1]["opt"].is_null());assert!(opt.is_file());
 }
 #[test] fn queued_cancellation_does_not_delete_partial_data(){let root=std::env::temp_dir().join(format!("products-cancel-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&root).unwrap();let obs=root.join("obs.24o");fs::write(&obs,"input").unwrap();let exe=root.join("python.exe");fs::write(&exe,"").unwrap();fs::write(root.join("findyou_products.py"),"").unwrap();let rt=Products::new(root.clone(),root.clone(),exe);let _guard=rt.gate.lock().unwrap();let id=rt.start(request(&obs)).unwrap();let dir=rt.directory(&id).unwrap();fs::write(dir.join("partial.part"),"retain").unwrap();rt.cancel(&id).unwrap();for _ in 0..30 {if rt.snapshot()[0]["job"]["status"]=="cancelled"{break;}std::thread::sleep(Duration::from_millis(20));}assert_eq!(rt.snapshot()[0]["job"]["status"],"cancelled");assert!(dir.join("partial.part").is_file());assert_eq!(fs::read_to_string(obs).unwrap(),"input");}
}

#[tauri::command] pub fn dismiss_products(ids:Option<Vec<String>>,rt:tauri::State<'_,Products>)->Result<(),String>{rt.dismiss(ids)}
