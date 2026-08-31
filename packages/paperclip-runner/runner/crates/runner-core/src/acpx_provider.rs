use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::codex_provider::{
    AcpxProviderConfig, Provider, ProviderEvent, ProviderKind, ProviderRuntimeIdentity,
    ProviderSessionIdentity,
};
use crate::generated_acpx_sidecar_contract::{
    GeneratedAcpxSidecarCommand, GeneratedAcpxSidecarEventType,
    GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
};
use crate::local_runner::LocalRunnerError;
use crate::process_supervisor::{BoundedLogBuffer, ProcessOutput, SupervisedProcess};
use crate::provider_bridge::{AuthorizedTool, ToolResult};

const ACPX_SIDECAR_MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug)]
struct PendingTool {
    operation_id: String,
    input: Value,
    turn_id: String,
}

pub struct AcpxProvider {
    process: SupervisedProcess,
    next_request_id: u64,
    inbox: VecDeque<ProviderEvent>,
    pending_tools: BTreeMap<String, PendingTool>,
    pending_input_requests: BTreeMap<String, String>,
    config: AcpxProviderConfig,
    tools: Vec<AuthorizedTool>,
    catalog_revision: u64,
    acpx_record_id: String,
    backend_session_id: String,
    agent_session_id: String,
    active_turn_id: Option<String>,
    last_sequence: u64,
    assistant_text: String,
    provider_requests: u64,
    agent_process_id: Option<u32>,
    thinking_active: bool,
    stderr_tail: BoundedLogBuffer,
    stdout_closed: bool,
}

