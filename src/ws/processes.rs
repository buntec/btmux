use axum::extract::ws::{Message, WebSocket};
use axum::extract::WebSocketUpgrade;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sysinfo::{
    MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, Signal, System,
    UpdateKind,
};
use tokio::time::{interval, Duration, MissedTickBehavior};

const REFRESH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Deserialize)]
struct ClientMessage {
    #[serde(rename = "type")]
    msg_type: String,
    pid: Option<u32>,
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

pub async fn handle(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut system = System::new_with_specifics(
        RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
    );
    let process_refresh = ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_user(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet);

    send_snapshot(&mut ws_tx, &mut system, process_refresh)
        .await
        .ok();

    let mut tick = interval(REFRESH_INTERVAL);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // `interval` ticks immediately on its first call; the initial snapshot was
    // sent above, so wait for the first complete measurement interval.
    tick.tick().await;

    loop {
        tokio::select! {
            _ = tick.tick() => {
                if send_snapshot(&mut ws_tx, &mut system, process_refresh).await.is_err() {
                    break;
                }
            }
            message = ws_rx.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if handle_command(&mut ws_tx, &system, text.as_ref()).await.is_err() {
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

async fn send_snapshot(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    system: &mut System,
    process_refresh: ProcessRefreshKind,
) -> Result<(), ()> {
    system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh);

    let processes = system
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
                user: process.user_id().map(|user| format!("{user:?}")),
                run_time: process.run_time(),
            }
        })
        .collect();
    let load = System::load_average();
    let snapshot = ProcessSnapshot {
        message_type: "snapshot",
        processes,
        cpu_count: system.physical_core_count().unwrap_or(1),
        mem_used: system.used_memory(),
        mem_total: system.total_memory(),
        load_average: [load.one, load.five, load.fifteen],
    };
    let text = serde_json::to_string(&snapshot).map_err(|_| ())?;
    ws_tx.send(Message::Text(text.into())).await.map_err(|_| ())
}

async fn handle_command(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    system: &System,
    text: &str,
) -> Result<(), ()> {
    let command: ClientMessage = match serde_json::from_str(text) {
        Ok(command) => command,
        Err(error) => {
            let message = ErrorMessage {
                message_type: "error",
                message: format!("Invalid message: {error}"),
            };
            return send_json(ws_tx, &message).await;
        }
    };

    if command.msg_type != "kill" {
        let message = ErrorMessage {
            message_type: "error",
            message: format!("Unknown process command: {}", command.msg_type),
        };
        return send_json(ws_tx, &message).await;
    }

    let Some(pid) = command.pid else {
        let message = ErrorMessage {
            message_type: "error",
            message: "Missing process id".to_string(),
        };
        return send_json(ws_tx, &message).await;
    };

    let result = match system.process(Pid::from_u32(pid)) {
        None => KillResult {
            message_type: "kill_result",
            pid,
            success: false,
            message: "Process no longer exists".to_string(),
        },
        Some(process) => match process.kill_with(Signal::Term) {
            Some(true) => KillResult {
                message_type: "kill_result",
                pid,
                success: true,
                message: "Termination signal sent".to_string(),
            },
            Some(false) => KillResult {
                message_type: "kill_result",
                pid,
                success: false,
                message: "Could not terminate process (permission denied?)".to_string(),
            },
            None if process.kill() => KillResult {
                message_type: "kill_result",
                pid,
                success: true,
                message: "Kill signal sent".to_string(),
            },
            None => KillResult {
                message_type: "kill_result",
                pid,
                success: false,
                message: "Could not terminate process on this platform".to_string(),
            },
        },
    };

    send_json(ws_tx, &result).await
}

async fn send_json<T: Serialize>(
    ws_tx: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &T,
) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    ws_tx.send(Message::Text(text.into())).await.map_err(|_| ())
}
