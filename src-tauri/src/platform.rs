use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub const SOLVER: &str = if cfg!(windows) { "IPSPOS.exe" } else { "IPSPOS" };
pub const CLIENT: &str = if cfg!(windows) { "IPSClient.exe" } else { "IPSClient" };
pub const TARGET: &str = if cfg!(windows) { "windows-x64" } else { "linux-x64" };

pub fn engine_resources(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.to_path_buf()
    } else {
        root.join("linux-x64")
    }
}

pub fn python(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) { "python.exe" } else { "bin/python3" })
}

pub fn prepare(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as i32;
        command.process_group(0);
        // Stop the direct child even if the desktop process crashes before dropping its job.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
                }
                Ok(())
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resources_follow_the_native_platform() {
        let root = Path::new("resources");
        assert!(python(root).ends_with(if cfg!(windows) { "python.exe" } else { "bin/python3" }));
        assert_eq!(SOLVER.ends_with(".exe"), cfg!(windows));
        assert_eq!(CLIENT.ends_with(".exe"), cfg!(windows));
    }
}
