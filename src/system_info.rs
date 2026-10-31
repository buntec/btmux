//! `GET /api/system`: a fastfetch-style report of the server host.
use std::net::IpAddr;
use std::process::Stdio;
use std::time::Duration;

use axum::{extract::State, Json};
use serde::Serialize;
use sysinfo::{Disks, Networks, Product, System};

use crate::AppState;

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct SystemInfo {
    pub user: Option<String>,
    pub host_name: Option<String>,
    /// "macOS 26.0 Tahoe", "Ubuntu 24.04 LTS".
    pub os: Option<String>,
    /// `ID` from os-release, or "macos"/"windows".
    pub os_id: String,
    pub arch: String,
    /// Hardware vendor and model.
    pub model: Option<String>,
    pub kernel: Option<String>,
    #[cfg_attr(test, ts(type = "number"))]
    pub uptime: u64,
    /// The shell new panes run, with its version when it reports one.
    pub shell: String,
    pub cpu: Option<CpuInfo>,
    pub memory: Usage,
    pub swap: Usage,
    pub disks: Vec<DiskInfo>,
    pub addresses: Vec<Address>,
    /// 1, 5, and 15 minute load; `null` where the OS has none.
    pub load: Option<[f64; 3]>,
    pub processes: usize,
    pub locale: Option<String>,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct CpuInfo {
    pub brand: String,
    pub threads: usize,
    pub cores: Option<usize>,
    #[cfg_attr(test, ts(type = "number"))]
    pub mhz: u64,
}

/// Bytes.
#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Usage {
    #[cfg_attr(test, ts(type = "number"))]
    pub used: u64,
    #[cfg_attr(test, ts(type = "number"))]
    pub total: u64,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DiskInfo {
    pub mount: String,
    pub file_system: String,
    pub usage: Usage,
    pub removable: bool,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Address {
    pub interface: String,
    /// CIDR notation.
    pub address: String,
}

pub async fn handle(State(state): State<AppState>) -> Json<SystemInfo> {
    Json(report(&state).await)
}

/// Shared by `GET /api/system` and the `system_info` MCP tool.
pub async fn report(state: &AppState) -> SystemInfo {
    let shell = state.read().await.shell().to_string();
    let (shell, info) = tokio::join!(shell_version(shell), tokio::task::spawn_blocking(collect));
    let mut info = info.expect("system info task panicked");
    info.shell = shell;
    info
}

fn collect() -> SystemInfo {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing().with_frequency());
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        false,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    let cpu = sys.cpus().first().map(|cpu| CpuInfo {
        brand: cpu.brand().trim().to_string(),
        threads: sys.cpus().len(),
        cores: System::physical_core_count(),
        mhz: cpu.frequency(),
    });
    let load = (!cfg!(windows)).then(|| {
        let load = System::load_average();
        [load.one, load.five, load.fifteen]
    });
    SystemInfo {
        user: std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .ok(),
        host_name: System::host_name(),
        os: System::long_os_version(),
        os_id: System::distribution_id(),
        arch: System::cpu_arch(),
        model: model(),
        kernel: System::kernel_version().map(|version| match System::name() {
            Some(name) if !cfg!(target_os = "linux") => format!("{name} {version}"),
            _ => format!("Linux {version}"),
        }),
        uptime: System::uptime(),
        shell: String::new(),
        cpu,
        memory: Usage {
            used: sys.used_memory(),
            total: sys.total_memory(),
        },
        swap: Usage {
            used: sys.used_swap(),
            total: sys.total_swap(),
        },
        disks: disks(),
        addresses: addresses(),
        load,
        processes: sys.processes().len(),
        locale: ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .find_map(|var| std::env::var(var).ok().filter(|v| !v.is_empty())),
    }
}

fn model() -> Option<String> {
    #[cfg(target_os = "macos")]
    if let Some(name) = mac_product_name() {
        return Some(name);
    }
    let name = Product::name().filter(|name| !placeholder(name))?;
    let vendor = Product::vendor_name()
        .filter(|vendor| !placeholder(vendor))
        .map(|vendor| vendor.trim_end_matches(" Inc.").to_string());
    let version = Product::version().filter(|v| !placeholder(v) && v != &name);
    let mut model = match vendor {
        Some(vendor) if !name.starts_with(&vendor) => format!("{vendor} {name}"),
        _ => name,
    };
    if let Some(version) = version {
        model = format!("{model} ({version})");
    }
    Some(model)
}

/// "MacBook Pro (16-inch, M5 Pro)"; Apple silicon only. sysinfo reports `hw.model` ("Mac17,8").
#[cfg(target_os = "macos")]
fn mac_product_name() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/ioreg")
        .args([
            "-p",
            "IODeviceTree",
            "-rn",
            "product",
            "-d1",
            "-k",
            "product-name",
        ])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let output = String::from_utf8_lossy(&output.stdout);
    let line = output
        .lines()
        .find(|line| line.contains("\"product-name\""))?;
    let name = line.split_once("<\"")?.1.rsplit_once("\">")?.0;
    (!name.is_empty()).then(|| name.to_string())
}

