use serde::Deserialize;
use std::sync::LazyLock;
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Capacity {pub realtime_runs:usize,pub realtime_records:usize,pub comparison_results:usize,pub postprocess_runs:usize}
pub static LIMITS:LazyLock<Capacity>=LazyLock::new(||serde_json::from_str(include_str!("../../contracts/capacity.json")).expect("valid bundled capacity settings"));
pub fn live_admission(running:usize,retained:usize,is_new:bool)->Result<(),String>{
 if running>=LIMITS.realtime_runs{return Err(format!("最多同时运行 {} 路，请先停止其它会话",LIMITS.realtime_runs));}
 if is_new&&retained>=LIMITS.realtime_records{return Err(format!("最多保留 {} 路记录，请先移除已结束会话",LIMITS.realtime_records));}
 Ok(())
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn live_boundaries_allow_sixteen_and_reject_seventeen(){assert!(live_admission(15,15,true).is_ok());assert!(live_admission(16,16,true).unwrap_err().contains("16"));assert!(live_admission(0,16,false).is_ok());assert!(live_admission(0,16,true).is_err());}
}
