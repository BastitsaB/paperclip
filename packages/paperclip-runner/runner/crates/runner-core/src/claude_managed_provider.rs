use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, RETRY_AFTER};
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::codex_provider::{
    ClaudeManagedProviderConfig, Provider, ProviderEvent, ProviderKind, ProviderRuntimeIdentity,
};
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::{AuthorizedTool, ToolResult};

const ANTHROPIC_ORIGIN: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const QUALIFIED_BETA: &str = "managed-agents-2026-04-01";
const SKILLS_BETA: &str = "skills-2025-10-02";
const MAX_REMOTE_EVENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_REMOTE_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REMOTE_TOOLS: usize = 128;
const MAX_HISTORY_EVENTS: usize = 10_000;
const MAX_HISTORY_PAGES: usize = 100;
const MAX_SKILL_UPLOAD_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
struct ManagedMcpBinding {
    name: String,
    capability_url: String,
}

struct SensitiveApiKey(String);

impl Drop for SensitiveApiKey {
    fn drop(&mut self) {
        // Rust strings cannot guarantee compiler-proof zeroization, but clearing
        // prevents this long-lived owner from retaining the credential.
        self.0.clear();
    }
}

enum NetworkCommand {
    Request {
        method: Method,
        path: String,
        body: Option<Value>,
        retry: bool,
        reply: mpsc::Sender<Result<Value, String>>,
    },
    OpenStream {
        session_id: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Stop,
}

enum NetworkEvent {
    Remote(Value),
    RecoverableFailure(String),
}

struct NetworkWorker {
    commands: SyncSender<NetworkCommand>,
    events: Receiver<NetworkEvent>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl NetworkWorker {
    fn start(api_key: SensitiveApiKey, beta: &str) -> Result<Self, LocalRunnerError> {
        Self::start_at(api_key, beta, ANTHROPIC_ORIGIN, true)
    }

    fn start_at(
        api_key: SensitiveApiKey,
        beta: &str,
        origin: &str,
        require_https: bool,
    ) -> Result<Self, LocalRunnerError> {
        let (command_tx, command_rx) = mpsc::sync_channel::<NetworkCommand>(32);
        let (event_tx, event_rx) = mpsc::sync_channel::<NetworkEvent>(256);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let beta = beta.to_owned();
        let origin = origin.trim_end_matches('/').to_owned();
        let join = thread::Builder::new()
            .name("paperclip-claude-managed-network".to_owned())
            .spawn(move || {
                network_loop(
                    api_key,
                    beta,
                    origin,
                    require_https,
                    command_rx,
                    event_tx,
                    worker_stop,
                )
            })
            .map_err(|error| {
                LocalRunnerError::invalid(format!(
                    "failed to start Anthropic network worker: {error}"
                ))
            })?;
        Ok(Self {
            commands: command_tx,
            events: event_rx,
            stop,
            join: Some(join),
        })
    }

    fn request(
        &self,
        method: Method,
        path: String,
        body: Option<Value>,
    ) -> Result<Value, LocalRunnerError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.commands
            .send(NetworkCommand::Request {
                method,
                path,
                body,
                retry: true,
                reply: reply_tx,
            })
            .map_err(|_| LocalRunnerError::invalid("Anthropic network worker stopped"))?;
        reply_rx
            .recv_timeout(Duration::from_secs(35))
            .map_err(|_| LocalRunnerError::invalid("Anthropic request timed out"))?
            .map_err(LocalRunnerError::invalid)
    }

    fn request_once(
        &self,
        method: Method,
        path: String,
        body: Option<Value>,
    ) -> Result<Value, LocalRunnerError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.commands
            .send(NetworkCommand::Request {
                method,
                path,
                body,
                retry: false,
                reply: reply_tx,
            })
            .map_err(|_| LocalRunnerError::invalid("Anthropic network worker stopped"))?;
        reply_rx
            .recv_timeout(Duration::from_secs(35))
            .map_err(|_| LocalRunnerError::invalid("Anthropic request timed out"))?
            .map_err(LocalRunnerError::invalid)
    }

    fn open_stream(&self, session_id: &str) -> Result<(), LocalRunnerError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.commands
            .send(NetworkCommand::OpenStream {
                session_id: session_id.to_owned(),
                reply: reply_tx,
            })
            .map_err(|_| LocalRunnerError::invalid("Anthropic network worker stopped"))?;
        reply_rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| LocalRunnerError::invalid("Anthropic event stream startup timed out"))?
            .map_err(LocalRunnerError::invalid)
    }

    fn try_event(&self) -> Option<NetworkEvent> {
        self.events.try_recv().ok()
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.commands.send(NetworkCommand::Stop);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for NetworkWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn take_managed_mcp_binding() -> Result<Option<ManagedMcpBinding>, LocalRunnerError> {
    let name = std::env::var("PAPERCLIP_NATIVE_MCP_NAME").ok();
    let url = std::env::var("PAPERCLIP_NATIVE_MCP_URL").ok();
    let token = std::env::var("PAPERCLIP_NATIVE_MCP_TOKEN").ok();
    for key in [
        "PAPERCLIP_NATIVE_MCP_NAME",
        "PAPERCLIP_NATIVE_MCP_URL",
        "PAPERCLIP_NATIVE_MCP_TOKEN",
    ] {
        std::env::remove_var(key);
    }
    match (name, url, token) {
        (None, None, None) => Ok(None),
        (Some(name), Some(url), Some(mut token))
            if !name.trim().is_empty() && url.starts_with("https://") && !token.is_empty() =>
        {
            let separator = if url.contains('?') { '&' } else { '?' };
            let capability_url = format!(
                "{url}{separator}paperclip_capability={}",
                percent_encode_query(&token)
            );
            token.clear();
            Ok(Some(ManagedMcpBinding {
                name,
                capability_url,
            }))
        }
        (_, _, Some(mut token)) => {
            token.clear();
            Err(LocalRunnerError::invalid(
                "Claude Managed MCP binding is incomplete or unsafe",
            ))
        }
        _ => Err(LocalRunnerError::invalid(
            "Claude Managed MCP binding is incomplete",
        )),
    }
}

fn runtime_array<'a>(context: &'a Value, field: &str) -> Result<&'a Vec<Value>, LocalRunnerError> {
    context.get(field).and_then(Value::as_array).ok_or_else(|| {
        LocalRunnerError::invalid(format!("runtimeContext.{field} must be an array"))
    })
}

fn runtime_text<'a>(value: &'a Value, pointer: &str) -> Result<&'a str, LocalRunnerError> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| LocalRunnerError::invalid(format!("runtimeContext {pointer} is missing")))
}

fn collect_bundle_files(root: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>, LocalRunnerError> {
    fn visit(
        root: &Path,
        current: &Path,
        files: &mut Vec<(PathBuf, Vec<u8>)>,
        total: &mut usize,
    ) -> Result<(), LocalRunnerError> {
        let mut entries = fs::read_dir(current)
            .map_err(|error| {
                LocalRunnerError::invalid(format!("failed to read runtime asset: {error}"))
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                LocalRunnerError::invalid(format!("failed to enumerate runtime asset: {error}"))
            })?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                LocalRunnerError::invalid(format!("failed to inspect runtime asset: {error}"))
            })?;
            if metadata.file_type().is_symlink() {
                return Err(LocalRunnerError::invalid(
                    "managed skill bundles may not contain symlinks",
                ));
            }
            if metadata.is_dir() {
                visit(root, &path, files, total)?;
            } else if metadata.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| LocalRunnerError::invalid("runtime asset escaped its root"))?
                    .to_path_buf();
                let bytes = fs::read(&path).map_err(|error| {
                    LocalRunnerError::invalid(format!("failed to read runtime asset file: {error}"))
                })?;
                *total = total.saturating_add(bytes.len());
                if *total > MAX_SKILL_UPLOAD_BYTES {
                    return Err(LocalRunnerError::invalid(
                        "managed skill upload exceeded its size limit",
                    ));
                }
                files.push((relative, bytes));
            }
        }
        Ok(())
    }
    let metadata = fs::symlink_metadata(root).map_err(|error| {
        LocalRunnerError::invalid(format!("runtime asset is unavailable: {error}"))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(LocalRunnerError::invalid(
            "runtime asset root must be a real directory",
        ));
    }
    let mut files = Vec::new();
    let mut total = 0;
    visit(root, root, &mut files, &mut total)?;
    Ok(files)
}

fn multipart_field(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .as_bytes(),
    );
}

fn multipart_file(body: &mut Vec<u8>, boundary: &str, filename: &str, bytes: &[u8]) {
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files[]\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
}

