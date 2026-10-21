//! Exercises native record-only lifecycle without using the user's desktop window.
#[path="../gnss_log.rs"] mod gnss_log;
#[path="../status_log.rs"] mod status_log;
#[path="../live_log.rs"] mod live_log;
#[path="../options.rs"] mod options;
#[path="../results.rs"] mod results;
#[path="../native.rs"] mod native;
#[path="../realtime.rs"] mod realtime;
#[path="../library.rs"] mod library;
#[path="../live_hub.rs"] mod live_hub;
#[path="../paths.rs"] mod paths;
use std::{fs,path::PathBuf,sync::Arc,thread,time::{Duration,Instant}};
fn main(){if let Err(e)=run(){eprintln!("{e}");std::process::exit(1);}}
fn run()->Result<(),String>{
 let args:Vec<_>=std::env::args().collect();if args.len()!=4{return Err("record-check ENGINE ROOT REQUESTS".into());}
 let root=PathBuf::from(&args[2]);fs::create_dir_all(&root).map_err(|e|e.to_string())?;
 let library=Arc::new(library::Library::new(&root));let hub=live_hub::LiveHub::new(PathBuf::from(&args[1]),root.join("realtime")).with_library(library.clone());
 let requests:Vec<realtime::LiveRequest>=serde_json::from_slice(&fs::read(&args[3]).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
 let mut keys=Vec::new();for (i,r) in requests.iter().enumerate(){keys.push(hub.start(r.clone(),Some(format!("record-{i}")))?);}
 let start=Instant::now();let mut disk_grew=false;let mut independently_stopped=false;
 loop{
  if start.elapsed()>Duration::from_secs(7){hub.stop(Some(&keys[0]))?;}
  if start.elapsed()>Duration::from_secs(11){hub.stop_all();}
  let overview=hub.overview();
  disk_grew|=overview.iter().any(|s|s.state=="running"&&s.recording_files.iter().any(|f|f.bytes>0));
  independently_stopped|=overview[0].state=="stopped"&&overview.iter().skip(1).all(|s|s.state=="running");
  if overview.iter().any(|s|s.state=="failed"){hub.stop_all();return Err("Record-only engine failed".into());}
  if overview.iter().all(|s|!live_hub::active(&s.state)){break;}
  if start.elapsed()>Duration::from_secs(25){hub.stop_all();return Err("Record stop timeout".into());}thread::sleep(Duration::from_millis(150));
 }
 let mut snapshots=Vec::new();for key in &keys{snapshots.push(hub.snapshot(Some(key))?);}
 if !disk_grew||!independently_stopped{return Err("Missing growing raw file or independent stop".into());}
 if !library.catalog()?.is_empty()||!hub.results(&keys)?.is_empty(){return Err("Recording must not create positioning results".into());}
 let previous=snapshots[0].id.clone();hub.start(requests[0].clone(),Some(keys[0].clone()))?;
 let start=Instant::now();loop{if start.elapsed()>Duration::from_secs(5){hub.stop(Some(&keys[0]))?;}let s=hub.snapshot(Some(&keys[0]))?;if !live_hub::active(&s.state){snapshots.push(s);break;}if start.elapsed()>Duration::from_secs(18){hub.stop_all();return Err("Restart timeout".into());}thread::sleep(Duration::from_millis(150));}
 if snapshots.last().unwrap().id==previous{return Err("Restart reused recording identity".into());}
 for s in &snapshots{
  if s.state!="stopped"||s.solution_mode!="RECORD"||!s.epochs.is_empty()||!s.history.is_empty()||s.received_epochs!=0||!s.metrics.is_null()||s.log_path.is_some()||s.parse_error.is_some()||s.status_error.is_some()||s.recording_files.is_empty(){return Err("Invalid record-only snapshot".into());}
 }
 fs::write(root.join("check.json"),serde_json::to_vec_pretty(&serde_json::json!({"snapshots":snapshots,"diskGrew":disk_grew,"independentStop":independently_stopped,"resultCount":library.catalog()?.len()})).unwrap()).map_err(|e|e.to_string())?;
 println!("Record-only receive, disk growth, independent stop and restart passed");Ok(())
}
