use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
#[cfg(desktop)]
use tauri::Manager;
use tauri::{ipc::Channel, AppHandle, State};
use tokio::{
    net::TcpStream,
    sync::mpsc,
    time::{self, Instant, MissedTickBehavior},
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use url::Url;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(12);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(55);
const RECONNECT_DELAYS: [u64; 5] = [1, 2, 4, 8, 15];
const INTERNAL_REQUEST: &str = "native-fleet-replay:";
type FleetSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub(crate) enum FleetEvent {
    Frame { frame: Value },
    Reconnecting,
    Unauthorized,
}

struct Connection {
    id: String,
    commands: mpsc::Sender<Value>,
    online: Arc<AtomicBool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub(crate) struct FleetTransport {
    connection: Mutex<Option<Connection>>,
    desktop_notifications: Arc<AtomicBool>,
}

fn fleet_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| "Fleet 连接地址无效")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.host().is_none()
        || !(url.scheme() == "wss" || (url.scheme() == "ws" && loopback))
        || url.path() != "/ws/fleet/client"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Fleet 连接地址无效".into());
    }
    Ok(url)
}

#[tauri::command]
pub(crate) fn fleet_connect(
    app: AppHandle,
    state: State<'_, FleetTransport>,
    id: String,
    url: String,
    token: String,
    events: Channel<FleetEvent>,
) -> Result<(), String> {
    let url = fleet_url(&url)?;
    let mut current = state.connection.lock().unwrap();
    if let Some(old) = current.take() {
        old.task.abort();
    }
    let (commands, receiver) = mpsc::channel(128);
    let online = Arc::new(AtomicBool::new(false));
    let task = tauri::async_runtime::spawn(run_connection(
        app,
        url,
        token,
        events,
        receiver,
        Arc::clone(&online),
        Arc::clone(&state.desktop_notifications),
    ));
    *current = Some(Connection {
        id,
        commands,
        online,
        task,
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn fleet_disconnect(
    app: AppHandle,
    state: State<'_, FleetTransport>,
    id: String,
) -> Result<(), String> {
    let stopped = {
        let mut current = state.connection.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|connection| connection.id == id)
        {
            current
                .take()
                .map(|connection| connection.task.abort())
                .is_some()
        } else {
            false
        }
    };
    if stopped {
        update_foreground_notice(&app, None, &Runs::default()).await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn fleet_send(
    state: State<'_, FleetTransport>,
    id: String,
    frame: Value,
) -> Result<(), String> {
    let current = state.connection.lock().unwrap();
    let connection = current
        .as_ref()
        .filter(|connection| connection.id == id && connection.online.load(Ordering::Acquire))
        .ok_or("Fleet 正在重新连接")?;
    connection
        .commands
        .try_send(frame)
        .map_err(|_| "Fleet 暂时无法发送请求".into())
}

#[tauri::command]
pub(crate) fn fleet_notifications(state: State<'_, FleetTransport>, enabled: bool) {
    state
        .desktop_notifications
        .store(enabled, Ordering::Release);
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub(crate) fn fleet_notify_attention(
    app: AppHandle,
    state: State<'_, FleetTransport>,
    title: String,
    body: String,
) {
    desktop_notice(&app, &state.desktop_notifications, &title, &body);
}

#[cfg(not(target_os = "android"))]
fn desktop_notice(app: &AppHandle, enabled: &AtomicBool, title: &str, body: &str) {
    #[cfg(desktop)]
    if enabled.load(Ordering::Acquire)
        && !app
            .get_webview_window("main")
            .is_some_and(|window| window.is_focused().unwrap_or(false))
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct Session {
    node: String,
    provider: String,
    id: String,
}

impl Session {
    fn from_frame(frame: &Value, parent: &Value) -> Option<Self> {
        let field = |name: &str| {
            frame[name]
                .as_str()
                .or_else(|| parent[name].as_str())
                .map(str::to_owned)
        };
        Some(Self {
            node: field("nodeId")?,
            provider: field("provider")?,
            id: field("sessionId")?,
        })
    }

    fn key(&self) -> String {
        format!("{}::{}::{}", self.node, self.provider, self.id)
    }
}

struct Run {
    id: String,
    stream: Option<String>,
    sequence: u64,
}

#[derive(Default)]
struct Runs {
    active: HashMap<Session, Run>,
    finished: VecDeque<(Session, String)>,
}

impl Runs {
    fn remember_active(&mut self, session: Session, id: &str, stream: Option<&str>, sequence: u64) {
        if self
            .finished
            .iter()
            .any(|(key, done)| key == &session && done == id)
        {
            return;
        }
        if let Some(current) = self.active.get(&session) {
            if current.stream.as_deref() == stream && current.sequence >= sequence {
                return;
            }
            if current.id == id && stream.is_none() {
                return;
            }
        }
        self.active.insert(
            session,
            Run {
                id: id.into(),
                stream: stream.map(str::to_owned),
                sequence,
            },
        );
    }

    fn record(&mut self, frame: &Value, parent: &Value, completed: &mut Vec<String>) {
        let kind = frame["type"].as_str().unwrap_or_default();
        if kind == "ActiveRunsSnapshot" {
            if let Some(runs) = frame["runs"].as_array() {
                for run in runs {
                    if let (Some(session), Some(id)) =
                        (Session::from_frame(run, frame), run["runId"].as_str())
                    {
                        self.remember_active(
                            session,
                            id,
                            run["streamId"].as_str(),
                            run["lastSeq"].as_u64().unwrap_or_default(),
                        );
                    }
                }
            }
            return;
        }
        let Some(session) = Session::from_frame(frame, parent) else {
            return;
        };
        let stream = frame["streamId"].as_str();
        if kind == "SessionStreamReplay" {
            if let Some(events) = frame["events"].as_array() {
                for event in events {
                    self.record(event, frame, completed);
                }
            }
            let latest = frame["lastSeq"].as_u64().unwrap_or_default();
            if frame["active"].as_bool() == Some(false) {
                if self
                    .active
                    .get(&session)
                    .is_some_and(|run| run.stream.as_deref() != stream || run.sequence <= latest)
                {
                    self.active.remove(&session);
                }
            } else if let Some(id) = frame["runId"].as_str() {
                self.remember_active(session, id, stream, latest);
            }
            return;
        }
        let id = frame["runId"]
            .as_str()
            .or_else(|| frame["requestId"].as_str());
        let sequence = frame["sequence"].as_u64();
        if kind == "Accepted" {
            if let Some(id) = id {
                self.remember_active(session.clone(), id, stream, sequence.unwrap_or_default());
            }
        }
        if let Some(run) = self.active.get_mut(&session) {
            if id.is_some_and(|id| run.id != id) {
                return;
            }
            if let (Some(stream), Some(sequence)) = (stream, sequence) {
                if run.stream.as_deref() != Some(stream) || sequence > run.sequence {
                    run.stream = Some(stream.into());
                    run.sequence = sequence;
                }
            }
        }
        if matches!(kind, "Completed" | "Failed") {
            let Some(id) = id else { return };
            let was_active = self.active.remove(&session).is_some();
            // A completion can arrive as the first live frame for a run begun on another device.
            // Replayed completions must belong to a known run to produce an alert.
            if (!was_active
                && (!parent.is_null()
                    || self
                        .finished
                        .iter()
                        .any(|(key, done)| key == &session && done == id)))
                || (kind == "Failed" && !was_active)
            {
                return;
            }
            if self.finished.len() >= 256 {
                self.finished.pop_front();
            }
            if kind == "Completed" {
                completed.push(session.key());
            }
            self.finished.push_back((session, id.into()));
        }
    }

    fn subscriptions(&self, node: Option<&str>, request_number: &mut u64) -> Vec<Value> {
        self.active
            .iter()
            .filter(|(session, _)| node.is_none_or(|node| session.node == node))
            .map(|(session, run)| {
                *request_number += 1;
                let mut frame = json!({
                    "type": "session.subscribe", "nodeId": session.node,
                    "provider": session.provider, "sessionId": session.id,
                    "requestId": format!("{INTERNAL_REQUEST}{request_number}"),
                });
                if let Some(stream) = &run.stream {
                    frame["streamId"] = json!(stream);
                    frame["afterSequence"] = json!(run.sequence);
                }
                frame
            })
            .collect()
    }
}

async fn update_foreground_notice(app: &AppHandle, status: Option<&str>, runs: &Runs) {
    #[cfg(target_os = "android")]
    crate::android::update_fleet_connection(
        app,
        status,
        runs.active.len(),
        runs.active.keys().next().map(Session::key),
    )
    .await;
    #[cfg(not(target_os = "android"))]
    let _ = (app, status, runs);
}

async fn notify_complete(app: &AppHandle, session: String, desktop_notifications: &AtomicBool) {
    #[cfg(target_os = "android")]
    crate::android::notify_fleet_completion(app, session).await;
    #[cfg(not(target_os = "android"))]
    {
        let _ = session;
        desktop_notice(
            app,
            desktop_notifications,
            "Studiolo 任务已完成",
            "Agent 回复已就绪",
        );
    }
    #[cfg(target_os = "android")]
    let _ = desktop_notifications;
}

async fn send(socket: &mut FleetSocket, frame: Value) -> bool {
    matches!(
        time::timeout(
            HANDSHAKE_TIMEOUT,
            socket.send(Message::Text(frame.to_string().into()))
        )
        .await,
        Ok(Ok(()))
    )
}

enum Disconnected {
    Retry,
    Unauthorized,
    Stopped,
}

async fn run_connection(
    app: AppHandle,
    url: Url,
    token: String,
    events: Channel<FleetEvent>,
    mut commands: mpsc::Receiver<Value>,
    online: Arc<AtomicBool>,
    desktop_notifications: Arc<AtomicBool>,
) {
    let mut runs = Runs::default();
    let mut retry = 0;
    let mut request_number = 0;
    update_foreground_notice(&app, Some("connecting"), &runs).await;
    loop {
        let reason = match time::timeout(HANDSHAKE_TIMEOUT, connect_async(url.as_str())).await {
            Ok(Ok((mut socket, _))) => {
                if send(&mut socket, json!({ "type": "auth", "token": token })).await {
                    process_socket(
                        &mut socket,
                        &app,
                        &events,
                        &mut commands,
                        &online,
                        &desktop_notifications,
                        &mut runs,
                        &mut retry,
                        &mut request_number,
                    )
                    .await
                } else {
                    Disconnected::Retry
                }
            }
            _ => Disconnected::Retry,
        };
        online.store(false, Ordering::Release);
        // Queued writes can be retried by the caller against the next connection.
        while commands.try_recv().is_ok() {}
        match reason {
            Disconnected::Unauthorized => {
                let _ = events.send(FleetEvent::Unauthorized);
                break;
            }
            Disconnected::Stopped => break,
            Disconnected::Retry => {
                let _ = events.send(FleetEvent::Reconnecting);
                update_foreground_notice(&app, Some("reconnecting"), &runs).await;
                time::sleep(Duration::from_secs(RECONNECT_DELAYS[retry])).await;
                retry = (retry + 1).min(RECONNECT_DELAYS.len() - 1);
            }
        }
    }
    update_foreground_notice(&app, None, &runs).await;
}

#[allow(clippy::too_many_arguments)]
async fn process_socket(
    socket: &mut FleetSocket,
    app: &AppHandle,
    events: &Channel<FleetEvent>,
    commands: &mut mpsc::Receiver<Value>,
    online: &AtomicBool,
    desktop_notifications: &AtomicBool,
    runs: &mut Runs,
    retry: &mut usize,
    request_number: &mut u64,
) -> Disconnected {
    let mut heartbeat = time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let mut ready = false;
    let mut active_run_inventory = false;
    loop {
        tokio::select! {
            _ = time::sleep_until(deadline) => return Disconnected::Retry,
            _ = heartbeat.tick(), if ready => {
                if !matches!(time::timeout(HANDSHAKE_TIMEOUT, socket.send(Message::Ping(Vec::new().into()))).await, Ok(Ok(()))) {
                    return Disconnected::Retry;
                }
            }
            command = commands.recv(), if ready => match command {
                Some(frame) => {
                    if !send(socket, frame).await {
                        return Disconnected::Retry;
                    }
                }
                None => return Disconnected::Stopped,
            },
            incoming = socket.next() => {
                let Ok(message) = incoming.unwrap_or(Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed)) else {
                    return Disconnected::Retry;
                };
                if ready {
                    deadline = Instant::now() + CONNECTION_TIMEOUT;
                }
                let raw = match message {
                    Message::Close(frame) => {
                        return if frame.is_some_and(|frame| u16::from(frame.code) == 4401) {
                            Disconnected::Unauthorized
                        } else {
                            Disconnected::Retry
                        };
                    }
                    Message::Text(raw) => raw,
                    _ => continue,
                };
                let Ok(frame) = serde_json::from_str::<Value>(raw.as_str()) else { continue };
                let kind = frame["type"].as_str();
                let mut refresh = None;
                if kind == Some("FleetSnapshot") && !ready {
                    ready = true;
                    active_run_inventory = frame["capabilities"].as_array().is_some_and(|caps| {
                        caps.iter().any(|cap| cap.as_str() == Some("active-runs"))
                    });
                    deadline = Instant::now() + CONNECTION_TIMEOUT;
                    online.store(true, Ordering::Release);
                    *retry = 0;
                    refresh = Some(None);
                    update_foreground_notice(app, Some("online"), runs).await;
                } else if kind == Some("NodePresence") && frame["status"].as_str() == Some("online") {
                    refresh = frame["nodeId"].as_str().map(Some);
                }
                let before = runs.active.len();
                let mut completed = Vec::new();
                runs.record(&frame, &Value::Null, &mut completed);
                if before != runs.active.len() {
                    update_foreground_notice(app, Some("online"), runs).await;
                }
                for session in completed {
                    notify_complete(app, session, desktop_notifications).await;
                }
                if let Some(node) = refresh {
                    let subscriptions = runs.subscriptions(node, request_number);
                    let nodes: Vec<&str> = match (active_run_inventory, node) {
                        (false, _) => Vec::new(),
                        (true, Some(node)) => vec![node],
                        (true, None) => frame["nodes"].as_array().into_iter().flatten().filter_map(|node| node["nodeId"].as_str()).collect(),
                    };
                    for subscription in subscriptions {
                        if !send(socket, subscription).await {
                            return Disconnected::Retry;
                        }
                    }
                    for node in nodes {
                        *request_number += 1;
                        if !send(socket, json!({
                            "type": "session.active.list", "nodeId": node,
                            "requestId": format!("{INTERNAL_REQUEST}{request_number}"),
                        })).await {
                            return Disconnected::Retry;
                        }
                    }
                }
                let internal = frame["requestId"].as_str().is_some_and(|id| id.starts_with(INTERNAL_REQUEST));
                if !internal {
                    let _ = events.send(FleetEvent::Frame { frame });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tracked_run_completing_during_disconnect_alerts_only_once() {
        let mut runs = Runs::default();
        let mut notices = Vec::new();
        runs.record(&json!({
            "type": "ActiveRunsSnapshot", "nodeId": "node",
            "runs": [{ "provider": "hermes", "sessionId": "chat", "runId": "run", "streamId": "stream", "lastSeq": 0 }],
        }), &Value::Null, &mut notices);
        assert_eq!(runs.subscriptions(None, &mut 0)[0]["afterSequence"], 0);

        let complete =
            json!({ "type": "Completed", "runId": "run", "streamId": "stream", "sequence": 2 });
        let replay = json!({
            "type": "SessionStreamReplay", "nodeId": "node", "provider": "hermes", "sessionId": "chat",
            "streamId": "stream", "lastSeq": 2, "active": false, "events": [complete],
        });
        runs.record(&replay, &Value::Null, &mut notices);
        runs.record(&replay, &Value::Null, &mut notices);
        assert_eq!(notices, vec!["node::hermes::chat"]);
        assert!(runs.active.is_empty());
    }

    #[test]
    fn delayed_replay_keeps_a_newer_running_task() {
        let mut runs = Runs::default();
        let mut notices = Vec::new();
        runs.record(
            &json!({
                "type": "Accepted", "nodeId": "node", "provider": "hermes", "sessionId": "chat",
                "runId": "new", "streamId": "stream", "sequence": 4,
            }),
            &Value::Null,
            &mut notices,
        );
        runs.record(&json!({
            "type": "SessionStreamReplay", "nodeId": "node", "provider": "hermes", "sessionId": "chat",
            "streamId": "stream", "lastSeq": 3, "active": false,
            "events": [{ "type": "Completed", "runId": "old", "streamId": "stream", "sequence": 3 }],
        }), &Value::Null, &mut notices);
        assert_eq!(runs.active.len(), 1);
        assert!(notices.is_empty());
    }
}