fn upload_managed_skill(
    client: &Client,
    origin: &str,
    title: &str,
    top_level: &str,
    mut files: Vec<(PathBuf, Vec<u8>)>,
    generated_skill: Option<String>,
) -> Result<Value, LocalRunnerError> {
    let listed: Value = client
        .get(format!("{origin}/v1/skills?limit=1000&source=custom"))
        .send()
        .map_err(|_| LocalRunnerError::invalid("Anthropic skill mapping lookup failed"))?
        .json()
        .map_err(|_| {
            LocalRunnerError::invalid("Anthropic skill mapping lookup returned invalid JSON")
        })?;
    if let Some(existing) = listed
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|skill| {
            skill.get("display_title").and_then(Value::as_str) == Some(title)
                || skill.get("title").and_then(Value::as_str) == Some(title)
        })
    {
        let skill_id = existing
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| LocalRunnerError::invalid("Anthropic skill mapping omitted id"))?;
        let version = existing.get("latest_version").cloned().ok_or_else(|| {
            LocalRunnerError::invalid("Anthropic skill mapping omitted latest_version")
        })?;
        return Ok(json!({ "type": "custom", "skill_id": skill_id, "version": version }));
    }
    if let Some(skill) = generated_skill {
        files.push((PathBuf::from("SKILL.md"), skill.into_bytes()));
    }
    if !files.iter().any(|(path, _)| path == Path::new("SKILL.md")) {
        return Err(LocalRunnerError::invalid(
            "managed custom skill bundle is missing SKILL.md",
        ));
    }
    let boundary = format!(
        "paperclip-{}",
        &format!("{:x}", Sha256::digest(title.as_bytes()))[..24]
    );
    let mut body = Vec::new();
    multipart_field(&mut body, &boundary, "display_title", title);
    multipart_field(
        &mut body,
        &boundary,
        "description",
        "Paperclip-owned immutable runtime context asset",
    );
    files.sort_by(|left, right| left.0.cmp(&right.0));
    for (path, bytes) in files {
        let relative = path
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        multipart_file(
            &mut body,
            &boundary,
            &format!("{top_level}/{relative}"),
            &bytes,
        );
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let response = client
        .post(format!("{origin}/v1/skills"))
        .header(
            CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .map_err(|_| LocalRunnerError::invalid("Anthropic skill upload transport failed"))?;
    if !response.status().is_success() {
        return Err(LocalRunnerError::invalid(format!(
            "Anthropic skill upload failed with HTTP {}",
            response.status().as_u16()
        )));
    }
    let value: Value = response
        .json()
        .map_err(|_| LocalRunnerError::invalid("Anthropic skill upload returned invalid JSON"))?;
    let skill_id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid("Anthropic skill upload omitted id"))?;
    let version = value.get("latest_version").cloned().ok_or_else(|| {
        LocalRunnerError::invalid("Anthropic skill upload omitted latest_version")
    })?;
    Ok(json!({ "type": "custom", "skill_id": skill_id, "version": version }))
}

