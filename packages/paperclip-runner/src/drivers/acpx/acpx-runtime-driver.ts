import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AcpElicitationResponse,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpRuntimeEvent,
} from "acpx/runtime";

import {
  createCodexTaskEnvelope,
  type CodexTaskEnvelope,
} from "../../contracts/codex.js";
import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessStaleTurnError,
  harnessRuntimeInputExpiredOutcome,
  harnessRuntimeRequestOutcome,
  parseHarnessRuntimeRequestResolution,
  type HarnessDriver,
  type HarnessDriverConfigValidation,
  type HarnessDriverDescriptor,
  type HarnessRuntimeRequest,
  type HarnessRuntimeRequestResolution,
  type HarnessSession,
  type HarnessSessionRecoveryResult,
  type HarnessTranscriptSnapshot,
  type OpenHarnessSessionInput,
  type PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import type { NativeSessionCapabilities, NativeUserMessage } from "../../contracts/types.js";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import { paperclipWorkspaceFileReferencesFromText } from "../../live/workspace-file-reference.js";
import type { PrpEvent, PrpStructuredRunResult } from "../../protocol/replay-contract.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import {
  canonicalProviderEventsFromAcpxRuntimeEvent,
  createAcpxToolEventNormalizer,
  providerFamilyCapabilities,
} from "../../provider-events.js";
import { canonicalRunnerToolName } from "../runner-tool-bridge.js";
import {
  AcpxRuntimeHost,
  type AcpxRuntimeFactory,
  type AcpxRuntimeIdentity,
  type AcpxRuntimeElicitationContext,
  type AcpxRuntimePermissionContext,
  type AcpxRuntimeUsage,
} from "./acpx-runtime-host.js";
import { normalizeAcpFormElicitation } from "./acp-question-adapter.js";
import { PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2 } from "../../contracts/question-set.js";
import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import {
  ACPX_DRIVER_KIND,
  QUALIFIED_ACPX_VERSION,
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "./qualified-profiles.js";

type DynamicToolHandler = (call: {
  tool: string;
  callId: string;
  threadId: string;
  turnId: string;
  arguments: unknown;
}) => Promise<unknown>;

export interface AcpxRuntimeDriverOptions {
  agent: QualifiedAcpxAgent;
  model: string;
  permissionMode?: NativeAcpxPermissionMode;
  /** False only when replaying a pre-v4 native execution. */
  permissionModePinned?: boolean;
  runtimeDirectory: string;
  systemInstructions?: string;
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  taskEnvelope?: CodexTaskEnvelope;
  environment?: NodeJS.ProcessEnv;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: DynamicToolHandler;
  runnerInstanceId?: string;
  runtimeFactory?: AcpxRuntimeFactory;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  onDiagnostic?: (message: string) => void;
  now?: () => Date;
}

export function acpxCapabilities(agent: QualifiedAcpxAgent): NativeSessionCapabilities {
  return {
    resume: true,
    typedEvents: true,
    typedEventFamilies: providerFamilyCapabilities({
      plan: "available",
      tool_execution: "available",
      model_identity: "available",
      review: "available",
      provider_notice: "available",
      artifact: "policy_disabled",
    }),
    steering: false,
    interruption: true,
    structuredResult: true,
    read: true,
    reconciliation: true,
    usage: true,
    dynamicTools: true,
    runtimeRequestResolution: true,
    runtimeRequestHandoff: true,
    goals: false,
    threadLineage: false,
    unsupported: ["steering", "goals", "threadLineage"],
  };
}

interface PendingPermission {
  request: HarnessRuntimeRequest;
  settle: (decision: AcpPermissionDecision | undefined) => void;
}

interface PendingInput {
  request: HarnessRuntimeRequest;
  accept: NonNullable<ReturnType<typeof normalizeAcpFormElicitation>>;
  settle: (response: AcpElicitationResponse) => void;
}

export class AcpxRuntimeDriver implements HarnessDriver {
  readonly #options: AcpxRuntimeDriverOptions;

  constructor(options: AcpxRuntimeDriverOptions) {
    if (options.agent === "pi") throw new Error("The Pi ACPX profile is not available");
    this.#options = options;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: ACPX_DRIVER_KIND,
      displayName: `${displayAgent(this.#options.agent)} via ACPX`,
      version: QUALIFIED_ACPX_VERSION,
      protocolVersion: "acp/v1",
      runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
      capabilities: acpxCapabilities(this.#options.agent),
    };
  }

  async validateConfig(value: unknown): Promise<HarnessDriverConfigValidation> {
    const config = record(value);
    const agent = text(config.agent);
    const model = text(config.model);
    const permissionMode = text(config.permissionMode) || "approve-all";
    const issues: Array<{ path: string; code: string; message: string }> = [];
    if (!["claude", "codex"].includes(agent)) {
      issues.push({ path: "agent", code: "invalid_agent", message: "ACPX agent must be claude or codex." });
    } else {
      try { resolveQualifiedAcpxProfile(agent as QualifiedAcpxAgent, model); }
      catch (error) { issues.push({ path: "model", code: "invalid_model", message: String(error) }); }
    }
    if (!["approve-all", "approve-reads", "deny-all"].includes(permissionMode)) {
      issues.push({ path: "permissionMode", code: "invalid_permission_mode", message: "ACPX permission mode must be approve-all, approve-reads, or deny-all." });
    }
    return issues.length === 0
      ? { ok: true, config: { agent, model, permissionMode }, issues: [] }
      : { ok: false, config: null, issues };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    return this.#open(input, null);
  }

  async recoverSession(snapshot: PersistedHarnessSession): Promise<HarnessSessionRecoveryResult> {
    if (
      snapshot.driverKind !== ACPX_DRIVER_KIND
      || !snapshot.runId
      || !snapshot.normalizedSessionId
      || snapshot.providerIdentity?.kind !== "acpx"
    ) return { recovered: false, reason: "persisted ACPX session identity is incomplete" };
    try {
      const workspace = (await readFile(
        join(sessionRoot(this.#options.runtimeDirectory, snapshot.normalizedSessionId), "workspace"),
        "utf8",
      )).trim();
      const input = {
        runId: snapshot.runId,
        normalizedSessionId: snapshot.normalizedSessionId,
        workingDirectory: workspace,
      };
      const replaceProviderSession =
        snapshot.providerRecoveryPolicy ===
        "allow_replacement_after_governed_wait";
      if (replaceProviderSession) {
        this.#options.onDiagnostic?.(
          "ACPX is opening a replacement provider session for a durable governed-wait continuation while preserving the Paperclip session lineage.",
        );
      }
      // ACPX 0.13 may not surface an unresumable persistent child until the
      // first prompt, after ensureSession has already returned successfully.
      // The explicit governed-wait policy therefore rotates proactively; all
      // other recovery remains strict same-session-only.
      const session = await this.#open(
        input,
        snapshot,
        replaceProviderSession,
      );
      return { recovered: true, session };
    } catch (error) {
      return { recovered: false, reason: redact(String(error), this.#options.environment) };
    }
  }

  async #open(
    input: OpenHarnessSessionInput,
    snapshot: PersistedHarnessSession | null,
    replaceProviderSession = false,
  ): Promise<HarnessSession> {
    let session: AcpxHarnessSession | null = null;
    const permissionMode = this.#options.permissionMode ?? "approve-all";
    this.#options.onDiagnostic?.(
      `Starting ACPX ${this.#options.agent} with permission mode ${permissionMode}.`,
    );
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: this.#options.runtimeDirectory,
      normalizedSessionId: input.normalizedSessionId,
      ...(replaceProviderSession
        ? {
            providerSessionKey:
              `${input.normalizedSessionId}${this.#options.permissionModePinned ? `:permission:${permissionMode}` : ""}:governed-wait-replacement:${input.runId}`,
          }
        : this.#options.permissionModePinned
          ? { providerSessionKey: `${input.normalizedSessionId}:permission:${permissionMode}` }
          : {}),
      workingDirectory: input.workingDirectory,
      agent: this.#options.agent,
      model: this.#options.model,
      permissionMode,
      systemInstructions: this.#options.systemInstructions,
      runtimeContext: this.#options.runtimeContext,
      ...(!replaceProviderSession && snapshot?.providerIdentity?.kind === "acpx"
        ? { expectedIdentity: snapshot.providerIdentity }
        : {}),
      environment: this.#options.environment,
      dynamicTools: this.#options.dynamicTools,
      dynamicToolHandler: (call) => {
        if (!session) throw new Error("ACPX session is not ready for semantic tool calls");
        return session.dispatchTool(call);
      },
      onPermissionRequest: (context) => {
        if (!session) return Promise.resolve({ outcome: "reject_once" });
        return session.requestPermission(context);
      },
      onElicitation: (context) => {
        if (!session) return Promise.resolve({ action: "cancel" });
        return session.requestInput(context);
      },
      runtimeFactory: this.#options.runtimeFactory,
      onSpawn: this.#options.onSpawn,
      onUsage: (usage) => session?.acceptUsage(usage),
      onDiagnostic: this.#options.onDiagnostic,
    });
    try {
      if (!replaceProviderSession && snapshot?.providerIdentity?.kind === "acpx") {
        assertRecoveryIdentity(snapshot.providerIdentity, host.identity(), input.workingDirectory);
      }
      session = new AcpxHarnessSession({
        host,
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        workingDirectory: input.workingDirectory,
        taskEnvelope: this.#options.taskEnvelope ?? createCodexTaskEnvelope({ objective: "Complete the supplied task." }),
        dynamicToolHandler: this.#options.dynamicToolHandler,
        runnerInstanceId: this.#options.runnerInstanceId ?? `paperclip-acpx-${input.runId}`,
        snapshot,
        now: this.#options.now ?? (() => new Date()),
      });
      return session;
    } catch (error) {
      await host.close({ reason: "ACPX session initialization failed" }).catch(() => {});
      throw error;
    }
  }
}

