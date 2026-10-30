//! Times the analysis load path without WebView: Log=4 parse, then the binary encoding sent to the page.
//! Usage: cargo run --release --bin load-check -- [--json <dir>] <a.log> [b.log ...]
//! `--json` also writes each result as JSON, to compare the parser output with another build;
//! `FINDU_WIRE_OUT=<file>` saves the encoded bytes.
// The app modules are included whole; only the analysis load path is used here.
#![allow(dead_code)]
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
#[path = "../wire.rs"]
mod wire;
use std::time::Instant;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let dump = args.iter().position(|a| a == "--json").map(|i| {
        args.remove(i);
        std::path::PathBuf::from(args.remove(i))
    });
    let root = std::env::temp_dir().join(format!("findu-load-check-{}", std::process::id()));
    let lib = library::Library::new(&root);
    let t = Instant::now();
    let results = lib.import(args.clone()).expect("import");
    println!("parse {} log(s): {:.2} s", results.len(), t.elapsed().as_secs_f64());
    if let Some(dir) = dump {
        std::fs::create_dir_all(&dir).unwrap();
        for (i, r) in results.iter().enumerate() {
            let rows = serde_json::json!({ "epochs": r.epochs, "diagnostics": r.diagnostics });
            std::fs::write(dir.join(format!("{i}.json")), serde_json::to_vec(&rows).unwrap()).unwrap();
        }
    }
    for (path, r) in args.iter().zip(&results) {
        println!("  {path}: epochs {} diagnostics {}", r.epochs.len(), r.diagnostics.len());
    }
    let json = serde_json::to_vec(&results).unwrap().len();
    let t = Instant::now();
    let bytes = wire::encode(results);
    if let Ok(path) = std::env::var("FINDU_WIRE_OUT") {
        std::fs::write(path, &bytes).unwrap();
    }
    println!(
        "encode {:.2} s: {:.1} MiB binary (JSON would be {:.1} MiB)",
        t.elapsed().as_secs_f64(),
        bytes.len() as f64 / 1048576.0,
        json as f64 / 1048576.0
    );
    let _ = std::fs::remove_dir_all(root);
}
