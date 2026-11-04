use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use netstat2::{iterate_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo};
use serde::{Deserialize, Serialize};
use sysinfo::{
    MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, Signal, System,
    Uid, UpdateKind, Users, MINIMUM_CPU_UPDATE_INTERVAL,
};
use tokio::time::{interval, sleep, Duration, MissedTickBehavior};
use uuid::Uuid;

use crate::AppState;

const REFRESH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Kill {
        pid: u32,
        /// Guards against PID reuse between snapshot and signal.
        start_time: u64,
        #[serde(default)]
        signal: KillSignal,
    },
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum KillSignal {
    #[default]
    Term,
    Kill,
}

#[derive(Debug, Serialize)]
struct ProcessInfo {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    command: String,
    cpu: f32,
    memory: u64,
    virtual_memory: u64,
    status: String,
    user: Option<String>,
    start_time: u64,
    run_time: u64,
    /// Bytes per second since the last refresh.
    disk_read: u64,
    disk_write: u64,
    pane_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PortInfo {
    pid: Option<u32>,
    protocol: String,
    local_address: String,
    local_port: u16,
    remote_address: Option<String>,
    state: String,
}

fn sample_ports() -> Result<Vec<PortInfo>, String> {
    let sockets = iterate_sockets_info(
        AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
        ProtocolFlags::TCP | ProtocolFlags::UDP,
    )
    .map_err(|error| format!("Could not read network ports: {error}"))?;
    let mut ports = Vec::new();
    // Processes can close sockets during enumeration.
    for socket in sockets.flatten() {
        let (protocol, local_address, local_port, remote_address, state) =
            match socket.protocol_socket_info {
                ProtocolSocketInfo::Tcp(tcp) => (
                    "TCP",
                    tcp.local_addr.to_string(),
                    tcp.local_port,
                    (tcp.remote_port != 0).then(|| {
                        std::net::SocketAddr::new(tcp.remote_addr, tcp.remote_port).to_string()
                    }),
                    tcp.state.to_string(),
                ),
                ProtocolSocketInfo::Udp(udp) => (
                    "UDP",
                    udp.local_addr.to_string(),
                    udp.local_port,
                    None,
                    "BOUND".to_string(),
                ),
            };
        if local_port == 0 {
            continue;
        }
        let mut pids = socket.associated_pids;
        pids.sort_unstable();
        pids.dedup();
        // Keep sockets whose owner is unavailable (permissions or process exit).
        let owners: Vec<_> = if pids.is_empty() {
            vec![None]
        } else {
            pids.into_iter().map(Some).collect()
        };
        for pid in owners {
            ports.push(PortInfo {
                pid,
                protocol: protocol.to_string(),
                local_address: local_address.clone(),
                local_port,
                remote_address: remote_address.clone(),
                state: state.clone(),
            });
        }
    }
    ports.sort_by(|a, b| {
        (
            a.local_port,
            &a.protocol,
            &a.local_address,
            &a.remote_address,
            a.pid,
        )
            .cmp(&(
                b.local_port,
                &b.protocol,
                &b.local_address,
                &b.remote_address,
                b.pid,
            ))
    });
    ports.dedup_by(|a, b| {
        a.pid == b.pid
            && a.protocol == b.protocol
            && a.local_address == b.local_address
            && a.local_port == b.local_port
            && a.remote_address == b.remote_address
    });
    Ok(ports)
}

#[derive(Debug, Serialize)]
struct ProcessSnapshot {
    #[serde(rename = "type")]
    message_type: &'static str,
    processes: Vec<ProcessInfo>,
    ports: Option<Vec<PortInfo>>,
    ports_error: Option<String>,
    cpu_count: usize,
    mem_used: u64,
    mem_total: u64,
    load_average: [f64; 3],
}

#[derive(Debug, Serialize)]
struct KillResult {
    #[serde(rename = "type")]
    message_type: &'static str,
    pid: u32,
    success: bool,
    message: String,
}

#[derive(Debug, Serialize)]
struct ErrorMessage {
    #[serde(rename = "type")]
    message_type: &'static str,
    message: String,
}

/// Resolves UIDs to user names, reloading the user list once per snapshot on a miss.
struct UserNames {
    users: Users,
    names: HashMap<Uid, String>,
}

impl UserNames {
    fn new() -> Result<Self, sysinfo::Error> {
        Ok(Self {
            users: Users::new_with_refreshed_list()?,
            names: HashMap::new(),
        })
    }

