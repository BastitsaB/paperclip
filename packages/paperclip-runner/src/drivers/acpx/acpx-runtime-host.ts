import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpElicitationHandler,
  type AcpElicitationRequest,
  type AcpElicitationResponse,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurn,
} from "acpx/runtime";

import {
  startRunnerToolBridge,
  type RunnerToolBridge,
} from "../runner-tool-bridge.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
  type QualifiedAcpxProfile,
} from "./qualified-profiles.js";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import { nativeMcpLaunchBinding } from "../native-mcp.js";
import { materializeNativeRuntimeSkills } from "../runtime-context-materializer.js";
import {
  createProviderTraceFileSink,
  type ProviderTraceFileSink,
} from "../../contracts/provider-trace-file-sink.js";
import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";

const PI_PERMISSION_TOOL = "__paperclip_runtime_permission";
const PI_INPUT_TOOL = "__paperclip_runtime_input";
const HUMAN_RUNTIME_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

type DynamicToolHandler = (call: {
  tool: string;
  callId: string;
  arguments: unknown;
}) => Promise<unknown>;

export interface AcpxRuntimeProcessIdentity {
  pid: number;
  processGroupId: number | null;
  startedAt: string;
}

export interface AcpxRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  cost?: { amount: number; currency: "USD" };
}

export interface AcpxRuntimePermissionContext {
  request: AcpPermissionRequest;
  signal: AbortSignal;
}

export interface AcpxRuntimeElicitationContext {
  request: AcpElicitationRequest;
  requestId: string | number | null;
  signal: AbortSignal;
}

export type AcpxRuntimeFactory = (options: AcpRuntimeOptions) => AcpRuntime;

interface SecureAcpRuntimeOptions extends AcpRuntimeOptions {
  /** Paperclip's 0.13.1 patch: evaluated immediately before ACP child spawn. */
  spawnEnvironment?: () => Record<string, string>;
  /** Paperclip's 0.13.1 patch: never persisted in ACPX session records. */
  onAgentSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void> | void;
  onAgentStderr?: (chunk: string) => void;
  /** Paperclip's 0.13.1 patch: observes transient ACP frames without persisting them. */
  onAcpMessage?: (direction: "inbound" | "outbound", message: unknown) => void;
  spawnCwd?: string;
}

export interface AcpxRuntimeHostOptions {
  runtimeDirectory: string;
  normalizedSessionId: string;
  /** Provider-record key may rotate while Paperclip's normalized session stays stable. */
  providerSessionKey?: string;
  workingDirectory: string;
  agent: QualifiedAcpxAgent;
  model: string;
  permissionMode?: NativeAcpxPermissionMode;
  systemInstructions?: string;
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  expectedIdentity?: {
    kind: "acpx";
    normalizedSessionId: string;
    acpxRecordId: string;
    backendSessionId: string;
    agentSessionId: string;
    profileDigest: string;
    workspaceDigest: string;
    requestedModel: string;
    effectiveModel: string;
    permissionMode?: NativeAcpxPermissionMode;
  };
  environment?: NodeJS.ProcessEnv;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler: DynamicToolHandler;
  runtimeFactory?: AcpxRuntimeFactory;
  onPermissionRequest?: (
    context: AcpxRuntimePermissionContext,
  ) => Promise<AcpPermissionDecision | undefined>;
  onElicitation?: (
    context: AcpxRuntimeElicitationContext,
  ) => Promise<AcpElicitationResponse>;
  onSpawn?: (meta: AcpxRuntimeProcessIdentity) => Promise<void>;
  onUsage?: (usage: AcpxRuntimeUsage) => void;
  onDiagnostic?: (message: string) => void;
  /** Host-only source paths; neither paths nor contents enter ACPX records. */
  managedCredentialSources?: { codexAuthPath?: string };
}

export interface AcpxRuntimeIdentity {
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
  requestedModel: string;
  effectiveModel: string;
  permissionMode: NativeAcpxPermissionMode;
  profile: QualifiedAcpxProfile;
  commandPath: string;
  commandDigest: string;
}

export async function inspectQualifiedAcpxInstallation(
  agent: QualifiedAcpxAgent,
  model: string,
): Promise<{
  profile: QualifiedAcpxProfile;
  commandPath: string;
  commandDigest: string;
  agentRuntimePath: string | null;
}> {
  if (agent === "pi") throw new Error("The Pi ACPX profile is not available");
  const profile = resolveQualifiedAcpxProfile(agent, model);
  const command = await resolveAndVerifyCommand(profile);
  return {
    profile,
    commandPath: command.path,
    commandDigest: command.digest,
    agentRuntimePath: agent === "pi" ? await resolvePiRuntimeCommand(profile) : null,
  };
}

export class AcpxRuntimeHost {
  readonly #runtime: AcpRuntime;
  readonly #handle: AcpRuntimeHandle;
  readonly #bridge: RunnerToolBridge;
  readonly #identity: AcpxRuntimeIdentity;
  readonly #root: string;
  readonly #ephemeralCredentialFiles: string[];
  readonly #agentProcessIdentity: AcpxRuntimeProcessIdentity | null;
  readonly #trace: ProviderTraceFileSink | null;
  readonly #traceState: { latestInboundFrameId: number | null };
  readonly #onElicitation?: AcpxRuntimeHostOptions["onElicitation"];
  #activeTurn: AcpRuntimeTurn | null = null;
  #closed = false;

