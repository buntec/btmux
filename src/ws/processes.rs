use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket};
use axum::extract::WebSocketUpgrade;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sysinfo::{
    MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, Signal, System,
    Uid, UpdateKind, Users, MINIMUM_CPU_UPDATE_INTERVAL,
};
use tokio::time::{interval, sleep, Duration, MissedTickBehavior};

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
}

#[derive(Debug, Serialize)]
struct ProcessSnapshot {
    #[serde(rename = "type")]
    message_type: &'static str,
    processes: Vec<ProcessInfo>,
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
    fn new() -> Self {
        Self {
            users: Users::new_with_refreshed_list(),
            names: HashMap::new(),
        }
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

struct ProcessSampler {
    system: System,
    users: UserNames,
    refresh: ProcessRefreshKind,
    cpu_count: usize,
}

impl ProcessSampler {
    fn new() -> Self {
        Self {
            system: System::new_with_specifics(
                RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
            ),
            users: UserNames::new(),
            refresh: ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_user(UpdateKind::OnlyIfNotSet)
                .with_cmd(UpdateKind::OnlyIfNotSet),
            // Per-process CPU% is relative to one logical CPU.
            cpu_count: std::thread::available_parallelism().map_or(1, usize::from),
        }
    }

    fn refresh(&mut self) {
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        self.system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, self.refresh);
    }

    fn snapshot(&mut self) -> ProcessSnapshot {
        let mut users_reloaded = false;
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
                }
            })
            .collect();
        let load = System::load_average();
        ProcessSnapshot {
            message_type: "snapshot",
            processes,
            cpu_count: self.cpu_count,
            mem_used: self.system.used_memory(),
            mem_total: self.system.total_memory(),
            load_average: [load.one, load.five, load.fifteen],
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
) -> Result<(), ()> {
    let text = with_sampler(sampler, |sampler| {
        sampler.refresh();
        serde_json::to_string(&sampler.snapshot())
    })
    .await?
    .map_err(|_| ())?;
    ws_tx.send(Message::Text(text.into())).await.map_err(|_| ())
}

pub async fn handle(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let Ok(sampler) =
        tokio::task::spawn_blocking(|| Arc::new(Mutex::new(ProcessSampler::new()))).await
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
    if send_snapshot(&mut ws_tx, &sampler).await.is_err() {
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
                if send_snapshot(&mut ws_tx, &sampler).await.is_err() {
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

    fn spawn_sleeper() -> std::process::Child {
        std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep")
    }

    #[test]
    fn kill_rejects_mismatched_start_time() {
        let mut child = spawn_sleeper();
        let mut sampler = ProcessSampler::new();
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
        let mut sampler = ProcessSampler::new();
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
        let ClientMessage::Kill { signal, .. } = message;
        assert!(matches!(signal, KillSignal::Term));
    }
}