fn upload_managed_runtime_skills_at(
    api_key: &str,
    config: &ClaudeManagedProviderConfig,
    origin: &str,
    require_https: bool,
) -> Result<Vec<Value>, LocalRunnerError> {
    let Some(context) = config.runtime_context.as_ref() else {
        return Ok(Vec::new());
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-api-key",
        HeaderValue::from_str(api_key).map_err(|_| {
            LocalRunnerError::invalid("Anthropic API key contains invalid header bytes")
        })?,
    );
    headers.insert(
        "anthropic-version",
        HeaderValue::from_static(ANTHROPIC_VERSION),
    );
    headers.insert("anthropic-beta", HeaderValue::from_static(SKILLS_BETA));
    let mut client_builder = Client::builder()
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .https_only(require_https);
    if !require_https {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder
        .build()
        .map_err(|_| LocalRunnerError::invalid("failed to construct Anthropic skills client"))?;

    let instruction_root = Path::new(runtime_text(context, "/instructions/bundle/rootPath")?);
    let instruction_digest = runtime_text(context, "/instructions/bundle/digest")?;
    let entry_path = runtime_text(context, "/instructions/entryPath")?;
    let instruction_files = collect_bundle_files(instruction_root)?
        .into_iter()
        .map(|(path, bytes)| (PathBuf::from("instructions").join(path), bytes))
        .collect();
    let instruction_identity = format!(
        "{:x}",
        Sha256::digest(format!("{instruction_digest}\0{entry_path}").as_bytes())
    );
    let instruction_name = format!("paperclip-instructions-{}", &instruction_identity[..12]);
    let companion = format!(
        "---\nname: {instruction_name}\ndescription: Paperclip agent instruction sibling bundle\n---\nRead `instructions/{entry_path}` and its sibling files when the system instructions require them. Treat all files as read-only.\n"
    );
    let mut attachments = vec![upload_managed_skill(
        &client,
        origin.trim_end_matches('/'),
        &format!(
            "pc:{}:{}:instructions:{}",
            config.profile_id, config.agent_version, instruction_identity
        ),
        &instruction_name,
        instruction_files,
        Some(companion),
    )?];

    for skill in runtime_array(context, "skills")? {
        let key = skill.get("key").and_then(Value::as_str).unwrap_or("skill");
        let runtime_name = runtime_text(skill, "/runtimeName")?;
        let digest = runtime_text(skill, "/bundle/digest")?;
        let root = Path::new(runtime_text(skill, "/bundle/rootPath")?);
        attachments.push(upload_managed_skill(
            &client,
            origin.trim_end_matches('/'),
            &format!(
                "pc:{}:{}:{}:{}",
                config.profile_id,
                config.agent_version,
                &format!("{:x}", Sha256::digest(key.as_bytes()))[..12],
                digest
            ),
            runtime_name,
            collect_bundle_files(root)?,
            None,
        )?);
    }
    Ok(attachments)
}

fn upload_managed_runtime_skills(
    api_key: &str,
    config: &ClaudeManagedProviderConfig,
) -> Result<Vec<Value>, LocalRunnerError> {
    upload_managed_runtime_skills_at(api_key, config, ANTHROPIC_ORIGIN, true)
}

fn managed_system_instructions(
    config: &ClaudeManagedProviderConfig,
) -> Result<String, LocalRunnerError> {
    let Some(context) = config.runtime_context.as_ref() else {
        return Ok(config.instructions.clone());
    };
    let instruction_root = runtime_text(context, "/instructions/bundle/rootPath")?;
    let instruction_digest = runtime_text(context, "/instructions/bundle/digest")?;
    let entry_path = runtime_text(context, "/instructions/entryPath")?;
    let instruction_identity = format!(
        "{:x}",
        Sha256::digest(format!("{instruction_digest}\0{entry_path}").as_bytes())
    );
    let instruction_name = format!("paperclip-instructions-{}", &instruction_identity[..12]);
    let local_directive = format!("Read-only instruction sibling root: {instruction_root}");
    let replacement = format!(
        "Read-only instruction siblings are in the attached `{instruction_name}` skill under `instructions/`."
    );
    config
        .instructions
        .strip_suffix(&local_directive)
        .map(|prefix| format!("{prefix}{replacement}"))
        .ok_or_else(|| {
            LocalRunnerError::invalid(
                "Claude Managed instruction-root directive is missing or inconsistent",
            )
        })
}

fn managed_agent_overrides(
    config: &ClaudeManagedProviderConfig,
    system_instructions: &str,
    mut custom_tools: Vec<Value>,
    skills: &[Value],
    mcp: Option<&ManagedMcpBinding>,
) -> Value {
    let mut tools = vec![json!({
        "type": "agent_toolset_20260401",
        "default_config": { "enabled": false },
        "configs": [{ "name": "read", "enabled": true }]
    })];
    tools.append(&mut custom_tools);
    let mcp_servers = mcp
        .map(|binding| {
            vec![json!({
                "type": "url",
                "name": binding.name,
                "url": binding.capability_url,
            })]
        })
        .unwrap_or_default();
    if let Some(binding) = mcp {
        tools.push(json!({
            "type": "mcp_toolset",
            "mcp_server_name": binding.name,
            "default_config": { "enabled": true }
        }));
    }
    json!({
        "model": { "id": config.model },
        "system": system_instructions,
        "tools": tools,
        "mcp_servers": mcp_servers,
        "skills": skills,
    })
}

fn network_loop(
    api_key: SensitiveApiKey,
    beta: String,
    origin: String,
    require_https: bool,
    commands: Receiver<NetworkCommand>,
    events: SyncSender<NetworkEvent>,
    stop: Arc<AtomicBool>,
) {
    let mut headers = HeaderMap::new();
    let Ok(key) = HeaderValue::from_str(&api_key.0) else {
        let _ = events.send(NetworkEvent::RecoverableFailure(
            "Anthropic API key contains invalid header bytes".to_owned(),
        ));
        return;
    };
    headers.insert("x-api-key", key);
    headers.insert(
        "anthropic-version",
        HeaderValue::from_static(ANTHROPIC_VERSION),
    );
    let Ok(beta_header) = HeaderValue::from_str(&beta) else {
        let _ = events.send(NetworkEvent::RecoverableFailure(
            "Anthropic beta version is invalid".to_owned(),
        ));
        return;
    };
    headers.insert("anthropic-beta", beta_header);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let Ok(client) = Client::builder()
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .https_only(require_https)
        .build()
    else {
        let _ = events.send(NetworkEvent::RecoverableFailure(
            "failed to construct Anthropic HTTPS client".to_owned(),
        ));
        return;
    };
    while let Ok(command) = commands.recv() {
        match command {
            NetworkCommand::Request {
                method,
                path,
                body,
                retry,
                reply,
            } => {
                let result = bounded_request(&client, &origin, method, &path, body, retry);
                let _ = reply.send(result);
            }
            NetworkCommand::OpenStream { session_id, reply } => {
                let stream_client = client.clone();
                let stream_origin = origin.clone();
                let stream_events = events.clone();
                let stream_stop = Arc::clone(&stop);
                thread::spawn(move || {
                    stream_remote_events(
                        stream_client,
                        stream_origin,
                        session_id,
                        stream_events,
                        stream_stop,
                        reply,
                    )
                });
            }
            NetworkCommand::Stop => break,
        }
    }
    stop.store(true, Ordering::Release);
    drop(api_key);
}

fn bounded_request(
    client: &Client,
    origin: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
    retry: bool,
) -> Result<Value, String> {
    let mut backoff = Duration::from_millis(250);
    let attempts = if retry { 4 } else { 1 };
    for attempt in 0..attempts {
        let mut request = client.request(method.clone(), format!("{origin}{path}"));
        if let Some(body) = body.as_ref() {
            request = request.json(body);
        }
        let mut response = match request.send() {
            Ok(response) => response,
            Err(_) if retry && attempt + 1 < attempts => {
                thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(4));
                continue;
            }
            Err(_) => return Err("Anthropic request transport failed".to_owned()),
        };
        let status = response.status();
        if !status.is_success() {
            if method == Method::DELETE && status.as_u16() == 404 {
                return Ok(json!({ "deleted": true, "alreadyMissing": true }));
            }
            if retry
                && (status.as_u16() == 429 || status.is_server_error())
                && attempt + 1 < attempts
            {
                let wait = response
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(backoff)
                    .min(Duration::from_secs(8));
                thread::sleep(wait);
                backoff = (backoff * 2).min(Duration::from_secs(4));
                continue;
            }
            return Err(format!(
                "Anthropic request failed with HTTP {}",
                status.as_u16()
            ));
        }
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take((MAX_REMOTE_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Anthropic response read failed".to_owned())?;
        if bytes.len() > MAX_REMOTE_RESPONSE_BYTES {
            return Err("Anthropic response exceeded the PRP payload limit".to_owned());
        }
        if bytes.is_empty() {
            return Ok(json!({}));
        }
        return serde_json::from_slice(&bytes)
            .map_err(|_| "Anthropic response was not valid JSON".to_owned());
    }
    Err("Anthropic request retries exhausted".to_owned())
}

fn stream_remote_events(
    client: Client,
    origin: String,
    session_id: String,
    events: SyncSender<NetworkEvent>,
    stop: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<(), String>>,
) {
    let mut ready = Some(ready);
    while !stop.load(Ordering::Acquire) {
        let response = client
            .get(format!("{origin}/v1/sessions/{session_id}/events/stream?event_deltas%5B%5D=agent.message&event_deltas%5B%5D=agent.thinking&beta=true"))
            .send();
        let Ok(response) = response else {
            if let Some(ready) = ready.take() {
                let _ = ready.send(Err("Anthropic event stream connection failed".to_owned()));
                return;
            }
            return;
        };
        if !response.status().is_success() {
            if let Some(ready) = ready.take() {
                let _ = ready.send(Err(format!(
                    "Anthropic event stream failed with HTTP {}",
                    response.status().as_u16()
                )));
                return;
            }
            return;
        }
        if let Some(ready) = ready.take() {
            let _ = ready.send(Ok(()));
        }
        let reader = BufReader::new(response);
        let mut data = String::new();
        let mut reader = reader;
        loop {
            if stop.load(Ordering::Acquire) {
                return;
            }
            let mut line = String::new();
            let read = match reader
                .by_ref()
                .take((MAX_REMOTE_EVENT_BYTES + 1) as u64)
                .read_line(&mut line)
            {
                Ok(read) => read,
                Err(_) => break,
            };
            if read == 0 {
                break;
            }
            if line.len() > MAX_REMOTE_EVENT_BYTES {
                let _ = events.try_send(NetworkEvent::RecoverableFailure(
                    "Anthropic event exceeded the PRP payload limit".to_owned(),
                ));
                return;
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !data.is_empty() {
                    if data.len() > MAX_REMOTE_EVENT_BYTES {
                        let _ = events.try_send(NetworkEvent::RecoverableFailure(
                            "Anthropic event exceeded the PRP payload limit".to_owned(),
                        ));
                        return;
                    }
                    match serde_json::from_str::<Value>(&data) {
                        Ok(value) => {
                            let _ = events.try_send(NetworkEvent::Remote(value));
                        }
                        Err(_) => {
                            let _ = events.try_send(NetworkEvent::RecoverableFailure(
                                "Anthropic event stream emitted malformed JSON".to_owned(),
                            ));
                            return;
                        }
                    }
                    data.clear();
                }
            } else if let Some(chunk) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(chunk.trim_start());
                if data.len() > MAX_REMOTE_EVENT_BYTES {
                    let _ = events.try_send(NetworkEvent::RecoverableFailure(
                        "Anthropic event exceeded the PRP payload limit".to_owned(),
                    ));
                    return;
                }
            }
        }
        if !stop.load(Ordering::Acquire) {
            let _ = events.try_send(NetworkEvent::RecoverableFailure(
                "Anthropic event stream disconnected".to_owned(),
            ));
            return;
        }
    }
}

pub struct ClaudeManagedProvider {
    session_id: String,
    worker: NetworkWorker,
    remote_to_canonical: BTreeMap<String, String>,
    operation_input_schemas: BTreeMap<String, Value>,
    pending_remote_calls: BTreeMap<String, String>,
    seen_event_fingerprints: BTreeMap<String, String>,
    durable_event_cursor: Option<String>,
    replay_queue: VecDeque<Value>,
    normalized_queue: VecDeque<ProviderEvent>,
    interrupted_turn: Option<String>,
    current_turn_id: Option<String>,
    model_request_count: u64,
    current_budget_cents: u64,
    reconnect_backoff: Duration,
    config: ClaudeManagedProviderConfig,
    system_instructions: String,
    managed_skills: Vec<Value>,
    mcp_binding: Option<ManagedMcpBinding>,
}

impl ClaudeManagedProvider {
    pub fn start(
        config: &ClaudeManagedProviderConfig,
        tools: Vec<AuthorizedTool>,
        resume_session_id: Option<&str>,
        resume_event_cursor: Option<&str>,
        resume_model_request_count: u64,
    ) -> Result<Self, LocalRunnerError> {
        let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| {
            LocalRunnerError::invalid("ANTHROPIC_API_KEY is required for Claude Agent")
        })?;
        std::env::remove_var("ANTHROPIC_API_KEY");
        let mcp_binding = take_managed_mcp_binding()?;
        let managed_skills = upload_managed_runtime_skills(&api_key, config)?;
        Self::start_with_worker(
            config,
            tools,
            resume_session_id,
            resume_event_cursor,
            resume_model_request_count,
            managed_skills,
            mcp_binding,
            SensitiveApiKey(api_key),
            NetworkWorker::start,
        )
    }

    fn start_with_worker<F>(
        config: &ClaudeManagedProviderConfig,
        tools: Vec<AuthorizedTool>,
        resume_session_id: Option<&str>,
        resume_event_cursor: Option<&str>,
        resume_model_request_count: u64,
        managed_skills: Vec<Value>,
        mcp_binding: Option<ManagedMcpBinding>,
        api_key: SensitiveApiKey,
        start_worker: F,
    ) -> Result<Self, LocalRunnerError>
    where
        F: FnOnce(SensitiveApiKey, &str) -> Result<NetworkWorker, LocalRunnerError>,
    {
        validate_config(config)?;
        let system_instructions = managed_system_instructions(config)?;
        let worker = start_worker(api_key, &config.beta_version)?;
        let (tool_payload, reverse, operation_input_schemas) = encode_tools(&tools)?;
        let agent_overrides = managed_agent_overrides(
            config,
            &system_instructions,
            tool_payload,
            &managed_skills,
            mcp_binding.as_ref(),
        );
        let mut replay_queue = VecDeque::new();
        let session_id = if let Some(session_id) = resume_session_id {
            let session = worker.request(
                Method::GET,
                format!("/v1/sessions/{session_id}?beta=true"),
                None,
            )?;
            verify_remote_session(config, &session)?;
            worker.request(
                Method::POST,
                format!("/v1/sessions/{session_id}?beta=true"),
                Some(json!({ "agent": agent_overrides })),
            )?;
            session_id.to_owned()
        } else {
            let version = config
                .agent_version
                .parse::<u64>()
                .map(Value::from)
                .unwrap_or_else(|_| Value::String(config.agent_version.clone()));
            // Session creation is not known to be idempotent. A transport
            // failure after Anthropic accepts the request must not result in
            // runnerd creating a second managed session on retry.
            let session = worker.request_once(
                Method::POST,
                "/v1/sessions?beta=true".to_owned(),
                Some(json!({
                    "agent": {
                        "type": "agent_with_overrides",
                        "id": config.anthropic_agent_id,
                        "version": version,
                        "model": agent_overrides["model"].clone(),
                        "system": agent_overrides["system"].clone(),
                        "tools": agent_overrides["tools"].clone(),
                        "mcp_servers": agent_overrides["mcp_servers"].clone(),
                        "skills": agent_overrides["skills"].clone()
                    },
                    "environment_id": config.environment_id,
                    "budget": {
                        "type": "limit",
                        "max_list_cost": {
                            "currency": "USD",
                            "amount": spend_cap_cents(config.max_session_list_cost_usd)?.to_string()
                        }
                    }
                })),
            )?;
            required_text(&session, "id", "Anthropic session create omitted id")?.to_owned()
        };
        worker.open_stream(&session_id)?;
        // Streams never replay. Open first, then overlap a durable history read
        // and deduplicate by event id so no recovery-gap event can be missed.
        if resume_session_id.is_some() {
            replay_queue.extend(fetch_event_history(
                &worker,
                &session_id,
                resume_event_cursor,
            )?);
        }
        Ok(Self {
            session_id,
            worker,
            remote_to_canonical: reverse,
            operation_input_schemas,
            pending_remote_calls: BTreeMap::new(),
            seen_event_fingerprints: BTreeMap::new(),
            durable_event_cursor: resume_event_cursor.map(str::to_owned),
            replay_queue,
            normalized_queue: VecDeque::new(),
            interrupted_turn: None,
            current_turn_id: None,
            model_request_count: resume_model_request_count,
            current_budget_cents: spend_cap_cents(config.max_session_list_cost_usd)?,
            reconnect_backoff: Duration::from_millis(250),
            config: config.clone(),
            system_instructions,
            managed_skills,
            mcp_binding,
        })
    }

    fn send_events(&self, events: Value) -> Result<Value, LocalRunnerError> {
        // Event POSTs are not blindly retried: a lost response is ambiguous.
        // Custom-tool delivery reconciles requires_action below; user/interrupt
        // ambiguity fails recoverably so durable history can be examined.
        self.worker.request_once(
            Method::POST,
            format!("/v1/sessions/{}/events?beta=true", self.session_id),
            Some(json!({ "events": events })),
        )
    }

    fn normalize_remote_event(
        &mut self,
        value: Value,
    ) -> Result<Option<ProviderEvent>, LocalRunnerError> {
        // Managed Agents emits event objects directly. `event_start.event` is
        // the descriptor for a provisional item, not an outer event envelope.
        let event = &value;
        if let Some(id) = event.get("id").and_then(Value::as_str) {
            let fingerprint = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(event).map_err(
                    |_| LocalRunnerError::invalid("Anthropic event could not be fingerprinted")
                )?)
            );
            if let Some(prior) = self.seen_event_fingerprints.get(id) {
                if prior == &fingerprint {
                    return Ok(None);
                }
                return Err(LocalRunnerError::invalid(
                    "Anthropic reused a remote event ID with conflicting content",
                ));
            }
            self.seen_event_fingerprints
                .insert(id.to_owned(), fingerprint);
            self.durable_event_cursor = Some(id.to_owned());
        }
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "event_start" => {
                let preview = event.get("event").unwrap_or(&Value::Null);
                let preview_type = preview
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let preview_id = preview
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("remote-preview");
                match preview_type {
                    "agent.message" => Ok(Some(ProviderEvent::Notification {
                        method: "item/started".to_owned(),
                        params: json!({ "turnId": self.current_turn_id, "item": { "id": preview_id, "type": "agentMessage", "provisional": true } }),
                    })),
                    "agent.thinking" => Ok(Some(ProviderEvent::Notification {
                        method: "item/started".to_owned(),
                        params: json!({ "turnId": self.current_turn_id, "item": { "id": preview_id, "type": "progress", "phase": "thinking" } }),
                    })),
                    _ => Ok(None),
                }
            }
            "event_delta" => Ok(Some(ProviderEvent::Notification {
                method: "item/agentMessage/delta".to_owned(),
                params: json!({
                    "turnId": self.current_turn_id,
                    "itemId": event.get("event_id"),
                    "delta": event.pointer("/delta/content/text").and_then(Value::as_str).unwrap_or_default(),
                    "provisional": true,
                }),
            })),
            "agent.custom_tool_use" => {
                let call_id = required_text(event, "id", "Anthropic custom tool event omitted id")?
                    .to_owned();
                let remote_name = event
                    .get("name")
                    .or_else(|| event.get("tool_name"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        LocalRunnerError::invalid("Anthropic custom tool event omitted name")
                    })?;
                let operation_id = self
                    .remote_to_canonical
                    .get(remote_name)
                    .ok_or_else(|| {
                        LocalRunnerError::invalid("Anthropic requested an unauthorized custom tool")
                    })?
                    .clone();
                let input = event.get("input").cloned().unwrap_or_else(|| json!({}));
                let schema = self
                    .operation_input_schemas
                    .get(&operation_id)
                    .ok_or_else(|| {
                        LocalRunnerError::invalid(
                            "Anthropic requested a tool without a durable input schema",
                        )
                    })?;
                let validator = jsonschema::validator_for(schema).map_err(|_| {
                    LocalRunnerError::invalid(
                        "authorized Paperclip tool has an invalid JSON Schema",
                    )
                })?;
                if !validator.is_valid(&input) {
                    return Err(LocalRunnerError::invalid(
                        "Anthropic custom tool arguments failed schema validation",
                    ));
                }
                self.pending_remote_calls
                    .insert(call_id.clone(), operation_id.clone());
                Ok(Some(ProviderEvent::ToolCall {
                    call_id,
                    operation_id,
                    input,
                }))
            }
            "agent.message" => Ok(Some(ProviderEvent::Notification {
                method: "item/completed".to_owned(),
                params: json!({ "turnId": self.current_turn_id, "item": { "id": event.get("id"), "type": "agentMessage", "text": extract_text(event), "authoritative": true }, "remoteEventId": event.get("id") }),
            })),
            "agent.thinking" => Ok(Some(ProviderEvent::Notification {
                method: "item/started".to_owned(),
                params: json!({ "turnId": self.current_turn_id, "item": { "id": event.get("id"), "type": "progress", "phase": "thinking" }, "remoteEventId": event.get("id") }),
            })),
            "span.model_request_end" => {
                self.model_request_count = self.model_request_count.saturating_add(1);
                Ok(None)
            }
            "session.usage" => {
                let mut params = event.clone();
                if let Some(usage) = params.get_mut("usage").and_then(Value::as_object_mut) {
                    usage.insert(
                        "requestCount".to_owned(),
                        Value::from(self.model_request_count),
                    );
                }
                Ok(Some(ProviderEvent::Notification {
                    method: "thread/tokenUsage/updated".to_owned(),
                    params,
                }))
            }
            "session.status_idle" | "session.status" => {
                let status = event
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("idle");
                let stop_reason = event.get("stop_reason").or_else(|| event.get("stopReason"));
                let reason = stop_reason
                    .and_then(|value| {
                        value
                            .get("type")
                            .and_then(Value::as_str)
                            .or_else(|| value.as_str())
                    })
                    .unwrap_or_default();
                if status == "terminated" {
                    return Err(LocalRunnerError::invalid(
                        "Anthropic managed session terminated",
                    ));
                }
                match reason {
                    "requires_action" => Ok(Some(ProviderEvent::Notification {
                        method: "provider/waitingForToolResult".to_owned(),
                        params: json!({
                            "turnId": self.current_turn_id,
                            "pendingRemoteEventIds": stop_reason.and_then(|value| value.get("event_ids")).cloned().unwrap_or_else(|| json!([])),
                        }),
                    })),
                    "end_turn" => {
                        let turn_id = self.current_turn_id.take();
                        let interrupted = self.interrupted_turn.take().is_some();
                        Ok(Some(ProviderEvent::Notification {
                            method: "turn/completed".to_owned(),
                            params: json!({ "turnId": turn_id, "turn": { "id": turn_id, "status": if interrupted { "interrupted" } else { "completed" } }, "remoteEventId": event.get("id") }),
                        }))
                    }
                    "retries_exhausted" => {
                        let turn_id = self.current_turn_id.take();
                        Ok(Some(ProviderEvent::Notification {
                            method: "turn/completed".to_owned(),
                            params: json!({
                                "turnId": turn_id,
                                "turn": { "id": turn_id, "status": "failed" },
                                "error": { "code": "provider_retries_exhausted", "retryable": true },
                                "remoteEventId": event.get("id"),
                            }),
                        }))
                    }
                    "budget_reached" => Ok(Some(ProviderEvent::Notification {
                        method: "provider/budgetReached".to_owned(),
                        params: json!({
                            "turnId": self.current_turn_id,
                            "status": "budget_reached",
                            "stopReason": "provider_quota",
                            "remoteEventId": event.get("id"),
                        }),
                    })),
                    "" => Ok(None),
                    _ => Err(LocalRunnerError::invalid(
                        "Anthropic managed session returned an unknown stop reason",
                    )),
                }
            }
            "session.status_running" => Ok(None),
            "session.status_rescheduled" => Ok(Some(ProviderEvent::Notification {
                method: "provider/reconnecting".to_owned(),
                params: json!({ "service": "anthropic_managed_agents", "reason": "remote_rescheduled" }),
            })),
            "session.status_terminated" => Err(LocalRunnerError::invalid(
                "Anthropic managed session terminated and cannot be resumed",
            )),
            "session.error" => Err(LocalRunnerError::invalid(
                "Anthropic managed session reported an error",
            )),
            _ => Ok(None),
        }
    }
}