class AcpxHarnessSession implements HarnessSession {
  readonly #host: AcpxRuntimeHost;
  #runId: string;
  readonly #normalizedSessionId: string;
  readonly #workingDirectory: string;
  readonly #taskEnvelope: CodexTaskEnvelope;
  readonly #dynamicToolHandler?: DynamicToolHandler;
  readonly #runnerInstanceId: string;
  readonly #providerRecoveryPolicy: PersistedHarnessSession["providerRecoveryPolicy"];
  readonly #now: () => Date;
  readonly #events = new AsyncQueue<PrpEvent>();
  readonly #transcript: PrpEvent[] = [];
  readonly #terminalTurns = new Map<string, string>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #pendingInputs = new Map<string, PendingInput>();
  readonly #emittedFileReferences = new Set<string>();
  #sourceSequence: number;
  #activeTurnId: string | null;
  #activeTurnAbort: AbortController | null = null;
  #result: PrpStructuredRunResult | null;
  #resultFingerprint: string | null;
  #resultCallId: string | null;
  #resultTurnId: string | null;
  #usage: Record<string, unknown> | null = null;
  #assistantText = "";
  #assistantTextSinceLastWorkTool = "";
  #assistantTextAtSemanticResult: string | null = null;
  #traceCorrelationEventIds: string[] | null = null;
  #thinking = false;
  #closed = false;

