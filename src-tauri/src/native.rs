#[path="capacity.rs"]
pub mod capacity;
use crate::{
    options,
    results::{self, RealResult},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub build_id: String,
    pub source_modified: bool,
    pub available: bool,
    pub executable: String,
    pub commit: String,
    pub version: String,
    pub sha256: String,
    pub default_output: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub document: options::OptDocument,
    pub output_dir: String,
    pub run_mode: String,
    pub playback_speed: f64,
    pub reference_xyz: Option<[f64; 3]>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTask {
    pub id: String,
    pub name: String,
    pub status: String,
    pub progress: f64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub output_dir: String,
    pub run_opt: String,
    pub request: RunRequest,
    pub error: Option<String>,
    pub result_id: Option<String>,
    pub exit_code: Option<i32>,
    pub phase: String,
    pub elapsed_sec: f64,
    pub preview: Option<RealResult>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLog {
    pub id: u64,
    pub time: String,
    pub level: String,
    pub message: String,
    pub task_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSnapshot {
    pub tasks: Vec<NativeTask>,
    pub logs: Vec<NativeLog>,
    pub concurrency: usize,
}
struct Data {
    tasks: Vec<NativeTask>,
    logs: Vec<NativeLog>,
    results: HashMap<String, RealResult>,
    cancel: HashMap<String, Arc<AtomicBool>>,
    seq: u64,
    concurrency: usize,
}
#[derive(Clone)]
pub struct NativeRuntime {
    data: Arc<Mutex<Data>>,
    pub engine_dir: PathBuf,
    pub default_root: PathBuf,
    library: Option<Arc<crate::library::Library>>,
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl NativeRuntime {
    pub fn new(engine_dir: PathBuf, default_root: PathBuf) -> Self {
        Self {
            data: Arc::new(Mutex::new(Data {
                tasks: vec![],
                logs: vec![],
                results: HashMap::new(),
                cancel: HashMap::new(),
                seq: 0,
                concurrency: 2,
            })),
            engine_dir,
            default_root,
            library:None,
        }
    }
    pub fn with_library(mut self,library:Arc<crate::library::Library>)->Self{self.library=Some(library);self}
    pub fn info(&self) -> Result<EngineInfo, String> {
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(self.engine_dir.join("manifest.json"))
                .map_err(|e| format!("找不到正式引擎 manifest：{e}"))?,
        )
        .map_err(|e| e.to_string())?;
        options::check_protocol(&manifest)?;
        let exe = self.engine_dir.join("IPSPOS.exe");
        let sha = options::hash(&exe)?;
        if manifest["solver_sha256"].as_str() != Some(sha.as_str()) {
            return Err("IPSPOS 引擎哈希与构建记录不匹配，请重新准备正式引擎".into());
        }
        Ok(EngineInfo {
            build_id: manifest["build_id"].as_str().unwrap_or_default().into(),
            source_modified: manifest["source_modified"].as_bool().unwrap_or(false),
            available: true,
            executable: options::display_path(&exe),
            commit: manifest["commit"].as_str().unwrap_or("").into(),
            version: manifest["ipspos_version"].as_str().unwrap_or("").into(),
            sha256: sha,
            default_output: options::display_path(&self.default_root),
        })
    }
    pub fn snapshot(&self) -> NativeSnapshot {
        let d = self.data.lock().unwrap();
        NativeSnapshot {
            tasks: d.tasks.clone(),
            logs: d.logs.clone(),
            concurrency: d.concurrency,
        }
    }
    pub fn result(&self, id: &str) -> Result<RealResult, String> {
        self.data
            .lock()
            .unwrap()
            .results
            .get(id)
            .cloned()
            .ok_or("结果已清理或尚未生成".into())
    }
    fn log(&self, id: &str, level: &str, message: impl Into<String>) {
        let mut d = self.data.lock().unwrap();
        d.seq += 1;
        let seq = d.seq;
        d.logs.push(NativeLog {
            id: seq,
            time: now(),
            level: level.into(),
            message: message.into(),
            task_id: Some(id.into()),
        });
        if d.logs.len() > 500 {
            d.logs.remove(0);
        }
    }
    fn update(&self, id: &str, f: impl FnOnce(&mut NativeTask)) {
        let mut d = self.data.lock().unwrap();
        if let Some(t) = d.tasks.iter_mut().find(|t| t.id == id) {
            f(t);
        }
    }
    pub fn submit(
        &self,
        requests: Vec<RunRequest>,
        concurrency: usize,
    ) -> Result<Vec<String>, String> {
        self.info()?;
        if !(1..=capacity::LIMITS.postprocess_runs).contains(&concurrency) {
            return Err(format!("并发数支持 1–{}",capacity::LIMITS.postprocess_runs));
        }
        if requests.is_empty() || requests.len() > 128 {
            return Err("一次提交 1–128 个任务".into());
        }
        for request in &requests {
            validate(request)?;
        }
        let mut d = self.data.lock().unwrap();
        if d.tasks
            .iter()
            .filter(|t| matches!(t.status.as_str(), "queued" | "running"))
            .count()
            + requests.len()
            > 128
        {
            return Err("最多 128 个待处理任务".into());
        }
        if d.tasks.iter().any(|t| t.status == "running") && d.concurrency != concurrency {
            return Err("请等待当前任务结束后再改变并发数".into());
        }
        d.concurrency = concurrency;
        let mut ids = Vec::new();
        let mut ordinal=d.tasks.iter().filter_map(|t|t.name.split('_').next()?.parse::<usize>().ok()).max().unwrap_or(0);
        for request in requests {
            ordinal+=1;
            let label=format!("{:02}_{}",ordinal,Path::new(&request.document.name).file_stem().unwrap_or_default().to_string_lossy());
            let id = uuid::Uuid::new_v4().to_string();
            let base = if request.output_dir.trim().is_empty() {
                self.default_root.clone()
            } else {
                PathBuf::from(&request.output_dir)
            };
            if !base.is_absolute() {
                return Err("输出根目录必须为绝对路径".into());
            }
            let dir = base.join(format!("run-{}", id));
            ids.push(id.clone());
            d.cancel
                .insert(id.clone(), Arc::new(AtomicBool::new(false)));
            d.tasks.insert(
                0,
                NativeTask {
                    id,
                    name: label,
                    status: "queued".into(),
                    progress: 0.0,
                    created_at: now(),
                    started_at: None,
                    finished_at: None,
                    output_dir: options::display_path(&dir),
                    run_opt: options::display_path(&dir.join("run.opt")),
                    request,
                    error: None,
                    result_id: None,
                    exit_code: None,
                    phase: "queued".into(),
                    elapsed_sec: 0.0,
                    preview: None,
                },
            );
        }
        while d.tasks.len() > 100 {
            if let Some(index) = d
                .tasks
                .iter()
                .rposition(|t| !matches!(t.status.as_str(), "queued" | "running"))
            {
                let old = d.tasks.remove(index);
                d.results.remove(&old.id);
                d.cancel.remove(&old.id);
            } else {
                break;
            }
        }
        drop(d);
        self.schedule();
        Ok(ids)
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut d = self.data.lock().unwrap();
        let t = d
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or("任务不存在")?;
        if t.status == "queued" {
            t.status = "cancelled".into();
            t.phase = "cancelled".into();
            t.finished_at = Some(now());
        } else if t.status != "running" {
            return Ok(());
        }
        if let Some(flag) = d.cancel.get(id) {
            flag.store(true, Ordering::SeqCst);
        }
        drop(d);
        self.log(id, "warn", "已请求取消任务");
        Ok(())
    }
    pub fn cancel_all(&self) {
        let d = self.data.lock().unwrap();
        for flag in d.cancel.values() {
            flag.store(true, Ordering::SeqCst);
        }
    }
    pub fn directory(&self, id: &str) -> Result<PathBuf, String> {
        self.data
            .lock()
            .unwrap()
            .tasks
            .iter()
            .find(|t| t.id == id)
            .map(|t| PathBuf::from(&t.output_dir))
            .ok_or("任务已移除".into())
    }
    /// Remove only terminal records from memory; all disk outputs remain available.
    pub fn dismiss(&self, ids: &[String]) -> Result<(), String> {
        let mut d = self.data.lock().unwrap();
        if d.tasks
            .iter()
            .any(|t| ids.contains(&t.id) && matches!(t.status.as_str(), "queued" | "running"))
        {
            return Err("运行中的任务请先取消，停止后才能从队列移除".into());
        }
        d.tasks.retain(|t| !ids.contains(&t.id));
        for id in ids {
            d.cancel.remove(id);
            d.results.remove(id);
        }
        d.logs
            .retain(|l| l.task_id.as_ref().is_none_or(|id| !ids.contains(id)));
        Ok(())
    }
    fn schedule(&self) {
        let mut d = self.data.lock().unwrap();
        let running = d.tasks.iter().filter(|t| t.status == "running").count();
        let count = d.concurrency.saturating_sub(running);
        let ids: Vec<String> = d
            .tasks
            .iter()
            .rev()
            .filter(|t| t.status == "queued")
            .take(count)
            .map(|t| t.id.clone())
            .collect();
        for id in &ids {
            if let Some(t) = d.tasks.iter_mut().find(|t| t.id == *id) {
                t.status = "running".into();
                t.phase = "preparing".into();
                t.started_at = Some(now());
            }
        }
        drop(d);
        for id in ids {
            let runtime = self.clone();
            thread::spawn(move || runtime.run(&id));
        }
    }
    fn run(&self, id: &str) {
        let start = Instant::now();
        self.log(
            id,
            "info",
            "准备真实 IPSPOS 任务：规范化输入路径，创建独立输出目录",
        );
        let outcome = self.solve(id, &start);
        if let Ok(Some(result)) = &outcome {
            self.data
                .lock()
                .unwrap()
                .results
                .insert(id.into(), result.clone());
        }
        self.update(id, |t| {
            t.elapsed_sec = start.elapsed().as_secs_f64();
            t.finished_at = Some(now());
            // Terminal tasks expose their complete result separately, never through polling previews.
            t.preview = None;
            match &outcome {
                Ok(Some(_)) => {
                    t.status = "succeeded".into();
                    t.phase = "completed".into();
                    t.progress = 100.0;
                    t.result_id = Some(id.into());
                }
                Ok(None) => {
                    t.status = "succeeded".into();
                    t.phase = "completed".into();
                    t.progress = 100.0;
                }
                Err(error) if error == "CANCELLED" => {
                    t.status = "cancelled".into();
                    t.phase = "cancelled".into();
                }
                Err(error) => {
                    t.status = "failed".into();
                    t.phase = "failed".into();
                    t.error = Some(error.clone());
                }
            }
        });
        match outcome {
            Ok(Some(result)) => {
                if let Some(lib)=&self.library {if let Err(e)=lib.remember(&result){self.log(id,"warn",format!("结果文件已保留，但历史索引未写入：{e}"));}}
                self.log(
                    id,
                    "info",
                    format!("真实任务完成：{} 个有效定位历元", result.epochs.len()),
                );
            }
            Ok(None) => self.log(
                id,
                "warn",
                "IPSPOS 成功退出，GNSS Log 已关闭；原始文件保留，本任务没有 Log=4 曲线",
            ),
            Err(e) => self.log(id, if e == "CANCELLED" { "warn" } else { "error" }, e),
        }
        // Persist the terminal state and provenance for review without storing large previews twice.
        if let Some(mut task) = self.snapshot().tasks.into_iter().find(|t| t.id == id) {
            task.preview = None;
            let _ = fs::write(
                Path::new(&task.output_dir).join("task.json"),
                serde_json::to_vec_pretty(&task).unwrap(),
            );
        }
        self.schedule();
    }
    fn solve(&self, id: &str, start: &Instant) -> Result<Option<RealResult>, String> {
        let (task, flag) = {
            let d = self.data.lock().unwrap();
            (
                d.tasks.iter().find(|t| t.id == id).unwrap().clone(),
                d.cancel[id].clone(),
            )
        };
        if flag.load(Ordering::SeqCst) {
            return Err("CANCELLED".into());
        }
        let info = self.info()?;
        let dir = PathBuf::from(&task.output_dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let options = options::parse(&task.request.document.text);
        let reference = reference_xyz(&task.request)?;
        let source = PathBuf::from(&task.request.document.source_path);
        let source_base = source.parent().ok_or("配置路径无效")?;
        let base = if let Some(value) = options.get("GNSS_FilePath").filter(|s| !s.is_empty()) {
            options::absolute(source_base, value)
        } else {
            let source_text = options::display_path(&source);
            if let Some(index) = source_text.find("\\opt") {
                PathBuf::from(&source_text[..index])
            } else {
                source_base.to_path_buf()
            }
        };
        let mut overrides = BTreeMap::new();
        let mut inputs = Vec::new();
        let rtk=matches!(options.get("GNSS_PMode").map(String::as_str),Some("6"|"7"|"8"));
        for key in options::FILE_KEYS {
            if rtk && !["GNSS_RoveFile","GNSS_BaseFile","GNSS_NaviFile","GNSS_RefFile"].contains(key){continue;}
            if !rtk && *key=="GNSS_BaseFile"{continue;}
            if let Some(value) = options.get(*key).filter(|v| !v.is_empty()) {
                let path = options::absolute(&base, value);
                if !path.is_file() {
                    return Err(format!("{key} 输入不存在：{}", path.display()));
                }
                let sha = options::hash(&path)?;
                inputs.push(
                    serde_json::json!({"key":key,"path":options::display_path(&path),"sha256":sha}),
                );
                let value = options::engine_path(&path)?;
                if value.len() > 900 || value.contains([';', '\n', '\r']) {
                    return Err(format!("{key} 路径过长或含配置分隔符"));
                }
                overrides.insert(key.to_string(), value);
            }
        }
        overrides.insert("GNSS_FilePath".into(), options::engine_path(&dir)?);
        let mut text = task.request.document.text.clone();
        text.push_str("\n# FINDYOU isolated file paths; algorithm parameters retained.\n");
        for (k, v) in &overrides {
            text.push_str(&format!("{k} = {v};\n"));
        }
        fs::write(&task.run_opt, text).map_err(|e| e.to_string())?;
        fs::write(dir.join("original.opt"), &task.request.document.text)
            .map_err(|e| e.to_string())?;
        let mut manifest = serde_json::json!({"schemaVersion":2,"engine":info,"sourcePath":task.request.document.source_path,"sourceOptSha256":options::hash(&source)?,"editedOptSha256":options::hash(&dir.join("original.opt"))?,"inputs":inputs,"overrides":overrides,"runMode":task.request.run_mode,"startedAt":now()});
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        if flag.load(Ordering::SeqCst) {
            return Err("CANCELLED".into());
        }
        let stdout = fs::File::create(dir.join("console.log")).map_err(|e| e.to_string())?;
        let mut command = Command::new(&info.executable);
        command
            .arg(options::engine_path(Path::new(&task.run_opt))?)
            .current_dir(&dir)
            .stdout(Stdio::from(stdout.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(stdout))
            .stdin(Stdio::null());
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("IPSPOS_DIAG_") {
                command.env_remove(key);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动 IPSPOS：{e}"))?;
        manifest["processId"] = serde_json::json!(child.id());
        manifest["processStartedAt"] = serde_json::json!(now());
        let _job = match Job::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        self.update(id, |t| t.phase = "solving".into());
        self.log(
            id,
            "info",
            format!(
                "IPSPOS {} 已启动，PID={}，提交 {}",
                info.version,
                child.id(),
                &info.commit[..12.min(info.commit.len())]
            ),
        );
        let mut refresh = Instant::now();
        let mut log_path = None;
        let status = loop {
            if flag.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                manifest["cancelled"] = serde_json::json!(true);
                manifest["solverFinishedAt"] = serde_json::json!(now());
                let _ = fs::write(
                    dir.join("manifest.json"),
                    serde_json::to_vec_pretty(&manifest).unwrap(),
                );
                return Err("CANCELLED".into());
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if refresh.elapsed() >= Duration::from_millis(900) {
                let tail = tail(&dir.join("console.log"), 16384);
                let progress = tail
                    .rsplit("Processing Progress:[")
                    .next()
                    .and_then(|s| s.split('%').next())
                    .and_then(|v| v.trim().parse::<f64>().ok());
                if log_path.is_none() {
                    log_path = results::find_solution_log(&dir);
                }
                let preview = log_path
                    .as_deref()
                    .and_then(|p| self.result_at(id, p, reference, &info).ok());
                self.update(id, |t| {
                    t.elapsed_sec = start.elapsed().as_secs_f64();
                    if let Some(p) = progress {
                        t.progress = p.min(99.0);
                    }
                    if let Some(mut result) = preview {
                        retain_preview_tail(&mut result.epochs);
                        retain_preview_tail(&mut result.diagnostics);
                        retain_preview_tail(&mut result.product_history);
                        result.is_live_cache = true;
                        t.preview = Some(result);
                    }
                });
                refresh = Instant::now();
            }
            thread::sleep(Duration::from_millis(150));
        };
        self.update(id, |t| t.exit_code = status.code());
        manifest["exitCode"] = serde_json::json!(status.code());
        manifest["solverFinishedAt"] = serde_json::json!(now());
        let unchanged = inputs.iter().all(|i| {
            options::hash(Path::new(i["path"].as_str().unwrap()))
                .is_ok_and(|sha| Some(sha.as_str()) == i["sha256"].as_str())
        });
        manifest["inputsUnchanged"] = serde_json::json!(unchanged);
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        if !unchanged {
            return Err("运行期间输入文件发生改变，结果未发布".into());
        }
        if !status.success() {
            return Err(format!(
                "IPSPOS 退出码 {:?}：{}",
                status.code(),
                tail(&dir.join("console.log"), 2500)
            ));
        }
        let Some(path) = results::find_solution_log(&dir) else {
            if options
                .get("GNSS_bOutputLOG")
                .is_some_and(|v| v.eq_ignore_ascii_case("OFF") || v == "0")
            {
                return Ok(None);
            }
            return Err("IPSPOS 成功退出但没有找到 Log=4 定位输出，请检查输出配置".into());
        };
        let result = self.result_at(id, &path, reference, &info)?;
        fs::write(
            dir.join("result.json"),
            serde_json::to_vec(&result).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        if task.request.run_mode == "replay" {
            self.log(
                id,
                "info",
                format!(
                    "解算完成，按 {}× 观测时间播放真实历元；不改变引擎解算",
                    task.request.playback_speed
                ),
            );
            self.update(id, |t| {
                t.phase = "playback".into();
                t.progress = 0.0;
                t.preview = None;
            });
            let begin = Instant::now();
            let first = &result.epochs[0];
            let first_time = first.gps_week as f64 * 604800.0 + first.tow;
            let mut cursor = 0;
            let mut template = result.clone();
            template.epochs.clear();
            while cursor < result.epochs.len() {
                if flag.load(Ordering::SeqCst) {
                    return Err("CANCELLED".into());
                }
                let until =
                    first_time + begin.elapsed().as_secs_f64() * task.request.playback_speed;
                while cursor < result.epochs.len()
                    && result.epochs[cursor].gps_week as f64 * 604800.0 + result.epochs[cursor].tow
                        <= until
                {
                    cursor += 1;
                }
                let mut preview = template.clone();
                preview.epochs = result.epochs[cursor.saturating_sub(300)..cursor].to_vec();
                self.update(id, |t| {
                    t.preview = Some(preview);
                    t.progress = cursor as f64 / result.epochs.len() as f64 * 99.0;
                    t.elapsed_sec = start.elapsed().as_secs_f64();
                });
                thread::sleep(Duration::from_millis(200));
            }
        }
        Ok(Some(result))
    }
    fn result_at(
        &self,
        id: &str,
        path: &Path,
        reference: Option<[f64; 3]>,
        info: &EngineInfo,
    ) -> Result<RealResult, String> {
        let mut result = results::read_solution(path, reference)?;
        let task = self
            .data
            .lock()
            .unwrap()
            .tasks
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or("任务不存在")?;
        result.id = id.into();
        result.run_id=id.into();
        result.name = task.name.clone();
        result.analysis_config=results::config_summary(&task.request.document.text);
        result.station = options::parse(&task.request.document.text)
            .get("GNSS_RoveFile")
            .and_then(|s| Path::new(s).file_stem())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        result.output_dir = task.output_dir;
        result.engine_commit = info.commit.clone();
        result.engine_build_id = info.build_id.clone();
        Ok(result)
    }
}

fn validate(request: &RunRequest) -> Result<(), String> {
    if request.document.text.len() > 1_048_576 {
        return Err("配置超过 1 MB".into());
    }
    let options = options::parse(&request.document.text);
    options::check_solver_options(&options)?;
    reference_xyz(request)?;
    if !matches!(
        options.get("GNSS_PMode").map(String::as_str),
        Some("2" | "3" | "6" | "7" | "8")
    ) {
        return Err("真实接入支持 PPP(2/3)及 RTK(6/7/8)模式".into());
    }
    if matches!(options.get("GNSS_PMode").map(String::as_str),Some("6"|"7"|"8")) && options.get("GNSS_BaseFile").is_none_or(|s|s.is_empty()) {
        return Err("RTK 后处理需要 GNSS_BaseFile 基站观测".into());
    }
    let rove = options
        .get("GNSS_RoveFile")
        .filter(|s| !s.is_empty())
        .ok_or("需要 GNSS_RoveFile")?;
    if ["opt", "list", "lst", "txt"].iter().any(|s| {
        Path::new(rove)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case(s))
    }) || options.contains_key("GNSS_OBSFile")
    {
        return Err("不支持批处理列表或组合观测入口，请导入多个单测站 .opt".into());
    }
    if !Path::new(&request.document.source_path).is_file() {
        return Err("原始 .opt 文件不存在".into());
    }
    if !request.output_dir.trim().is_empty() && !Path::new(&request.output_dir).is_absolute() {
        return Err("输出根目录须为绝对路径".into());
    }
    if !matches!(request.run_mode.as_str(), "post" | "replay")
        || !request.playback_speed.is_finite()
        || !(1.0..=86400.0).contains(&request.playback_speed)
    {
        return Err("运行模式或回放倍速无效".into());
    }
    if let Some(xyz) = request.reference_xyz {
        if xyz.iter().any(|v| !v.is_finite()) || xyz.iter().map(|v| v * v).sum::<f64>().sqrt() < 1e6
        {
            return Err("参考坐标须为有效 ECEF XYZ（米）".into());
        }
    }
    Ok(())
}

fn reference_xyz(request: &RunRequest) -> Result<Option<[f64; 3]>, String> {
    if let Some(xyz) = request.reference_xyz {
        return Ok(Some(xyz));
    }
    let values = options::parse(&request.document.text);
    let Some(value) = values.get("GNSS_RefPoss").filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let numbers: Vec<f64> = value
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(str::parse::<f64>)
        .collect::<Result<_, _>>()
        .map_err(|_| "GNSS_RefPoss 需要三个 ECEF 坐标（米）")?;
    if numbers == [0.0, 0.0, 0.0] {
        return Ok(None);
    }
    if numbers.len() != 3
        || numbers.iter().any(|v| !v.is_finite())
        || numbers.iter().map(|v| v * v).sum::<f64>().sqrt() < 1e6
    {
        return Err(
            "GNSS_RefPoss 需要有效 ECEF XYZ（米），未提供独立参考时请留空或设 0,0,0".into(),
        );
    }
    Ok(Some([numbers[0], numbers[1], numbers[2]]))
}
fn retain_preview_tail<T>(values: &mut Vec<T>) {
    if values.len() > 300 { *values = values.split_off(values.len() - 300); }
}
fn tail(path: &Path, size: u64) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let _ = file.seek(SeekFrom::End(
        -(size.min(file.metadata().map(|m| m.len()).unwrap_or(0)) as i64),
    ));
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into()
}

pub(crate) struct Job(#[cfg(windows)] isize);
impl Job {
    pub(crate) fn attach(child: &std::process::Child) -> Result<Self, String> {
        #[cfg(windows)]
        unsafe {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("无法创建进程隔离 Job".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                CloseHandle(handle);
                return Err("无法将 IPSPOS 加入进程隔离 Job".into());
            }
            return Ok(Self(handle as isize));
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self())
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(test)] mod queue_tests {
    use super::*;
    #[test] fn polling_preview_keeps_latest_records_without_changing_full_result(){
        let full:Vec<usize>=(0..86370).collect();
        let mut preview=full.clone();retain_preview_tail(&mut preview);
        assert_eq!(preview.len(),300);assert_eq!(preview[0],86070);assert_eq!(preview[299],86369);
        assert_eq!(full.len(),86370);assert_eq!(full[0],0);
        let mut short=vec![1,2];retain_preview_tail(&mut short);assert_eq!(short,vec![1,2]);
    }
    #[test] fn dismiss_requires_terminal_state_and_keeps_disk_outputs(){
        let root=std::env::temp_dir().join(format!("findyou-queue-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();fs::write(root.join("result.txt"),"keep").unwrap();
        let rt=NativeRuntime::new(root.clone(),root.clone());
        let request=RunRequest{document:options::OptDocument{source_path:"unused.opt".into(),name:"unused.opt".into(),text:"GNSS_PMode=3;".into()},output_dir:root.to_string_lossy().into(),run_mode:"post".into(),playback_speed:1.,reference_xyz:None};
        for (id,status) in [("active","running"),("done","succeeded")] {
            rt.data.lock().unwrap().tasks.push(NativeTask{id:id.into(),name:id.into(),status:status.into(),progress:0.,created_at:now(),started_at:None,finished_at:None,output_dir:root.to_string_lossy().into(),run_opt:String::new(),request:request.clone(),error:None,result_id:None,exit_code:None,phase:status.into(),elapsed_sec:0.,preview:None});
        }
        assert!(rt.dismiss(&["active".into(),"done".into()]).is_err());assert_eq!(rt.snapshot().tasks.len(),2);
        rt.dismiss(&["done".into()]).unwrap();assert_eq!(rt.snapshot().tasks.len(),1);assert!(root.join("result.txt").is_file());assert!(rt.directory("done").is_err());
        fs::remove_file(root.join("result.txt")).unwrap();fs::remove_dir(root).unwrap();
    }
}