  private constructor(input: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    bridge: RunnerToolBridge;
    identity: AcpxRuntimeIdentity;
    root: string;
    ephemeralCredentialFiles: string[];
    agentProcessIdentity: AcpxRuntimeProcessIdentity | null;
    trace: ProviderTraceFileSink | null;
    traceState: { latestInboundFrameId: number | null };
    onElicitation?: AcpxRuntimeHostOptions["onElicitation"];
  }) {
    this.#runtime = input.runtime;
    this.#handle = input.handle;
    this.#bridge = input.bridge;
    this.#identity = input.identity;
    this.#root = input.root;
    this.#ephemeralCredentialFiles = input.ephemeralCredentialFiles;
    this.#agentProcessIdentity = input.agentProcessIdentity;
    this.#trace = input.trace;
    this.#traceState = input.traceState;
    this.#onElicitation = input.onElicitation;
  }

  static async open(options: AcpxRuntimeHostOptions): Promise<AcpxRuntimeHost> {
    if (options.agent === "pi") throw new Error("The Pi ACPX profile is not available");
    const permissionMode = options.permissionMode
      ?? (options.expectedIdentity ? options.expectedIdentity.permissionMode ?? "approve-reads" : "approve-all");
    const profile = resolveQualifiedAcpxProfile(options.agent, options.model);
    const cwd = validateWorkspace(options.workingDirectory);
    const root = sessionRoot(options.runtimeDirectory, options.normalizedSessionId);
    const stateDir = join(root, "acpx-state");
    const homeDir = join(root, "home");
    const configDir = join(root, "config");
    const dataDir = join(root, "data");
    const cacheDir = join(root, "cache");
    const agentHome = join(root, `${options.agent}-home`);
    for (const directory of [root, stateDir, homeDir, configDir, dataDir, cacheDir, agentHome]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const trace = await createProviderTraceFileSink({
      path: options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH,
      provider: `acpx:${options.agent}`,
      channel: "typescript_acpx_native",
      maxBytes: options.environment?.PAPERCLIP_PROVIDER_TRACE_MAX_BYTES,
    });
    const traceState = { latestInboundFrameId: null as number | null };
    if (options.expectedIdentity) {
      await verifyExpectedIdentity(
        options.expectedIdentity,
        root,
        options.normalizedSessionId,
        cwd,
        profile,
        options.model,
        permissionMode,
      );
    }
    await writeFile(join(root, "workspace"), `${cwd}\n`, { mode: 0o600 });
    if (options.agent === "pi") {
      await writeFile(join(agentHome, "settings.json"), `${JSON.stringify({
        quietStartup: true,
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
      })}\n`, { mode: 0o600 });
    }
    await materializeNativeRuntimeSkills(options.runtimeContext ?? null, join(agentHome, "skills"));
    const ephemeralCredentialFiles = options.agent === "codex"
      ? await stageManagedCodexCredential(agentHome, options)
      : [];

    const command = await resolveAndVerifyCommand(profile);
    const piCommand = options.agent === "pi" ? await resolvePiRuntimeCommand(profile) : null;
    const piExtension = fileURLToPath(new URL("./pi-paperclip-extension.js", import.meta.url));
    const piPermissionRules = new Set<string>();
    const bridge = await startRunnerToolBridge({
      tools: normalizeBridgeTools(options.dynamicTools ?? []),
      privateTools: options.agent === "pi" ? [{
        name: PI_PERMISSION_TOOL,
        description: "Runner-internal Pi permission gate.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["operation", "target", "inputClass"],
          properties: {
            operation: { enum: ["write", "edit", "bash"] },
            target: { type: ["string", "null"], maxLength: 4_096 },
            inputClass: { enum: ["workspace_mutation", "command"] },
          },
        },
      }, ...(options.onElicitation ? [{
        name: PI_INPUT_TOOL,
        description: "Runner-internal Pi structured input gate.",
        inputSchema: piInputToolSchema(),
      }] : [])] : [],
      handler: async (call) => {
        if (call.tool === PI_PERMISSION_TOOL) {
          return requestPiPermission(options, call.callId, call.arguments, call.signal, piPermissionRules);
        }
        if (call.tool === PI_INPUT_TOOL) {
          return requestPiInput(options, call.callId, call.arguments, call.signal);
        }
        return options.dynamicToolHandler(call);
      },
      privateToolTimeoutMs: HUMAN_RUNTIME_REQUEST_TIMEOUT_MS,
    });
    const agentEnvironment = sanitizedAgentEnvironment(options.environment ?? process.env, {
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      XDG_CACHE_HOME: cacheDir,
      ...(options.agent === "pi" ? {
        PI_CODING_AGENT_DIR: agentHome,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_ACP_PI_COMMAND: piCommand!,
        PI_ACP_PI_ARGS_JSON: JSON.stringify([
          "--no-extensions", "--extension", piExtension,
          ...(options.runtimeContext ? [] : ["--no-skills"]),
          "--no-prompt-templates", "--no-themes", "--no-context-files",
        ]),
        PAPERCLIP_RUNNER_BRIDGE_URL: bridge.url,
        PAPERCLIP_RUNNER_BRIDGE_TOKEN: bridge.secret,
        PAPERCLIP_WORKSPACE_ROOT: cwd,
        PAPERCLIP_RUNTIME_ROOT: root,
        ...(options.runtimeContext ? {
          PAPERCLIP_INSTRUCTION_ROOT: options.runtimeContext.instructions.bundle.rootPath,
          PAPERCLIP_ASSIGNED_SKILLS_ROOT: join(agentHome, "skills"),
        } : {}),
      } : {}),
      ...(options.agent === "claude" ? { CLAUDE_CONFIG_DIR: agentHome } : {}),
      ...(options.agent === "codex" ? {
        CODEX_HOME: agentHome,
        NO_BROWSER: "1",
        ...((options.environment?.CODEX_API_KEY || options.environment?.OPENAI_API_KEY)
          ? { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }) }
          : {}),
      } : {}),
      PAPERCLIP_ACPX_PROFILE: options.agent,
      PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1",
    }, options.agent);
    const safeSessionEnvironment = withoutCredentials(agentEnvironment);
    const nativeMcp = nativeMcpLaunchBinding(options.environment ?? process.env);
    const runnerOwnedMcpServerNames = new Set([
      "paperclip",
      ...(nativeMcp ? [nativeMcp.name] : []),
    ]);
    const mcpServers: NonNullable<AcpRuntimeOptions["mcpServers"]> = options.agent === "pi" ? [] : [{
      type: "http",
      name: "paperclip",
      url: bridge.url,
      headers: [{ name: "Authorization", value: `Bearer ${bridge.secret}` }],
    }, ...(nativeMcp ? [{
      type: "http" as const,
      name: nativeMcp.name,
      url: nativeMcp.url,
      headers: [{ name: "Authorization", value: `Bearer ${nativeMcp.token}` }],
    }] : [])];
    const agentStderr = createAgentStderrRouter(
      agentEnvironment,
      options.onUsage,
      options.onDiagnostic,
    );
    let agentProcessIdentity: AcpxRuntimeProcessIdentity | null = null;
    const runtimeOptions: SecureAcpRuntimeOptions = {
      cwd,
      spawnCwd: cwd,
      sessionStore: createRuntimeStore({ stateDir }),
      agentRegistry: createAgentRegistry({
        overrides: { [options.agent]: [process.execPath, command.path] },
      }),
      mcpServers,
      permissionMode,
      nonInteractivePermissions: "fail",
      permissionPolicy: acpxPermissionPolicy(permissionMode),
      // Paperclip routes durable user interaction through PRP semantic tools.
      // Advertising ACP form elicitation to Codex diverts MCP-tool approvals
      // into a separate UI callback that this headless runner does not own.
      // With no generic elicitation capability advertised, Codex-ACP uses the
      // governed permission channel where the runner-owned server identity is
      // correlated and external tool calls remain subject to policy.
      elicitationModes: options.agent === "codex" || !options.onElicitation ? [] : ["form"],
      onPermissionRequest: async (request, context) => {
        // Claude Code and Codex ask their ACP client to authorize MCP
        // invocations,
        // including calls to Paperclip's own authenticated semantic bridge.
        // Those calls must reach PRP, whose attached run catalog and schema
        // checks are the authority. Treating this duplicate provider prompt as
        // a human approval prevents even read-only semantic tools from running.
        // Built-in filesystem/process calls do not have this closed namespace
        // and continue through the durable interactive permission flow.
        if (shouldAutoApproveRunnerOwnedSemanticPermission(
          options.agent,
          request,
          runnerOwnedMcpServerNames,
          true,
        )) {
          return { outcome: "allow_once" };
        }
        if (permissionMode === "approve-all") return { outcome: "allow_once" };
        if (permissionMode === "deny-all") return { outcome: "reject_once" };
        if (["read", "search", "list"].includes(request.inferredKind ?? "")) {
          return { outcome: "allow_once" };
        }
        return options.onPermissionRequest
          ? options.onPermissionRequest({ request, signal: context.signal })
          : { outcome: "reject_once" };
      },
      spawnEnvironment: () => ({ ...agentEnvironment }),
      onAgentStderr: agentStderr.push,
      onAcpMessage: (direction, message) => {
        try {
          const raw = `${JSON.stringify(message)}\n`;
          const nativeMethod = message && typeof message === "object" && !Array.isArray(message)
            && typeof (message as Record<string, unknown>).method === "string"
            ? (message as Record<string, unknown>).method as string
            : undefined;
          const frameId = trace?.frame({
            direction: direction === "outbound" ? "client_to_provider" : "provider_to_client",
            raw,
            transport: "acp_json_rpc_object",
            ...(nativeMethod ? { nativeMethod } : {}),
          });
          if (direction === "inbound" && frameId !== null && frameId !== undefined) {
            traceState.latestInboundFrameId = frameId;
          }
          if (frameId !== null && frameId !== undefined) {
            trace?.interpretation({
              frameId,
              stage: "typescript_acpx_transport",
              ruleId: direction === "outbound" ? "acpx.transport.outbound" : "acpx.transport.inbound",
              disposition: direction === "outbound" ? "operator_only" : "generic",
              reason: direction === "outbound"
                ? "Captured the ACP client request before provider delivery."
                : "Captured the parsed ACP provider message before runtime-event normalization.",
            });
          }
        } catch {
          // Debug capture must never alter provider execution.
        }
      },
      onAgentSpawn: async (meta) => {
        agentProcessIdentity = { pid: meta.pid, processGroupId: null, startedAt: meta.startedAt };
        await options.onSpawn?.(agentProcessIdentity);
      },
    };
    const runtimeFactory = options.runtimeFactory ?? ((input) => createAcpRuntime(input));
    const runtime = runtimeFactory(runtimeOptions);
    let handle: AcpRuntimeHandle | null = null;
    try {
      handle = await runtime.ensureSession({
        sessionKey: profileSessionKey(
          options.providerSessionKey ?? options.normalizedSessionId,
          cwd,
          profile,
          options.model,
        ),
        agent: options.agent,
        mode: "persistent",
        cwd,
        sessionOptions: {
          model: options.model,
          systemPrompt: { append: options.systemInstructions ?? paperclipAcpSystemPrompt() },
          env: safeSessionEnvironment,
        },
      });
      const status = await requireVerifiedModel(runtime, handle, profile);
      const backendSessionId = requiredIdentity(status.backendSessionId ?? handle.backendSessionId, "backend session");
      const identity: AcpxRuntimeIdentity = {
        acpxRecordId: requiredIdentity(status.acpxRecordId ?? handle.acpxRecordId, "ACPX record"),
        backendSessionId,
        // ACPX 0.13.1 exposes the ACP protocol session as backendSessionId for
        // agents (including pi-acp) that do not advertise a second native
        // thread identity. Preserve that real ACP session identity explicitly
        // instead of inventing a random or Paperclip-owned identifier.
        agentSessionId: requiredIdentity(status.agentSessionId ?? handle.agentSessionId ?? backendSessionId, "agent session"),
        requestedModel: options.model,
        effectiveModel: requiredIdentity(status.models?.currentModelId, "effective model"),
        permissionMode,
        profile,
        commandPath: command.path,
        commandDigest: command.digest,
      };
      await writeFile(join(root, "identity.json"), `${JSON.stringify({
        acpxRecordId: identity.acpxRecordId,
        backendSessionId: identity.backendSessionId,
        agentSessionId: identity.agentSessionId,
        requestedModel: identity.requestedModel,
        effectiveModel: identity.effectiveModel,
        permissionMode: identity.permissionMode,
        profileDigest: profile.commandDigest,
      }, null, 2)}\n`, { mode: 0o600 });
      return new AcpxRuntimeHost({
        runtime,
        handle,
        bridge,
        identity,
        root,
        ephemeralCredentialFiles,
        agentProcessIdentity,
        trace,
        traceState,
        onElicitation: options.onElicitation,
      });
    } catch (error) {
      agentStderr.flush();
      if (handle) {
        await runtime.close({ handle, reason: "ACPX startup failed", discardPersistentState: false }).catch(() => {});
      }
      await bridge.close().catch(() => {});
      await trace?.finish({ reason: "acpx_session_start_failed" });
      await removeEphemeralCredentialFiles(ephemeralCredentialFiles);
      throw error;
    }
  }

  identity(): AcpxRuntimeIdentity {
    return structuredClone(this.#identity);
  }

  latestInboundTraceFrameId(): number | null {
    return this.#traceState.latestInboundFrameId;
  }

  correlateProviderFrame(frameId: number | null, eventIds: string[], runtimeEventType: string): void {
    if (frameId === null || eventIds.length === 0) return;
    this.#trace?.interpretation({
      frameId,
      stage: "typescript_acpx_runtime_normalization",
      ruleId: `acpx.runtime.${runtimeEventType}`,
      disposition: "mapped",
      emittedEventIds: eventIds,
      reason: `Normalized the ACP runtime ${runtimeEventType} event into canonical PRP.`,
    });
  }

  async status(): Promise<AcpRuntimeStatus> {
    if (!this.#runtime.getStatus) return {};
    return normalizeQualifiedModelStatus(
      await this.#runtime.getStatus({ handle: this.#handle }),
      this.#identity.profile,
    );
  }

  startTurn(input: { requestId: string; text: string; signal?: AbortSignal }): AcpRuntimeTurn {
    if (this.#closed) throw new Error("ACPX runtime host is closed");
    if (this.#activeTurn) throw new Error("ACPX runtime host already has an active turn");
    const turn = this.#runtime.startTurn({
      handle: this.#handle,
      text: input.text,
      mode: "prompt",
      requestId: input.requestId,
      signal: input.signal,
      ...(this.#onElicitation ? {
        onElicitation: ((request, context) => this.#onElicitation!({
          request,
          requestId: context.requestId,
          signal: context.signal,
        })) satisfies AcpElicitationHandler,
      } : {}),
    });
    this.#activeTurn = turn;
    void turn.result.finally(() => {
      if (this.#activeTurn === turn) this.#activeTurn = null;
    });
    return turn;
  }

  async cancel(reason = "Paperclip turn interrupted"): Promise<void> {
    const turn = this.#activeTurn;
    if (turn) await turn.cancel({ reason });
    else await this.#runtime.cancel({ handle: this.#handle, reason });
  }

  async close(input: { reason: string; discardPersistentState?: boolean }): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#activeTurn?.cancel({ reason: input.reason }).catch(() => {});
    try {
      const discardPersistentState = input.discardPersistentState ?? false;
      try {
        await this.#runtime.close({
          handle: this.#handle,
          reason: input.reason,
          discardPersistentState,
        });
      } catch (error) {
        // Some qualified ACP agents (currently Pi) do not implement the
        // optional session/close control required for remote destruction.
        // Still close the live owner and descendants, but retain the provider
        // record rather than leaking a process or pretending it was deleted.
        if (!discardPersistentState || runtimeErrorCode(error) !== "ACP_BACKEND_UNSUPPORTED_CONTROL") {
          throw error;
        }
        await this.#runtime.close({
          handle: this.#handle,
          reason: `${input.reason} (retaining unsupported backend record)`,
          discardPersistentState: false,
        });
      }
    } finally {
      await this.#bridge.close().catch(() => {});
      await this.#trace?.finish();
      await removeEphemeralCredentialFiles(this.#ephemeralCredentialFiles);
    }
  }

  runtimeRoot(): string { return this.#root; }

  processIdentity(): AcpxRuntimeProcessIdentity | null {
    return this.#agentProcessIdentity === null ? null : { ...this.#agentProcessIdentity };
  }
}

function runtimeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function isRunnerOwnedSemanticPermission(request: AcpPermissionRequest): boolean {
  const raw = request.raw as unknown as Record<string, unknown>;
  const toolCall = raw.toolCall;
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return false;
  const call = toolCall as Record<string, unknown>;
  const requestMeta = raw._meta;
  const isMcpToolApproval = requestMeta && typeof requestMeta === "object" && !Array.isArray(requestMeta)
    ? (requestMeta as Record<string, unknown>).is_mcp_tool_approval === true
    : false;
  const rawInput = call.rawInput;
  const serverName = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? (rawInput as Record<string, unknown>).serverName
    : null;
  if (isMcpToolApproval && serverName === "paperclip") return true;
  const meta = call._meta;
  const claudeCode = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).claudeCode
    : null;
  const metadataToolName = claudeCode && typeof claudeCode === "object" && !Array.isArray(claudeCode)
    ? (claudeCode as Record<string, unknown>).toolName
    : null;
  return [call.name, call.title, metadataToolName].some((value) => (
    typeof value === "string"
    && (value.startsWith("mcp__paperclip__") || value.startsWith("mcp.paperclip."))
  ));
}

export function shouldAutoApproveRunnerOwnedSemanticPermission(
  agent: QualifiedAcpxAgent,
  request: AcpPermissionRequest,
  runnerOwnedMcpServerNames: ReadonlySet<string> = new Set(["paperclip"]),
  allConfiguredMcpServersAreRunnerOwned = false,
): boolean {
  if (agent === "pi") return false;
  const raw = request.raw as unknown as Record<string, unknown>;
  const requestMeta = raw._meta;
  const isMcpToolApproval = requestMeta && typeof requestMeta === "object" && !Array.isArray(requestMeta)
    ? (requestMeta as Record<string, unknown>).is_mcp_tool_approval === true
    : false;
  if (agent === "codex" && isMcpToolApproval && allConfiguredMcpServersAreRunnerOwned) return true;
  const toolCall = raw.toolCall;
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const rawInput = (toolCall as Record<string, unknown>).rawInput;
    if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      const serverName = (rawInput as Record<string, unknown>).serverName;
      if (typeof serverName === "string" && runnerOwnedMcpServerNames.has(serverName)) return true;
    }
  }
  return isRunnerOwnedSemanticPermission(request);
}

