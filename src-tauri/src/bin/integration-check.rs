//! Runs the production adapters without WebView. Inputs and evidence stay in the supplied local root.
#[path = "../gnss_log.rs"]
mod gnss_log;
#[path = "../library.rs"]
mod library;
#[path = "../live_hub.rs"]
mod live_hub;
#[path = "../live_log.rs"]
mod live_log;
#[path = "../native.rs"]
mod native;
#[path = "../options.rs"]
mod options;
#[path = "../paths.rs"]
mod paths;
#[path = "../realtime.rs"]
mod realtime;
#[path = "../results.rs"]
mod results;
#[path = "../status_log.rs"]
mod status_log;
#[path = "../table.rs"]
mod table;
use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if !(args.len() == 4 || args.len() == 5 && args[4] == "--satellites") {
        return Err("integration-check ENGINE ROOT REQUEST_JSON [--satellites]".into());
    }
    let check_satellites = args.len() == 5;
    let mut satellite_seen = false;
    let mut last_satellite_poll = 0;
    let root = PathBuf::from(&args[2]);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let library = Arc::new(library::Library::new(&root));
    let hub =
        live_hub::LiveHub::new(PathBuf::from(&args[1]), root.join("realtime")).with_library(library.clone());
    let requests: Vec<realtime::LiveRequest> =
        serde_json::from_slice(&fs::read(&args[3]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut keys = Vec::new();
    for (i, request) in requests.iter().enumerate() {
        keys.push(hub.start(request.clone(), Some(format!("case-{i}")))?);
    }
    let start = Instant::now();
    let mut stopped_one = false;
    let mut independent_stop = false;
    loop {
        if start.elapsed() > Duration::from_secs(12) && !stopped_one {
            hub.stop(Some(&keys[0]))?;
            stopped_one = true;
        }
        if start.elapsed() > Duration::from_secs(16) {
            hub.stop_all();
        }
        let overview = hub.overview();
        if check_satellites && start.elapsed().as_secs() > last_satellite_poll {
            last_satellite_poll = start.elapsed().as_secs();
            let state = hub.snapshot(Some(&keys[0]))?;
            if state.state == "running" {
                let value = hub.runtime(Some(&keys[0]))?.satellites(&state.id, true)?;
                satellite_seen |= value["satellites"].as_array().is_some_and(|rows| !rows.is_empty());
                let opt = fs::read_to_string(PathBuf::from(&state.output_dir).join("live.opt"))
                    .map_err(|e| e.to_string())?;
                if opt.contains("IPSClient_Satellite") {
                    return Err("Diagnostics leaked into OPT".into());
                }
            }
        }
        if stopped_one && start.elapsed() < Duration::from_secs(16) {
            independent_stop |= overview.iter().any(|s| s.session_key == keys[0] && s.state == "stopped")
                && overview.iter().filter(|s| s.session_key != keys[0]).all(|s| s.state == "running");
        }
        if overview.iter().any(|s| s.state == "failed") {
            hub.stop_all();
            return Err(serde_json::to_string(&overview).unwrap());
        }
        if overview.iter().all(|s| !live_hub::active(&s.state)) {
            break;
        }
        if start.elapsed() > Duration::from_secs(35) {
            hub.stop_all();
            return Err("Live integration timed out".into());
        }
        thread::sleep(Duration::from_millis(250));
    }
    if check_satellites && !satellite_seen {
        return Err("No snapshot through production launcher".into());
    }
    let mut snapshots = Vec::new();
    for key in &keys {
        let snapshot = hub.snapshot(Some(key))?;
        if snapshot.parse_error.is_some() || snapshot.status_error.is_some() {
            return Err(format!("{key}: {:?} {:?}", snapshot.parse_error, snapshot.status_error));
        }
        if snapshot.received_epochs < 3 || snapshot.epochs.is_empty() || snapshot.heartbeat.is_null() {
            return Err(format!("{key}: missing native records"));
        }
        snapshots.push(snapshot);
    }
    if library.catalog()?.len() != keys.len() {
        return Err("Terminal sessions must already be indexed".into());
    }
    // Immediately reuse the same UI key. Old summary and index must still belong to the old run.
    let mut request = requests[0].clone();
    request.label = Some("restart-check".into());
    hub.start(request, Some(keys[0].clone()))?;
    if hub.snapshot(Some(&keys[0]))?.id == snapshots[0].id {
        return Err("Restart reused run identity".into());
    }
    let restart_start = Instant::now();
    loop {
        if restart_start.elapsed() > Duration::from_secs(8) {
            hub.stop(Some(&keys[0]))?;
        }
        let s = hub.snapshot(Some(&keys[0]))?;
        if !live_hub::active(&s.state) {
            break;
        }
        if restart_start.elapsed() > Duration::from_secs(18) {
            hub.stop_all();
            return Err("Restart timed out".into());
        }
        thread::sleep(Duration::from_millis(250));
    }
    let restart = hub.snapshot(Some(&keys[0]))?;
    if restart.state != "stopped"
        || restart.received_epochs < 3
        || restart.epochs.is_empty()
        || restart.parse_error.is_some()
        || restart.status_error.is_some()
    {
        return Err("Restart did not produce valid native records".into());
    }
    let old: serde_json::Value = serde_json::from_slice(
        &fs::read(PathBuf::from(&snapshots[0].output_dir).join("session-summary.json"))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if old["id"] != snapshots[0].id || old["label"] != snapshots[0].label {
        return Err("Restart changed old session identity".into());
    }
    if library.catalog()?.len() != keys.len() + 1 {
        return Err("Restart result not indexed at terminal state".into());
    }
    let catalog = library.catalog()?;
    let mut reopened = Vec::new();
    for entry in catalog {
        let result = library.open(&entry.id)?;
        if result.ntrip_log_path.is_none()
            || result.product_log_path.is_none()
            || result.client_status["streams"].as_array().is_none_or(|s| s.is_empty())
        {
            return Err(format!("{}: archived native status is missing", result.name));
        }
        reopened.push(serde_json::json!({"name":result.name,"mode":result.solution_mode,"logVersion":result.log_version,
            "epochs":result.epochs.len(),"diagnostics":result.diagnostics.len(),"productHistory":result.product_history.len(),"engineBuildId":result.engine_build_id,
            "ntripLogPath":result.ntrip_log_path,"productLogPath":result.product_log_path,"clientStatus":result.client_status}));
    }
    if keys.len() > 1 && !independent_stop {
        return Err("Independent stop was not observed".into());
    }
    let evidence = serde_json::json!({"snapshots":snapshots,"restart":restart,"reopened":reopened,"independentStop":independent_stop,"satelliteSnapshotSeen":satellite_seen});
    fs::write(root.join("check.json"), serde_json::to_vec_pretty(&evidence).unwrap())
        .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::json!({"sessions":keys.len(),"reopened":reopened,"evidence":root.join("check.json")})
    );
    Ok(())
}
