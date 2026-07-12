mod run_command;
mod tools;

use std::sync::Arc;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

use crate::AppState;

/// Per-session MCP server. `rmcp` constructs a fresh instance per MCP client
/// session (see `mcp_service`'s factory closure below), but every instance
/// shares the same `AppState` — the same `SessionManager` the REST API and
/// `/ws/control` operate on, so MCP-driven mutations broadcast to browser
/// tabs exactly like REST-driven ones do.
#[derive(Clone)]
pub struct BtmuxMcpServer {
    state: AppState,
    tool_router: ToolRouter<Self>,
}

impl BtmuxMcpServer {
    fn new(state: AppState) -> Self {
        Self {
            state,
            tool_router: Self::tool_router(),
        }
    }
}

/// Builds the tower `Service` mounted at `/mcp` in `server.rs::create_app`.
pub fn mcp_service(state: AppState) -> StreamableHttpService<BtmuxMcpServer, LocalSessionManager> {
    StreamableHttpService::new(
        move || Ok(BtmuxMcpServer::new(state.clone())),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    )
}