async function stageManagedCodexCredential(
  agentHome: string,
  options: AcpxRuntimeHostOptions,
): Promise<string[]> {
  const destination = join(agentHome, "auth.json");
  if (options.environment?.OPENAI_API_KEY || options.environment?.CODEX_API_KEY) {
    // codex-acp persists the selected API-key credential into CODEX_HOME during
    // authentication. Treat that provider-generated file as ephemeral too.
    return [destination];
  }
  const inlineCredential = options.environment?.PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET;
  if (inlineCredential) {
    const credential = Buffer.from(inlineCredential, "utf8");
    try {
      if (credential.length <= 0 || credential.length > 256 * 1024) {
        throw new Error("Managed Codex credential document exceeds the bounded size");
      }
      const parsed = JSON.parse(credential.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid credential document");
      }
      await writeFile(destination, credential, { mode: 0o600 });
      return [destination];
    } finally {
      credential.fill(0);
    }
  }
  const source = options.managedCredentialSources?.codexAuthPath ?? join(homedir(), ".codex", "auth.json");
  let metadata;
  try {
    metadata = await stat(source);
  } catch {
    throw new Error(
      "provider_initialize_protocol_error: provider=acpx stage=credential.stage managed Codex credential missing",
    );
  }
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 256 * 1024) {
    throw new Error("Managed Codex credential source is not a bounded regular file");
  }
  const credential = await readFile(source);
  try {
    const parsed = JSON.parse(credential.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid credential document");
    }
  } catch {
    credential.fill(0);
    throw new Error("Managed Codex credential source is malformed");
  }
  try {
    await writeFile(destination, credential, { mode: 0o600 });
    await chmod(destination, 0o600);
  } finally {
    credential.fill(0);
  }
  return [destination];
}