impl AcpxProvider {
    pub fn start(
        config: &AcpxProviderConfig,
        tools: Vec<AuthorizedTool>,
        expected_identity: Option<&ProviderSessionIdentity>,
        replacement_provider_session_key: Option<&str>,
    ) -> Result<Self, LocalRunnerError> {
        validate_config(config)?;
        let process = SupervisedProcess::spawn(
            Path::new(&config.sidecar_command),
            &config.sidecar_args,
            Duration::from_secs(3),
            ACPX_SIDECAR_MAX_FRAME_BYTES,
        )?;
        let mut provider = Self {
            process,
            next_request_id: 1,
            inbox: VecDeque::new(),
            pending_tools: BTreeMap::new(),
            pending_input_requests: BTreeMap::new(),
            config: config.clone(),
            tools,
            catalog_revision: 1,
            acpx_record_id: String::new(),
            backend_session_id: String::new(),
            agent_session_id: String::new(),
            active_turn_id: None,
            last_sequence: 0,
            assistant_text: String::new(),
            provider_requests: 0,
            agent_process_id: None,
            thinking_active: false,
            stderr_tail: BoundedLogBuffer::new(32, 8 * 1024),
            stdout_closed: false,
        };
        provider.request(
            GeneratedAcpxSidecarCommand::Initialize,
            json!({ "agent": config.agent, "model": config.model }),
        )?;
        let opened = provider.request(
            GeneratedAcpxSidecarCommand::SessionOpen,
            json!({
                "runtimeDirectory": config.runtime_directory,
                "normalizedSessionId": config.normalized_session_id,
                "workingDirectory": config.cwd,
                "agent": config.agent,
                "model": config.model,
                "permissionMode": config.permission_mode,
                "permissionModePinned": config.permission_mode_pinned,
                "systemInstructions": config.instructions,
                "tools": provider.tools,
                "expectedIdentity": expected_identity,
                "providerSessionKey": replacement_provider_session_key,
            }),
        )?;
        let identity = opened.get("identity").unwrap_or(&Value::Null);
        provider.acpx_record_id = required_text(identity, "acpxRecordId", "ACPX record")?;
        provider.backend_session_id =
            required_text(identity, "backendSessionId", "backend session")?;
        provider.agent_session_id = required_text(identity, "agentSessionId", "agent session")?;
        if identity.get("effectiveModel").and_then(Value::as_str) != Some(config.model.as_str()) {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar did not verify the configured effective model",
            ));
        }
        if let Some(agent_process) = opened.get("agentProcess").filter(|value| value.is_object()) {
            provider.agent_process_id = agent_process
                .get("pid")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .filter(|value| *value > 0);
            provider.inbox.push_back(ProviderEvent::Notification {
                method: "acpx/process".to_owned(),
                params: json!({
                    "role": "acp_agent",
                    "pid": agent_process.get("pid").and_then(Value::as_u64),
                    "processGroupId": agent_process.get("processGroupId").and_then(Value::as_u64),
                    "startedAt": agent_process.get("startedAt").and_then(Value::as_str),
                }),
            });
        }
        provider.request(
            GeneratedAcpxSidecarCommand::RunAttach,
            json!({
                "runId": config.run_id,
                "catalogRevision": provider.catalog_revision,
                "tools": provider.tools,
            }),
        )?;
        Ok(provider)
    }

    fn request(
        &mut self,
        command: GeneratedAcpxSidecarCommand,
        params: Value,
    ) -> Result<Value, LocalRunnerError> {
        let id = self.next_request_id;
        self.next_request_id += 1;
        if let Err(error) = self.process.send(&json!({
            "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
            "id": id,
            "command": command.as_str(),
            "params": params,
        })) {
            return Err(self.request_send_failure(command.as_str(), error));
        }
        loop {
            let line = self
                .receive_stdout_line(Duration::from_secs(30))?
                .ok_or_else(|| self.request_wait_failure(command.as_str()))?;
            let message = parse_frame(&line).map_err(|error| {
                LocalRunnerError::invalid(format!(
                    "provider_initialize_protocol_error: provider=acpx stage={}: {error}",
                    command.as_str()
                ))
            })?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if message.get("ok").and_then(Value::as_bool) != Some(true) {
                    let code = if matches!(
                        command,
                        GeneratedAcpxSidecarCommand::Initialize
                            | GeneratedAcpxSidecarCommand::SessionOpen
                    ) {
                        "provider_initialize_protocol_error"
                    } else {
                        "provider_request_protocol_error"
                    };
                    return Err(LocalRunnerError::invalid(format!(
                        "{code}: provider=acpx stage={}: {}",
                        command.as_str(),
                        message
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                    )));
                }
                return Ok(message.get("result").cloned().unwrap_or_else(|| json!({})));
            }
            if let Some(event) = self.map_frame(&message)? {
                self.inbox.push_back(event);
            }
        }
    }

    fn receive_stdout_line(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<String>, LocalRunnerError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            match self.process.recv_timeout(remaining) {
                Ok(ProcessOutput::Stdout(line)) => return Ok(Some(line)),
                Ok(ProcessOutput::Stderr(line)) => {
                    self.stderr_tail.push(redact_acpx_diagnostic(&line));
                }
                Ok(ProcessOutput::StdoutError(message)) => {
                    return Err(LocalRunnerError::invalid(format!(
                        "provider_initialize_protocol_error: provider=acpx stage=stdout: {message}"
                    )));
                }
                Ok(ProcessOutput::StdoutClosed) => {
                    self.stdout_closed = true;
                    return Ok(None);
                }
                Ok(ProcessOutput::StderrClosed) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Ok(None),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(LocalRunnerError::invalid(
                        "provider_process_output_closed: provider=acpx",
                    ));
                }
            }
        }
    }

    fn request_wait_failure(&mut self, command: &str) -> LocalRunnerError {
        if self.stdout_closed {
            self.drain_failure_diagnostics(Duration::from_millis(50));
        } else {
            self.drain_failure_diagnostics(Duration::ZERO);
        }
        let stderr = self.stderr_tail.snapshot().lines.join("\n");
        let stderr_detail = if stderr.is_empty() {
            String::new()
        } else {
            format!(" stderrTail={stderr:?}")
        };
        if self.stdout_closed {
            return match self.process.try_wait() {
                Ok(Some(exit)) => LocalRunnerError::invalid(format!(
                    "provider_process_exited: provider=acpx stage={command} exitCode={:?} signal={:?}{stderr_detail}",
                    exit.exit_code, exit.signal,
                )),
                Ok(None) => LocalRunnerError::invalid(format!(
                    "provider_stdout_closed: provider=acpx stage={command}{stderr_detail}"
                )),
                Err(error) => LocalRunnerError::invalid(format!(
                    "provider_process_status_failed: provider=acpx stage={command}: {error}{stderr_detail}"
                )),
            };
        }
        let code = if matches!(command, "initialize" | "session.open") {
            "provider_initialize_timeout"
        } else {
            "provider_request_timeout"
        };
        LocalRunnerError::invalid(format!(
            "{code}: provider=acpx stage={command}{stderr_detail}"
        ))
    }

    fn request_send_failure(&mut self, command: &str, error: LocalRunnerError) -> LocalRunnerError {
        self.drain_failure_diagnostics(Duration::from_millis(50));
        let stderr = self.stderr_tail.snapshot().lines.join("\n");
        let stderr_detail = if stderr.is_empty() {
            String::new()
        } else {
            format!(" stderrTail={stderr:?}")
        };
        match self.process.try_wait() {
            Ok(Some(exit)) => LocalRunnerError::invalid(format!(
                "provider_process_exited: provider=acpx stage={command} exitCode={:?} signal={:?}{stderr_detail}",
                exit.exit_code, exit.signal,
            )),
            Ok(None) => LocalRunnerError::invalid(format!(
                "provider_transport_failed: provider=acpx stage={command}: {error}{stderr_detail}"
            )),
            Err(status_error) => LocalRunnerError::invalid(format!(
                "provider_process_status_failed: provider=acpx stage={command}: {status_error}; sendError={error}{stderr_detail}"
            )),
        }
    }

    fn drain_failure_diagnostics(&mut self, max_wait: Duration) {
        let deadline = Instant::now() + max_wait;
        loop {
            let output = if max_wait.is_zero() {
                self.process.try_recv().ok()
            } else {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    None
                } else {
                    self.process.recv_timeout(remaining).ok()
                }
            };
            match output {
                Some(ProcessOutput::Stderr(line)) => {
                    self.stderr_tail.push(redact_acpx_diagnostic(&line));
                }
                Some(ProcessOutput::StderrClosed) => break,
                Some(ProcessOutput::StdoutClosed) => self.stdout_closed = true,
                Some(ProcessOutput::Stdout(_)) | Some(ProcessOutput::StdoutError(_)) => {}
                None => break,
            }
        }
    }

    fn map_frame(&mut self, message: &Value) -> Result<Option<ProviderEvent>, LocalRunnerError> {
        let Some(event_type_text) = message.get("eventType").and_then(Value::as_str) else {
            return Ok(None);
        };
        let event_type: GeneratedAcpxSidecarEventType =
            serde_json::from_value(Value::String(event_type_text.to_owned())).map_err(|_| {
                LocalRunnerError::invalid("ACPX sidecar emitted an unclassified event type")
            })?;
        let sequence = message
            .get("sequence")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or_else(|| LocalRunnerError::invalid("ACPX sidecar event omitted its sequence"))?;
        if sequence <= self.last_sequence {
            return Ok(None);
        }
        if sequence != self.last_sequence + 1 {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar event sequence has a gap",
            ));
        }
        self.last_sequence = sequence;
        let event_run_id = message.get("runId").and_then(Value::as_str);
        if let Some(event_run_id) = event_run_id {
            if event_run_id != self.config.run_id {
                return Err(LocalRunnerError::invalid(
                    "ACPX sidecar event named a stale run",
                ));
            }
        } else if !matches!(
            event_type,
            GeneratedAcpxSidecarEventType::RuntimeProcess
                | GeneratedAcpxSidecarEventType::RuntimeDiagnostic
        ) {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar event omitted its run binding",
            ));
        }
        if matches!(
            event_type,
            GeneratedAcpxSidecarEventType::RuntimeToolCalled
                | GeneratedAcpxSidecarEventType::RuntimePermissionRequested
                | GeneratedAcpxSidecarEventType::RuntimeInputRequested
                | GeneratedAcpxSidecarEventType::RuntimeTurnTerminal
                | GeneratedAcpxSidecarEventType::RuntimeEvent
        ) {
            let event_turn_id = message
                .get("turnId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    LocalRunnerError::invalid("ACPX sidecar event omitted its turn binding")
                })?;
            if self.active_turn_id.as_deref() != Some(event_turn_id) {
                return Err(LocalRunnerError::invalid(
                    "ACPX sidecar event named a stale turn",
                ));
            }
        }
        let payload = message.get("payload").cloned().unwrap_or_else(|| json!({}));
        match event_type {
            GeneratedAcpxSidecarEventType::RuntimeToolCalled => {
                let call_id = required_text(&payload, "callId", "tool call")?;
                let operation_id = required_text(&payload, "operationId", "tool operation")?;
                let input = payload.get("input").cloned().unwrap_or(Value::Null);
                let turn_id = message
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if self
                    .pending_tools
                    .insert(
                        call_id.clone(),
                        PendingTool {
                            operation_id: operation_id.clone(),
                            input: input.clone(),
                            turn_id,
                        },
                    )
                    .is_some()
                {
                    return Err(LocalRunnerError::invalid(
                        "ACPX reused a pending tool call id",
                    ));
                }
                Ok(Some(ProviderEvent::ToolCall {
                    call_id,
                    operation_id,
                    input,
                }))
            }
            GeneratedAcpxSidecarEventType::RuntimePermissionRequested => {
                let request_id = required_text(&payload, "requestId", "permission request")?;
                let request_kind = permission_kind(payload.get("kind").and_then(Value::as_str));
                Ok(Some(ProviderEvent::RuntimeRequest {
                    request: json!({
                        "schema": "paperclip.runtime_request.v1",
                        "requestKind": "runtime",
                        "requestId": request_id,
                        "type": "permission",
                        "status": "pending",
                        "prompt": payload.get("title").and_then(Value::as_str).unwrap_or("ACP permission request"),
                        "origin": {
                            "adapter": "acpx-runtime-sidecar",
                            "provider": "acpx",
                            "method": "runtime.permission_requested",
                            "kind": request_kind,
                        },
                        "details": payload,
                    }),
                }))
            }
            GeneratedAcpxSidecarEventType::RuntimeInputRequested => {
                let request_id = required_text(&payload, "requestId", "input request")?;
                let question_set = payload.get("questionSet").cloned().ok_or_else(|| {
                    LocalRunnerError::invalid("ACPX input request omitted its question set")
                })?;
                validate_question_set(&question_set)?;
                let turn_id = message
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if self
                    .pending_input_requests
                    .insert(request_id.clone(), turn_id.clone())
                    .is_some()
                {
                    return Err(LocalRunnerError::invalid(
                        "ACPX reused a pending input request id",
                    ));
                }
                Ok(Some(ProviderEvent::RuntimeRequest {
                    request: json!({
                        "schema": "paperclip.runtime_request.v2",
                        "requestKind": "runtime",
                        "requestId": request_id,
                        "type": "input",
                        "status": "pending",
                        "prompt": question_set.get("title").and_then(Value::as_str).unwrap_or("Additional information needed"),
                        "input": question_set,
                        "origin": payload.get("origin").cloned().unwrap_or_else(|| json!({
                            "adapter": "acpx-runtime-sidecar",
                            "provider": "acpx",
                            "method": "elicitation/create",
                        })),
                        "turnId": turn_id,
                        "itemId": request_id,
                    }),
                }))
            }
            GeneratedAcpxSidecarEventType::RuntimeTurnTerminal => {
                let turn_id = message
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if self.active_turn_id.as_deref() == Some(turn_id.as_str()) {
                    self.active_turn_id = None;
                }
                self.pending_input_requests
                    .retain(|_, pending_turn_id| pending_turn_id != &turn_id);
                let status = payload
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                let error = payload.get("error").cloned().unwrap_or(Value::Null);
                let terminal = ProviderEvent::Notification {
                    method: "turn/completed".to_owned(),
                    params: json!({
                        "threadId": self.acpx_record_id,
                        "turnId": turn_id,
                        "turn": { "id": turn_id, "status": status, "error": error },
                        "error": error,
                        "acpx": payload,
                    }),
                };
                if self.assistant_text.is_empty() {
                    Ok(Some(terminal))
                } else {
                    let text = std::mem::take(&mut self.assistant_text);
                    self.inbox.push_back(terminal);
                    Ok(Some(ProviderEvent::Notification {
                        method: "item/completed".to_owned(),
                        params: json!({
                            "threadId": self.acpx_record_id,
                            "turnId": turn_id,
                            "item": { "id": format!("acpx-message-{turn_id}"), "type": "agentMessage", "text": text },
                        }),
                    }))
                }
            }
            GeneratedAcpxSidecarEventType::RuntimeEvent => {
                // ACPX reports one thought delta per provider chunk. The
                // canonical PRP surface needs one reasoning item boundary,
                // not hundreds of duplicate item.started events.
                if payload.get("type").and_then(Value::as_str) == Some("thinking") {
                    if self.thinking_active {
                        return Ok(None);
                    }
                    self.thinking_active = true;
                }
                if payload.get("type").and_then(Value::as_str) == Some("text_delta") {
                    self.assistant_text.push_str(
                        payload
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    );
                }
                let turn_id = message
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Ok(Some(map_runtime_event(
                    payload,
                    self.provider_requests,
                    &self.acpx_record_id,
                    turn_id,
                )))
            }
            GeneratedAcpxSidecarEventType::RuntimeProcess => {
                Ok(Some(ProviderEvent::Notification {
                    method: "acpx/process".to_owned(),
                    params: payload,
                }))
            }
            GeneratedAcpxSidecarEventType::RuntimeDiagnostic => {
                Ok(Some(ProviderEvent::Notification {
                    method: "acpx/diagnostic".to_owned(),
                    params: payload,
                }))
            }
        }
    }
}

