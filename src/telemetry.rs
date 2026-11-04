//! Bounded, pane-scoped OTLP/HTTP collection. Raw log content is never retained.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, KeyValue};
use opentelemetry_proto::tonic::metrics::v1::{metric, number_data_point, AggregationTemporality};
use prost::Message;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ws::control::ServerMessage;
use crate::AppState;

const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_RECORDS: usize = 4096;
const MAX_PANES: usize = 128;
// Larger than a batch, so a retried batch is still recognized.
const MAX_SEEN: usize = 2 * MAX_RECORDS;
const MAX_CLOSED: usize = 1024;
const MAX_MODELS: usize = 32;
const HISTORY_SECONDS: u64 = 24 * 3600;
const MAX_VALUE: f64 = 1e15;

#[derive(Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AgentUsage {
    /// Input includes cache reads and writes; cached tokens are a subset.
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cached_tokens: f64,
    pub cache_write_tokens: f64,
    /// Reasoning is a subset of output tokens.
    pub reasoning_tokens: f64,
    pub requests: f64,
    pub tool_calls: f64,
    pub duration_ms: f64,
    pub cost_usd: Option<f64>,
}

impl AgentUsage {
    fn add(&mut self, other: &Self) {
        self.input_tokens = (self.input_tokens + other.input_tokens).min(MAX_VALUE);
        self.output_tokens = (self.output_tokens + other.output_tokens).min(MAX_VALUE);
        self.cached_tokens = (self.cached_tokens + other.cached_tokens).min(MAX_VALUE);
        self.cache_write_tokens =
            (self.cache_write_tokens + other.cache_write_tokens).min(MAX_VALUE);
        self.reasoning_tokens = (self.reasoning_tokens + other.reasoning_tokens).min(MAX_VALUE);
        self.requests = (self.requests + other.requests).min(MAX_VALUE);
        self.tool_calls = (self.tool_calls + other.tool_calls).min(MAX_VALUE);
        self.duration_ms = (self.duration_ms + other.duration_ms).min(MAX_VALUE);
        if let Some(cost) = other.cost_usd {
            self.cost_usd = Some((self.cost_usd.unwrap_or_default() + cost).min(MAX_VALUE));
        }
    }
}

#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct UsageBucket {
    /// Unix seconds, rounded down to a minute.
    pub timestamp: f64,
    pub usage: AgentUsage,
}

#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ModelTelemetry {
    pub agent: String,
    /// `None` is usage reported without a model, such as Claude's tool calls.
    pub model: Option<String>,
    /// Over all retained history, even when `buckets` holds only changed minutes.
    pub totals: AgentUsage,
    pub buckets: Vec<UsageBucket>,
}

#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct AgentTelemetry {
    pub pane_id: Uuid,
    pub updated_at: f64,
    /// Over all retained history and models.
    pub totals: AgentUsage,
    /// Most tokens first; an update holds only models with changed minutes.
    pub models: Vec<ModelTelemetry>,
}

