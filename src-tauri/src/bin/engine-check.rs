#[path = "../live_log.rs"]
mod live_log;
#[path = "../gnss_log.rs"]
mod gnss_log;
#[path = "../status_log.rs"]
mod status_log;
#[path = "../native.rs"]
mod native;
#[path = "../options.rs"]
mod options;
#[path = "../results.rs"]
mod results;
#[path = "../library.rs"]
mod library;
use std::{path::PathBuf, thread, time::Duration};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("engine-check ENGINE_DIR OUTPUT_DIR CONCURRENCY OPT...");
        std::process::exit(2);
    }
    let runtime = native::NativeRuntime::new(PathBuf::from(&args[1]), PathBuf::from(&args[2]));
    let docs = options::load(args[4..].to_vec()).unwrap();
    let requests = docs
        .into_iter()
        .map(|document| native::RunRequest {
            document,
            output_dir: args[2].clone(),
            run_mode: "post".into(),
            playback_speed: 3600.0,
            reference_xyz: None,
        })
        .collect();
    let ids = runtime.submit(requests, args[3].parse().unwrap()).unwrap();
    loop {
        let snapshot = runtime.snapshot();
        if snapshot
            .tasks
            .iter()
            .all(|t| !matches!(t.status.as_str(), "queued" | "running"))
        {
            let tasks:Vec<_>=snapshot.tasks.iter().map(|t|serde_json::json!({"id":t.id,"name":t.name,"status":t.status,"outputDir":t.output_dir,"exitCode":t.exit_code,"error":t.error,"elapsedSec":t.elapsed_sec})).collect();
            println!("{}", serde_json::to_string_pretty(&tasks).unwrap());
            for id in ids {
                if let Ok(result) = runtime.result(&id) {
                    println!("RESULT {} {} epochs", result.name, result.epochs.len());
                }
            }
            runtime.cancel_all();
            if snapshot.tasks.iter().any(|t| t.status != "succeeded") {
                std::process::exit(1);
            }
            break;
        }
        thread::sleep(Duration::from_secs(2));
    }
}