impl Provider for AcpxProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Acpx
    }

    fn runtime_identity(&self) -> ProviderRuntimeIdentity {
        ProviderRuntimeIdentity::LocalProcess {
            process_id: self.process.id(),
            provider_session_id: self.agent_session_id.clone(),
        }
    }

    fn agent_process_id(&self) -> Option<u32> {
        self.agent_process_id
    }

    fn session_identity(&self) -> &str {
        &self.acpx_record_id
    }

    fn provider_session_id(&self) -> Option<&str> {
        Some(&self.agent_session_id)
    }

    fn durable_session_identity(&self) -> Option<ProviderSessionIdentity> {
        Some(ProviderSessionIdentity::Acpx {
            normalized_session_id: self.config.normalized_session_id.clone(),
            acpx_record_id: self.acpx_record_id.clone(),
            backend_session_id: self.backend_session_id.clone(),
            agent_session_id: self.agent_session_id.clone(),
            profile_digest: self.config.command_digest.clone(),
            workspace_digest: format!("sha256:{:x}", Sha256::digest(self.config.cwd.as_bytes())),
            requested_model: self.config.model.clone(),
            effective_model: self.config.model.clone(),
            permission_mode: Some(self.config.permission_mode.clone()),
        })
    }

    fn attach_run(
        &mut self,
        run_id: &str,
        tools: Vec<AuthorizedTool>,
    ) -> Result<(), LocalRunnerError> {
        if self.active_turn_id.is_some()
            || !self.pending_tools.is_empty()
            || !self.pending_input_requests.is_empty()
        {
            return Err(LocalRunnerError::invalid(
                "cannot attach an ACPX run while work is active",
            ));
        }
        self.catalog_revision += 1;
        self.tools = tools;
        let previous_run_id = std::mem::replace(&mut self.config.run_id, run_id.to_owned());
        let attached = self.request(
            GeneratedAcpxSidecarCommand::RunAttach,
            json!({
                "runId": run_id,
                "catalogRevision": self.catalog_revision,
                "tools": self.tools,
            }),
        );
        if let Err(error) = attached {
            self.config.run_id = previous_run_id;
            return Err(error);
        }
        Ok(())
    }

    fn configure_tools(&mut self, tools: Vec<AuthorizedTool>) -> Result<(), LocalRunnerError> {
        let run_id = self.config.run_id.clone();
        self.attach_run(&run_id, tools)
    }

    fn start_turn(
        &mut self,
        message: &str,
        cwd: &str,
        turn_id: &str,
    ) -> Result<Value, LocalRunnerError> {
        if cwd != self.config.cwd {
            return Err(LocalRunnerError::invalid(
                "ACPX turn cwd differs from its immutable workspace",
            ));
        }
        if self.active_turn_id.is_some() {
            return Err(LocalRunnerError::invalid("ACPX already has an active turn"));
        }
        self.active_turn_id = Some(turn_id.to_owned());
        self.assistant_text.clear();
        self.thinking_active = false;
        self.provider_requests += 1;
        match self.request(
            GeneratedAcpxSidecarCommand::TurnStart,
            json!({ "turnId": turn_id, "message": message }),
        ) {
            Ok(response) => {
                // Sidecar runtime events can arrive while the turn.start
                // response is in flight. Put the authoritative turn boundary
                // ahead of those buffered events so the strict outer driver
                // observes one valid turn before any items.
                self.inbox.push_front(ProviderEvent::Notification {
                    method: "turn/started".to_owned(),
                    params: json!({
                        "threadId": self.acpx_record_id,
                        "turnId": turn_id,
                        "turn": { "id": turn_id, "status": "inProgress" },
                    }),
                });
                Ok(response)
            }
            Err(error) => {
                if self.active_turn_id.as_deref() == Some(turn_id) {
                    self.active_turn_id = None;
                }
                self.provider_requests = self.provider_requests.saturating_sub(1);
                Err(error)
            }
        }
    }

    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError> {
        self.request(
            GeneratedAcpxSidecarCommand::TurnCancel,
            json!({ "turnId": turn_id, "reason": "Paperclip interruption" }),
        )
    }

    fn read(&mut self) -> Result<Value, LocalRunnerError> {
        self.request(GeneratedAcpxSidecarCommand::SessionRead, json!({}))
    }

    fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError> {
        if let Some(event) = self.inbox.pop_front() {
            return Ok(Some(event));
        }
        let Some(line) = self.receive_stdout_line(Duration::from_millis(1))? else {
            return if self.process.try_wait()?.is_some() {
                Ok(Some(ProviderEvent::Exited))
            } else {
                Ok(None)
            };
        };
        let frame = parse_frame(&line)?;
        self.map_frame(&frame)
    }

    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        let pending = self
            .pending_tools
            .get(&result.call_id)
            .cloned()
            .ok_or_else(|| {
                LocalRunnerError::invalid("ACPX tool result has no pending sidecar call")
            })?;
        if pending.operation_id != result.operation_id {
            return Err(LocalRunnerError::invalid(
                "ACPX tool result operation mismatch",
            ));
        }
        self.request(GeneratedAcpxSidecarCommand::ToolResolve, json!({
            "callId": result.call_id,
            "turnId": pending.turn_id,
            "result": result.result,
            "error": if result.is_error { json!({"message":"Paperclip semantic operation failed"}) } else { Value::Null },
        }))?;
        self.pending_tools.remove(&result.call_id);
        if !result.is_error
            && ["paperclip_finish", "paperclip_block"].contains(&result.operation_id.as_str())
        {
            self.inbox.push_back(ProviderEvent::SemanticResult {
                result: pending.input,
                item_id: Some(result.call_id.clone()),
            });
        }
        Ok(())
    }

    fn resolve_runtime_request(
        &mut self,
        request_id: &str,
        turn_id: &str,
        resolution: &Value,
    ) -> Result<(), LocalRunnerError> {
        if let Some(pending_turn_id) = self.pending_input_requests.get(request_id) {
            if pending_turn_id != turn_id {
                return Err(LocalRunnerError::invalid(
                    "ACPX input resolution named a stale turn",
                ));
            }
            self.request(
                GeneratedAcpxSidecarCommand::InputResolve,
                json!({
                    "requestId": request_id,
                    "turnId": turn_id,
                    "resolution": resolution,
                }),
            )?;
            self.pending_input_requests.remove(request_id);
            return Ok(());
        }
        let action = resolution
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("cancel");
        let outcome = match action {
            "accept" => "allow_once",
            "accept_for_session" => "allow_always",
            "decline" => "reject_once",
            "cancel" => "cancel",
            _ => {
                return Err(LocalRunnerError::invalid(
                    "unsupported ACPX permission resolution",
                ))
            }
        };
        self.request(
            GeneratedAcpxSidecarCommand::PermissionResolve,
            json!({
                "requestId": request_id,
                "turnId": turn_id,
                "decision": { "outcome": outcome },
            }),
        )?;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        if self.active_turn_id.is_none() {
            let _ = self.request(
                GeneratedAcpxSidecarCommand::SessionSuspend,
                json!({ "reason": "Paperclip runner suspension" }),
            );
        }
        self.process.terminate_group().map(|_| ())
    }
}

