//! IPSClient StatusLog=1. Only native records supply receive time and product validity.
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashMap, HashSet}, fs, io::{BufRead, BufReader}, path::{Path, PathBuf}};

pub struct Parser {
    kind: &'static str,
    version: bool,
    ended: bool,
    columns: Vec<String>,
    stamp: Option<i64>,
    rows: BTreeMap<String, Value>,
    week: Option<u32>,
    tow: Option<f64>,
}

impl Parser {
    pub fn new(kind: &'static str) -> Self {
        Self {kind, version:false, ended:false, columns:vec![], stamp:None, rows:BTreeMap::new(), week:None, tow:None}
    }

    pub fn snapshot(&self) -> Option<Value> {
        Some(json!({"schemaVersion":1,"arrivalUnix":self.stamp?,"week":self.week,"tow":self.tow,
            if self.kind=="NTRIP" {"streams"} else {"products"}: self.rows.values().cloned().collect::<Vec<_>>()}))
    }

    /// Returns the completed previous second. snapshot() also exposes the current native group.
    pub fn line(&mut self, line: &str) -> Result<Option<Value>, String> {
        if line.starts_with('#') {
            if line.split_whitespace().any(|v|v.starts_with("StatusLog=")) {
                if !line.split_whitespace().any(|v|v=="StatusLog=1") ||
                    !line.split_whitespace().any(|v|v==format!("Kind={}",self.kind)) {
                    return Err(format!("{} 状态日志协议不匹配，需要 StatusLog=1",self.kind));
                }
                self.version=true;
            }
            if line.starts_with("# Unix ") {
                self.columns=line[2..].split_whitespace().map(String::from).collect();
                if self.columns.iter().collect::<HashSet<_>>().len()!=self.columns.len() {return Err("状态日志列名重复".into());}
            }
            if line.trim()=="# END OF HEADER" {
                let required=if self.kind=="NTRIP" {
                    "Unix Role State Error HTTP Attempts Bytes Frames HAS LastArrival Queued Committed Dropped"
                } else {"Unix Week TOW Component System Decoded Fresh Signals ProductWeek ProductTOW Age"};
                if !self.version || required.split_whitespace().any(|k|!self.columns.iter().any(|c|c==k)) {
                    return Err(format!("{} 状态日志文件头不完整",self.kind));
                }
                self.ended=true;
            }
            return Ok(None);
        }
        if line.trim().is_empty() {return Ok(None);}
        if !self.ended {return Err("状态日志数据出现在完整文件头之前".into());}
        let parts:Vec<_>=line.split_whitespace().collect();
        if parts.len()!=self.columns.len() {return Err(format!("{} 状态日志列数不匹配",self.kind));}
        let fields:HashMap<_,_>=self.columns.iter().map(String::as_str).zip(parts).collect();
        let uint=|key:&str|fields.get(key).and_then(|v|v.parse::<u64>().ok()).ok_or_else(||format!("状态日志 {key} 无效"));
        let finite=|key:&str|fields.get(key).and_then(|v|v.parse::<f64>().ok()).filter(|v|v.is_finite()).ok_or_else(||format!("状态日志 {key} 无效"));
        let stamp=fields["Unix"].parse::<i64>().ok().filter(|s|*s>0&&chrono::DateTime::from_timestamp(*s,0).is_some()).ok_or("状态日志 Unix 无效")?;
        if self.stamp.is_some_and(|t|stamp<t) {return Err("状态日志时间倒退，请分开不同会话".into());}
        let (key,row,week,tow)=if self.kind=="NTRIP" {
            let role=fields["Role"];
            if !["ROVE","BASE","PRODUCT","BIAS","ATMO"].contains(&role) {return Err("未知 Ntrip 流角色".into());}
            let state=uint("State")?;let http=uint("HTTP")?;
            if state>3 || (http!=0&&!(100..=599).contains(&http)) {return Err("Ntrip 状态或 HTTP 码无效".into());}
            let attempts=uint("Attempts")?;
            let error=fields["Error"].parse::<i64>().map_err(|_|"Ntrip 错误码无效")?;
            (role.to_string(),json!({"role":role,"state":state,"errorCode":error,"httpStatus":http,
                "attempts":attempts,"reconnects":attempts.saturating_sub(1),"bytes":uint("Bytes")?,"frames":uint("Frames")?,
                "hasPages":uint("HAS")?,"lastArrival":uint("LastArrival")?,"queued":uint("Queued")?,
                "committed":uint("Committed")?,"dropped":uint("Dropped")?}),None,None)
        } else {
            let component=fields["Component"];
            if !["orbit","clock","code","phase"].contains(&component) {return Err("未知产品状态组件".into());}
            let week=uint("Week")?;let tow=finite("TOW")?;let product_week=uint("ProductWeek")?;let product_tow=finite("ProductTOW")?;
            if week==0||week>u32::MAX as u64||product_week==0||!(0. ..604800.).contains(&tow)||!(0. ..604800.).contains(&product_tow) {
                return Err("产品状态 GPST 无效".into());
            }
            let decoded=uint("Decoded")?;let fresh=uint("Fresh")?;
            if fresh>decoded {return Err("产品状态有效数量超过记录数量".into());}
            (format!("{component}:{}",fields["System"]),json!({"component":component,"system":fields["System"],
                "decoded":decoded,"fresh":fresh,"signals":uint("Signals")?,"week":product_week,"tow":product_tow,"age":finite("Age")?}),
                Some(week as u32),Some(tow))
        };
        let finished=if self.stamp!=Some(stamp) {let previous=self.snapshot();self.rows.clear();previous} else {None};
        self.stamp=Some(stamp);self.week=week;self.tow=tow;self.rows.insert(key,row);
        Ok(finished)
    }
}