  constructor(input: {
    host: AcpxRuntimeHost;
    runId: string;
    normalizedSessionId: string;
    workingDirectory: string;
    taskEnvelope: CodexTaskEnvelope;
    dynamicToolHandler?: DynamicToolHandler;
    runnerInstanceId: string;
    snapshot: PersistedHarnessSession | null;
    now: () => Date;
  }) {
    this.#host = input.host;
    this.#runId = input.runId;
    this.#normalizedSessionId = input.normalizedSessionId;
    this.#workingDirectory = resolve(input.workingDirectory);
    this.#taskEnvelope = input.taskEnvelope;
    this.#dynamicToolHandler = input.dynamicToolHandler;
    this.#runnerInstanceId = input.runnerInstanceId;
    this.#providerRecoveryPolicy =
      input.snapshot?.providerRecoveryPolicy ?? "same_session_only";
    this.#now = input.now;
    this.#sourceSequence = input.snapshot?.lastSourceSequence ?? 0;
    this.#activeTurnId = input.snapshot?.activeTurnId ?? null;
    this.#result = input.snapshot?.semanticResult?.result ?? null;
    this.#resultFingerprint = input.snapshot?.semanticResult?.fingerprint ?? null;
    this.#resultCallId = input.snapshot?.semanticResult?.callId ?? null;
    this.#resultTurnId = input.snapshot?.semanticResult?.turnId ?? null;
    for (const terminal of input.snapshot?.terminalTurns ?? []) {
      this.#terminalTurns.set(terminal.turnId, terminal.fingerprint);
    }
    if (this.#activeTurnId && this.#terminalTurns.has(this.#activeTurnId)) {
      this.#activeTurnId = null;
    }
    for (const stale of input.snapshot?.pendingRuntimeRequests ?? []) {
      this.#emit(
        "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(stale, { reason: "transport_recovered" }),
        { turnId: stale.turnId, itemId: stale.itemId },
      );
    }
  }

  ids() {
    const identity = this.#host.identity();
    return {
      driverSessionId: identity.acpxRecordId,
      providerSessionId: identity.agentSessionId,
      displayId: identity.agentSessionId,
    };
  }

  events(): AsyncIterable<PrpEvent> { return this.#events; }

  attachRun(input: { runId: string }): void {
    if (this.#activeTurnId !== null || this.#pendingPermissions.size > 0 || this.#pendingInputs.size > 0) {
      throw new Error("acpx_run_attach_busy");
    }
    if (!input.runId.trim()) throw new Error("acpx_run_attach_invalid");
    this.#runId = input.runId;
    this.#result = null;
    this.#resultFingerprint = null;
    this.#resultCallId = null;
    this.#resultTurnId = null;
    this.#assistantText = "";
    this.#assistantTextSinceLastWorkTool = "";
    this.#assistantTextAtSemanticResult = null;
    this.#emit("run.attached", { runId: input.runId, sameSession: true });
  }

  async startTurn(input: { message: NativeUserMessage }): Promise<{ turnId: string }> {
    if (this.#closed) throw new Error("ACPX session is closed");
    if (this.#activeTurnId !== null) throw new Error("ACPX session already has an active turn");
    const turnId = `turn-${randomBytes(12).toString("hex")}`;
    this.#activeTurnId = turnId;
    this.#assistantText = "";
    this.#assistantTextSinceLastWorkTool = "";
    this.#assistantTextAtSemanticResult = null;
    this.#activeTurnAbort = new AbortController();
    this.#emit("turn.submitted", { envelopeSchema: this.#taskEnvelope.schema, text: input.message.text });
    this.#emit("turn.accepted", { turnId }, { turnId });
    this.#emit("turn.started", { status: "inProgress" }, { turnId });
    const turn = this.#host.startTurn({
      requestId: `${this.#runId}:${turnId}`,
      text: JSON.stringify({ task: this.#taskEnvelope, message: input.message.text }),
      signal: this.#activeTurnAbort.signal,
    });
    void this.#pumpTurn(turnId, turn);
    return { turnId };
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    if (input.turnId && this.#activeTurnId !== input.turnId) throw new HarnessStaleTurnError(input.turnId);
    if (this.#activeTurnId === null) throw new HarnessCapabilityUnavailableError("interruption", "there is no active ACPX turn");
    await this.#host.cancel(input.reason);
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return [...this.#pendingPermissions.values(), ...this.#pendingInputs.values()]
      .map((pending) => structuredClone(pending.request));
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    const pendingInput = this.#pendingInputs.get(input.requestId);
    const pendingPermission = this.#pendingPermissions.get(input.requestId);
    const pending = pendingInput ?? pendingPermission;
    if (!pending) throw new HarnessCapabilityUnavailableError("runtime request resolution", `request ${input.requestId} is no longer pending`);
    if (pending.request.turnId !== input.turnId || this.#activeTurnId !== input.turnId) {
      throw new HarnessStaleTurnError(input.turnId);
    }
    const resolution = parseHarnessRuntimeRequestResolution(
      pending.request.requestKind,
      input.resolution,
      pending.request.input,
    );
    if (pendingInput) {
      this.#pendingInputs.delete(input.requestId);
      this.#emit("runtime_request.resolved", harnessRuntimeRequestOutcome(pending.request, {
        action: resolution.action,
        ...(resolution.action === "submit" && "response" in resolution
          ? { response: resolution.response }
          : {}),
      }), {
        turnId: input.turnId,
        itemId: pending.request.itemId,
      });
      if (resolution.action === "submit" && "response" in resolution) {
        pendingInput.settle(pendingInput.accept.accept(resolution.response));
      } else if (resolution.action === "decline") {
        pendingInput.settle({ action: "decline" });
      } else {
        pendingInput.settle({ action: "cancel" });
      }
      return;
    }
    if (!pendingPermission) {
      throw new HarnessCapabilityUnavailableError("runtime request resolution", `request ${input.requestId} is no longer pending`);
    }
    const decision = permissionDecision(resolution.action);
    this.#pendingPermissions.delete(input.requestId);
    this.#emit("runtime_request.resolved", harnessRuntimeRequestOutcome(pending.request, { action: resolution.action }), {
      turnId: input.turnId,
      itemId: pending.request.itemId,
    });
    pendingPermission.settle(decision);
  }

  async handoffRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
  }): Promise<"handed_off" | "already_settled"> {
    const pending = this.#pendingInputs.get(input.requestId);
    if (
      !pending
      || pending.request.turnId !== input.turnId
      || this.#activeTurnId !== input.turnId
    ) return "already_settled";
    if (!this.#pendingInputs.delete(input.requestId)) return "already_settled";
    this.#emit(
      "runtime_request.expired",
      harnessRuntimeInputExpiredOutcome(pending.request, input.reason),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
    pending.settle({ action: "cancel" });
    await this.#host.cancel("durable_handoff").catch(() => undefined);
    return "handed_off";
  }

  async requestPermission(context: AcpxRuntimePermissionContext): Promise<AcpPermissionDecision | undefined> {
    const turnId = this.#activeTurnId;
    if (!turnId || context.signal.aborted) return { outcome: "cancel" };
    const raw = record(context.request.raw);
    const toolCall = record(raw.toolCall);
    const requestId = safeId(text(toolCall.toolCallId, text(toolCall.id)), `permission-${randomBytes(8).toString("hex")}`);
    if (this.#pendingPermissions.has(requestId)) return { outcome: "reject_once" };
    const inferred = text(context.request.inferredKind).toLowerCase();
    const requestKind = /write|edit|delete|move/.test(inferred) ? "file_approval"
      : /execute|terminal/.test(inferred) ? "command_approval"
        : "permission_approval";
    const runtimeRequest: HarnessRuntimeRequest = {
      requestId,
      requestKind,
      method: "acp/session/request_permission",
      turnId,
      itemId: safeId(text(toolCall.toolCallId, requestId), requestId),
      status: "pending",
      prompt: text(toolCall.title, `Allow ${inferred || "requested capability"}?`).slice(0, 4000),
      details: {
        toolKind: inferred || "unknown",
        toolTitle: text(toolCall.title).slice(0, 4000) || null,
        optionCount: Array.isArray(raw.options) ? Math.min(raw.options.length, 32) : 0,
      },
    };
    this.#emit("runtime_request.created", { request: { ...runtimeRequest, type: runtimeRequest.method } }, {
      turnId,
      itemId: runtimeRequest.itemId,
    });
    return new Promise((settle) => {
      const abort = () => {
        const pending = this.#pendingPermissions.get(requestId);
        if (!pending) return;
        this.#pendingPermissions.delete(requestId);
        this.#emit("runtime_request.cancelled", harnessRuntimeRequestOutcome(runtimeRequest, { reason: "provider_cancelled" }), {
          turnId,
          itemId: runtimeRequest.itemId,
        });
        settle({ outcome: "cancel" });
      };
      context.signal.addEventListener("abort", abort, { once: true });
      this.#pendingPermissions.set(requestId, {
        request: runtimeRequest,
        settle: (decision) => {
          context.signal.removeEventListener("abort", abort);
          settle(decision);
        },
      });
    });
  }

  async requestInput(context: AcpxRuntimeElicitationContext): Promise<AcpElicitationResponse> {
    const turnId = this.#activeTurnId;
    if (!turnId || context.signal.aborted) return { action: "cancel" };
    let normalized: ReturnType<typeof normalizeAcpFormElicitation>;
    try {
      normalized = normalizeAcpFormElicitation(context.request);
    } catch (error) {
      this.#emit("harness.diagnostic", {
        code: "runtime_input_rejected",
        adapter: "acpx-runtime",
        reason: redact(String(error)).slice(0, 4_000),
      }, { turnId });
      return { action: "decline" };
    }
    if (!normalized) return { action: "decline" };
    const requestId = safeId(String(context.requestId), `input-${randomBytes(8).toString("hex")}`);
    if (this.#pendingInputs.has(requestId)) return { action: "decline" };
    const runtimeRequest: HarnessRuntimeRequest = {
      requestId,
      requestKind: "elicitation",
      method: "elicitation/create",
      turnId,
      itemId: requestId,
      status: "pending",
      prompt: normalized.questionSet.title ?? "Additional information needed",
      details: {},
      input: normalized.questionSet,
      origin: {
        adapter: "acpx-runtime",
        provider: "acpx",
        method: "elicitation/create",
      },
    };
    this.#emit("runtime_request.created", {
      request: {
        schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
        requestKind: "runtime",
        requestId,
        type: "input",
        status: "pending",
        prompt: runtimeRequest.prompt,
        input: normalized.questionSet,
        origin: runtimeRequest.origin,
        turnId,
        itemId: requestId,
      },
    }, { turnId, itemId: requestId });
    return new Promise((settle) => {
      const abort = () => {
        const pending = this.#pendingInputs.get(requestId);
        if (!pending) return;
        this.#pendingInputs.delete(requestId);
        this.#emit("runtime_request.cancelled", harnessRuntimeRequestOutcome(runtimeRequest, { reason: "provider_cancelled" }), {
          turnId,
          itemId: requestId,
        });
        settle({ action: "cancel" });
      };
      context.signal.addEventListener("abort", abort, { once: true });
      this.#pendingInputs.set(requestId, {
        request: runtimeRequest,
        accept: normalized,
        settle: (response) => {
          context.signal.removeEventListener("abort", abort);
          settle(response);
        },
      });
    });
  }

  async dispatchTool(call: { tool: string; callId: string; arguments: unknown }): Promise<unknown> {
    const turnId = this.#activeTurnId;
    if (!turnId) throw new Error("ACPX semantic tool call is not bound to an active turn");
    const tool = canonicalRunnerToolName(call.tool);
    const traceFrameId = this.#host.latestInboundTraceFrameId();
    const traceEventIds: string[] = [];
    traceEventIds.push(this.#emit("item.started", {
      kind: "dynamicToolCall",
      item: { type: "tool_call", id: call.callId, name: tool, arguments: bounded(call.arguments) },
    }, { turnId, itemId: call.callId }));
    try {
      if (tool === PRP_COMPLETION_TOOL_NAME || tool === PRP_BLOCK_TOOL_NAME) {
        const validation = validatePrpStructuredRunResult(call.arguments);
        if (!validation.ok) throw new Error("Invalid semantic result");
        if (
          (tool === PRP_BLOCK_TOOL_NAME && validation.result.reportedWorkDisposition !== "blocked")
          || (tool === PRP_COMPLETION_TOOL_NAME && validation.result.reportedWorkDisposition === "blocked")
        ) throw new Error("Semantic result disposition does not match the terminal tool");
        if (validation.result.completionClaim.contractRevision !== this.#taskEnvelope.completionContract.revision) {
          throw new Error("Semantic result completion contract revision does not match");
        }
        const fingerprint = canonicalJson(validation.result);
        if (this.#resultFingerprint && this.#resultFingerprint !== fingerprint) throw new Error("A different semantic result was already committed");
        if (!this.#resultFingerprint) {
          this.#result = structuredClone(validation.result);
          this.#resultFingerprint = fingerprint;
          this.#resultCallId = call.callId;
          this.#resultTurnId = turnId;
          this.#assistantTextAtSemanticResult = this.#assistantTextSinceLastWorkTool.trim() || null;
          traceEventIds.push(this.#emit("run.result.proposed", validation.result, { turnId, itemId: call.callId }));
        }
        traceEventIds.push(this.#emit("item.completed", {
          kind: "dynamicToolCall",
          item: { type: "tool_result", id: call.callId, tool_use_id: call.callId, result: "Semantic completion accepted." },
        }, { turnId, itemId: call.callId }));
        return { accepted: true };
      }
      if (!this.#dynamicToolHandler) throw new Error("Unsupported Paperclip operation");
      const result = await this.#dynamicToolHandler({
        tool,
        callId: call.callId,
        threadId: this.#host.identity().agentSessionId,
        turnId,
        arguments: call.arguments,
      });
      traceEventIds.push(this.#emit("item.completed", {
        kind: "dynamicToolCall",
        item: { type: "tool_result", id: call.callId, tool_use_id: call.callId, result: bounded(result) },
      }, { turnId, itemId: call.callId }));
      return result;
    } catch (error) {
      traceEventIds.push(this.#emit("item.completed", {
        kind: "dynamicToolCall",
        item: { type: "tool_result", id: call.callId, tool_use_id: call.callId, error: redact(String(error)), is_error: true },
      }, { turnId, itemId: call.callId }));
      throw error;
    } finally {
      this.#host.correlateProviderFrame(traceFrameId, traceEventIds, `semantic_tool.${tool}`);
    }
  }

  acceptUsage(usage: AcpxRuntimeUsage): void {
    const turnId = this.#activeTurnId;
    if (!turnId) return;
    this.#captureUsage({
      cumulative: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedReadTokens: usage.cachedReadTokens,
        cachedWriteTokens: usage.cachedWriteTokens,
        thoughtTokens: usage.thoughtTokens,
        totalTokens: usage.totalTokens,
      },
      cost: usage.cost,
    }, turnId, `${turnId}:usage-live:${this.#sourceSequence + 1}`);
  }

  async read(): Promise<Record<string, unknown>> {
    return { identity: this.#host.identity(), status: await this.#host.status() };
  }

  async reconcile(): Promise<Record<string, unknown>> {
    const status = await this.#host.status();
    const identity = this.#host.identity();
    if (status.agentSessionId && status.agentSessionId !== identity.agentSessionId) {
      throw new Error("ACPX reconciliation returned a different agent session");
    }
    return { identity, status };
  }

  async usage(): Promise<Record<string, unknown> | null> {
    if (this.#usage) return structuredClone(this.#usage);
    const status = await this.#host.status();
    return status.usage ? bounded(status.usage) : null;
  }

  async transcript(): Promise<HarnessTranscriptSnapshot> {
    return {
      schema: "paperclip-runner/harness-transcript/v1",
      complete: true,
      eventCount: this.#transcript.length,
      events: structuredClone(this.#transcript),
      omissionReason: null,
    };
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    const identity = this.#host.identity();
    return {
      driverKind: ACPX_DRIVER_KIND,
      driverSessionId: identity.acpxRecordId,
      providerSessionId: identity.agentSessionId,
      providerIdentity: {
        kind: "acpx",
        normalizedSessionId: this.#normalizedSessionId,
        acpxRecordId: identity.acpxRecordId,
        backendSessionId: identity.backendSessionId,
        agentSessionId: identity.agentSessionId,
        profileDigest: identity.profile.commandDigest,
        workspaceDigest: workspaceDigest(this.#workingDirectory),
        requestedModel: identity.requestedModel,
        effectiveModel: identity.effectiveModel,
        permissionMode: identity.permissionMode,
      },
      providerRecoveryPolicy: this.#providerRecoveryPolicy,
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      semanticResult: this.#result && this.#resultFingerprint && this.#resultTurnId
        ? { result: structuredClone(this.#result), fingerprint: this.#resultFingerprint, callId: this.#resultCallId, turnId: this.#resultTurnId }
        : null,
      terminalTurns: [...this.#terminalTurns].map(([turnId, fingerprint]) => ({ turnId, fingerprint })),
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
      lastSourceSequence: this.#sourceSequence,
    };
  }

  async close(input: { reason: string; force?: boolean }): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pendingPermissions.values()) {
      this.#emit("runtime_request.cancelled", harnessRuntimeRequestOutcome(pending.request, { reason: "session_closed" }), {
        turnId: pending.request.turnId,
        itemId: pending.request.itemId,
      });
      pending.settle({ outcome: "cancel" });
    }
    this.#pendingPermissions.clear();
    for (const pending of this.#pendingInputs.values()) {
      this.#emit("runtime_request.expired", harnessRuntimeInputExpiredOutcome(pending.request, "provider_process_lost"), {
        turnId: pending.request.turnId,
        itemId: pending.request.itemId,
      });
      pending.settle({ action: "cancel" });
    }
    this.#pendingInputs.clear();
    this.#events.close();
    await this.#host.close({ reason: input.reason, discardPersistentState: false });
  }

  #expirePendingInputsAfterProviderLoss(): void {
    for (const [requestId, pending] of this.#pendingInputs) {
      this.#pendingInputs.delete(requestId);
      this.#emit(
        "runtime_request.expired",
        harnessRuntimeInputExpiredOutcome(pending.request, "provider_process_lost"),
        { turnId: pending.request.turnId, itemId: pending.request.itemId },
      );
      pending.settle({ action: "cancel" });
    }
  }

  async #pumpTurn(turnId: string, turn: ReturnType<AcpxRuntimeHost["startTurn"]>): Promise<void> {
    try {
      let index = 0;
      const normalizeToolEvent = createAcpxToolEventNormalizer();
      for await (const event of turn.events) {
        const frameId = this.#host.latestInboundTraceFrameId();
        const emittedEventIds: string[] = [];
        this.#traceCorrelationEventIds = emittedEventIds;
        try {
          this.#mapRuntimeEvent(normalizeToolEvent(event), turnId, ++index);
        } finally {
          this.#traceCorrelationEventIds = null;
        }
        this.#host.correlateProviderFrame(frameId, emittedEventIds, event.type);
      }
      const result = await turn.result;
      if (this.#thinking) {
        this.#emit("item.completed", { kind: "thinking", text: "Reasoning completed." }, { turnId, itemId: `${turnId}:thinking` });
        this.#thinking = false;
      }
      const status = await this.#host.status();
      this.#captureUsage(status.usage, turnId, `${turnId}:usage-final`);
      const effectiveModel = status.models?.currentModelId;
      const identity = this.#host.identity();
      if (effectiveModel && effectiveModel !== identity.effectiveModel) {
        this.#emit("model.route.changed", {
          schema: "paperclip.model.route_changed.v1",
          routeId: `${turnId}:model-route`,
          provider: biller(identity.profile.agent),
          requestedModel: identity.requestedModel,
          fromModel: identity.effectiveModel,
          effectiveModel,
          reason: "ACP agent reported an effective model change",
        }, { turnId, itemId: `${turnId}:model-route` });
      }
      if (this.#activeTurnId === turnId) this.#activeTurnId = null;
      this.#activeTurnAbort = null;
      if (result.status === "completed") {
        const finalText = selectAcpxFinalAgentMessage({
          semanticResultCommitted: this.#resultFingerprint !== null,
          textAtSemanticResult: this.#assistantTextAtSemanticResult,
          textAfterLastWorkTool: this.#assistantTextSinceLastWorkTool,
        });
        if (finalText) {
          this.#emit("item.completed", {
            kind: "agentMessage",
            channel: "final",
            providerPhase: "final_answer",
            text: finalText,
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: finalText,
            },
          }, { turnId, itemId: `${turnId}:final-answer` });
        }
        this.#terminalTurns.set(turnId, canonicalJson({ status: "completed", semanticResult: this.#resultFingerprint }));
        this.#emit("turn.completed", { status: "completed", stopReason: result.stopReason ?? null }, { turnId });
      } else if (result.status === "cancelled") {
        this.#terminalTurns.set(turnId, canonicalJson({ status: "interrupted" }));
        this.#emit("turn.interrupted", { status: "interrupted", stopReason: result.stopReason ?? "cancelled" }, { turnId });
      } else {
        this.#terminalTurns.set(turnId, canonicalJson({ status: "failed" }));
        this.#emit("provider.notice.recorded", {
          schema: "paperclip.provider.notice.v1",
          noticeId: `${turnId}:failure`,
          severity: "error",
          category: "acpx_turn_failed",
          scope: "turn",
          recoverable: result.error.retryable ?? false,
          userActionable: true,
          summary: redact(result.error.message, this.#optionsEnvironment()).slice(0, 4000),
        }, { turnId, itemId: `${turnId}:failure` });
        this.#emit("turn.failed", { status: "failed", error: { code: result.error.code ?? null, message: redact(result.error.message) } }, { turnId });
      }
    } catch (error) {
      this.#expirePendingInputsAfterProviderLoss();
      if (this.#activeTurnId === turnId) this.#activeTurnId = null;
      this.#activeTurnAbort = null;
      this.#terminalTurns.set(turnId, canonicalJson({ status: "failed" }));
      this.#emit("turn.failed", { status: "failed", error: { message: redact(String(error)) } }, { turnId });
    } finally {
      if (this.#activeTurnId === turnId) this.#activeTurnId = null;
      this.#activeTurnAbort = null;
    }
  }

  #mapRuntimeEvent(event: AcpRuntimeEvent, turnId: string, index: number): void {
    const itemId = event.type === "tool_call" && event.toolCallId
      ? safeId(event.toolCallId, `${turnId}:acp:${index}`)
      : event.type === "plan"
        ? turnId
      : `${turnId}:acp:${index}`;
    if (
      event.type === "tool_call"
      && event.tag === "tool_call"
      && ![PRP_COMPLETION_TOOL_NAME, PRP_BLOCK_TOOL_NAME].includes(
        canonicalAcpxRuntimeToolName(event.title) as typeof PRP_COMPLETION_TOOL_NAME,
      )
    ) {
      // ACP agents do not label commentary and final-answer channels. Text
      // emitted after the last work tool is the only safe final candidate;
      // the accepted completion-tool boundary below then excludes any trailing
      // acknowledgement emitted after Paperclip already accepted the result.
      this.#assistantTextSinceLastWorkTool = "";
    }
    if (event.type === "text_delta") {
      if (event.stream === "thought" || event.tag === "agent_thought_chunk") {
        if (!this.#thinking) {
          this.#thinking = true;
          this.#emit("item.started", { kind: "thinking", text: "Reasoning started." }, { turnId, itemId: `${turnId}:thinking` });
        }
        return;
      }
      const output = event.text.slice(0, 64 * 1024);
      this.#assistantText = `${this.#assistantText}${output}`.slice(-256 * 1024);
      this.#assistantTextSinceLastWorkTool = `${this.#assistantTextSinceLastWorkTool}${output}`.slice(-256 * 1024);
      this.#emit("item.delta", { kind: "agent_message", text: output }, { turnId, itemId });
      for (const reference of paperclipWorkspaceFileReferencesFromText(this.#workingDirectory, output, turnId)) {
        if (this.#emittedFileReferences.has(reference.referenceId)) continue;
        this.#emittedFileReferences.add(reference.referenceId);
        this.#emit("workspace.file.referenced", { ...reference }, { turnId, itemId: reference.referenceId });
      }
    }
    if (event.type === "status" && event.tag === "usage_update") {
      this.#captureUsage({
        cumulative: event.breakdown,
        cost: event.cost,
      }, turnId, itemId);
    }
    if (event.type === "tool_call") this.#emitToolLocations(event, turnId, itemId);
    for (const canonical of canonicalProviderEventsFromAcpxRuntimeEvent(event, itemId, turnId)) {
      this.#emit(canonical.eventType, canonical.payload, { turnId, itemId: canonical.itemId });
    }
    if (event.type === "error") {
      this.#emit("provider.notice.recorded", {
        schema: "paperclip.provider.notice.v1",
        noticeId: itemId,
        severity: "error",
        category: event.code ?? "acpx_runtime_error",
        scope: "turn",
        recoverable: event.retryable ?? false,
        userActionable: true,
        summary: redact(event.message).slice(0, 4000),
      }, { turnId, itemId });
    }
  }

  #emitToolLocations(event: Extract<AcpRuntimeEvent, { type: "tool_call" }>, turnId: string, itemId: string): void {
    const files = (event.locations ?? []).slice(0, 2_000).flatMap((location): Record<string, unknown>[] => {
      const candidate = record(location);
      const path = safeWorkspacePath(text(candidate.path, text(candidate.uri)));
      if (!path) return [];
      return [{ path, operation: toolOperation(event.kind), previousPath: null, additions: null, deletions: null, binary: false, diff: null }];
    });
    if (files.length === 0) return;
    const payload = {
      schema: "paperclip.workspace.diff.v1",
      changeSetId: `${turnId}:workspace:${itemId}`,
      revision: 1,
      source: "harness_reported",
      complete: canonicalToolTerminal(event.status),
      files,
      totals: { files: files.length, additions: null, deletions: null },
      patchArtifactRef: null,
    };
    this.#emit(canonicalToolTerminal(event.status) ? "workspace.diff.recorded" : "workspace.change.updated", payload, {
      turnId,
      itemId: `${turnId}:workspace:${itemId}`,
    });
  }

  #captureUsage(value: unknown, turnId: string, itemId: string): void {
    const usage = record(value);
    if (Object.keys(usage).length === 0) return;
    const identity = this.#host.identity();
    this.#usage = bounded({
      ...usage,
      provider: "acpx",
      agent: identity.profile.agent,
      biller: biller(identity.profile.agent),
      requestedModel: identity.requestedModel,
      effectiveModel: identity.effectiveModel,
      acpxVersion: identity.profile.acpxVersion,
      agentServerVersion: identity.profile.agentServerVersion,
    });
    this.#emit("item.completed", { kind: "usage", usage: this.#usage }, { turnId, itemId });
  }

  #emit(eventType: PrpEvent["eventType"], payload: Record<string, unknown>, refs: { turnId?: string; itemId?: string } = {}): string {
    const sourceSeq = ++this.#sourceSequence;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#runnerInstanceId,
      sourceKind: "runner",
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    };
    this.#traceCorrelationEventIds?.push(event.sourceEventId);
    this.#transcript.push(structuredClone(event));
    this.#events.push(event);
    return event.sourceEventId;
  }

  #optionsEnvironment(): NodeJS.ProcessEnv { return {}; }
}