fn validate_config(config: &AcpxProviderConfig) -> Result<(), LocalRunnerError> {
    let (server_package, server_version, runtime_package, runtime_version, model, command_digest) =
        match config.agent.as_str() {
            "claude" => (
                "@agentclientprotocol/claude-agent-acp",
                "0.70.0",
                None,
                None,
                "claude-sonnet-5",
                "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
            ),
            "codex" => (
                "@agentclientprotocol/codex-acp",
                "1.6.2",
                None,
                None,
                "gpt-5.6-sol",
                "sha256:94049b3e3c3aee87de62703786e4fa81d031d7bd979f99bdf516d84f28791a79",
            ),
            _ => {
                return Err(LocalRunnerError::invalid(
                    "ACPX agent must be claude or codex",
                ))
            }
        };
    if config.acpx_version != "0.13.1"
        || config.agent_server_package != server_package
        || config.agent_server_version != server_version
        || config.agent_runtime_package.as_deref() != runtime_package
        || config.agent_runtime_version.as_deref() != runtime_version
        || config.model != model
        || !matches!(
            config.permission_mode.as_str(),
            "approve-all" | "approve-reads" | "deny-all"
        )
        || config.command_digest != command_digest
        || config.normalized_session_id.is_empty()
        || config.run_id.is_empty()
        || config.cwd.is_empty()
    {
        return Err(LocalRunnerError::invalid(
            "ACPX config does not match a qualified profile",
        ));
    }
    Ok(())
}