    fn resolve(&mut self, uid: &Uid, reloaded: &mut bool) -> String {
        if let Some(name) = self.names.get(uid) {
            return name.clone();
        }
        if self.users.get_user_by_id(uid).is_none() && !*reloaded {
            self.users.refresh();
            *reloaded = true;
        }
        let name = self
            .users
            .get_user_by_id(uid)
            .map(|user| user.name().to_string())
            .unwrap_or_else(|| uid.to_string());
        self.names.insert(uid.clone(), name.clone());
        name
    }
}

/// A process's parent and session.
type Link = (Option<u32>, Option<u32>);

/// The nearest ancestor that is a pane's shell, else the shell leading its
/// session (orphans reparented to init). Processes that call `setsid` and
/// reparent, like daemons, belong to no pane.
fn pane_owner(pid: u32, links: &HashMap<u32, Link>, shells: &HashMap<u32, Uuid>) -> Option<Uuid> {
    let mut current = pid;
    for _ in 0..64 {
        if let Some(&pane) = shells.get(&current) {
            return Some(pane);
        }
        match links.get(&current).and_then(|link| link.0) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    let session = links.get(&pid)?.1?;
    shells.get(&session).copied()
}

struct ProcessSampler {
    system: System,
    users: UserNames,
    refresh: ProcessRefreshKind,
    cpu_count: usize,
    last_refresh: Option<Instant>,
    /// Seconds between the last two refreshes.
    refresh_seconds: f64,
}

impl ProcessSampler {
    fn new() -> Result<Self, sysinfo::Error> {
        Ok(Self {
            system: System::new_with_specifics(
                RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
            )?,
            users: UserNames::new()?,
            last_refresh: None,
            refresh_seconds: 1.0,
            refresh: ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_disk_usage()
                .with_user(UpdateKind::OnlyIfNotSet)
                .with_cmd(UpdateKind::OnlyIfNotSet),
            // Per-process CPU% is relative to one logical CPU.
            cpu_count: std::thread::available_parallelism().map_or(1, usize::from),
        })
    }

    fn refresh(&mut self) {
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        self.system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, self.refresh);
        let now = Instant::now();
        if let Some(last) = self.last_refresh.replace(now) {
            // A command can refresh right after a tick; don't inflate its rate.
            self.refresh_seconds = (now - last)
                .as_secs_f64()
                .max(MINIMUM_CPU_UPDATE_INTERVAL.as_secs_f64());
        }
    }

    fn snapshot(&mut self, shells: &HashMap<u32, Uuid>) -> ProcessSnapshot {
        let mut users_reloaded = false;
        let links: HashMap<u32, Link> = self
            .system
            .processes()
            .values()
            .map(|process| {
                (
                    process.pid().as_u32(),
                    (
                        process.parent().map(Pid::as_u32),
                        process.session_id().map(Pid::as_u32),
                    ),
                )
            })
            .collect();
        let rate = |bytes: u64| (bytes as f64 / self.refresh_seconds) as u64;
        let processes = self
            .system
            .processes()
            .values()
            .map(|process| {
                let name = process.name().to_string_lossy().into_owned();
                let command = process
                    .cmd()
                    .iter()
                    .map(|part| part.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" ");
                let disk = process.disk_usage();
                ProcessInfo {
                    pid: process.pid().as_u32(),
                    parent_pid: process.parent().map(Pid::as_u32),
                    name: name.clone(),
                    command: if command.is_empty() { name } else { command },
                    cpu: process.cpu_usage(),
                    memory: process.memory(),
                    virtual_memory: process.virtual_memory(),
                    status: process.status().to_string(),
                    user: process
                        .user_id()
                        .map(|uid| self.users.resolve(uid, &mut users_reloaded)),
                    start_time: process.start_time(),
                    run_time: process.run_time(),
                    disk_read: rate(disk.read_bytes),
                    disk_write: rate(disk.written_bytes),
                    pane_id: pane_owner(process.pid().as_u32(), &links, shells),
                }
            })
            .collect();
        let (ports, ports_error) = match sample_ports() {
            Ok(ports) => (Some(ports), None),
            Err(error) => (None, Some(error)),
        };
        let load_average =
            System::load_average().map_or([0.0; 3], |load| [load.one, load.five, load.fifteen]);
        ProcessSnapshot {
            message_type: "snapshot",
            processes,
            ports,
            ports_error,
            cpu_count: self.cpu_count,
            mem_used: self.system.used_memory(),
            mem_total: self.system.total_memory(),
            load_average,
        }
    }

    fn kill(&mut self, pid: u32, start_time: u64, signal: KillSignal) -> KillResult {
        let result = |success: bool, message: &str| KillResult {
            message_type: "kill_result",
            pid,
            success,
            message: message.to_string(),
        };

        if pid == std::process::id() {
            return result(false, "Refusing to signal the btmux server");
        }
        if pid <= 1 {
            return result(false, "Refusing to signal the init process");
        }

        // Re-read this PID so a reused PID is detected by its start time.
        let target = Pid::from_u32(pid);
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[target]),
            true,
            ProcessRefreshKind::nothing(),
        );
        let Some(process) = self.system.process(target) else {
            return result(false, "Process no longer exists");
        };
        if process.start_time() != start_time {
            return result(false, "Process no longer exists (PID was reused)");
        }

