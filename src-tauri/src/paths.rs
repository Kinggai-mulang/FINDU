use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePaths {
    pub workspace: String,
    pub root: String,
    pub postprocess: String,
    pub realtime: String,
    pub cache: String,
    pub logs: String,
}

pub fn workspace(exe: &Path) -> PathBuf {
    let parent = exe.parent().expect("executable parent");
    if parent.file_name().is_some_and(|n| n == "deliverables") {
        return parent.parent().unwrap_or(parent).to_path_buf();
    }
    // Development binaries live under this checkout; portable copies resolve beside their exe.
    if parent
        .file_name()
        .is_some_and(|n| n == "debug" || n == "release")
        && parent
            .parent()
            .is_some_and(|p| p.file_name().is_some_and(|n| n == "target"))
    {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
    }
    parent.to_path_buf()
}
impl RuntimePaths {
    pub fn new(workspace: PathBuf) -> Result<Self, String> {
        let root = workspace.join("runtime");
        for folder in [
            "downloads",
            "cache/products",
            "postprocess",
            "realtime",
            "cache/webview",
            "cache/temp",
            "logs",
            "config",
            "exports",
        ] {
            std::fs::create_dir_all(root.join(folder))
                .map_err(|e| format!("本地运行目录不可写：{e}"))?;
        }
        Ok(Self {
            workspace: crate::options::display_path(&workspace),
            root: crate::options::display_path(&root),
            postprocess: crate::options::display_path(&root.join("postprocess")),
            realtime: crate::options::display_path(&root.join("realtime")),
            cache: crate::options::display_path(&root.join("cache")),
            logs: crate::options::display_path(&root.join("logs")),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_root_follows_the_program() {
        assert_eq!(
            workspace(Path::new("D:/apps/FINDYOU/deliverables/FINDYOU.exe")),
            PathBuf::from("D:/apps/FINDYOU")
        );
        assert_eq!(
            workspace(Path::new("D:/portable/FINDYOU.exe")),
            PathBuf::from("D:/portable")
        );
    }
}