impl Provider for ClaudeManagedProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::ClaudeManaged
    }

    fn runtime_identity(&self) -> ProviderRuntimeIdentity {
        ProviderRuntimeIdentity::RemoteService {
            service: "anthropic_managed_agents".to_owned(),
            provider_session_id: self.session_id.clone(),
            process_id: None,
        }
    }

    fn session_identity(&self) -> &str {
        &self.session_id
    }
    fn provider_session_id(&self) -> Option<&str> {
        Some(&self.session_id)
    }
    fn durable_event_cursor(&self) -> Option<&str> {
        self.durable_event_cursor.as_deref()
    }

    fn configure_tools(&mut self, tools: Vec<AuthorizedTool>) -> Result<(), LocalRunnerError> {
        let (payload, reverse, operation_input_schemas) = encode_tools(&tools)?;
        let overrides = managed_agent_overrides(
            &self.config,
            &self.system_instructions,
            payload,
            &self.managed_skills,
            self.mcp_binding.as_ref(),
        );
        self.worker.request(
            Method::POST,
            format!("/v1/sessions/{}?beta=true", self.session_id),
            Some(json!({ "agent": overrides })),
        )?;
        self.remote_to_canonical = reverse;
        self.operation_input_schemas = operation_input_schemas;
        Ok(())
    }

    fn increase_budget(&mut self, max_list_cost_usd: f64) -> Result<Value, LocalRunnerError> {
        let cents = spend_cap_cents(max_list_cost_usd)?;
        if cents <= self.current_budget_cents {
            return Err(LocalRunnerError::invalid(
                "Claude Agent spend ceiling may only be raised monotonically",
            ));
        }
        let response = self.worker.request(
            Method::POST,
            format!("/v1/sessions/{}?beta=true", self.session_id),
            Some(json!({
                "budget": {
                    "type": "limit",
                    "max_list_cost": { "currency": "USD", "amount": cents.to_string() }
                }
            })),
        )?;
        self.current_budget_cents = cents;
        Ok(response)
    }

    fn destroy_session(&mut self) -> Result<(), LocalRunnerError> {
        self.worker.request(
            Method::DELETE,
            format!("/v1/sessions/{}?beta=true", self.session_id),
            None,
        )?;
        self.worker.stop();
        Ok(())
    }

    fn start_turn(
        &mut self,
        message: &str,
        _cwd: &str,
        turn_id: &str,
    ) -> Result<Value, LocalRunnerError> {
        let response = self.send_events(
            json!([{ "type": "user.message", "content": [{ "type": "text", "text": message }] }]),
        )?;
        self.current_turn_id = Some(turn_id.to_owned());
        self.normalized_queue.push_back(ProviderEvent::Notification {
            method: "turn/started".to_owned(),
            params: json!({ "turnId": turn_id, "turn": { "id": turn_id, "status": "inProgress" } }),
        });
        Ok(response)
    }

    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError> {
        self.interrupted_turn = Some(turn_id.to_owned());
        self.send_events(json!([{ "type": "user.interrupt" }]))
    }

    fn read(&mut self) -> Result<Value, LocalRunnerError> {
        let session = self.worker.request(
            Method::GET,
            format!("/v1/sessions/{}?beta=true", self.session_id),
            None,
        )?;
        let events = self.worker.request(
            Method::GET,
            format!("/v1/sessions/{}/events?beta=true", self.session_id),
            None,
        )?;
        Ok(json!({ "session": session, "events": events }))
    }

    fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError> {
        if let Some(event) = self.normalized_queue.pop_front() {
            return Ok(Some(event));
        }
        if let Some(event) = self.replay_queue.pop_front() {
            return self.normalize_remote_event(event);
        }
        match self.worker.try_event() {
            Some(NetworkEvent::Remote(value)) => {
                self.reconnect_backoff = Duration::from_millis(250);
                self.normalize_remote_event(value)
            }
            Some(NetworkEvent::RecoverableFailure(detail)) => {
                if let Ok(history) = fetch_event_history(
                    &self.worker,
                    &self.session_id,
                    self.durable_event_cursor.as_deref(),
                ) {
                    self.replay_queue.extend(history);
                }
                // Durable history is authoritative. Reconcile it before opening
                // a fresh preview stream so the reconnect gap cannot reorder
                // provisional content ahead of persisted events.
                thread::sleep(self.reconnect_backoff);
                self.worker.open_stream(&self.session_id)?;
                self.reconnect_backoff = (self.reconnect_backoff * 2).min(Duration::from_secs(8));
                Ok(Some(ProviderEvent::Notification {
                    method: "provider/reconnecting".to_owned(),
                    params: json!({ "service": "anthropic_managed_agents", "detail": detail }),
                }))
            }
            None => Ok(None),
        }
    }

    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        match self.pending_remote_calls.get(&result.call_id) {
            Some(expected) if expected != &result.operation_id => {
                return Err(LocalRunnerError::invalid(
                    "Claude Agent tool result operation does not match pending tool use",
                ));
            }
            None => {
                // A duplicate PRP result may arrive after runner recovery.
                // Managed Agents does not retain custom-tool-result events in
                // normal history, so the session's requires_action IDs are the
                // authoritative delivery receipt.
                if !self.remote_call_still_pending(&result.call_id)? {
                    return Ok(());
                }
            }
            Some(_) => {}
        }
        let event = json!({
            "type": "user.custom_tool_result",
            "custom_tool_use_id": result.call_id,
            "content": [{ "type": "text", "text": serde_json::to_string(&result.result).unwrap_or_else(|_| "null".to_owned()) }],
            "is_error": result.is_error
        });
        let event_path = format!("/v1/sessions/{}/events?beta=true", self.session_id);
        let body = json!({ "events": [event.clone()] });
        for attempt in 0..2 {
            if self
                .worker
                .request_once(Method::POST, event_path.clone(), Some(body.clone()))
                .is_ok()
            {
                self.pending_remote_calls.remove(&result.call_id);
                return Ok(());
            }
            if !self.remote_call_still_pending(&result.call_id)? {
                self.pending_remote_calls.remove(&result.call_id);
                return Ok(());
            }
            if attempt == 1 {
                return Err(LocalRunnerError::invalid(
                    "Anthropic custom tool result delivery remains ambiguous",
                ));
            }
        }
        unreachable!("bounded tool-result delivery loop always returns")
    }

    fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        self.worker.stop();
        Ok(())
    }
}