function assertRecoveryIdentity(
  expected: Extract<PersistedHarnessSession["providerIdentity"], { kind: "acpx" }>,
  actual: AcpxRuntimeIdentity,
  workspace: string,
): void {
  if (
    expected.acpxRecordId !== actual.acpxRecordId
    || expected.backendSessionId !== actual.backendSessionId
    || expected.agentSessionId !== actual.agentSessionId
    || expected.profileDigest !== actual.profile.commandDigest
    || expected.workspaceDigest !== workspaceDigest(workspace)
    || expected.requestedModel !== actual.requestedModel
    || expected.effectiveModel !== actual.effectiveModel
    || (expected.permissionMode ?? "approve-reads") !== actual.permissionMode
  ) throw new Error("ACPX recovery identity does not match the immutable persisted session");
}

function permissionDecision(action: HarnessRuntimeRequestResolution["action"]): AcpPermissionDecision {
  if (action === "accept") return { outcome: "allow_once" };
  if (action === "accept_for_session") return { outcome: "allow_always" };
  if (action === "decline") return { outcome: "reject_once" };
  return { outcome: "cancel" };
}

function displayAgent(agent: QualifiedAcpxAgent): string {
  return agent === "claude" ? "Claude" : "Codex";
}

function biller(agent: QualifiedAcpxAgent): "anthropic" | "openai" {
  return agent === "claude" ? "anthropic" : "openai";
}

