//! Incremental, bounded readers for files still being appended by IPSClient.
use crate::results::{enu, quality_name, RealEpoch};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

#[derive(Default)]
pub struct LineTail {
    offset: u64,
    pending: Vec<u8>,
    prefix: Vec<u8>,
    anchor: Vec<u8>,
}
impl LineTail {
    pub fn read(&mut self, path: &Path) -> Result<(bool, Vec<String>), String> {
        let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
        let len = f.metadata().map_err(|e| e.to_string())?.len();
        let mut prefix = vec![0; len.min(64) as usize];
        f.read_exact(&mut prefix).map_err(|e| e.to_string())?;
        let mut replaced = false;
        if self.offset >= self.anchor.len() as u64 && len >= self.offset && !self.anchor.is_empty()
        {
            f.seek(SeekFrom::Start(self.offset - self.anchor.len() as u64))
                .map_err(|e| e.to_string())?;
            let mut anchor = vec![0; self.anchor.len()];
            f.read_exact(&mut anchor).map_err(|e| e.to_string())?;
            replaced = anchor != self.anchor;
        }
        let reset = len < self.offset
            || (!self.prefix.is_empty() && !prefix.starts_with(&self.prefix))
            || replaced;
        if reset {
            *self = Self::default();
        }
        self.prefix = prefix;
        f.seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![];
        Read::by_ref(&mut f)
            .take(1_048_576)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        self.offset += bytes.len() as u64;
        let anchor_len = self.offset.min(64) as usize;
        f.seek(SeekFrom::Start(self.offset - anchor_len as u64))
            .map_err(|e| e.to_string())?;
        self.anchor = vec![0; anchor_len];
        f.read_exact(&mut self.anchor).map_err(|e| e.to_string())?;
        self.pending.extend(bytes);
        let end = self
            .pending
            .iter()
            .rposition(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let lines = String::from_utf8_lossy(&self.pending[..end])
            .lines()
            .map(String::from)
            .collect();
        self.pending.drain(..end);
        if self.pending.len() > 65536 {
            self.pending.clear();
            return Err("实时文件单行超过 64 KiB".into());
        }
        Ok((reset, lines))
    }
}

#[derive(Default)]
pub struct LiveLog {
    pub header: crate::gnss_log::Header,
    pub origin: Option<[f64; 3]>,
    last_gps: Option<f64>,
}
impl LiveLog {
    pub fn line(&mut self, line: &str) -> Result<Option<(Option<RealEpoch>, Value)>, String> {
        if line.starts_with('#') {self.header.line(line)?;return Ok(None);}
        if line.trim().is_empty() {return Ok(None);}
        let fields=self.header.fields(line)?;
        let n=|key:&str|fields.get(key).and_then(|v|crate::gnss_log::number(key,v));
        let mut value=crate::results::diagnostic(&fields)?;
        value["solutionMode"]=serde_json::json!(self.header.mode);
        value["logVersion"]=serde_json::json!(4);
        let utc=value["time"].as_str().ok_or("实时 UTC 无效")?.to_string();
        let q=fields["Q"].parse::<u8>().map_err(|_|"实时 Q 无效")?;
        let mut epoch=None;
        if let (Some(x),Some(y),Some(z))=(n("X"),n("Y"),n("Z")) {
            let xyz=[x,y,z];
            if matches!(q,1|2|4|5|6|7|8) && xyz.iter().map(|n|n*n).sum::<f64>().sqrt()>1e6 {
                let week=n("Week").ok_or("缺少 Week")?;
                let tow=n("TOW").ok_or("缺少 TOW")?;
                let gps=week*604800.+tow;
                if self.last_gps.is_some_and(|t|gps<t) {return Err("实时日志历元倒退，请分开不同会话".into());}
                if self.last_gps.is_none_or(|t|gps>t) {
                    self.last_gps=Some(gps);
                    let origin=*self.origin.get_or_insert(xyz);
                    let [e,north,u]=enu(xyz,origin);
                    epoch=Some(RealEpoch{time:utc,e,n:north,u,x,y,z,
                        satellites:n("FloUse").or_else(||n("SppS")).unwrap_or(0.) as i32,
                        solution:quality_name(q).into(),raw_quality:q,gps_week:week as u32,tow});
                }
            }
        }
        Ok(Some((epoch,value)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn append_partial_truncate_and_replacement() {
        let p = std::env::temp_dir().join(format!("tail-{}", uuid::Uuid::new_v4()));
        let mut t = LineTail::default();
        fs::write(&p, "first\npar").unwrap();
        assert_eq!(t.read(&p).unwrap().1, vec!["first"]);
        fs::write(&p, "first\npartial\n").unwrap();
        assert_eq!(t.read(&p).unwrap().1, vec!["partial"]);
        assert!(t.read(&p).unwrap().1.is_empty());
        fs::write(&p, "new\n").unwrap();
        let (reset, lines) = t.read(&p).unwrap();
        assert!(reset);
        assert_eq!(lines, vec!["new"]);
        fs::remove_file(p).unwrap();
    }
    #[test]
    fn metrics_preserve_unknown_and_origin_is_stable() {
        let mut p = LiveLog::default();
        p.line("# Program: IPSPOS Log=4").unwrap();p.line("# Mode : PPP").unwrap();
        p.line("#Week TOW UTC X Y Z Q FloUse Ratio Obs").unwrap();p.line("# END OF HEADER").unwrap();
        let (_, m) = p
            .line("2438 1 20261001000000.00 0 0 0 0 -99999999 -99999999 12")
            .unwrap()
            .unwrap();
        assert!(m["Ratio"].is_null());
        assert_eq!(m["Obs"], 12.);
        p.line("2438 2 20261001000001.00 6378137 0 0 7 10 4 12")
            .unwrap();
        let (e, _) = p
            .line("2438 3 20261001000002.00 6378138 2 3 8 11 5 13")
            .unwrap()
            .unwrap();
        let e = e.unwrap();
        assert_eq!([e.e, e.n, e.u], [2., 3., 1.]);
        assert_eq!(e.solution, "HOLD");
    }
    #[test]
    fn a_missing_coordinate_cannot_be_replaced_with_zero(){
        let mut p=LiveLog::default();p.line("# Program: IPSPOS Log=4").unwrap();p.line("# Mode : RTK").unwrap();p.line("#Week TOW UTC X Y Z Q VX").unwrap();p.line("# END OF HEADER").unwrap();
        let (e,m)=p.line("2438 1 20261001000000.00 6378137 -99999999.999 0 5 -999.999").unwrap().unwrap();
        assert!(e.is_none());assert!(m["Y"].is_null());assert!(m["VX"].is_null());
    }
}
