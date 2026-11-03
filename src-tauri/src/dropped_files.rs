//! Folders dropped on a file box are replaced by the files inside them, so a whole product folder can be dropped at
//! once. Only listing: nothing is opened or read.
use std::fs;
use std::path::Path;

const MAX_DEPTH: usize = 4;
const MAX_FILES: usize = 2000;

fn collect(dir: &Path, depth: usize, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            if depth < MAX_DEPTH {
                collect(&path, depth + 1, out);
            }
        } else if path.is_file() {
            out.push(crate::options::display_path(&path));
        }
    }
}

/// The given paths with every folder replaced by the files in it (to a depth of four, at most 2000 files).
pub fn expand(paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for path in paths {
        if Path::new(path).is_dir() {
            collect(Path::new(path), 0, &mut out);
        } else {
            out.push(path.clone());
        }
    }
    out
}

#[tauri::command]
pub fn expand_dropped_paths(paths: Vec<String>) -> Vec<String> {
    expand(&paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_become_their_files_and_plain_paths_stay() {
        let dir = std::env::temp_dir().join(format!("dropped-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("inner")).unwrap();
        fs::write(dir.join("b.bia"), b"x").unwrap();
        fs::write(dir.join("a.sp3"), b"x").unwrap();
        fs::write(dir.join("inner").join("c.clk"), b"x").unwrap();
        let single = dir.join("a.sp3").to_string_lossy().into_owned();
        let all = expand(&[dir.to_string_lossy().into_owned(), "elsewhere/x.rnx".into(), single.clone()]);
        let names: Vec<&str> = all.iter().map(|p| p.rsplit(['/', '\\']).next().unwrap()).collect();
        assert_eq!(names, ["a.sp3", "b.bia", "c.clk", "x.rnx", "a.sp3"], "{all:?}");
        assert_eq!(
            expand(&["missing-folder".into()]),
            ["missing-folder"],
            "what is not a folder is passed through"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_huge_folder_is_cut_off() {
        let dir = std::env::temp_dir().join(format!("dropped-many-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        for i in 0..(MAX_FILES + 5) {
            fs::write(dir.join(format!("f{i:05}.dat")), b"").unwrap();
        }
        assert_eq!(expand(&[dir.to_string_lossy().into_owned()]).len(), MAX_FILES);
        fs::remove_dir_all(dir).unwrap();
    }
}