impl ClaudeManagedProvider {
    fn remote_call_still_pending(&self, call_id: &str) -> Result<bool, LocalRunnerError> {
        let session = self.worker.request(
            Method::GET,
            format!("/v1/sessions/{}?beta=true", self.session_id),
            None,
        )?;
        Ok(session
            .pointer("/stop_reason/event_ids")
            .or_else(|| session.pointer("/requires_action/event_ids"))
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(call_id))))
    }
}

fn validate_config(config: &ClaudeManagedProviderConfig) -> Result<(), LocalRunnerError> {
    if config.beta_version != QUALIFIED_BETA {
        return Err(LocalRunnerError::invalid(
            "unsupported Anthropic Managed Agents beta version",
        ));
    }
    if [
        config.model.as_str(),
        config.profile_id.as_str(),
        config.anthropic_agent_id.as_str(),
        config.agent_version.as_str(),
        config.environment_id.as_str(),
        config.instructions.as_str(),
    ]
    .iter()
    .any(|value| value.trim().is_empty())
    {
        return Err(LocalRunnerError::invalid(
            "Claude Agent profile fields must be non-empty",
        ));
    }
    if !config.max_session_list_cost_usd.is_finite() || config.max_session_list_cost_usd <= 0.0 {
        return Err(LocalRunnerError::invalid(
            "Claude Agent spend ceiling must be positive",
        ));
    }
    spend_cap_cents(config.max_session_list_cost_usd)?;
    Ok(())
}