pub fn heartbeat(ntrip:&Parser,product:&Parser)->Value {
    let n=ntrip.snapshot();let p=product.snapshot();
    if n.is_none()&&p.is_none(){return Value::Null;}
    json!({"schemaVersion":1,"arrivalUnix":n.as_ref().or(p.as_ref()).unwrap()["arrivalUnix"],
        "streamUnix":n.as_ref().map(|v|v["arrivalUnix"].clone()),"productUnix":p.as_ref().map(|v|v["arrivalUnix"].clone()),
        "week":p.as_ref().map(|v|v["week"].clone()),"tow":p.as_ref().map(|v|v["tow"].clone()),
        "streams":n.map(|v|v["streams"].clone()).unwrap_or_else(||json!([])),
        "products":p.map(|v|v["products"].clone()).unwrap_or_else(||json!([]))})
}

pub fn find(root:&Path,kind:&str)->Option<PathBuf> {
    let mut entries:Vec<_>=fs::read_dir(root).ok()?.flatten().map(|e|e.path()).collect();entries.sort();
    for p in entries {
        if p.is_dir(){if let Some(found)=find(&p,kind){return Some(found);}}
        else if p.file_name().is_some_and(|n|n.to_string_lossy().starts_with(&format!("{kind}_")))&&p.extension().is_some_and(|e|e=="log") {return Some(p);}
    }
    None
}

fn read_file(path:&Path,kind:&'static str)->Result<(Parser,Vec<Value>),String> {
    if fs::metadata(path).map_err(|e|e.to_string())?.len()>256*1024*1024 {return Err("状态日志超过 256 MiB".into());}
    let mut parser=Parser::new(kind);let mut history=Vec::new();
    let mut reader=BufReader::new(fs::File::open(path).map_err(|e|e.to_string())?);
    let mut line=String::new();
    loop {
        line.clear();if reader.read_line(&mut line).map_err(|e|e.to_string())?==0 {break;}
        if line.len()>65536 {return Err("状态日志单行超过 64 KiB".into());}
        if !line.ends_with('\n') {break;}
        if let Some(snapshot)=parser.line(line.trim_end_matches(['\r','\n']))? {
            if kind=="PRODUCT" {if let Some(metric)=crate::results::product_metric(&snapshot){history.push(metric);}}
        }
    }
    if kind=="PRODUCT" {if let Some(metric)=parser.snapshot().and_then(|v|crate::results::product_metric(&v)){history.push(metric);}}
    Ok((parser,history))
}

pub struct Archive {
    pub ntrip_path: Option<String>,
    pub product_path: Option<String>,
    pub heartbeat: Value,
    pub product_history: Vec<Value>,
}

/// Import both original client files, including the final receive state; never synthesize stream records.
pub fn archive(root:&Path)->Result<Archive,String> {
    let ntrip=find(root,"NTRIP");let product=find(root,"PRODUCT");
    let n=if let Some(path)=&ntrip {read_file(path,"NTRIP")?.0}else{Parser::new("NTRIP")};
    let (p,history)=if let Some(path)=&product {read_file(path,"PRODUCT")?}else{(Parser::new("PRODUCT"),vec![])};
    Ok(Archive{ntrip_path:ntrip.as_deref().map(crate::options::display_path),
        product_path:product.as_deref().map(crate::options::display_path),heartbeat:heartbeat(&n,&p),product_history:history})
}

#[cfg(test)]mod tests {
    use super::*;
    fn parser(kind:&'static str,cols:&str)->Parser {
        let mut p=Parser::new(kind);p.line(&format!("# IPSClient StatusLog=1 Kind={kind}")).unwrap();
        p.line(&format!("# {cols}")).unwrap();p.line("# END OF HEADER").unwrap();p
    }
    #[test]fn groups_roles_without_inventing_arrival_or_products() {
        let mut n=parser("NTRIP","Unix Role State Error HTTP Attempts Bytes Frames HAS LastArrival Queued Committed Dropped");
        n.line("1792579200 ROVE 2 0 0 1 0 0 0 0 0 0 0").unwrap();
        n.line("1792579200 BASE 3 5 404 2 10 1 0 1792579100 0 0 0").unwrap();
        let h=heartbeat(&n,&Parser::new("PRODUCT"));assert_eq!(h["streams"].as_array().unwrap().len(),2);
        assert!(h["products"].as_array().unwrap().is_empty());assert!(h["week"].is_null());
        assert_eq!(n.snapshot().unwrap()["streams"][1]["lastArrival"],0);
        n.line("1792579201 ROVE 2 0 0 2 10 1 0 1792579100 0 0 0").unwrap();
        assert_eq!(n.snapshot().unwrap()["streams"].as_array().unwrap().len(),1);
    }
    #[test]fn product_signed_age_and_final_same_second_rows_remain_native() {
        let mut p=parser("PRODUCT","Unix Week TOW Component System Decoded Fresh Signals ProductWeek ProductTOW Age");
        p.line("1792579200 2441 300 orbit GPS 8 0 0 2441 302 -2").unwrap();
        p.line("1792579200 2441 300 clock GAL 5 5 0 2441 299 1").unwrap();
        p.line("1792579200 2441 300 orbit GPS 8 3 0 2441 300 0").unwrap();
        let m=crate::results::product_metric(&p.snapshot().unwrap()).unwrap();assert_eq!(m["orbit"],3);
        assert_eq!(p.snapshot().unwrap()["products"].as_array().unwrap().len(),2);
        assert!(p.line("1792579201 2441 300 orbit GPS 2 3 0 2441 300 0").is_err());
    }
}