fn parse_frame(line: &str) -> Result<Value, LocalRunnerError> {
    let value: Value = serde_json::from_str(line).map_err(|error| {
        LocalRunnerError::invalid(format!("ACPX sidecar emitted invalid JSON: {error}"))
    })?;
    if value.get("protocolVersion").and_then(Value::as_u64)
        != Some(GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION)
    {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar protocol version mismatch",
        ));
    }
    Ok(value)
}

fn required_text(value: &Value, key: &str, label: &str) -> Result<String, LocalRunnerError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| LocalRunnerError::invalid(format!("ACPX sidecar omitted {label} identity")))
}

fn redact_acpx_diagnostic(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let boundary = [
        "authorization",
        "api_key",
        "apikey",
        "token",
        "secret",
        "password",
    ]
    .iter()
    .filter_map(|marker| lower.find(marker))
    .min();
    match boundary {
        Some(index) => format!("{}[REDACTED]", &value[..index]),
        None => value.chars().take(2_000).collect(),
    }
}

fn validate_question_set(value: &Value) -> Result<(), LocalRunnerError> {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/question-set.schema.json"
    ))
    .map_err(|_| LocalRunnerError::invalid("embedded question-set schema is invalid"))?;
    let validator = jsonschema::validator_for(&schema)
        .map_err(|_| LocalRunnerError::invalid("embedded question-set schema cannot compile"))?;
    if !validator.is_valid(value) {
        return Err(LocalRunnerError::invalid(
            "ACPX input request failed the Paperclip question-set schema",
        ));
    }
    if value.get("schema").and_then(Value::as_str) != Some("paperclip.question_set.v1") {
        return Err(LocalRunnerError::invalid(
            "ACPX input request used an unsupported question-set schema",
        ));
    }
    let questions = value
        .get("questions")
        .and_then(Value::as_array)
        .filter(|questions| !questions.is_empty() && questions.len() <= 64)
        .ok_or_else(|| {
            LocalRunnerError::invalid("ACPX input request must contain 1 through 64 questions")
        })?;
    let mut question_ids = std::collections::BTreeSet::new();
    for question in questions {
        let id = question
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 160)
            .ok_or_else(|| LocalRunnerError::invalid("ACPX input question omitted a valid id"))?;
        if !question_ids.insert(id) {
            return Err(LocalRunnerError::invalid(
                "ACPX input question ids must be unique",
            ));
        }
        if question.get("required").and_then(Value::as_bool).is_none()
            || question.get("prompt").and_then(Value::as_str).is_none()
        {
            return Err(LocalRunnerError::invalid(
                "ACPX input question omitted required presentation fields",
            ));
        }
        let answer_mode = question.get("answerMode").and_then(Value::as_str);
        if !matches!(answer_mode, Some("text" | "single_select" | "multi_select")) {
            return Err(LocalRunnerError::invalid(
                "ACPX input question used an unsupported answer mode",
            ));
        }
        if matches!(answer_mode, Some("single_select" | "multi_select"))
            && question
                .get("options")
                .and_then(Value::as_array)
                .map_or(true, Vec::is_empty)
        {
            return Err(LocalRunnerError::invalid(
                "ACPX select question omitted its options",
            ));
        }
    }
    Ok(())
}