fn spend_cap_cents(value: f64) -> Result<u64, LocalRunnerError> {
    let cents = value * 100.0;
    if !cents.is_finite()
        || cents < 1.0
        || cents > u64::MAX as f64
        || (cents - cents.round()).abs() > 0.000_001
    {
        return Err(LocalRunnerError::invalid(
            "Claude Agent spend ceiling must be expressible as whole US cents",
        ));
    }
    Ok(cents.round() as u64)
}

fn fetch_event_history(
    worker: &NetworkWorker,
    session_id: &str,
    after_event_id: Option<&str>,
) -> Result<Vec<Value>, LocalRunnerError> {
    let mut page: Option<String> = None;
    let mut events = Vec::new();
    for _ in 0..MAX_HISTORY_PAGES {
        let page_query = page
            .as_ref()
            .map(|value| format!("&page={}", percent_encode_query(value)))
            .unwrap_or_default();
        let response = worker.request(
            Method::GET,
            format!("/v1/sessions/{session_id}/events?beta=true&limit=100{page_query}"),
            None,
        )?;
        events.extend(extract_event_list(response.clone()));
        if events.len() > MAX_HISTORY_EVENTS {
            return Err(LocalRunnerError::invalid(
                "Anthropic event history exceeded the recovery bound",
            ));
        }
        page = response
            .get("next_page")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if page.is_none() {
            break;
        }
    }
    if page.is_some() {
        return Err(LocalRunnerError::invalid(
            "Anthropic event history pagination exceeded the recovery bound",
        ));
    }
    if let Some(cursor) = after_event_id {
        let position = events
            .iter()
            .position(|value| value.get("id").and_then(Value::as_str) == Some(cursor))
            .ok_or_else(|| {
                LocalRunnerError::invalid(
                    "Anthropic recovery cursor was not present in durable event history",
                )
            })?;
        Ok(events.into_iter().skip(position + 1).collect())
    } else {
        Ok(events)
    }
}

fn percent_encode_query(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                vec![byte as char]
            } else {
                format!("%{byte:02X}").chars().collect()
            }
        })
        .collect()
}

fn encode_tools(
    tools: &[AuthorizedTool],
) -> Result<
    (
        Vec<Value>,
        BTreeMap<String, String>,
        BTreeMap<String, Value>,
    ),
    LocalRunnerError,
