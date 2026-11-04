//! Bounded, pane-scoped OTLP/HTTP collection. Raw log content is never retained.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::Read;
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
use opentelemetry_proto::tonic::metrics::v1::{metric, number_data_point};
use prost::Message;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ws::control::ServerMessage;
use crate::AppState;

const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_RECORDS: usize = 4096;
const MAX_PANES: usize = 128;
const MAX_SERIES: usize = 256;
// Larger than a batch, so a retried batch is still recognized.
const MAX_SEEN: usize = 2 * MAX_RECORDS;
const HISTORY_SECONDS: u64 = 3600;
const MAX_VALUE: f64 = 1e15;

#[derive(Clone, Default, Serialize)]
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
pub struct AgentTelemetry {
    pub pane_id: Uuid,
    pub agent: String,
    pub model: Option<String>,
    pub updated_at: f64,
    pub totals: AgentUsage,
    pub buckets: Vec<UsageBucket>,
}

#[derive(Default)]
pub struct TelemetryStore {
    panes: HashMap<Uuid, PaneTelemetry>,
}

#[derive(Default)]
struct PaneTelemetry {
    agent: String,
    model: Option<String>,
    updated_at: u64,
    buckets: BTreeMap<u64, AgentUsage>,
    counters: HashMap<u64, Counter>,
    seen: HashSet<u64>,
    seen_order: VecDeque<u64>,
}

struct Counter {
    start: u64,
    end: u64,
    value: f64,
}

