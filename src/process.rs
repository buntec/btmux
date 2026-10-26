//! Process groups, names, and working directories across platforms.
//!
//! Windows has no process groups: a pane's "group" is the shell's child that
//! runs a process (or the shell itself), and its foreground group is the
//! shell's newest child.

pub type Pid = i32;

/// Process group of `pid`.
#[cfg(unix)]
pub fn group(pid: Pid) -> Option<Pid> {
    match unsafe { libc::getpgid(pid) } {
        group if group > 0 => Some(group),
        _ => None,
    }
}

/// Name of `pid`'s executable.
#[cfg(target_os = "linux")]
pub fn name(pid: Pid) -> Option<String> {
    let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    Some(name.trim_end().to_string())
}

#[cfg(target_os = "macos")]
pub fn name(pid: Pid) -> Option<String> {
    let mut name = [0u8; 64];
    let len = unsafe { libc::proc_name(pid, name.as_mut_ptr().cast(), name.len() as u32) };
    (len > 0).then(|| String::from_utf8_lossy(&name[..len as usize]).into_owned())
}

/// Working directory of `pid`.
#[cfg(target_os = "linux")]
pub fn cwd(pid: Pid) -> Option<std::path::PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
pub fn cwd(pid: Pid) -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    if read != size {
        return None;
    }
    let path: Vec<u8> = info
        .pvi_cdir
        .vip_path
        .as_flattened()
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    (!path.is_empty()).then(|| std::ffi::OsString::from_vec(path).into())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn name(_pid: Pid) -> Option<String> {
    None
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
pub fn cwd(_pid: Pid) -> Option<std::path::PathBuf> {
    None
}

/// Process group of `pid`: its ancestor (or itself) whose parent is a shell
/// this server started, else the shell itself.
#[cfg(windows)]
pub fn group(pid: Pid) -> Option<Pid> {
    let server = std::process::id() as Pid;
    let parents = windows::parents();
    let mut current = pid;
    for _ in 0..64 {
        let parent = *parents.get(&current)?;
        if parent == server {
            return Some(current);
        }
        if parents.get(&parent) == Some(&server) {
            return Some(current);
        }
        current = parent;
    }
    None
}

/// Foreground process group of the terminal whose shell is `shell`.
#[cfg(windows)]
pub fn foreground(shell: Pid) -> Option<Pid> {
    let children: Vec<Pid> = windows::parents()
        .into_iter()
        .filter(|&(_, parent)| parent == shell)
        .map(|(pid, _)| pid)
        .collect();
    children
        .into_iter()
        .filter_map(|pid| Some((windows::start_time(pid)?, pid)))
        .max()
        .map(|(_, pid)| pid)
        .or(Some(shell))
}

/// Name of `pid`'s executable, without `.exe`.
#[cfg(windows)]
pub fn name(pid: Pid) -> Option<String> {
    let name = windows::name(pid)?;
    Some(
        std::path::Path::new(&name)
            .file_stem()?
            .to_string_lossy()
            .into_owned(),
    )
}

/// Block until `pid` exits; returns at once if it can't be watched.
#[cfg(windows)]
pub fn wait_exit(pid: Pid) {
    windows::wait_exit(pid);
}

#[cfg(windows)]
mod windows {
    use super::Pid;
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, INFINITE,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    /// Calls `f` with every running process.
    fn each_process(mut f: impl FnMut(&PROCESSENTRY32W)) {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snapshot, &mut entry);
            while ok != 0 {
                f(&entry);
                ok = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
        }
    }

    /// Parent of every running process.
    pub fn parents() -> HashMap<Pid, Pid> {
        let mut parents = HashMap::new();
        each_process(|entry| {
            parents.insert(entry.th32ProcessID as Pid, entry.th32ParentProcessID as Pid);
        });
        parents
    }

    pub fn name(pid: Pid) -> Option<String> {
        let mut name = None;
        each_process(|entry| {
            if entry.th32ProcessID as Pid == pid {
                let exe = &entry.szExeFile;
                let len = exe.iter().position(|&c| c == 0).unwrap_or(exe.len());
                name = Some(String::from_utf16_lossy(&exe[..len]));
            }
        });
        name
    }

    pub fn wait_exit(pid: Pid) {
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid as u32);
            if !handle.is_null() {
                WaitForSingleObject(handle, INFINITE);
                CloseHandle(handle);
            }
        }
    }

    pub fn start_time(pid: Pid) -> Option<u64> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            if handle.is_null() {
                return None;
            }
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
            CloseHandle(handle);
            (ok != 0)
                .then_some((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64)
        }
    }
}