fn permission_kind(value: Option<&str>) -> String {
    let kind = value.unwrap_or_default().to_ascii_lowercase();
    if kind.contains("write")
        || kind.contains("edit")
        || kind.contains("delete")
        || kind.contains("move")
    {
        "file_approval".to_owned()
    } else if kind.contains("execute") || kind.contains("terminal") {
        "command_approval".to_owned()
    } else {
        "permission_approval".to_owned()
    }
}

fn map_runtime_event(
    payload: Value,
    provider_requests: u64,
    thread_id: &str,
    turn_id: &str,
) -> ProviderEvent {
    match payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "text_delta" => ProviderEvent::Notification {
            method: "item/delta".to_owned(),
            params: json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": payload.get("messageId").and_then(Value::as_str).unwrap_or("acpx-agent-message"),
                "delta": payload.get("text").and_then(Value::as_str).unwrap_or_default(),
                "authoritative": true,
            }),
        },
        "thinking" => ProviderEvent::Notification {
            method: "item/started".to_owned(),
            params: json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": { "type": "reasoning", "status": "inProgress" },
            }),
        },
        "plan" => {
            let plan: Vec<Value> = payload
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .take(256)
                        .filter_map(|entry| {
                            let step = entry.get("content")?.as_str()?.trim();
                            if step.is_empty() {
                                return None;
                            }
                            Some(json!({
                                "step": step.chars().take(4000).collect::<String>(),
                                "status": entry.get("status").and_then(Value::as_str).unwrap_or("pending"),
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            ProviderEvent::Notification {
                method: "turn/plan/updated".to_owned(),
                params: json!({ "threadId": thread_id, "turnId": turn_id, "plan": plan }),
            }
        }
        "semantic_result" => ProviderEvent::SemanticResult {
            result: payload.get("result").cloned().unwrap_or(Value::Null),
            item_id: payload
                .get("callId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        "status" if payload.get("tag").and_then(Value::as_str) == Some("usage_update") => {
            let breakdown = payload
                .get("breakdown")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let provider_cost_usd = payload
                .pointer("/cost/amount")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            ProviderEvent::Notification {
                method: "thread/tokenUsage/updated".to_owned(),
                params: json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "tokenUsage": { "total": {
                        "inputTokens": breakdown.get("inputTokens"),
                        "outputTokens": breakdown.get("outputTokens"),
                        "cacheReadTokens": breakdown.get("cachedReadTokens"),
                        "cacheWriteTokens": breakdown.get("cachedWriteTokens"),
                        "reasoningTokens": breakdown.get("thoughtTokens"),
                        "providerCostUsd": provider_cost_usd,
                        "requests": provider_requests,
                    }},
                }),
            }
        }
        "tool_call" => {
            let completed = matches!(
                payload.get("status").and_then(Value::as_str),
                Some("completed" | "failed" | "cancelled" | "canceled")
            );
            ProviderEvent::Notification {
                method: if completed {
                    "item/completed"
                } else {
                    "item/started"
                }
                .to_owned(),
                params: json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {
                        "id": payload.get("toolCallId"),
                        "type": "commandExecution",
                        "command": payload.get("title"),
                        "status": payload.get("status"),
                        "locations": payload.get("locations"),
                        "aggregatedOutput": payload.get("output"),
                        "outputBytes": payload.get("outputBytes"),
                        "outputTruncated": payload.get("outputTruncated"),
                        "outputDigest": payload.get("outputDigest"),
                    }
                }),
            }
        }
        "provider_notice" => ProviderEvent::Notification {
            method: "warning".to_owned(),
            params: json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "code": payload.get("category").and_then(Value::as_str).unwrap_or("unclassified_acp_update"),
                "message": payload.get("summary").and_then(Value::as_str).unwrap_or("The qualified ACP agent emitted an unclassified runtime update."),
            }),
        },
        _ => ProviderEvent::Notification {
            method: "warning".to_owned(),
            params: json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "code": "unclassified_acp_runtime_event",
                "message": "The ACPX sidecar emitted an unclassified bounded runtime event.",
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qualified_test_config(sidecar_script: &str) -> AcpxProviderConfig {
        AcpxProviderConfig {
            agent: "codex".to_owned(),
            model: "gpt-5.6-sol".to_owned(),
            acpx_version: "0.13.1".to_owned(),
            agent_server_package: "@agentclientprotocol/codex-acp".to_owned(),
            agent_server_version: "1.6.2".to_owned(),
            agent_runtime_package: None,
            agent_runtime_version: None,
            command_digest:
                "sha256:94049b3e3c3aee87de62703786e4fa81d031d7bd979f99bdf516d84f28791a79".to_owned(),
            sidecar_command: "/bin/sh".into(),
            sidecar_args: vec!["-c".to_owned(), sidecar_script.to_owned()],
            runtime_directory: "/tmp/acpx-provider-test".to_owned(),
            normalized_session_id: "session-test".to_owned(),
            run_id: "run-test".to_owned(),
            cwd: "/tmp".to_owned(),
            instructions: "Test provider bootstrap diagnostics.".to_owned(),
            permission_mode: "deny-all".to_owned(),
            permission_mode_pinned: true,
            runtime_context: None,
        }
    }

    #[test]
    fn initialize_exit_reports_process_state_stage_and_redacted_stderr() {
        let result = AcpxProvider::start(
            &qualified_test_config(
                "IFS= read -r request; echo 'API_KEY=super-secret-acpx-token' >&2; exit 17",
            ),
            Vec::new(),
            None,
            None,
        );
        let error = match result {
            Ok(mut provider) => {
                provider.shutdown().unwrap();
                panic!("provider unexpectedly initialized")
            }
            Err(error) => error.to_string(),
        };
        assert!(error.contains("provider_process_exited"), "{error}");
        assert!(error.contains("provider=acpx"), "{error}");
        assert!(error.contains("stage=initialize"), "{error}");
        assert!(error.contains("[REDACTED]"), "{error}");
        assert!(!error.contains("super-secret-acpx-token"), "{error}");
    }

    #[test]
    fn malformed_initialize_response_reports_protocol_stage() {
        let result = AcpxProvider::start(
            &qualified_test_config("IFS= read -r request; echo 'not-json'"),
            Vec::new(),
            None,
            None,
        );
        let error = match result {
            Ok(mut provider) => {
                provider.shutdown().unwrap();
                panic!("provider unexpectedly initialized")
            }
            Err(error) => error.to_string(),
        };
        assert!(
            error.contains("provider_initialize_protocol_error"),
            "{error}"
        );
        assert!(error.contains("provider=acpx"), "{error}");
        assert!(error.contains("stage=initialize"), "{error}");
    }

    #[test]
    fn rejects_unqualified_profiles() {
        let config = AcpxProviderConfig {
            agent: "pi".to_owned(),
            model: "fallback".to_owned(),
            acpx_version: "0.13.1".to_owned(),
            agent_server_package: "pi-acp".to_owned(),
            agent_server_version: "0.0.33".to_owned(),
            agent_runtime_package: Some("@earendil-works/pi-coding-agent".to_owned()),
            agent_runtime_version: Some("0.84.2".to_owned()),
            command_digest: "sha256:test".to_owned(),
            sidecar_command: "node".into(),
            sidecar_args: vec![],
            runtime_directory: "/tmp/acpx".to_owned(),
            normalized_session_id: "session".to_owned(),
            run_id: "run".to_owned(),
            cwd: "/tmp/workspace".to_owned(),
            instructions: "safe".to_owned(),
            permission_mode: "approve-all".to_owned(),
            permission_mode_pinned: true,
            runtime_context: None,
        };
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn maps_thought_without_retaining_hidden_text() {
        let event = map_runtime_event(
            json!({ "type": "thinking", "text": "secret chain of thought" }),
            1,
            "thread-1",
            "turn-1",
        );
        match event {
            ProviderEvent::Notification { params, .. } => {
                assert!(!params.to_string().contains("secret"));
                assert_eq!(params["threadId"], "thread-1");
                assert_eq!(params["turnId"], "turn-1");
            }
            _ => panic!("expected notification"),
        }
    }

    #[test]
    fn maps_runner_owned_terminal_result_without_control_plane_tool_authority() {
        let result = json!({
            "schema": "paperclip.run_result.v1",
            "reportedWorkDisposition": "done"
        });
        let event = map_runtime_event(
            json!({ "type": "semantic_result", "callId": "finish-1", "result": result }),
            1,
            "thread-1",
            "turn-1",
        );
        match event {
            ProviderEvent::SemanticResult { result, item_id } => {
                assert_eq!(result["reportedWorkDisposition"], "done");
                assert_eq!(item_id.as_deref(), Some("finish-1"));
            }
            _ => panic!("expected semantic result"),
        }
    }

    #[test]
    fn preserves_every_structured_plan_entry_for_the_active_turn() {
        let event = map_runtime_event(
            json!({
                "type": "plan",
                "entries": [
                    {"content": "Inspect", "status": "completed", "priority": "high"},
                    {"content": "Implement", "status": "in_progress", "priority": "medium"},
                    {"content": "Verify", "status": "pending", "priority": "low"}
                ]
            }),
            1,
            "thread-acp",
            "turn-acp",
        );
        match event {
            ProviderEvent::Notification { method, params } => {
                assert_eq!(method, "turn/plan/updated");
                assert_eq!(params["threadId"], "thread-acp");
                assert_eq!(params["turnId"], "turn-acp");
                assert_eq!(params["plan"].as_array().unwrap().len(), 3);
                assert_eq!(params["plan"][0]["step"], "Inspect");
                assert_eq!(params["plan"][1]["status"], "in_progress");
                assert_eq!(params["plan"][2]["step"], "Verify");
            }
            _ => panic!("expected plan notification"),
        }
    }
}