/// Firmware filler such as "To Be Filled By O.E.M.".
fn placeholder(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.is_empty()
        || value.contains("o.e.m")
        || value.contains("default string")
        || value.contains("system product name")
        || value.contains("not applicable")
        || value == "none"
}

fn disks() -> Vec<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();
    let mut seen = Vec::new();
    let mut list: Vec<_> = disks
        .list()
        .iter()
        .filter(|disk| disk.total_space() > 0)
        .filter(|disk| {
            let mount = disk.mount_point().to_string_lossy();
            ![
                "/System/Volumes/",
                "/boot",
                "/nix/store",
                "/snap/",
                "/var/lib/snapd",
            ]
            .iter()
            .any(|hidden| mount.starts_with(hidden))
        })
        .collect();
    list.sort_by_key(|disk| disk.mount_point().as_os_str().len());
    // A device mounted twice (bind mounts) counts once, at its shortest path.
    list.retain(|disk| {
        let new = !seen.contains(&disk.name());
        seen.push(disk.name());
        new || disk.name().is_empty()
    });
    list.into_iter()
        .map(|disk| DiskInfo {
            mount: disk.mount_point().to_string_lossy().into_owned(),
            file_system: disk.file_system().to_string_lossy().into_owned(),
            // APFS volumes share their container's free space.
            usage: Usage {
                used: disk.total_space().saturating_sub(disk.available_space()),
                total: disk.total_space(),
            },
            removable: disk.is_removable(),
        })
        .collect()
}

fn addresses() -> Vec<Address> {
    let networks = Networks::new_with_refreshed_list();
    let mut list: Vec<_> = networks
        .iter()
        .flat_map(|(interface, data)| {
            data.ip_networks()
                .iter()
                .filter_map(move |net| match net.addr {
                    IpAddr::V4(addr) if !addr.is_loopback() && !addr.is_link_local() => {
                        Some(Address {
                            interface: interface.clone(),
                            address: format!("{addr}/{}", net.prefix),
                        })
                    }
                    _ => None,
                })
        })
        .collect();
    list.sort_by(|a, b| a.interface.cmp(&b.interface));
    list
}

/// "zsh 5.9", or the program name if it reports no version within a second.
async fn shell_version(shell: String) -> String {
    let argv = crate::shell::argv(&shell);
    let Some(program) = argv.first() else {
        return shell;
    };
    let name = std::path::Path::new(program)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.clone());
    // cmd and wsl.exe don't take `--version`.
    if !matches!(
        crate::shell::Dialect::of(&shell),
        crate::shell::Dialect::Posix | crate::shell::Dialect::PowerShell
    ) {
        return name;
    }
    let output = tokio::process::Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(1), output).await {
        Ok(Ok(output)) => match version(&String::from_utf8_lossy(&output.stdout)) {
            Some(version) => format!("{name} {version}"),
            None => name,
        },
        _ => name,
    }
}

fn version(output: &str) -> Option<&str> {
    let line = output.lines().next()?;
    let re = regex::Regex::new(r"\d+(\.\d+)+").unwrap();
    re.find(line).map(|m| m.as_str())
}

#[cfg(test)]
mod tests {
    use super::version;

    #[test]
    fn parses_shell_versions() {
        assert_eq!(version("zsh 5.9 (arm64-apple-darwin25.0)\n"), Some("5.9"));
        assert_eq!(
            version("GNU bash, version 5.2.37(1)-release (aarch64-apple-darwin24)\nCopyright"),
            Some("5.2.37")
        );
        assert_eq!(version("fish, version 4.0.2"), Some("4.0.2"));
        assert_eq!(version("0.101.0"), Some("0.101.0"));
        assert_eq!(version("PowerShell 7.4.6"), Some("7.4.6"));
        assert_eq!(version("usage: sh"), None);
    }
}