struct Sample {
    agent: &'static str,
    model: Option<String>,
    timestamp: u64,
    identity: u64,
    counter: Option<(u64, bool, f64)>,
    usage: AgentUsage,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl TelemetryStore {
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
        pane.buckets
            .retain(|minute, _| *minute + 60 > now.saturating_sub(HISTORY_SECONDS));
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
        let buckets: Vec<_> = self
            .buckets
            .iter()
            .filter(|(minute, _)| **minute + 60 > now.saturating_sub(HISTORY_SECONDS))
            .map(|(minute, usage)| UsageBucket {
                timestamp: *minute as f64,
                usage: usage.clone(),
            })
            .collect();
        if buckets.is_empty() {
            return None;
        }
        let mut totals = AgentUsage::default();
        for bucket in &buckets {
            totals.add(&bucket.usage);
        }
        Some(AgentTelemetry {
            pane_id,
            agent: self.agent.clone(),
            model: self.model.clone(),
            updated_at: self.updated_at as f64,
            totals,
            buckets,
        })
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
        if let Some((start, cumulative, value)) = sample.counter {
            if !value.is_finite() || !(0.0..=MAX_VALUE).contains(&value) || sample.timestamp == 0 {
                return false;
            }
            let delta = if cumulative {
                let previous = self.counters.get(&sample.identity);
                if previous.is_some_and(|old| sample.timestamp <= old.end) {
                    return false;
                }
                let delta = previous
                    .filter(|old| old.start == start && value >= old.value)
                    .map_or_else(
                        || {
                            // An old counter's first export is a baseline, not recent usage.
                            if previous.is_none()
                                && start / 1_000_000_000 < now.saturating_sub(HISTORY_SECONDS)
                            {
                                0.0
                            } else {
                                value
                            }
                        },
                        |old| value - old.value,
                    );
                // Each session adds series, so the stalest gives way to the newest.
                if previous.is_none() && self.counters.len() >= MAX_SERIES {
                    if let Some(oldest) = self
                        .counters
                        .iter()
                        .min_by_key(|(_, counter)| counter.end)
                        .map(|(identity, _)| *identity)
                    {
                        self.counters.remove(&oldest);
                    }
                }
                self.counters.insert(
                    sample.identity,
                    Counter {
                        start,
                        end: sample.timestamp,
                        value,
                    },
                );
                delta
            } else {
                // Delta points stand alone, so a late retry still counts once.
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                (sample.identity, start, sample.timestamp).hash(&mut hasher);
                if !self.remember(hasher.finish()) {
                    return false;
                }
                value
            };
            sample.usage.input_tokens *= delta;
            sample.usage.output_tokens *= delta;
            sample.usage.cached_tokens *= delta;
            sample.usage.cache_write_tokens *= delta;
            sample.usage.cost_usd = sample.usage.cost_usd.map(|cost| cost * delta);
        } else if !self.remember(sample.identity) {
            return false;
        }
        self.agent = sample.agent.to_string();
        if sample.model.is_some() {
            self.model = sample.model;
        }
        self.updated_at = now;
        self.buckets
            .entry(seconds / 60 * 60)
            .or_default()
            .add(&sample.usage);
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
    mgr.telemetry
        .snapshots(now_seconds())
        .into_iter()
        .filter(|pane| mgr.find_pane(pane.pane_id).is_some())
        .collect()
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
    if state.read().await.find_pane(id).is_none() {
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
    if mgr.find_pane(id).is_none() {
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
            .get(&id)
            .and_then(|pane| pane.snapshot(id, now))
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
                record.observed_time_unix_nano = 0;
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
                    counter: None,
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
                if !sum.is_monotonic || !matches!(sum.aggregation_temporality, 1 | 2) {
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
                        counter: Some((
                            point.start_time_unix_nano,
                            sum.aggregation_temporality == 2,
                            value,
                        )),
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
    fn cumulative_counters_handle_retries_resets_and_reordered_exports() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for (value, end, start) in [
            (100.0, NOW, NOW - 10),
            (100.0, NOW, NOW - 10),
            (150.0, NOW + 1, NOW - 10),
            (120.0, NOW, NOW - 10),
            (20.0, NOW + 2, NOW + 2),
            (30.0, NOW + 3, NOW + 2),
            (5.0, NOW + 4, NOW + 2),
        ] {
            store.ingest(
                pane,
                parse_metrics(metric(value, end, start, 2, "input")).unwrap(),
                NOW + 4,
            );
        }
        let snapshot = &store.snapshots(NOW + 4)[0];
        assert_eq!(snapshot.totals.input_tokens, 185.0);
        assert_eq!(snapshot.buckets.len(), 1);
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
    fn logs_and_metrics_have_separate_roles_for_claude() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        store.ingest(
            pane,
            parse_metrics(metric(100.0, NOW, NOW - 1, 2, "input")).unwrap(),
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
            let mut sample = parse_metrics(metric(1.0, NOW, NOW, 2, "input"))
                .unwrap()
                .remove(0);
            sample.counter.as_mut().unwrap().2 = value;
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
        let id = *store.panes.keys().next().unwrap();
        let tracked = store.panes.get_mut(&id).unwrap();
        for index in 0..MAX_SERIES + 10 {
            let mut sample = parse_metrics(metric(1.0, NOW, NOW, 2, "input"))
                .unwrap()
                .remove(0);
            sample.identity = index as u64;
            tracked.ingest(sample, NOW);
        }
        assert_eq!(tracked.counters.len(), MAX_SERIES);
    }

    fn metric_with_session(
        value: f64,
        end: u64,
        temporality: i32,
        session: usize,
    ) -> ExportMetricsServiceRequest {
        let mut request = metric(value, end, NOW - 100, temporality, "input");
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
    fn new_sessions_count_after_the_series_limit() {
        for temporality in [1, 2] {
            let mut store = TelemetryStore::default();
            let pane = Uuid::new_v4();
            for session in 0..MAX_SERIES + 10 {
                let request = metric_with_session(1.0, NOW, temporality, session);
                assert!(store.ingest(pane, parse_metrics(request).unwrap(), NOW));
            }
            let total = store.snapshots(NOW)[0].totals.input_tokens;
            assert_eq!(total, (MAX_SERIES + 10) as f64);
            assert!(store.panes[&pane].counters.len() <= MAX_SERIES);
        }
    }

    #[test]
    fn evicting_a_counter_keeps_the_most_recent_series() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for session in 0..MAX_SERIES {
            let end = NOW - 10 + (session == 0) as u64 * 5;
            let request = metric_with_session(1.0, end, 2, session);
            store.ingest(pane, parse_metrics(request).unwrap(), NOW);
        }
        // Session 0 exported last, so a new series must not replace it.
        let request = metric_with_session(1.0, NOW, 2, MAX_SERIES);
        store.ingest(pane, parse_metrics(request).unwrap(), NOW);
        let request = metric_with_session(3.0, NOW + 1, 2, 0);
        store.ingest(pane, parse_metrics(request).unwrap(), NOW + 1);
        // 257 first exports, plus session 0's increase of 2.
        let total = store.snapshots(NOW + 1)[0].totals.input_tokens;
        assert_eq!(total, (MAX_SERIES + 1) as f64 + 2.0);
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
    fn old_cumulative_counters_begin_at_a_baseline() {
        let mut store = TelemetryStore::default();
        let pane = Uuid::new_v4();
        for (value, end) in [(10000.0, NOW), (10025.0, NOW + 1)] {
            store.ingest(
                pane,
                parse_metrics(metric(value, end, NOW - 7200, 2, "input")).unwrap(),
                NOW + 1,
            );
        }
        assert_eq!(store.snapshots(NOW + 1)[0].totals.input_tokens, 25.0);
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
        let metric = metric(123.0, now_seconds(), now_seconds() - 1, 2, "input");
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