        let (signal, sent) = match signal {
            KillSignal::Term => (Signal::Term, "Termination signal sent"),
            KillSignal::Kill => (Signal::Kill, "Kill signal sent"),
        };
        match process.kill_with(signal) {
            Some(true) => result(true, sent),
            Some(false) => result(false, "Could not signal process (permission denied?)"),
            None if process.kill() => result(true, "Kill signal sent"),
            None => result(false, "Could not signal process on this platform"),
        }
    }
}

type SharedSampler = Arc<Mutex<ProcessSampler>>;

/// Runs sysinfo work on the blocking pool; a full refresh can take tens of ms.
async fn with_sampler<T: Send + 'static>(
    sampler: &SharedSampler,
    f: impl FnOnce(&mut ProcessSampler) -> T + Send + 'static,
) -> Result<T, ()> {
    let sampler = sampler.clone();
    tokio::task::spawn_blocking(move || f(&mut sampler.lock().unwrap()))
        .await
        .map_err(|_| ())
}

async fn send_snapshot(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    sampler: &SharedSampler,
    state: &AppState,
) -> Result<(), ()> {
    let shells: HashMap<u32, Uuid> = state
        .read()
        .await
        .pane_shells()
        .into_iter()
        .map(|(pane, shell, _)| (shell, pane))
        .collect();
    let text = with_sampler(sampler, move |sampler| {
        sampler.refresh();
        serde_json::to_string(&sampler.snapshot(&shells))
    })
    .await?
    .map_err(|_| ())?;
    ws_tx.send(Message::Text(text.into())).await.map_err(|_| ())
}