> {
    if tools.len() > MAX_REMOTE_TOOLS {
        return Err(LocalRunnerError::invalid(
            "Anthropic custom-tool catalog exceeds 128 tools",
        ));
    }
    let mut reverse = BTreeMap::new();
    let mut operation_input_schemas = BTreeMap::new();
    let payload = tools
        .iter()
        .map(|tool| {
            jsonschema::validator_for(&tool.input_schema).map_err(|_| {
                LocalRunnerError::invalid(format!(
                    "Paperclip tool {} has an invalid JSON Schema",
                    tool.operation_id
                ))
            })?;
            let remote_name = remote_tool_name(&tool.operation_id);
            if reverse
                .insert(remote_name.clone(), tool.operation_id.clone())
                .is_some()
            {
                return Err(LocalRunnerError::invalid(
                    "Anthropic custom-tool name collision",
                ));
            }
            operation_input_schemas.insert(tool.operation_id.clone(), tool.input_schema.clone());
            Ok(json!({
                "type": "custom",
                "name": remote_name,
                "description": tool.description,
                "input_schema": tool.input_schema
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((payload, reverse, operation_input_schemas))
}

fn remote_tool_name(operation_id: &str) -> String {
    let slug = operation_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(96)
        .collect::<String>();
    let digest = format!("{:x}", Sha256::digest(operation_id.as_bytes()));
    format!("pc_{slug}_{}", &digest[..16])
}

fn required_text<'a>(
    value: &'a Value,
    field: &str,
    message: &str,
) -> Result<&'a str, LocalRunnerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| LocalRunnerError::invalid(message))
}

fn verify_remote_session(
    config: &ClaudeManagedProviderConfig,
    session: &Value,
) -> Result<(), LocalRunnerError> {
    let expected_budget = spend_cap_cents(config.max_session_list_cost_usd)?.to_string();
    let actual_budget = session
        .pointer("/budget/max_list_cost/amount")
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .or_else(|| value.as_u64().map(|number| number.to_string()))
        });
    if session.get("environment_id").and_then(Value::as_str) != Some(config.environment_id.as_str())
        || session
            .pointer("/agent/model/id")
            .and_then(Value::as_str)
            .or_else(|| session.pointer("/agent/model").and_then(Value::as_str))
            != Some(config.model.as_str())
        || session.pointer("/agent/id").and_then(Value::as_str)
            != Some(config.anthropic_agent_id.as_str())
        || session
            .pointer("/agent/version")
            .and_then(|value| {
                value
                    .as_u64()
                    .map(|number| number.to_string())
                    .or_else(|| value.as_str().map(str::to_owned))
            })
            .as_deref()
            != Some(config.agent_version.as_str())
        || actual_budget.as_deref() != Some(expected_budget.as_str())
    {
        return Err(LocalRunnerError::invalid(
            "Anthropic session identity does not match its immutable Paperclip profile",
        ));
    }
    Ok(())
}

fn extract_text(event: &Value) -> String {
    if let Some(text) = event.get("text").and_then(Value::as_str) {
        return text.to_owned();
    }
    event
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn extract_event_list(value: Value) -> Vec<Value> {
    value
        .get("data")
        .or_else(|| value.get("events"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{ErrorKind, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Mutex;
    use std::time::Instant;

    #[derive(Clone, Debug)]
    struct CapturedRequest {
        method: String,
        path: String,
        headers: String,
        body: String,
    }

    struct FakeAnthropicService {
        origin: String,
        requests: Arc<Mutex<Vec<CapturedRequest>>>,
        stop: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
    }

    impl FakeAnthropicService {
        fn start(stream_events: Vec<Value>, history_events: Vec<Value>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = Arc::clone(&requests);
            let stop = Arc::new(AtomicBool::new(false));
            let server_stop = Arc::clone(&stop);
            let stream_count = Arc::new(AtomicUsize::new(0));
            let join = thread::spawn(move || {
                while !server_stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut socket, _)) => {
                            let Ok(request) = read_http_request(&mut socket) else {
                                continue;
                            };
                            captured.lock().unwrap().push(request.clone());
                            respond_to_fake_request(
                                &mut socket,
                                &request,
                                &stream_events,
                                &history_events,
                                &stream_count,
                            );
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                origin,
                requests,
                stop,
                join: Some(join),
            }
        }

        fn captured(&self) -> Vec<CapturedRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for FakeAnthropicService {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    fn read_http_request(socket: &mut TcpStream) -> Result<CapturedRequest, std::io::Error> {
        socket.set_read_timeout(Some(Duration::from_secs(2)))?;
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let read = socket.read(&mut buffer)?;
            if read == 0 {
                return Err(std::io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "request ended before headers",
                ));
            }
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break position + 4;
            }
            if bytes.len() > MAX_REMOTE_RESPONSE_BYTES {
                return Err(std::io::Error::new(
                    ErrorKind::InvalidData,
                    "test request too large",
                ));
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while bytes.len() < header_end + content_length {
            let read = socket.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        let request_line = headers.lines().next().unwrap_or_default();
        let mut request_parts = request_line.split_whitespace();
        Ok(CapturedRequest {
            method: request_parts.next().unwrap_or_default().to_owned(),
            path: request_parts.next().unwrap_or_default().to_owned(),
            headers,
            body: String::from_utf8_lossy(
                &bytes[header_end..bytes.len().min(header_end + content_length)],
            )
            .into_owned(),
        })
    }

    fn send_json_response(socket: &mut TcpStream, status: &str, value: &Value) {
        let body = serde_json::to_string(value).unwrap();
        let _ = write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = socket.flush();
    }

    fn respond_to_fake_request(
        socket: &mut TcpStream,
        request: &CapturedRequest,
        stream_events: &[Value],
        history_events: &[Value],
        stream_count: &AtomicUsize,
    ) {
        if request.method == "GET" && request.path.starts_with("/v1/skills?") {
            return send_json_response(socket, "200 OK", &json!({ "data": [] }));
        }
        if request.method == "POST" && request.path == "/v1/skills" {
            return send_json_response(
                socket,
                "200 OK",
                &json!({ "id": "skill_test", "latest_version": 1 }),
            );
        }
        if request.method == "POST" && request.path.starts_with("/v1/sessions?") {
            return send_json_response(socket, "200 OK", &json!({ "id": "session_test" }));
        }
        if request.method == "GET" && request.path.contains("/events/stream") {
            if stream_count.fetch_add(1, AtomicOrdering::SeqCst) > 0 {
                return send_json_response(
                    socket,
                    "503 Service Unavailable",
                    &json!({ "type": "error" }),
                );
            }
            let body = stream_events
                .iter()
                .map(|event| format!("data: {}\n\n", serde_json::to_string(event).unwrap()))
                .collect::<String>();
            let _ = write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.flush();
            return;
        }
        if request.method == "GET" && request.path.contains("/events?") {
            return send_json_response(
                socket,
                "200 OK",
                &json!({ "data": history_events, "next_page": null }),
            );
        }
        if request.method == "GET" && request.path.starts_with("/v1/sessions/session_test?") {
            return send_json_response(
                socket,
                "200 OK",
                &json!({
                    "id": "session_test",
                    "status": "idle",
                    "environment_id": "env_test",
                    "agent": { "id": "agent_test", "version": 3, "model": { "id": "claude-sonnet-5" } },
                    "budget": { "type": "limit", "max_list_cost": { "currency": "USD", "amount": "100" } },
                    "stop_reason": { "type": "end_turn", "event_ids": [] }
                }),
            );
        }
        send_json_response(socket, "200 OK", &json!({ "accepted": true }));
    }

    fn config() -> ClaudeManagedProviderConfig {
        ClaudeManagedProviderConfig {
            model: "claude-sonnet-5".to_owned(),
            profile_id: "profile_test".to_owned(),
            anthropic_agent_id: "agent_test".to_owned(),
            agent_version: "3".to_owned(),
            environment_id: "env_test".to_owned(),
            beta_version: QUALIFIED_BETA.to_owned(),
            max_session_list_cost_usd: 1.0,
            instructions: "Paperclip test system instructions".to_owned(),
            runtime_context: None,
        }
    }

    fn tool() -> AuthorizedTool {
        AuthorizedTool {
            operation_id: "issues.comment:create".to_owned(),
            version: 1,
            description: "Create an issue comment.".to_owned(),
            input_schema: json!({
                "type": "object",
                "required": ["body"],
                "properties": { "body": { "type": "string" } },
                "additionalProperties": false
            }),
            response_schema: json!({ "type": "object" }),
        }
    }

    fn start_test_provider(
        service: &FakeAnthropicService,
        tools: Vec<AuthorizedTool>,
        resume_session_id: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<ClaudeManagedProvider, LocalRunnerError> {
        let origin = service.origin.clone();
        ClaudeManagedProvider::start_with_worker(
            &config(),
            tools,
            resume_session_id,
            cursor,
            0,
            Vec::new(),
            None,
            SensitiveApiKey("anthropic-test-secret".to_owned()),
            move |key, beta| NetworkWorker::start_at(key, beta, &origin, false),
        )
    }

    #[test]
    fn tool_names_are_anthropic_safe_stable_and_collision_resistant() {
        let first = remote_tool_name("issues.comment:create");
        let second = remote_tool_name("issues.comment/create");
        assert!(first.len() <= 128);
        assert!(first
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '_' | '-')));
        assert_ne!(first, second);
        assert_eq!(first, remote_tool_name("issues.comment:create"));
    }

    #[test]
    fn managed_overrides_replace_saved_context_and_pin_skills_and_mcp() {
        let binding = ManagedMcpBinding {
            name: "paperclip-assigned".to_owned(),
            capability_url: "https://paperclip.example/mcp?paperclip_capability=secret".to_owned(),
        };
        let overrides = managed_agent_overrides(
            &config(),
            "Paperclip test system instructions",
            vec![json!({ "type": "custom", "name": "pc_finish" })],
            &[json!({ "type": "custom", "skill_id": "skill_1", "version": 7 })],
            Some(&binding),
        );
        assert_eq!(
            overrides.get("system"),
            Some(&json!("Paperclip test system instructions"))
        );
        assert_eq!(overrides.pointer("/skills/0/version"), Some(&json!(7)));
        assert_eq!(
            overrides.pointer("/mcp_servers/0/name"),
            Some(&json!("paperclip-assigned"))
        );
        assert!(overrides
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| tools
                .iter()
                .any(|tool| tool.get("type") == Some(&json!("agent_toolset_20260401")))));
        assert!(serde_json::to_string(&config())
            .unwrap()
            .find("paperclip_capability")
            .is_none());
    }

    #[test]
    fn managed_system_replaces_the_local_instruction_path_with_the_companion_skill() {
        let mut config = config();
        let local_root = "/paperclip/runtime/instructions";
        config.instructions = format!(
            "paperclip prompt\n\nAGENTS entry\n\nRead-only instruction sibling root: {local_root}"
        );
        config.runtime_context = Some(json!({
            "instructions": {
                "entryPath": "AGENTS.md",
                "bundle": { "digest": "abc123", "rootPath": local_root }
            },
            "skills": []
        }));

        let instructions = managed_system_instructions(&config).unwrap();
        assert!(instructions.starts_with("paperclip prompt\n\nAGENTS entry\n\n"));
        assert!(instructions.contains("attached `paperclip-instructions-"));
        assert!(instructions.ends_with("skill under `instructions/`."));
        assert!(!instructions.contains(local_root));
    }

    #[test]
    fn managed_skill_uploads_include_instruction_siblings_and_complete_assigned_skill_trees() {
        let service = FakeAnthropicService::start(vec![], vec![]);
        let root = std::env::temp_dir().join(format!(
            "paperclip-claude-managed-context-{}",
            uuid::Uuid::new_v4()
        ));
        let instruction_root = root.join("instructions");
        let skill_root = root.join("reviewer");
        fs::create_dir_all(instruction_root.join("references")).unwrap();
        fs::create_dir_all(skill_root.join("references")).unwrap();
        fs::write(
            instruction_root.join("AGENTS.md"),
            "Follow the entry instructions.\n",
        )
        .unwrap();
        fs::write(
            instruction_root.join("references/policy.md"),
            "Instruction sibling policy.\n",
        )
        .unwrap();
        fs::write(
            skill_root.join("SKILL.md"),
            "# Reviewer\nUse the checklist.\n",
        )
        .unwrap();
        fs::write(
            skill_root.join("references/checklist.md"),
            "- Verify the tests\n",
        )
        .unwrap();
        let mut config = config();
        config.runtime_context = Some(json!({
            "instructions": {
                "entryPath": "AGENTS.md",
                "bundle": {
                    "digest": "instruction-digest",
                    "rootPath": instruction_root.display().to_string()
                }
            },
            "skills": [{
                "key": "company-1/reviewer",
                "runtimeName": "reviewer",
                "bundle": {
                    "digest": "skill-digest",
                    "rootPath": skill_root.display().to_string()
                }
            }]
        }));

        let attached = upload_managed_runtime_skills_at(
            "anthropic-test-secret",
            &config,
            &service.origin,
            false,
        )
        .unwrap();

        assert_eq!(attached.len(), 2);
        assert!(attached.iter().all(|skill| {
            skill.get("skill_id") == Some(&json!("skill_test"))
                && skill.get("version") == Some(&json!(1))
        }));
        let requests = service.captured();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == "GET" && request.path.starts_with("/v1/skills?"))
                .count(),
            2
        );
        let uploads = requests
            .iter()
            .filter(|request| request.method == "POST" && request.path == "/v1/skills")
            .collect::<Vec<_>>();
        assert_eq!(uploads.len(), 2);
        assert!(uploads.iter().all(|request| request
            .headers
            .to_ascii_lowercase()
            .contains("x-api-key: anthropic-test-secret")));
        let instruction_upload = uploads
            .iter()
            .find(|request| request.body.contains("Follow the entry instructions."))
            .unwrap();
        assert!(instruction_upload
            .body
            .contains("/instructions/AGENTS.md\""));
        assert!(instruction_upload
            .body
            .contains("/instructions/references/policy.md\""));
        assert!(instruction_upload
            .body
            .contains("Instruction sibling policy."));
        assert!(instruction_upload.body.contains("/SKILL.md\""));
        let assigned_upload = uploads
            .iter()
            .find(|request| request.body.contains("# Reviewer"))
            .unwrap();
        assert!(assigned_upload.body.contains("reviewer/SKILL.md\""));
        assert!(assigned_upload
            .body
            .contains("reviewer/references/checklist.md\""));
        assert!(assigned_upload.body.contains("- Verify the tests"));
        assert!(uploads
            .iter()
            .all(|request| !request.body.contains("anthropic-test-secret")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_oversized_remote_catalogs() {
        let tools = (0..129)
            .map(|index| AuthorizedTool {
                operation_id: format!("operation_{index}"),
                version: 1,
                description: "test".to_owned(),
                input_schema: json!({"type": "object"}),
                response_schema: json!({"type": "object"}),
            })
            .collect::<Vec<_>>();
        assert!(encode_tools(&tools)
            .unwrap_err()
            .to_string()
            .contains("128"));
    }

    #[test]
    fn managed_transport_streams_reconciles_tools_and_accounts_without_leaking_auth() {
        let service = FakeAnthropicService::start(
            vec![
                json!({ "type": "event_start", "event": { "type": "agent.message", "id": "sevt_message" } }),
                json!({ "type": "event_delta", "event_id": "sevt_message", "delta": { "type": "content_delta", "index": 0, "content": { "type": "text", "text": "draft" } } }),
                json!({ "type": "agent.message", "id": "sevt_message", "content": [{ "type": "text", "text": "Authoritative final" }] }),
                json!({ "type": "agent.message", "id": "sevt_message", "content": [{ "type": "text", "text": "Authoritative final" }] }),
                json!({ "type": "agent.custom_tool_use", "id": "sevt_tool", "name": remote_tool_name("issues.comment:create"), "input": { "body": "Ship it" } }),
                json!({ "type": "session.status_idle", "id": "sevt_wait", "status": "idle", "stop_reason": { "type": "requires_action", "event_ids": ["sevt_tool"] } }),
                json!({ "type": "span.model_request_end", "id": "sevt_request", "model_usage": { "input_tokens": 10, "output_tokens": 4 } }),
                json!({ "type": "session.usage", "id": "sevt_usage", "usage": { "input_tokens": 10, "output_tokens": 4, "cache_read_input_tokens": 2, "active_seconds": 1.5, "list_cost": { "currency": "USD", "amount": "7" } } }),
                json!({ "type": "session.status_idle", "id": "sevt_end", "status": "idle", "stop_reason": { "type": "end_turn", "event_ids": [] } }),
            ],
            vec![],
        );
        let mut provider = start_test_provider(&service, vec![tool()], None, None).unwrap();
        provider.start_turn("Hello", ".", "turn_test").unwrap();

        let mut methods = Vec::new();
        let mut saw_tool = false;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match provider.poll().unwrap() {
                Some(ProviderEvent::ToolCall {
                    call_id,
                    operation_id,
                    input,
                }) => {
                    assert_eq!(call_id, "sevt_tool");
                    assert_eq!(operation_id, "issues.comment:create");
                    assert_eq!(input, json!({ "body": "Ship it" }));
                    let result = ToolResult {
                        call_id,
                        operation_id,
                        result: json!({ "ok": true }),
                        is_error: false,
                    };
                    provider.deliver_tool_result(&result).unwrap();
                    // A replayed PRP command after the accepted delivery must
                    // reconcile against requires_action instead of POSTing the
                    // result a second time.
                    provider.deliver_tool_result(&result).unwrap();
                    saw_tool = true;
                }
                Some(ProviderEvent::Notification { method, params }) => {
                    if method == "item/completed" {
                        assert_eq!(
                            params.pointer("/item/text"),
                            Some(&json!("Authoritative final"))
                        );
                    }
                    methods.push(method);
                    if methods.iter().any(|value| value == "turn/completed") {
                        break;
                    }
                }
                Some(_) | None => thread::sleep(Duration::from_millis(2)),
            }
        }
        assert!(saw_tool);
        assert!(methods
            .iter()
            .any(|value| value == "item/agentMessage/delta"));
        assert_eq!(
            methods
                .iter()
                .filter(|value| value.as_str() == "item/completed")
                .count(),
            1
        );
        assert!(methods
            .iter()
            .any(|value| value == "thread/tokenUsage/updated"));
        assert!(methods.iter().any(|value| value == "turn/completed"));

        let requests = service.captured();
        let create = requests
            .iter()
            .find(|request| request.method == "POST" && request.path.starts_with("/v1/sessions?"))
            .unwrap();
        assert!(create
            .headers
            .to_ascii_lowercase()
            .contains("x-api-key: anthropic-test-secret"));
        assert!(create.headers.contains(QUALIFIED_BETA));
        let body: Value = serde_json::from_str(&create.body).unwrap();
        assert_eq!(
            body.pointer("/agent/model/id"),
            Some(&json!("claude-sonnet-5"))
        );
        assert_eq!(
            body.pointer("/budget/max_list_cost/amount"),
            Some(&json!("100"))
        );
        let serialized = serde_json::to_string(
            &requests
                .iter()
                .map(|request| (&request.path, &request.body))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(!serialized.contains("anthropic-test-secret"));
        assert!(!serialized.contains("PAPERCLIP_API_KEY"));
        let result_post = requests
            .iter()
            .filter(|request| request.body.contains("user.custom_tool_result"))
            .collect::<Vec<_>>();
        assert_eq!(result_post.len(), 1);
        let result_post = result_post[0];
        assert!(result_post.body.contains("sevt_tool"));
    }

    #[test]
    fn recovery_opens_stream_then_replays_only_after_the_durable_cursor() {
        let service = FakeAnthropicService::start(
            vec![],
            vec![
                json!({ "type": "agent.message", "id": "sevt_old", "content": [{ "type": "text", "text": "old" }] }),
                json!({ "type": "agent.message", "id": "sevt_new", "content": [{ "type": "text", "text": "recovered" }] }),
            ],
        );
        let mut provider =
            start_test_provider(&service, vec![], Some("session_test"), Some("sevt_old")).unwrap();
        match provider.poll().unwrap().unwrap() {
            ProviderEvent::Notification { method, params } => {
                assert_eq!(method, "item/completed");
                assert_eq!(params.pointer("/item/text"), Some(&json!("recovered")));
            }
            _ => panic!("expected recovered message"),
        }
        let paths = service
            .captured()
            .into_iter()
            .map(|request| request.path)
            .collect::<Vec<_>>();
        let stream_index = paths
            .iter()
            .position(|path| path.contains("/events/stream"))
            .unwrap();
        let history_index = paths
            .iter()
            .position(|path| path.contains("/events?") && !path.contains("/stream"))
            .unwrap();
        assert!(stream_index < history_index);
    }

    #[test]
    fn malformed_tool_arguments_fail_closed_before_paperclip_execution() {
        let service = FakeAnthropicService::start(
            vec![json!({
                "type": "agent.custom_tool_use",
                "id": "sevt_bad_tool",
                "name": remote_tool_name("issues.comment:create"),
                "input": { "body": 42 }
            })],
            vec![],
        );
        let mut provider = start_test_provider(&service, vec![tool()], None, None).unwrap();
        provider.start_turn("Bad call", ".", "turn_bad").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            assert!(
                Instant::now() < deadline,
                "malformed tool event was not observed"
            );
            match provider.poll() {
                Err(error) => {
                    assert!(error.to_string().contains("schema validation"));
                    break;
                }
                _ => thread::sleep(Duration::from_millis(2)),
            }
        }
    }

    #[test]
    fn budget_increase_is_monotonic_and_remote_deletion_is_explicit() {
        let service = FakeAnthropicService::start(vec![], vec![]);
        let mut provider = start_test_provider(&service, vec![], None, None).unwrap();
        assert!(provider
            .increase_budget(0.99)
            .unwrap_err()
            .to_string()
            .contains("monotonically"));
        provider.increase_budget(2.0).unwrap();
        provider.destroy_session().unwrap();
        let requests = service.captured();
        let update = requests
            .iter()
            .find(|request| {
                request.method == "POST"
                    && request.path.starts_with("/v1/sessions/session_test?")
                    && request.body.contains("max_list_cost")
            })
            .unwrap();
        let body: Value = serde_json::from_str(&update.body).unwrap();
        assert_eq!(
            body.pointer("/budget/max_list_cost/amount"),
            Some(&json!("200"))
        );
        assert!(requests.iter().any(|request| {
            request.method == "DELETE" && request.path.starts_with("/v1/sessions/session_test?")
        }));
    }

    #[test]
    fn conflicting_duplicate_remote_event_ids_fail_closed() {
        let service = FakeAnthropicService::start(vec![], vec![]);
        let mut provider = start_test_provider(&service, vec![], None, None).unwrap();
        assert!(provider
            .normalize_remote_event(json!({
                "type": "agent.message",
                "id": "sevt_conflict",
                "content": [{ "type": "text", "text": "first" }]
            }))
            .unwrap()
            .is_some());
        assert!(provider
            .normalize_remote_event(json!({
                "type": "agent.message",
                "id": "sevt_conflict",
                "content": [{ "type": "text", "text": "different" }]
            }))
            .unwrap_err()
            .to_string()
            .contains("conflicting content"));
    }
}
