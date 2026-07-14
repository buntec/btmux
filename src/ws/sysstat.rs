use axum::{
    extract::{
        ws::{Message, WebSocket},
        WebSocketUpgrade,
    },
    response::IntoResponse,
};
use serde::Serialize;
use sysinfo::{Networks, System};
use tokio::time::{interval, Duration};

#[derive(Serialize)]
pub struct SysStatFrame {
    /// Per-core CPU usage 0–100.
    cpu: Vec<f32>,
    /// Used memory in bytes.
    mem_used: u64,
    /// Total memory in bytes.
    mem_total: u64,
    /// Network received bytes/s (sum across interfaces).
    net_rx: u64,
    /// Network transmitted bytes/s (sum across interfaces).
    net_tx: u64,
}

pub async fn handle(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    let mut sys = System::new();
    let mut networks = Networks::new_with_refreshed_list();
    let mut tick = interval(Duration::from_secs(1));

    // Prime CPU readings (first call always returns 0 without a prior refresh).
    sys.refresh_cpu_all();
    tick.tick().await;

    loop {
        tick.tick().await;

        sys.refresh_cpu_all();
        sys.refresh_memory();
        networks.refresh(false);

        let cpu: Vec<f32> = sys.cpus().iter().map(|c| c.cpu_usage()).collect();
        let mem_used = sys.used_memory();
        let mem_total = sys.total_memory();
        let (net_rx, net_tx) = networks.iter().fold((0u64, 0u64), |(rx, tx), (_, n)| {
            (rx + n.received(), tx + n.transmitted())
        });

        let frame = SysStatFrame {
            cpu,
            mem_used,
            mem_total,
            net_rx,
            net_tx,
        };
        let Ok(json) = serde_json::to_string(&frame) else {
            continue;
        };
        if socket.send(Message::Text(json.into())).await.is_err() {
            break;
        }
    }
}