pub async fn handle(State(state): State<AppState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let Ok(Ok(sampler)) =
        tokio::task::spawn_blocking(|| ProcessSampler::new().map(|s| Arc::new(Mutex::new(s))))
            .await
    else {
        return;
    };

    // CPU usage needs a baseline. On macOS a newly seen process only records
    // CPU times on its second refresh, so prime twice before waiting.
    let primed = with_sampler(&sampler, |sampler| {
        sampler.refresh();
        sampler.refresh();
    })
    .await;
    if primed.is_err() {
        return;
    }
    sleep(MINIMUM_CPU_UPDATE_INTERVAL).await;
    if send_snapshot(&mut ws_tx, &sampler, &state).await.is_err() {
        return;
    }

    let mut tick = interval(REFRESH_INTERVAL);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // `interval` ticks immediately on its first call; the initial snapshot was
    // sent above, so wait for the first complete measurement interval.
    tick.tick().await;

    loop {
        tokio::select! {
            _ = tick.tick() => {
                if send_snapshot(&mut ws_tx, &sampler, &state).await.is_err() {
                    break;
                }
            }
            message = ws_rx.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if handle_command(&mut ws_tx, &sampler, text.as_ref()).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

async fn handle_command(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    sampler: &SharedSampler,
    text: &str,
) -> Result<(), ()> {
    match serde_json::from_str::<ClientMessage>(text) {
        Ok(ClientMessage::Kill {
            pid,
            start_time,
            signal,
        }) => {
            let result = with_sampler(sampler, move |sampler| {
                sampler.kill(pid, start_time, signal)
            })
            .await?;
            send_json(ws_tx, &result).await
        }
        Err(error) => {
            let message = ErrorMessage {
                message_type: "error",
                message: format!("Invalid message: {error}"),
            };
            send_json(ws_tx, &message).await
        }
    }
}

async fn send_json<T: Serialize>(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &T,
) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    ws_tx.send(Message::Text(text.into())).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_include_tcp_listener_and_udp_owner() {
        let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let ports = sample_ports().unwrap();
        for (protocol, port, state) in [
            ("TCP", tcp.local_addr().unwrap().port(), "LISTEN"),
            ("UDP", udp.local_addr().unwrap().port(), "BOUND"),
        ] {
            let entry = ports
                .iter()
                .find(|entry| {
                    entry.protocol == protocol
                        && entry.local_port == port
                        && entry.pid == Some(std::process::id())
                })
                .unwrap_or_else(|| panic!("missing {protocol} port {port}"));
            assert_eq!(entry.local_address, "127.0.0.1");
            assert_eq!(entry.state, state);
            assert!(entry.remote_address.is_none());
        }
    }

    #[test]
    fn pane_owner_follows_ancestors_then_session() {
        let (pane, other) = (Uuid::new_v4(), Uuid::new_v4());
        let shells = HashMap::from([(10, pane), (20, other)]);
        let links = HashMap::from([
            (1, (None, Some(1))),
            (10, (Some(1), Some(10))),
            (11, (Some(10), Some(10))),
            (12, (Some(11), Some(10))),
            // A nested shell's session doesn't override its ancestry.
            (13, (Some(11), Some(20))),
            // Reparented to init.
            (14, (Some(1), Some(10))),
            // A daemon: its own session, under init.
            (15, (Some(1), Some(15))),
            (16, (Some(1), Some(1))),
        ]);
        let owner = |pid| pane_owner(pid, &links, &shells);
        for pid in [10, 11, 12, 13, 14] {
            assert_eq!(owner(pid), Some(pane), "pid {pid}");
        }
        for pid in [1, 15, 16, 99] {
            assert_eq!(owner(pid), None, "pid {pid}");
        }
    }

    #[test]
    fn pane_owner_stops_at_parent_cycles() {
        let links = HashMap::from([(5, (Some(6), None)), (6, (Some(5), None))]);
        assert_eq!(pane_owner(5, &links, &HashMap::new()), None);
    }

    #[test]
    fn snapshot_assigns_children_of_a_shell_to_its_pane() {
        let mut child = spawn_sleeper();
        let mut sampler = ProcessSampler::new().unwrap();
        sampler.refresh();
        let pane = Uuid::new_v4();
        let snapshot = sampler.snapshot(&HashMap::from([(std::process::id(), pane)]));
        let process = |pid| snapshot.processes.iter().find(|p| p.pid == pid).unwrap();
        assert_eq!(process(child.id()).pane_id, Some(pane));
        assert_eq!(process(std::process::id()).pane_id, Some(pane));
        assert!(snapshot.ports.is_some());
        child.kill().unwrap();
        child.wait().unwrap();
    }

    fn spawn_sleeper() -> std::process::Child {
        #[cfg(unix)]
        let (program, args) = ("sleep", ["30"].as_slice());
        #[cfg(windows)]
        let (program, args) = ("ping", ["-n", "31", "127.0.0.1"].as_slice());
        std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleeper")
    }

    #[test]
    fn kill_rejects_mismatched_start_time() {
        let mut child = spawn_sleeper();
        let mut sampler = ProcessSampler::new().unwrap();
        let pid = child.id();
        sampler.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
            true,
            ProcessRefreshKind::nothing(),
        );
        let start_time = sampler
            .system
            .process(Pid::from_u32(pid))
            .unwrap()
            .start_time();

        let stale = sampler.kill(pid, start_time + 1, KillSignal::Term);
        assert!(!stale.success);
        assert!(child.try_wait().unwrap().is_none());

        let fresh = sampler.kill(pid, start_time, KillSignal::Kill);
        assert!(fresh.success, "{}", fresh.message);
        child.wait().unwrap();
    }

    #[test]
    fn kill_refuses_server_and_init() {
        let mut sampler = ProcessSampler::new().unwrap();
        assert!(
            !sampler
                .kill(std::process::id(), 0, KillSignal::Term)
                .success
        );
        assert!(!sampler.kill(1, 0, KillSignal::Term).success);
    }

    #[test]
    fn kill_message_defaults_to_term() {
        let message: ClientMessage =
            serde_json::from_str(r#"{"type":"kill","pid":42,"start_time":7}"#).unwrap();
        let ClientMessage::Kill { signal, .. } = message else {
            panic!("expected kill")
        };
        assert!(matches!(signal, KillSignal::Term));
    }
}