/// Keeps closed panes, so a day's totals don't shrink when a pane closes.
#[derive(Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TelemetryStore {
    panes: HashMap<Uuid, PaneTelemetry>,
    /// Recently closed panes, whose first export may still be on its way.
    #[cfg_attr(test, ts(as = "Vec<Uuid>"))]
    closed: VecDeque<Uuid>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct PaneTelemetry {
    series: Vec<ModelSeries>,
    updated_at: u64,
    #[serde(skip)]
    seen: HashSet<u64>,
    #[cfg_attr(test, ts(as = "Vec<u64>"))]
    seen_order: VecDeque<u64>,
    /// Minutes changed since the last push.
    #[serde(skip)]
    dirty: BTreeSet<u64>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct ModelSeries {
    agent: String,
    model: Option<String>,
    buckets: BTreeMap<u64, AgentUsage>,
}

struct Sample {
    agent: &'static str,
    model: Option<String>,
    timestamp: u64,
    identity: u64,
    /// A delta metric point's start time and value, which scales `usage`.
    delta: Option<(u64, f64)>,
    usage: AgentUsage,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl TelemetryStore {
    /// After a handoff, which carries only the ordered copy of `seen`.
    #[cfg(unix)]
    pub fn restored(mut self) -> Self {
        for pane in self.panes.values_mut() {
            pane.seen = pane.seen_order.iter().copied().collect();
        }
        self
    }

    pub fn pane_closed(&mut self, id: Uuid) {
        self.closed.push_back(id);
        if self.closed.len() > MAX_CLOSED {
            self.closed.pop_front();
        }
    }

    fn accepts_closed(&self, id: Uuid) -> bool {
        self.panes.contains_key(&id) || self.closed.contains(&id)
    }

    pub fn snapshots(&self, now: u64) -> Vec<AgentTelemetry> {
        let mut panes: Vec<_> = self
            .panes
            .iter()
            .filter_map(|(id, pane)| pane.snapshot(*id, now))
            .collect();
        panes.sort_by_key(|pane| pane.pane_id);
        panes
    }

    fn ingest(&mut self, pane_id: Uuid, samples: Vec<Sample>, now: u64) -> bool {
        if samples.is_empty() {
            return false;
        }
        self.panes
            .retain(|_, pane| pane.updated_at + HISTORY_SECONDS > now);
        let mut pane = self.panes.remove(&pane_id).unwrap_or_default();
        let mut changed = false;
        for sample in samples {
            changed |= pane.ingest(sample, now);
        }
        // A new pane with no accepted samples must not displace another.
        if pane.updated_at == 0 {
            return false;
        }
        for series in &mut pane.series {
            series
                .buckets
                .retain(|minute, _| *minute + 60 > now.saturating_sub(HISTORY_SECONDS));
        }
        pane.series.retain(|series| !series.buckets.is_empty());
        if self.panes.len() >= MAX_PANES {
            if let Some(oldest) = self
                .panes
                .iter()
                .min_by_key(|(_, pane)| pane.updated_at)
                .map(|(id, _)| *id)
            {
                self.panes.remove(&oldest);
            }
        }
        self.panes.insert(pane_id, pane);
        changed
    }
}

impl PaneTelemetry {
    fn snapshot(&self, pane_id: Uuid, now: u64) -> Option<AgentTelemetry> {
        self.telemetry(pane_id, now, |_| true)
    }

    /// The minutes changed since the last update, which tabs merge into what they have.
    fn take_update(&mut self, pane_id: Uuid, now: u64) -> Option<AgentTelemetry> {
        let dirty = std::mem::take(&mut self.dirty);
        self.telemetry(pane_id, now, |minute| dirty.contains(&minute))
    }

    fn telemetry(
        &self,
        pane_id: Uuid,
        now: u64,
        include: impl Fn(u64) -> bool,
    ) -> Option<AgentTelemetry> {
        let mut totals = AgentUsage::default();
        let mut models = Vec::new();
        for series in &self.series {
            let retained = series
                .buckets
                .iter()
                .filter(|(minute, _)| **minute + 60 > now.saturating_sub(HISTORY_SECONDS));
            let mut series_totals = AgentUsage::default();
            for (_, usage) in retained.clone() {
                series_totals.add(usage);
            }
            totals.add(&series_totals);
            let buckets: Vec<_> = retained
                .filter(|(minute, _)| include(**minute))
                .map(|(minute, usage)| UsageBucket {
                    timestamp: *minute as f64,
                    usage: usage.clone(),
                })
                .collect();
            if !buckets.is_empty() {
                models.push(ModelTelemetry {
                    agent: series.agent.clone(),
                    model: series.model.clone(),
                    totals: series_totals,
                    buckets,
                });
            }
        }
        if models.is_empty() {
            return None;
        }
        let tokens =
            |model: &ModelTelemetry| model.totals.input_tokens + model.totals.output_tokens;
        models.sort_by(|a, b| tokens(b).total_cmp(&tokens(a)));
        Some(AgentTelemetry {
            pane_id,
            updated_at: self.updated_at as f64,
            totals,
            models,
        })
    }

    /// Past `MAX_MODELS`, usage still counts, without its model.
    fn series_mut(&mut self, agent: &str, model: Option<String>) -> &mut ModelSeries {
        let known = |series: &ModelSeries, model: &Option<String>| {
            series.agent == agent && series.model == *model
        };
        let fits = self.series.len() < MAX_MODELS || self.series.iter().any(|s| known(s, &model));
        let model = model.filter(|_| fits);
        let index = match self.series.iter().position(|s| known(s, &model)) {
            Some(index) => index,
            None => {
                self.series.push(ModelSeries {
                    agent: agent.to_string(),
                    model,
                    buckets: BTreeMap::new(),
                });
                self.series.len() - 1
            }
        };
        &mut self.series[index]
    }

    fn ingest(&mut self, mut sample: Sample, now: u64) -> bool {
        let seconds = if sample.timestamp == 0 {
            now
        } else {
            sample.timestamp / 1_000_000_000
        };
        if seconds < now.saturating_sub(HISTORY_SECONDS) || seconds > now + 300 {
            return false;
        }
        if let Some((start, delta)) = sample.delta {
            if !delta.is_finite() || !(0.0..=MAX_VALUE).contains(&delta) || sample.timestamp == 0 {
                return false;
            }
            // Each point stands alone, so a late retry still counts once.
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            (sample.identity, start, sample.timestamp).hash(&mut hasher);
            if !self.remember(hasher.finish()) {
                return false;
            }
            sample.usage.input_tokens *= delta;
            sample.usage.output_tokens *= delta;
            sample.usage.cached_tokens *= delta;
            sample.usage.cache_write_tokens *= delta;
            sample.usage.cost_usd = sample.usage.cost_usd.map(|cost| cost * delta);
        } else if !self.remember(sample.identity) {
            return false;
        }
        self.updated_at = now;
        let minute = seconds / 60 * 60;
        self.series_mut(sample.agent, sample.model)
            .buckets
            .entry(minute)
            .or_default()
            .add(&sample.usage);
        self.dirty.insert(minute);
        true
    }

    /// False if `identity` was already seen.
    fn remember(&mut self, identity: u64) -> bool {
        if !self.seen.insert(identity) {
            return false;
        }
        self.seen_order.push_back(identity);
        if self.seen_order.len() > MAX_SEEN {
            if let Some(oldest) = self.seen_order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/telemetry", get(snapshot))
        .route("/api/panes/{pane_id}/telemetry/v1/logs", post(logs))
        .route("/api/panes/{pane_id}/telemetry/v1/metrics", post(metrics))
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

pub fn snapshots(mgr: &crate::session::manager::SessionManager) -> Vec<AgentTelemetry> {
    mgr.telemetry.snapshots(now_seconds())
}

/// An agent's last export, even its first, can arrive just after its pane closes.
fn accepts(mgr: &crate::session::manager::SessionManager, id: Uuid) -> bool {
    mgr.find_pane(id).is_some() || mgr.telemetry.accepts_closed(id)
}

async fn snapshot(State(state): State<AppState>) -> Json<Vec<AgentTelemetry>> {
    let mgr = state.read().await;
    Json(snapshots(&mgr))
}

#[derive(Clone, Copy)]
enum Signal {
    Logs,
    Metrics,
}

async fn logs(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    collect(state, id, headers, body, Signal::Logs).await
}

async fn metrics(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    collect(state, id, headers, body, Signal::Metrics).await
}

async fn collect(
    state: AppState,
    id: Uuid,
    headers: HeaderMap,
    body: Bytes,
    signal: Signal,
) -> Response {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !matches!(
        content_type.as_str(),
        "application/json" | "application/x-protobuf"
    ) {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected OTLP JSON or protobuf",
        )
            .into_response();
    }
    let gzip = match headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
    {
        None | Some("identity") => false,
        Some("gzip") => true,
        _ => return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response(),
    };
    if !accepts(&*state.read().await, id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let json = content_type == "application/json";
    let decoded = tokio::task::spawn_blocking(move || {
        let mut uncompressed = Vec::new();
        let bytes = if gzip {
            flate2::read::GzDecoder::new(body.as_ref())
                .take(MAX_BODY as u64 + 1)
                .read_to_end(&mut uncompressed)
                .map_err(|_| StatusCode::BAD_REQUEST)?;
            if uncompressed.len() > MAX_BODY {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            uncompressed.as_slice()
        } else {
            body.as_ref()
        };
        match signal {
            Signal::Logs => parse_logs(decode(bytes, json)?),
            Signal::Metrics => parse_metrics(decode(bytes, json)?),
        }
    })
    .await;
    let samples = match decoded {
        Ok(Ok(samples)) => samples,
        Ok(Err(status)) => return status.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mut mgr = state.write().await;
    if !accepts(&mgr, id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let now = now_seconds();
    let previous: Vec<_> = mgr.telemetry.panes.keys().copied().collect();
    let changed = mgr.telemetry.ingest(id, samples, now);
    let removed_panes: Vec<_> = previous
        .into_iter()
        .filter(|id| !mgr.telemetry.panes.contains_key(id))
        .collect();
    if changed || !removed_panes.is_empty() {
        let panes = mgr
            .telemetry
            .panes
            .get_mut(&id)
            .and_then(|pane| pane.take_update(id, now))
            .into_iter()
            .collect();
        let _ = mgr.events().send(
            serde_json::to_string(&ServerMessage::AgentTelemetry {
                panes,
                removed_panes,
                replace: false,
            })
            .unwrap(),
        );
    }
    // Both OTLP export responses encode an empty success message.
    (
        [(header::CONTENT_TYPE, content_type)],
        if json { b"{}".to_vec() } else { Vec::new() },
    )
        .into_response()
}

fn decode<T: Message + Default + for<'de> Deserialize<'de>>(
    bytes: &[u8],
    json: bool,
) -> Result<T, StatusCode> {
    if json {
        serde_json::from_slice(bytes).map_err(|_| StatusCode::BAD_REQUEST)
    } else {
        T::decode(bytes).map_err(|_| StatusCode::BAD_REQUEST)
    }
}

fn attr<'a>(attrs: &'a [KeyValue], key: &str) -> Option<&'a any_value::Value> {
    attrs
        .iter()
        .find(|attr| attr.key == key)?
        .value
        .as_ref()?
        .value
        .as_ref()
}

fn text_attr<'a>(attrs: &'a [KeyValue], key: &str) -> Option<&'a str> {
    match attr(attrs, key)? {
        any_value::Value::StringValue(value) => Some(value),
        _ => None,
    }
}

fn number_attr(attrs: &[KeyValue], keys: &[&str]) -> f64 {
    keys.iter()
        .find_map(|key| match attr(attrs, key)? {
            any_value::Value::IntValue(n) => Some(*n as f64),
            any_value::Value::DoubleValue(n) => Some(*n),
            any_value::Value::StringValue(n) => n.parse().ok(),
            _ => None,
        })
        .filter(|n| n.is_finite() && (0.0..=MAX_VALUE).contains(n))
        .unwrap_or_default()
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hash);
    hash.finish()
}

fn hash_attributes(attrs: &[KeyValue]) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let mut sorted: Vec<_> = attrs.iter().collect();
    sorted.sort_by_key(|attr| &attr.key);
    for attr in sorted {
        attr.encode_to_vec().hash(&mut hash);
    }
    hash.finish()
}

fn parse_logs(request: ExportLogsServiceRequest) -> Result<Vec<Sample>, StatusCode> {
    let mut samples = Vec::new();
    let mut count = 0;
    for resource in request.resource_logs {
        let resource_id = hash_attributes(&resource.resource.unwrap_or_default().attributes);
        for scope in resource.scope_logs {
            for mut record in scope.log_records {
                count += 1;
                if count > MAX_RECORDS {
                    return Err(StatusCode::PAYLOAD_TOO_LARGE);
                }
                let attrs = &record.attributes;
                let event = text_attr(attrs, "event.name")
                    .or_else(|| {
                        record.body.as_ref().and_then(|body| match &body.value {
                            Some(any_value::Value::StringValue(body)) => Some(body.as_str()),
                            _ => None,
                        })
                    })
                    .unwrap_or_default();
                let mut usage = AgentUsage::default();
                let agent = if event.starts_with("codex.") {
                    "codex"
                } else if event.starts_with("claude_code.")
                    || matches!(event, "api_request" | "tool_result")
                {
                    "claude"
                } else {
                    continue;
                };
                match event {
                    "codex.sse_event" | "codex.websocket_event"
                        if text_attr(attrs, "event.kind").or_else(|| text_attr(attrs, "kind"))
                            == Some("response.completed") =>
                    {
                        usage.input_tokens =
                            number_attr(attrs, &["input_token_count", "input_tokens"]);
                        usage.output_tokens =
                            number_attr(attrs, &["output_token_count", "output_tokens"]);
                        usage.cached_tokens =
                            number_attr(attrs, &["cached_token_count", "cached_input_tokens"]);
                        usage.reasoning_tokens = number_attr(
                            attrs,
                            &["reasoning_token_count", "reasoning_output_tokens"],
                        );
                        usage.requests = 1.0;
                        usage.duration_ms = number_attr(attrs, &["duration_ms"]);
                    }
                    // Claude tokens/cost use counters; counting them here would duplicate metric exports.
                    "claude_code.api_request" | "api_request" => {
                        usage.requests = 1.0;
                        usage.duration_ms = number_attr(attrs, &["duration_ms"]);
                    }
                    "codex.tool_result" | "claude_code.tool_result" | "tool_result" => {
                        usage.tool_calls = 1.0
                    }
                    _ => continue,
                }
                let timestamp = if record.time_unix_nano == 0 {
                    record.observed_time_unix_nano
                } else {
                    record.time_unix_nano
                };
                let model = text_attr(attrs, "model").map(|s| s.chars().take(100).collect());
                record.attributes.sort_by(|a, b| a.key.cmp(&b.key));
                // Retries may re-observe a record, but this may be its only timestamp.
                if record.time_unix_nano != 0 {
                    record.observed_time_unix_nano = 0;
                }
                let identity = hash_bytes(
                    &[
                        resource_id.to_le_bytes().as_slice(),
                        &record.encode_to_vec(),
                    ]
                    .concat(),
                );
                samples.push(Sample {
                    agent,
                    model,
                    timestamp,
                    identity,
                    delta: None,
                    usage,
                });
            }
        }
    }
    Ok(samples)
}

fn parse_metrics(request: ExportMetricsServiceRequest) -> Result<Vec<Sample>, StatusCode> {
    let mut samples = Vec::new();
    let mut count = 0;
    for resource in request.resource_metrics {
        let resource_id = hash_attributes(&resource.resource.unwrap_or_default().attributes);
        for scope in resource.scope_metrics {
            let scope_id = hash_bytes(&scope.scope.unwrap_or_default().encode_to_vec());
            for metric in scope.metrics {
                if !matches!(
                    metric.name.as_str(),
                    "claude_code.token.usage" | "claude_code.cost.usage"
                ) {
                    continue;
                }
                let Some(metric::Data::Sum(sum)) = metric.data else {
                    continue;
                };
                if !sum.is_monotonic {
                    continue;
                }
                if sum.aggregation_temporality != AggregationTemporality::Delta as i32 {
                    static WARNED: Once = Once::new();
                    WARNED.call_once(|| {
                        tracing::warn!(
                            "ignoring non-delta {}: set OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta",
                            metric.name
                        )
                    });
                    continue;
                }
                for point in sum.data_points {
                    count += 1;
                    if count > MAX_RECORDS {
                        return Err(StatusCode::PAYLOAD_TOO_LARGE);
                    }
                    if point.flags & 1 != 0 {
                        continue;
                    }
                    let value = match point.value {
                        Some(number_data_point::Value::AsInt(value)) => value as f64,
                        Some(number_data_point::Value::AsDouble(value)) => value,
                        None => continue,
                    };
                    let mut usage = AgentUsage::default();
                    if metric.name == "claude_code.cost.usage" {
                        usage.cost_usd = Some(1.0);
                    } else {
                        match text_attr(&point.attributes, "type") {
                            Some("input") => usage.input_tokens = 1.0,
                            Some("output") => usage.output_tokens = 1.0,
                            Some("cacheRead") => {
                                usage.input_tokens = 1.0;
                                usage.cached_tokens = 1.0;
                            }
                            Some("cacheCreation") => {
                                usage.input_tokens = 1.0;
                                usage.cache_write_tokens = 1.0;
                            }
                            _ => continue,
                        }
                    }
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    resource_id.hash(&mut hasher);
                    scope_id.hash(&mut hasher);
                    metric.name.hash(&mut hasher);
                    hash_attributes(&point.attributes).hash(&mut hasher);
                    samples.push(Sample {
                        agent: "claude",
                        model: text_attr(&point.attributes, "model")
                            .map(|s| s.chars().take(100).collect()),
                        timestamp: point.time_unix_nano,
                        identity: hasher.finish(),
                        delta: Some((point.start_time_unix_nano, value)),
                        usage,
                    });
                }
            }
        }
    }
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tower::ServiceExt;

    const NOW: u64 = 1_800_000_000;

    fn kv(key: &str, value: Value) -> Value {
        json!({"key": key, "value": value})
    }

    fn metric(
        value: f64,
        end: u64,
        start: u64,
        temporality: i32,
        kind: &str,
    ) -> ExportMetricsServiceRequest {
        serde_json::from_value(json!({"resourceMetrics": [{"scopeMetrics": [{"metrics": [{
            "name": "claude_code.token.usage", "sum": {
                "aggregationTemporality": temporality, "isMonotonic": true,
                "dataPoints": [{"startTimeUnixNano": (start * 1_000_000_000).to_string(),
                    "timeUnixNano": (end * 1_000_000_000).to_string(), "asDouble": value,
                    "attributes": [kv("type", json!({"stringValue": kind})), kv("model", json!({"stringValue": "claude-test"}))]}]
            }
        }]}]}]})).unwrap()
    }

    fn log(end: u64, event: &str, extras: Vec<Value>) -> ExportLogsServiceRequest {
        let mut attributes = vec![kv("event.name", json!({"stringValue": event}))];
        attributes.extend(extras);
        serde_json::from_value(json!({"resourceLogs": [{"scopeLogs": [{"logRecords": [{
            "timeUnixNano": (end * 1_000_000_000).to_string(), "attributes": attributes
        }]}]}]}))
        .unwrap()
    }

    fn completion(end: u64) -> ExportLogsServiceRequest {
        log(
            end,
            "codex.sse_event",
            vec![
                kv("event.kind", json!({"stringValue": "response.completed"})),
                kv("input_token_count", json!({"intValue": "1000"})),
                kv("output_token_count", json!({"intValue": "100"})),
                kv("cached_token_count", json!({"intValue": "800"})),
                kv("reasoning_token_count", json!({"intValue": "30"})),
            ],
        )
    }

    #[test]
    fn delta_counters_deduplicate_and_cache_is_part_of_input() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for (value, end, kind) in [
            (20.0, NOW, "input"),
            (50.0, NOW, "cacheRead"),
            (50.0, NOW, "cacheRead"),
            (30.0, NOW + 1, "cacheRead"),
            (10.0, NOW, "cacheCreation"),
        ] {
            store.ingest(
                pane,
                parse_metrics(metric(value, end, NOW - 1, 1, kind)).unwrap(),
                NOW + 1,
            );
        }
        let total = &store.snapshots(NOW + 1)[0].totals;
        assert_eq!(total.input_tokens, 110.0);
        assert_eq!(total.cached_tokens, 80.0);
        assert_eq!(total.cache_write_tokens, 10.0);
    }

    fn model_completion(end: u64, model: &str, input: u64) -> ExportLogsServiceRequest {
        log(
            end,
            "codex.sse_event",
            vec![
                kv("event.kind", json!({"stringValue": "response.completed"})),
                kv("model", json!({"stringValue": model})),
                kv("input_token_count", json!({"intValue": input.to_string()})),
            ],
        )
    }

    #[test]
    fn usage_is_kept_per_model_with_the_most_used_first() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for (end, name, input) in [(NOW - 3, "helper", 6_000), (NOW - 2, "main", 20_000)] {
            store.ingest(
                pane,
                parse_logs(model_completion(end, name, input)).unwrap(),
                NOW,
            );
        }
        let snapshot = &store.snapshots(NOW)[0];
        assert_eq!(snapshot.totals.input_tokens, 26_000.0);
        let models: Vec<_> = snapshot
            .models
            .iter()
            .map(|model| (model.model.as_deref(), model.totals.input_tokens))
            .collect();
        assert_eq!(
            models,
            [(Some("main"), 20_000.0), (Some("helper"), 6_000.0)]
        );
    }

    #[test]
    fn usage_without_a_model_stays_separate_and_counted() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.ingest(
            pane,
            parse_logs(model_completion(NOW - 1, "main", 10)).unwrap(),
            NOW,
        );
        let tool = log(NOW, "claude_code.tool_result", vec![]);
        store.ingest(pane, parse_logs(tool).unwrap(), NOW);
        let snapshot = &store.snapshots(NOW)[0];
        assert_eq!(snapshot.totals.tool_calls, 1.0);
        let unattributed = snapshot.models.iter().find(|m| m.model.is_none()).unwrap();
        assert_eq!(unattributed.agent, "claude");
        assert_eq!(unattributed.totals.tool_calls, 1.0);
    }

    #[test]
    fn each_agent_in_a_pane_keeps_its_own_models() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.ingest(
            pane,
            parse_metrics(metric(100.0, NOW - 1, NOW - 2, 1, "input")).unwrap(),
            NOW,
        );
        store.ingest(
            pane,
            parse_logs(model_completion(NOW, "codex-test", 10)).unwrap(),
            NOW,
        );
        let models: Vec<_> = store.snapshots(NOW)[0]
            .models
            .iter()
            .map(|m| (m.agent.clone(), m.model.clone().unwrap()))
            .collect();
        assert_eq!(
            models,
            [
                ("claude".to_string(), "claude-test".to_string()),
                ("codex".to_string(), "codex-test".to_string())
            ]
        );
    }

    #[test]
    fn models_per_pane_are_bounded_without_losing_usage() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        let count = MAX_MODELS as u64 + 8;
        for i in 0..count {
            store.ingest(
                pane,
                parse_logs(model_completion(NOW - i, &format!("model-{i}"), 10)).unwrap(),
                NOW,
            );
        }
        // Known models still count past the limit.
        store.ingest(
            pane,
            parse_logs(model_completion(NOW + 1, "model-0", 10)).unwrap(),
            NOW + 1,
        );
        let snapshot = &store.snapshots(NOW + 1)[0];
        assert_eq!(store.panes[&pane].series.len(), MAX_MODELS + 1);
        assert_eq!(snapshot.totals.input_tokens, (count as f64 + 1.0) * 10.0);
        let first = snapshot
            .models
            .iter()
            .find(|m| m.model.as_deref() == Some("model-0"))
            .unwrap();
        assert_eq!(first.totals.input_tokens, 20.0);
        let overflow = snapshot.models.iter().find(|m| m.model.is_none()).unwrap();
        assert_eq!(overflow.totals.input_tokens, 80.0);
    }

    #[test]
    fn an_update_holds_only_models_with_changed_minutes() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.ingest(
            pane,
            parse_logs(model_completion(NOW, "first", 10)).unwrap(),
            NOW,
        );
        store.panes.get_mut(&pane).unwrap().take_update(pane, NOW);
        store.ingest(
            pane,
            parse_logs(model_completion(NOW + 60, "second", 5)).unwrap(),
            NOW + 60,
        );
        let update = store
            .panes
            .get_mut(&pane)
            .unwrap()
            .take_update(pane, NOW + 60)
            .unwrap();
        assert_eq!(update.models.len(), 1);
        assert_eq!(update.models[0].model.as_deref(), Some("second"));
        assert_eq!(update.totals.input_tokens, 15.0);
    }

    #[test]
    fn codex_completion_retries_and_subset_counts_do_not_inflate_totals() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for _ in 0..2 {
            store.ingest(pane, parse_logs(completion(NOW)).unwrap(), NOW);
        }
        let mut retry = completion(NOW);
        let record = &mut retry.resource_logs[0].scope_logs[0].log_records[0];
        record.attributes.reverse();
        record.observed_time_unix_nano = (NOW + 2) * 1_000_000_000;
        assert!(!store.ingest(pane, parse_logs(retry).unwrap(), NOW + 2));
        let total = &store.snapshots(NOW)[0].totals;
        assert_eq!(total.input_tokens + total.output_tokens, 1100.0);
        assert_eq!(total.cached_tokens, 800.0);
        assert_eq!(total.reasoning_tokens, 30.0);
        assert_eq!(total.requests, 1.0);
        assert_eq!(total.cost_usd, None);
    }

    #[test]
    fn observation_time_identifies_only_records_without_a_source_time() {
        let observed = |source: u64, observed: u64| {
            let mut request = log(source, "codex.tool_result", vec![]);
            let record = &mut request.resource_logs[0].scope_logs[0].log_records[0];
            record.observed_time_unix_nano = observed * 1_000_000_000;
            parse_logs(request).unwrap()
        };
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        assert!(store.ingest(pane, observed(0, NOW - 60), NOW));
        assert!(store.ingest(pane, observed(0, NOW), NOW));
        assert!(!store.ingest(pane, observed(0, NOW), NOW));
        let snapshot = &store.snapshots(NOW)[0];
        assert_eq!(snapshot.totals.tool_calls, 2.0);
        assert_eq!(snapshot.models[0].buckets.len(), 2);

        let mut store = TelemetryStore::default();
        assert!(store.ingest(pane, observed(NOW, NOW), NOW));
        assert!(!store.ingest(pane, observed(NOW, NOW + 1), NOW + 1));
        assert_eq!(store.snapshots(NOW + 1)[0].totals.tool_calls, 1.0);
    }

    #[test]
    fn logs_and_metrics_have_separate_roles_for_claude() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.ingest(
            pane,
            parse_metrics(metric(100.0, NOW, NOW - 1, 1, "input")).unwrap(),
            NOW,
        );
        store.ingest(
            pane,
            parse_logs(log(
                NOW,
                "claude_code.api_request",
                vec![
                    kv("input_tokens", json!({"intValue": "100"})),
                    kv("duration_ms", json!({"doubleValue": 25.0})),
                ],
            ))
            .unwrap(),
            NOW,
        );
        let total = &store.snapshots(NOW)[0].totals;
        assert_eq!(total.input_tokens, 100.0);
        assert_eq!(total.requests, 1.0);
        assert_eq!(total.duration_ms, 25.0);
    }

    #[test]
    fn invalid_values_and_old_or_future_events_are_ignored() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for value in [f64::NAN, f64::INFINITY, -1.0, MAX_VALUE + 1.0] {
            let mut sample = parse_metrics(metric(1.0, NOW, NOW, 1, "input"))
                .unwrap()
                .remove(0);
            sample.delta.as_mut().unwrap().1 = value;
            assert!(!store.ingest(pane, vec![sample], NOW));
        }
        for end in [NOW - HISTORY_SECONDS - 1, NOW + 301] {
            assert!(!store.ingest(pane, parse_logs(completion(end)).unwrap(), NOW));
        }
        assert!(store.snapshots(NOW).is_empty());
    }

    #[test]
    fn history_and_cardinality_are_bounded() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.ingest(pane, parse_logs(completion(NOW)).unwrap(), NOW);
        assert!(store.snapshots(NOW + HISTORY_SECONDS + 60).is_empty());
        for _ in 0..MAX_PANES + 10 {
            store.ingest(Uuid::new_v4(), parse_logs(completion(NOW)).unwrap(), NOW);
        }
        assert_eq!(store.panes.len(), MAX_PANES);
    }

    fn metric_with_session(value: f64, end: u64, session: usize) -> ExportMetricsServiceRequest {
        let mut request = metric(value, end, NOW - 100, 1, "input");
        let data = request.resource_metrics[0].scope_metrics[0].metrics[0]
            .data
            .as_mut()
            .unwrap();
        let metric::Data::Sum(sum) = data else {
            panic!("expected a sum");
        };
        sum.data_points[0].attributes.push(
            serde_json::from_value(kv(
                "session.id",
                json!({"stringValue": format!("session-{session}")}),
            ))
            .unwrap(),
        );
        request
    }

    #[test]
    fn many_sessions_all_count() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for session in 0..1000 {
            let request = metric_with_session(1.0, NOW, session);
            assert!(store.ingest(pane, parse_metrics(request).unwrap(), NOW));
        }
        assert_eq!(store.snapshots(NOW)[0].totals.input_tokens, 1000.0);
    }

    #[test]
    fn only_delta_metrics_are_read() {
        for temporality in [0, 2] {
            let request = metric(100.0, NOW, NOW - 10, temporality, "input");
            assert!(parse_metrics(request).unwrap().is_empty());
        }
    }

    #[test]
    fn late_delta_retries_count_once() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for (value, end) in [(20.0, NOW + 1), (10.0, NOW), (10.0, NOW), (20.0, NOW + 1)] {
            store.ingest(
                pane,
                parse_metrics(metric(value, end, end - 1, 1, "input")).unwrap(),
                NOW + 1,
            );
        }
        assert_eq!(store.snapshots(NOW + 1)[0].totals.input_tokens, 30.0);
    }

    #[test]
    fn rejected_samples_from_a_new_pane_displace_nothing() {
        let mut store = TelemetryStore::default();
        for _ in 0..MAX_PANES {
            store.ingest(Uuid::new_v4(), parse_logs(completion(NOW)).unwrap(), NOW);
        }
        let before: HashSet<_> = store.panes.keys().copied().collect();
        let stale = parse_logs(completion(NOW - HISTORY_SECONDS - 1)).unwrap();
        assert!(!store.ingest(Uuid::new_v4(), stale, NOW));
        assert_eq!(store.panes.keys().copied().collect::<HashSet<_>>(), before);
    }

    #[test]
    fn a_full_retried_batch_is_recognized() {
        let batch = |store: &mut TelemetryStore, pane| {
            let samples = (0..MAX_RECORDS)
                .flat_map(|i| {
                    let mut request = completion(NOW);
                    let record = &mut request.resource_logs[0].scope_logs[0].log_records[0];
                    record.time_unix_nano = (NOW * 1_000_000_000) + i as u64;
                    parse_logs(request).unwrap()
                })
                .collect();
            store.ingest(pane, samples, NOW)
        };
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        assert!(batch(&mut store, pane));
        assert!(!batch(&mut store, pane));
        assert_eq!(store.snapshots(NOW)[0].totals.requests, MAX_RECORDS as f64);
    }

    #[test]
    fn history_covers_a_day_including_idle_panes() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        let other = Uuid::new_v4();
        store.ingest(pane, parse_logs(completion(NOW)).unwrap(), NOW);
        let later = NOW + 8 * 3600;
        store.ingest(other, parse_logs(completion(later)).unwrap(), later);
        assert_eq!(store.snapshots(later).len(), 2);
        let expired = NOW + HISTORY_SECONDS + 60;
        store.ingest(other, parse_logs(completion(expired)).unwrap(), expired);
        assert!(!store.panes.contains_key(&pane));
    }

    #[test]
    fn updates_hold_only_changed_minutes_but_totals_cover_all_history() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.ingest(pane, parse_logs(completion(NOW)).unwrap(), NOW);
        store.ingest(pane, parse_logs(completion(NOW + 120)).unwrap(), NOW + 120);
        let tracked = store.panes.get_mut(&pane).unwrap();
        let update = tracked.take_update(pane, NOW + 120).unwrap();
        assert_eq!(update.models[0].buckets.len(), 2);
        assert!(tracked.take_update(pane, NOW + 120).is_none());
        store.ingest(pane, parse_logs(completion(NOW + 121)).unwrap(), NOW + 121);
        let tracked = store.panes.get_mut(&pane).unwrap();
        let update = tracked.take_update(pane, NOW + 121).unwrap();
        assert_eq!(update.models[0].buckets.len(), 1);
        assert_eq!(update.models[0].buckets[0].usage.requests, 2.0);
        assert_eq!(update.totals.requests, 3.0);
        assert_eq!(store.snapshots(NOW + 121)[0].models[0].buckets.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn a_handoff_keeps_history_and_deduplication() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.ingest(pane, parse_logs(completion(NOW)).unwrap(), NOW);
        let delta = || metric(100.0, NOW, NOW - 10, 1, "input");
        store.ingest(pane, parse_metrics(delta()).unwrap(), NOW);
        let json = serde_json::to_vec(&store).unwrap();
        let mut store = serde_json::from_slice::<TelemetryStore>(&json)
            .unwrap()
            .restored();
        assert_eq!(store.snapshots(NOW)[0].totals.input_tokens, 1100.0);
        assert!(!store.ingest(pane, parse_logs(completion(NOW)).unwrap(), NOW));
        assert!(!store.ingest(pane, parse_metrics(delta()).unwrap(), NOW));
        let total = &store.snapshots(NOW)[0].totals;
        assert_eq!(total.input_tokens, 1100.0);
        assert_eq!(total.requests, 1.0);
    }

    #[cfg(unix)]
    #[test]
    fn a_handoff_keeps_closed_panes() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.pane_closed(pane);
        let json = serde_json::to_vec(&store).unwrap();
        let store = serde_json::from_slice::<TelemetryStore>(&json)
            .unwrap()
            .restored();
        assert!(store.accepts_closed(pane));
    }

    #[test]
    fn closed_panes_are_bounded() {
        let mut store = TelemetryStore::default();
        let first = Uuid::new_v4();
        store.pane_closed(first);
        for _ in 0..MAX_CLOSED - 1 {
            store.pane_closed(Uuid::new_v4());
        }
        assert!(store.accepts_closed(first));
        let last = Uuid::new_v4();
        store.pane_closed(last);
        assert_eq!(store.closed.len(), MAX_CLOSED);
        assert!(!store.accepts_closed(first));
        assert!(store.accepts_closed(last));
    }

    async fn app() -> (Router, AppState, Uuid) {
        let (exit, _) = tokio::sync::mpsc::unbounded_channel();
        let (meta, _) = tokio::sync::mpsc::unbounded_channel();
        let mut manager = crate::session::manager::SessionManager::new(
            "/bin/sh".into(),
            crate::config::FileConfig::default(),
            exit,
            meta,
            8004,
            None,
        );
        let session = manager.create_session(None).await;
        let pane = manager.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
        let state = Arc::new(tokio::sync::RwLock::new(manager));
        let auth =
            Arc::new(crate::auth::Auth::new("test-token".into(), "127.0.0.1", 8004, &[]).unwrap());
        let app = crate::server::create_app(state.clone()).layer(
            axum::middleware::from_fn_with_state(auth, crate::auth::protect),
        );
        (app, state, pane)
    }

    fn request(pane: Uuid, signal: &str, content_type: &str, body: Vec<u8>) -> Request<Body> {
        Request::post(format!("/api/panes/{pane}/telemetry/v1/{signal}"))
            .header(header::HOST, "localhost:8004")
            .header(header::AUTHORIZATION, "Bearer test-token")
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn http_accepts_json_protobuf_and_gzip_and_broadcasts_to_all_viewers() {
        use std::io::Write;
        let (app, state, pane) = app().await;
        let mut first = state.read().await.events().subscribe();
        let mut second = state.read().await.events().subscribe();
        let log = completion(now_seconds());
        let response = app
            .clone()
            .oneshot(request(
                pane,
                "logs",
                "application/json",
                serde_json::to_vec(&log).unwrap(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 100).await.unwrap().as_ref(),
            b"{}"
        );
        let event = first.recv().await.unwrap();
        assert_eq!(event, second.recv().await.unwrap());
        assert_eq!(
            serde_json::from_str::<Value>(&event).unwrap()["type"],
            "agent_telemetry"
        );
        let metric = metric(123.0, now_seconds(), now_seconds() - 1, 1, "input");
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&metric.encode_to_vec()).unwrap();
        let mut req = request(
            pane,
            "metrics",
            "application/x-protobuf",
            gzip.finish().unwrap(),
        );
        req.headers_mut()
            .insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
        let response = app.clone().oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-protobuf"
        );
        assert!(to_bytes(response.into_body(), 100)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            snapshots(&*state.read().await)[0].totals.input_tokens,
            1123.0
        );
        // A repeated export is acknowledged without another update.
        app.clone()
            .oneshot(request(
                pane,
                "logs",
                "application/x-protobuf",
                log.encode_to_vec(),
            ))
            .await
            .unwrap();
        assert_eq!(snapshots(&*state.read().await)[0].totals.requests, 1.0);
        let serialized = serde_json::to_string(&snapshots(&*state.read().await)).unwrap();
        assert!(!serialized.contains("event.name"));
    }

    #[tokio::test]
    async fn closed_panes_keep_their_usage_and_accept_a_last_export() {
        let (app, state, _) = app().await;
        let closed = Uuid::new_v4();
        let now = now_seconds();
        state
            .write()
            .await
            .telemetry
            .ingest(closed, parse_logs(completion(now)).unwrap(), now);
        assert_eq!(snapshots(&*state.read().await).len(), 1);
        let last = serde_json::to_vec(&completion(now + 1)).unwrap();
        let response = app
            .oneshot(request(closed, "logs", "application/json", last))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(snapshots(&*state.read().await)[0].totals.requests, 2.0);
    }

    #[tokio::test]
    async fn a_first_export_after_a_pane_closes_counts() {
        let (app, state, _) = app().await;
        let closed = {
            let mut mgr = state.write().await;
            let session = mgr.create_session(None).await;
            let pane = mgr.snapshot_by_id(session).unwrap().windows[0].panes[0].id;
            mgr.kill_session(session);
            pane
        };
        assert!(snapshots(&*state.read().await).is_empty());
        let body = serde_json::to_vec(&completion(now_seconds())).unwrap();
        let response = app
            .oneshot(request(closed, "logs", "application/json", body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let panes = snapshots(&*state.read().await);
        assert_eq!(panes[0].pane_id, closed);
        assert_eq!(panes[0].totals.requests, 1.0);
    }

    #[tokio::test]
    async fn every_way_of_closing_a_pane_records_it() {
        use crate::session::manager::SessionManager;
        fn active_pane(mgr: &SessionManager, session: Uuid) -> Uuid {
            let snapshot = mgr.snapshot_by_id(session).unwrap();
            let window = &snapshot.windows[snapshot.active_window];
            window.panes[window.active_pane].id
        }
        async fn split(mgr: &mut SessionManager, session: Uuid) -> Uuid {
            let pane = active_pane(mgr, session);
            mgr.split_pane(pane, "right", None, false).await.unwrap()
        }
        let (_, state, _) = app().await;
        let mut mgr = state.write().await;
        let session = mgr.create_session(None).await;

        let pane = split(&mut mgr, session).await;
        mgr.kill_pane(session, pane);
        assert!(mgr.telemetry.accepts_closed(pane), "kill_pane");

        let pane = split(&mut mgr, session).await;
        mgr.kill_pane_by_id(pane).unwrap();
        assert!(mgr.telemetry.accepts_closed(pane), "kill_pane_by_id");

        let pane = split(&mut mgr, session).await;
        mgr.handle_pane_exit(pane).await;
        assert!(mgr.telemetry.accepts_closed(pane), "handle_pane_exit");

        mgr.create_window(session).await;
        let pane = active_pane(&mgr, session);
        mgr.close_window(session);
        assert!(mgr.find_pane(pane).is_none());
        assert!(mgr.telemetry.accepts_closed(pane), "close_window");

        mgr.create_window(session).await;
        let pane = active_pane(&mgr, session);
        let snapshot = mgr.snapshot_by_id(session).unwrap();
        mgr.kill_window(snapshot.windows[snapshot.active_window].id);
        assert!(mgr.find_pane(pane).is_none());
        assert!(mgr.telemetry.accepts_closed(pane), "kill_window");

        let pane = active_pane(&mgr, session);
        mgr.kill_session(session);
        assert!(mgr.telemetry.accepts_closed(pane), "kill_session");

        let pane = mgr.sessions[0].windows[0].panes[0].id;
        mgr.clear_sessions().await;
        assert!(mgr.telemetry.accepts_closed(pane), "clear_sessions");
    }

    #[tokio::test]
    async fn http_preserves_auth_and_rejects_invalid_payloads_and_missing_panes() {
        use std::io::Write;
        let (app, _, pane) = app().await;
        let mut unauthorized = request(pane, "logs", "application/json", b"{}".to_vec());
        unauthorized.headers_mut().remove(header::AUTHORIZATION);
        assert_eq!(
            app.clone().oneshot(unauthorized).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        for (id, content_type, payload, expected) in [
            (
                pane,
                "application/json",
                b"{".to_vec(),
                StatusCode::BAD_REQUEST,
            ),
            (
                pane,
                "application/x-protobuf",
                vec![255],
                StatusCode::BAD_REQUEST,
            ),
            (
                pane,
                "text/plain",
                b"{}".to_vec(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                Uuid::new_v4(),
                "application/json",
                b"{}".to_vec(),
                StatusCode::NOT_FOUND,
            ),
            (
                pane,
                "application/json",
                vec![b' '; MAX_BODY + 1],
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(request(id, "logs", content_type, payload))
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip.write_all(&vec![b' '; MAX_BODY + 1]).unwrap();
        let mut oversized = request(pane, "logs", "application/json", gzip.finish().unwrap());
        oversized
            .headers_mut()
            .insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
        assert_eq!(
            app.clone().oneshot(oversized).await.unwrap().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let mut foreign = request(pane, "logs", "application/json", b"{}".to_vec());
        foreign
            .headers_mut()
            .insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert_eq!(
            app.oneshot(foreign).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
}
