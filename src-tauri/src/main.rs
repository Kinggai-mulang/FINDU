#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod gnss_log;
mod status_log;
mod products;
mod live_log;
mod native;
mod options;
mod input_path;
mod paths;
mod realtime;
mod results;
mod library;
mod live_hub;
use tauri::Manager;

#[tauri::command]
async fn import_analysis(paths:Vec<String>,library:tauri::State<'_,std::sync::Arc<library::Library>>)->Result<Vec<results::RealResult>,String>{
    let lib=library.inner().clone();tauri::async_runtime::spawn_blocking(move||lib.import(paths)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn analysis_catalog(library:tauri::State<'_,std::sync::Arc<library::Library>>)->Result<Vec<library::Entry>,String>{library.catalog()}
#[tauri::command]
async fn open_analysis(id:String,library:tauri::State<'_,std::sync::Arc<library::Library>>)->Result<results::RealResult,String>{let lib=library.inner().clone();tauri::async_runtime::spawn_blocking(move||lib.open(&id)).await.map_err(|e|e.to_string())?}
#[tauri::command]
fn forget_analysis(id:String,library:tauri::State<'_,std::sync::Arc<library::Library>>)->Result<(),String>{library.forget(&id)}

#[tauri::command]
fn engine_info(
    runtime: tauri::State<'_, native::NativeRuntime>,
) -> Result<native::EngineInfo, String> {
    runtime.info()
}
#[tauri::command]
fn import_opts(paths: Vec<String>) -> Result<Vec<options::OptDocument>, String> {
    options::load(paths)
}
#[tauri::command]
fn submit_native(
    requests: Vec<native::RunRequest>,
    concurrency: usize,
    runtime: tauri::State<'_, native::NativeRuntime>,
) -> Result<Vec<String>, String> {
    runtime.submit(requests, concurrency)
}
#[tauri::command]
fn native_snapshot(runtime: tauri::State<'_, native::NativeRuntime>) -> native::NativeSnapshot {
    runtime.snapshot()
}
#[tauri::command]
fn native_result(
    id: String,
    runtime: tauri::State<'_, native::NativeRuntime>,
) -> Result<results::RealResult, String> {
    runtime.result(&id)
}
#[tauri::command]
fn cancel_native(
    id: String,
    runtime: tauri::State<'_, native::NativeRuntime>,
) -> Result<(), String> {
    runtime.cancel(&id)
}

#[tauri::command]
fn import_realtime(path: String) -> Result<realtime::LiveDocument, String> {
    realtime::import(path)
}
#[tauri::command]
fn start_realtime(
    request: realtime::LiveRequest,
    session_id: Option<String>,
    runtime: tauri::State<'_, live_hub::LiveHub>,
) -> Result<String, String> {
    runtime.start(request,session_id)
}
#[tauri::command]
fn stop_realtime(session_id:Option<String>,runtime: tauri::State<'_, live_hub::LiveHub>)->Result<(),String> {
    runtime.stop(session_id.as_deref())
}
#[tauri::command]
fn realtime_snapshot(
    session_id:Option<String>,
    runtime: tauri::State<'_, live_hub::LiveHub>,
) -> Result<realtime::LiveSnapshot,String> {
    runtime.snapshot(session_id.as_deref())
}
#[tauri::command]
fn realtime_overview(runtime:tauri::State<'_,live_hub::LiveHub>)->Vec<realtime::LiveSnapshot>{runtime.overview()}
#[tauri::command]
fn stop_all_realtime(runtime:tauri::State<'_,live_hub::LiveHub>){runtime.stop_all();}
#[tauri::command]
fn remove_realtime(session_id:String,runtime:tauri::State<'_,live_hub::LiveHub>)->Result<(),String>{runtime.remove(&session_id)}
#[tauri::command]
fn realtime_results(ids:Vec<String>,runtime:tauri::State<'_,live_hub::LiveHub>)->Result<Vec<results::RealResult>,String>{runtime.results(&ids)}

#[tauri::command]
fn runtime_paths(paths: tauri::State<'_, paths::RuntimePaths>) -> paths::RuntimePaths {
    paths.inner().clone()
}
#[tauri::command]
fn dismiss_native(
    ids: Vec<String>,
    runtime: tauri::State<'_, native::NativeRuntime>,
) -> Result<(), String> {
    runtime.dismiss(&ids)
}
#[tauri::command]
fn open_native_folder(
    id: String,
    runtime: tauri::State<'_, native::NativeRuntime>,
) -> Result<(), String> {
    open_folder(&runtime.directory(&id)?)
}
#[tauri::command]
fn open_live_folder(session_id:Option<String>,runtime: tauri::State<'_, live_hub::LiveHub>) -> Result<(), String> {
    open_folder(&runtime.directory(session_id.as_deref())?)
}
fn open_folder(path: &std::path::Path) -> Result<(), String> {
    let path = std::fs::canonicalize(path).map_err(|_| "目录尚未创建，或已被移动")?;
    if !path.is_dir() {
        return Err("目标不是目录".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(options::display_path(&path))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    let paths = paths::RuntimePaths::new(paths::workspace(
        &std::env::current_exe().expect("program path"),
    ))
    .expect("FINDYOU local runtime");
    let root = std::path::PathBuf::from(&paths.root);
    std::env::set_var("TEMP", root.join("cache/temp"));
    std::env::set_var("TMP", root.join("cache/temp"));
    let mut context = tauri::generate_context!();
    context.config_mut().app.app_directories_override =
        Some(tauri::utils::config::AppDirectoriesOverride::Directories(
            tauri::utils::config::AppDirectoryOverrides {
                config: Some(root.join("config")),
                data: Some(root.join("config")),
                local_data: Some(root.join("cache/webview")),
                cache: Some(root.join("cache")),
                log: Some(root.join("logs")),
            },
        ));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(move |app| {
            let beside = std::env::current_exe()?.parent().unwrap().join("engine");
            let resource = app.path().resource_dir()?.join("engine");
            let dev =
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/engine");
            let engine = if beside.join("IPSPOS.exe").is_file() {
                beside
            } else if resource.join("IPSPOS.exe").is_file() {
                resource
            } else {
                dev
            };
            let library=std::sync::Arc::new(library::Library::new(&root));
            app.manage(live_hub::LiveHub::new(
                engine.clone(),
                std::path::PathBuf::from(&paths.realtime),
            ).with_library(library.clone()));
            app.manage(native::NativeRuntime::new(
                engine,
                std::path::PathBuf::from(&paths.postprocess),
            ).with_library(library.clone()));
            let locate = |name:&str| {
                let beside=std::env::current_exe().unwrap().parent().unwrap().join(name);
                let resource=app.path().resource_dir().unwrap().join(name);
                if beside.is_dir(){beside}else if resource.is_dir(){resource}else{std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources").join(name)}
            };
            app.manage(products::Products::new(root.clone(),locate("product-tools"),locate("product-runtime").join("python.exe")));
            app.manage(paths);
            app.manage(library);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            products::dismiss_products,products::product_jobs,products::start_product,products::retry_product,products::cancel_product,products::open_product_folder,products::create_post_document,
            engine_info,
            import_opts,
            input_path::validate_input_path,
            submit_native,
            native_snapshot,
            native_result,
            cancel_native,
            import_realtime,
            realtime::create_live_document,
            start_realtime,
            stop_realtime,
            realtime_snapshot,
            runtime_paths,
            dismiss_native,
            open_native_folder,
            open_live_folder
            ,import_analysis,analysis_catalog,open_analysis,forget_analysis,realtime_overview,stop_all_realtime,remove_realtime,realtime_results
        ])
        .build(context)
        .expect("FINDYOU desktop startup failed")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<products::Products>().stop_all();
                app.state::<native::NativeRuntime>().cancel_all();
                app.state::<live_hub::LiveHub>().stop_all();
            }
        });
}