async function removeEphemeralCredentialFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => {})));
}

async function verifyExpectedIdentity(
  expected: NonNullable<AcpxRuntimeHostOptions["expectedIdentity"]>,
  root: string,
  normalizedSessionId: string,
  cwd: string,
  profile: QualifiedAcpxProfile,
  model: string,
  permissionMode: NativeAcpxPermissionMode,
): Promise<void> {
  if (
    expected.normalizedSessionId !== normalizedSessionId
    || expected.profileDigest !== profile.commandDigest
    || expected.workspaceDigest !== workspaceDigest(cwd)
    || expected.requestedModel !== model
    || expected.effectiveModel !== model
    || (expected.permissionMode ?? permissionMode) !== permissionMode
  ) throw new Error("ACPX recovery identity conflicts with the immutable session configuration");
  let persisted: Record<string, unknown>;
  try {
    persisted = JSON.parse(await readFile(join(root, "identity.json"), "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("ACPX recovery identity record is missing or malformed");
  }
  if (
    persisted.acpxRecordId !== expected.acpxRecordId
    || persisted.backendSessionId !== expected.backendSessionId
    || persisted.agentSessionId !== expected.agentSessionId
    || persisted.profileDigest !== expected.profileDigest
    || persisted.requestedModel !== expected.requestedModel
    || persisted.effectiveModel !== expected.effectiveModel
    || (persisted.permissionMode ?? "approve-reads") !== permissionMode
  ) throw new Error("ACPX recovery identity does not match the persisted runtime record");
}

function acpxPermissionPolicy(
  mode: NativeAcpxPermissionMode,
): NonNullable<AcpRuntimeOptions["permissionPolicy"]> {
  if (mode === "approve-all") {
    return { defaultAction: "approve" };
  }
  if (mode === "deny-all") {
    return { defaultAction: "deny" };
  }
  return {
    autoApprove: ["read", "search", "list"],
    escalate: ["execute", "write", "edit", "delete", "move"],
    defaultAction: "escalate",
  };
}

async function requireVerifiedModel(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  profile: QualifiedAcpxProfile,
): Promise<AcpRuntimeStatus> {
  if (!runtime.getStatus) throw new Error("ACPX agent cannot verify its effective model");
  const requestedModel = profile.qualificationModel;
  let status = await runtime.getStatus({ handle });

  // A distinct reported selector is an explicit part of a pinned profile, not
  // a fuzzy alias. Re-apply the user's exact canonical model through ACP so a
  // stale/default session cannot be mistaken for the qualified model merely
  // because it currently reports the same selector.
  if (profile.reportedModelId !== requestedModel) {
    if (!runtime.setConfigOption) {
      throw new Error("ACPX agent cannot verify its canonical model through ACP config options");
    }
    await runtime.setConfigOption({ handle, key: "model", value: requestedModel });
    status = await runtime.getStatus({ handle });
  } else if (status.models?.currentModelId !== requestedModel && runtime.setConfigOption) {
    await runtime.setConfigOption({ handle, key: "model", value: requestedModel });
    status = await runtime.getStatus({ handle });
  }
  if (status.models?.currentModelId !== profile.reportedModelId) {
    throw new Error(
      `ACPX effective model mismatch: requested ${requestedModel}, expected ACP selector ${profile.reportedModelId}, received ${status.models?.currentModelId ?? "unverified"}`,
    );
  }
  return normalizeQualifiedModelStatus(status, profile);
}

function normalizeQualifiedModelStatus(
  status: AcpRuntimeStatus,
  profile: QualifiedAcpxProfile,
): AcpRuntimeStatus {
  if (status.models?.currentModelId !== profile.reportedModelId) return status;
  return {
    ...status,
    models: {
      ...status.models,
      currentModelId: profile.qualificationModel,
      availableModelIds: status.models.availableModelIds.map((modelId) => (
        modelId === profile.reportedModelId ? profile.qualificationModel : modelId
      )),
    },
  };
}

async function resolveAndVerifyCommand(profile: QualifiedAcpxProfile): Promise<{ path: string; digest: string }> {
  const packageJsonPath = resolvePackageJson(profile.agentServerPackage);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (packageJson.version !== profile.agentServerVersion) {
    throw new Error(
      `ACPX ${profile.agent} package version mismatch: expected ${profile.agentServerVersion}, received ${packageJson.version ?? "unknown"}`,
    );
  }
  const relativeBin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.[Object.keys(packageJson.bin)[0] ?? ""];
  if (!relativeBin) throw new Error(`ACPX ${profile.agent} package does not expose an executable`);
  const path = resolve(dirname(packageJsonPath), relativeBin);
  const digest = `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  if (digest !== profile.commandDigest) {
    throw new Error(`ACPX ${profile.agent} executable digest does not match the qualified profile`);
  }
  return { path, digest };
}

async function resolvePiRuntimeCommand(profile: QualifiedAcpxProfile): Promise<string> {
  if (!profile.agentRuntimePackage || !profile.agentRuntimeVersion) {
    throw new Error("Qualified Pi profile omitted its harness runtime");
  }
  const packageJsonPath = resolvePackageJsonFromEntrypoint(profile.agentRuntimePackage);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (packageJson.version !== profile.agentRuntimeVersion) {
    throw new Error(`Pi runtime version mismatch: expected ${profile.agentRuntimeVersion}`);
  }
  const relativeBin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.pi;
  if (!relativeBin) throw new Error("Qualified Pi runtime does not expose the pi executable");
  const portableLauncher = resolve(dirname(packageJsonPath), "../../.bin/pi");
  const launcherStat = await stat(portableLauncher);
  if (!launcherStat.isFile() || (launcherStat.mode & 0o111) === 0) {
    throw new Error("Qualified Pi runtime launcher is not executable");
  }
  return portableLauncher;
}

function resolvePackageJson(packageName: string): string {
  return createRequire(import.meta.url).resolve(`${packageName}/package.json`);
}

function resolvePackageJsonFromEntrypoint(packageName: string): string {
  // The qualified Pi runtime intentionally has no package root export. It is
  // a direct dependency of this package, so resolve its owned installation
  // relative to both source and built driver locations without consulting PATH.
  return fileURLToPath(new URL(`../../../node_modules/${packageName}/package.json`, import.meta.url));
}

function piInputToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "questions"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 1_000 },
      description: { type: "string", maxLength: 4_000 },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "prompt", "answerMode"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9_.:-]+$" },
            header: { type: "string", maxLength: 1_000 },
            prompt: { type: "string", minLength: 1, maxLength: 4_000 },
            helpText: { type: "string", maxLength: 4_000 },
            required: { type: "boolean" },
            answerMode: { enum: ["text", "single_select", "multi_select", "boolean", "integer", "number"] },
            options: {
              type: "array",
              minItems: 1,
              maxItems: 128,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 160 },
                  label: { type: "string", minLength: 1, maxLength: 1_000 },
                  description: { type: "string", maxLength: 4_000 },
                },
              },
            },
            minLength: { type: "integer", minimum: 0, maximum: 1_000_000 },
            maxLength: { type: "integer", minimum: 0, maximum: 1_000_000 },
            minimum: { type: "number" },
            maximum: { type: "number" },
            pattern: { type: "string", maxLength: 1_000 },
          },
        },
      },
    },
  };
}

async function requestPiInput(
  options: AcpxRuntimeHostOptions,
  callId: string,
  input: unknown,
  signal: AbortSignal,
): Promise<AcpElicitationResponse> {
  if (!options.onElicitation || signal.aborted) return { action: "cancel" };
  const value = piRecord(input);
  const rawQuestions = Array.isArray(value.questions) ? value.questions.slice(0, 32) : [];
  if (rawQuestions.length === 0) return { action: "decline" };
  const required: string[] = [];
  const properties = Object.fromEntries(rawQuestions.map((candidate, index) => {
    const question = piRecord(candidate);
    const id = piText(question.id) || `question-${index + 1}`;
    if (question.required !== false) required.push(id);
    const answerMode = piText(question.answerMode);
    const nativeOptions = Array.isArray(question.options) ? question.options.map(piRecord) : [];
    const options = nativeOptions.map((option, optionIndex) => ({
      const: piText(option.id) || `option-${optionIndex + 1}`,
      title: piText(option.label) || `Option ${optionIndex + 1}`,
      ...(piText(option.description) ? { description: piText(option.description) } : {}),
    }));
    let property: Record<string, unknown>;
    if (answerMode === "single_select" || answerMode === "multi_select") {
      if (options.length === 0) throw new Error(`Pi input question ${id} requires options`);
      property = answerMode === "multi_select"
        ? { type: "array", items: { type: "string", oneOf: options } }
        : { type: "string", oneOf: options };
    } else if (answerMode === "boolean") {
      property = { type: "boolean" };
    } else if (answerMode === "integer" || answerMode === "number") {
      property = {
        type: answerMode,
        ...(typeof question.minimum === "number" ? { minimum: question.minimum } : {}),
        ...(typeof question.maximum === "number" ? { maximum: question.maximum } : {}),
      };
    } else {
      property = {
        type: "string",
        ...(typeof question.minLength === "number" ? { minLength: question.minLength } : {}),
        ...(typeof question.maxLength === "number" ? { maxLength: question.maxLength } : {}),
        ...(piText(question.pattern) ? { pattern: piText(question.pattern) } : {}),
      };
    }
    return [id, {
      ...property,
      title: piText(question.header) || piText(question.prompt) || id,
      ...(piText(question.helpText) || piText(question.prompt)
        ? { description: piText(question.helpText) || piText(question.prompt) }
        : {}),
    }];
  }));
  const request = {
    mode: "form",
    sessionId: options.normalizedSessionId,
    message: piText(value.description) || piText(value.title) || "Pi needs your input",
    requestedSchema: {
      type: "object",
      title: piText(value.title) || "Pi needs your input",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  } as AcpElicitationRequest;
  return options.onElicitation({ request, requestId: callId, signal });
}

function piRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function piText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 4_000) : "";
}

async function requestPiPermission(
  options: AcpxRuntimeHostOptions,
  callId: string,
  input: unknown,
  signal: AbortSignal,
  acceptedRules: Set<string>,
): Promise<{ decision: "accept" | "accept_for_session" | "decline" | "cancel" }> {
  const value = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const operation = value.operation === "write" || value.operation === "edit" || value.operation === "bash"
    ? value.operation
    : "unknown";
  const target = typeof value.target === "string" ? value.target.slice(0, 4_096) : null;
  const rule = JSON.stringify({ operation, target });
  if (acceptedRules.has(rule)) return { decision: "accept_for_session" };
  const permissionMode = options.permissionMode ?? "approve-all";
  if (permissionMode === "approve-all") return { decision: "accept_for_session" };
  if (permissionMode === "deny-all") return { decision: "decline" };
  if (!options.onPermissionRequest || signal.aborted) return { decision: "cancel" };
  const inferredKind = operation === "bash" ? "execute" : "edit";
  const decision = await options.onPermissionRequest({
    request: {
      sessionId: options.normalizedSessionId,
      inferredKind,
      raw: {
        sessionId: options.normalizedSessionId,
        toolCall: {
          toolCallId: callId,
          kind: inferredKind,
          status: "pending",
          title: operation === "bash"
            ? "Allow Pi to run a command in the workspace?"
            : `Allow Pi to ${operation} ${target ?? "a workspace file"}?`,
        },
        options: [
          { optionId: "accept", name: "Allow once", kind: "allow_once" },
          { optionId: "accept_for_session", name: "Allow for this session", kind: "allow_always" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
      },
    },
    signal,
  });
  if (decision?.outcome === "allow_always") {
    acceptedRules.add(rule);
    return { decision: "accept_for_session" };
  }
  if (decision?.outcome === "allow_once") return { decision: "accept" };
  if (decision?.outcome === "cancel") return { decision: "cancel" };
  return { decision: "decline" };
}

function sanitizedAgentEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  agent: QualifiedAcpxAgent,
): Record<string, string> {
  const allowedExact = new Set([
    "PATH", "LANG", "LANGUAGE", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "PAPERCLIP_NATIVE_MCP_NAME", "PAPERCLIP_NATIVE_MCP_URL", "PAPERCLIP_NATIVE_MCP_TOKEN",
  ]);
  const credentialNames = agent === "pi"
    ? ["OPENROUTER_API_KEY"]
    : agent === "claude"
      ? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
      : ["OPENAI_API_KEY", "CODEX_API_KEY"];
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!value) continue;
    if (allowedExact.has(key) || key.startsWith("LC_") || credentialNames.includes(key)) {
      environment[key] = value;
    }
  }
  Object.assign(environment, overrides);
  return environment;
}

function withoutCredentials(environment: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/i.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function redactDiagnostic(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  let redacted = value;
  for (const [key, secret] of Object.entries(environment)) {
    if (!secret || !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/i.test(key) || secret.length < 4) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(/(key|token|secret|password|authorization)\s*[:=]\s*[^\s,}\]]+/gi, "$1=[REDACTED]").slice(-8_192);
}

function sessionRoot(runtimeDirectory: string, normalizedSessionId: string): string {
  const safe = normalizedSessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid normalized ACPX session id");
  return join(resolve(runtimeDirectory), "acpx", safe);
}

function workspaceDigest(cwd: string): string {
  return `sha256:${createHash("sha256").update(resolve(cwd)).digest("hex")}`;
}

function validateWorkspace(value: string): string {
  const cwd = resolve(value);
  if (!value.trim() || cwd === dirname(cwd)) throw new Error("ACPX working directory must not be a filesystem root");
  return cwd;
}

function profileSessionKey(
  normalizedSessionId: string,
  cwd: string,
  profile: QualifiedAcpxProfile,
  model: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      normalizedSessionId,
      cwd,
      agent: profile.agent,
      model,
      reportedModelId: profile.reportedModelId,
      commandDigest: profile.commandDigest,
      driverKind: profile.driverKind,
      protocolVersion: profile.protocolVersion,
    }))
    .digest("hex");
  return `paperclip-${digest}`;
}

function requiredIdentity(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} identity is missing`);
  return value;
}

const PI_USAGE_PREFIX = "[paperclip-pi-usage-v1]";

function createAgentStderrRouter(
  environment: NodeJS.ProcessEnv,
  onUsage?: (usage: AcpxRuntimeUsage) => void,
  onDiagnostic?: (message: string) => void,
): { push: (chunk: string) => void; flush: () => void } {
  let pending = "";
  const emitLine = (line: string): void => {
    if (line.startsWith(PI_USAGE_PREFIX)) {
      const usage = parsePiUsage(line.slice(PI_USAGE_PREFIX.length));
      if (usage) onUsage?.(usage);
      else onDiagnostic?.("Pi emitted a malformed bounded usage notification.");
      return;
    }
    if (line) onDiagnostic?.(redactDiagnostic(line, environment));
  };
  return {
    push: (chunk) => {
      pending = `${pending}${chunk}`.slice(-128 * 1024);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) emitLine(line);
    },
    flush: () => {
      if (!pending) return;
      const trailing = pending;
      pending = "";
      emitLine(trailing);
    },
  };
}