function workspaceDigest(cwd: string): string {
  return `sha256:${createHash("sha256").update(resolve(cwd)).digest("hex")}`;
}

function sessionRoot(runtimeDirectory: string, normalizedSessionId: string): string {
  const safe = normalizedSessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return join(resolve(runtimeDirectory), "acpx", safe);
}

function toolOperation(kind: unknown): "create" | "modify" | "delete" {
  const value = text(kind).toLowerCase();
  return value.includes("delete") ? "delete" : value.includes("create") ? "create" : "modify";
}

function canonicalToolTerminal(status: unknown): boolean {
  return ["completed", "failed", "cancelled", "canceled"].includes(text(status).toLowerCase());
}

function canonicalAcpxRuntimeToolName(value: unknown): string {
  const nativeName = text(value).trim();
  const bridgeName = nativeName
    .replace(/^mcp__[^_]+__/, "")
    .replace(/^mcp\.paperclip\./, "");
  return canonicalRunnerToolName(bridgeName);
}

export function selectAcpxFinalAgentMessage(input: {
  semanticResultCommitted: boolean;
  textAtSemanticResult: string | null;
  textAfterLastWorkTool: string;
}): string | null {
  const candidate = input.semanticResultCommitted
    ? input.textAtSemanticResult
    : input.textAfterLastWorkTool;
  return candidate?.trim() || null;
}

function safeWorkspacePath(value: string): string | null {
  const path = value.replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.split("/").includes("..") || /^[a-z]+:\/\//i.test(path)) return null;
  return path.slice(0, 4000);
}

function safeId(value: string, fallback: string): string {
  const candidate = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 160);
  return /^[A-Za-z0-9]/.test(candidate) ? candidate : fallback;
}

function bounded(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 64 * 1024) return { omitted: true, reason: "payload_limit" };
  const parsed: unknown = JSON.parse(serialized);
  return record(parsed);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function redact(value: string, environment: NodeJS.ProcessEnv = {}): string {
  let redacted = value;
  for (const [key, secret] of Object.entries(environment)) {
    if (secret && /(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) && secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(/(key|token|secret|password|authorization)\s*[:=]\s*[^\s,}\]]+/gi, "$1=[REDACTED]").slice(0, 8192);
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  #closed = false;
  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.#items.push(item);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ done: false, value: item });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}