function parsePiUsage(serialized: string): AcpxRuntimeUsage | null {
  if (Buffer.byteLength(serialized) > 8 * 1024) return null;
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const usage: AcpxRuntimeUsage = {};
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cachedReadTokens",
      "cachedWriteTokens",
      "thoughtTokens",
      "totalTokens",
    ] as const) {
      const amount = value[key];
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) usage[key] = amount;
    }
    const cost = value.cost;
    if (typeof cost === "object" && cost !== null && !Array.isArray(cost)) {
      const amount = (cost as Record<string, unknown>).amount;
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
        usage.cost = { amount, currency: "USD" };
      }
    }
    return Object.keys(usage).length > 0 ? usage : null;
  } catch {
    return null;
  }
}

function paperclipAcpSystemPrompt(): string {
  return [
    "You are running inside Paperclip Runner.",
    "Use only the semantic Paperclip tools made available for the attached run.",
    "Work only inside the supplied workspace.",
    "Do not discover user or project skills, plugins, MCP servers, prompts, or configuration.",
    "Finish through paperclip_finish or paperclip_block exactly once.",
  ].join("\n");
}

/** PRP names semantic tools by operationId; MCP and Pi name them `name`. */
function normalizeBridgeTools(
  tools: readonly Readonly<Record<string, unknown>>[],
): Array<Readonly<Record<string, unknown>>> {
  return tools.map((tool) => ({
    name: typeof tool.name === "string" ? tool.name : tool.operationId,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export type { AcpRuntimeEvent, AcpRuntimeTurn, AcpRuntimeStatus };
