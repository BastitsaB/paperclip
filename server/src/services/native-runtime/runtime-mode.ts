import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusDecision,
} from "./status-arbiter.js";

export const NATIVE_RUNTIME_RESOLVER_VERSION = "phase6-v1" as const;

export type NativeRuntimeResolution =
  | {
      kind: "legacy";
      resolverVersion: typeof NATIVE_RUNTIME_RESOLVER_VERSION;
      reason: string;
      authorityDecision?: NativeStatusDecision;
    }
  | {
      kind: "native";
      resolverVersion: typeof NATIVE_RUNTIME_RESOLVER_VERSION;
      reason: "eligible_opt_in";
      profile: {
        mode: "native";
        backend: "codex_app_server" | "opencode_server" | "claude_managed_agents_api" | "aws_agentcore_harness_api" | "acpx_runtime";
        protocolVersion: 1;
      };
      authorityDecision: NativeStatusDecision;
    };

export class NativeRuntimeEligibilityError extends Error {
  constructor(
    readonly code: string,
    reason?: string,
  ) {
    super(reason ?? `Native runner profile is ineligible: ${code}`);
    this.name = "NativeRuntimeEligibilityError";
  }
}

function ineligible(reason: string): NativeRuntimeEligibilityError {
  return new NativeRuntimeEligibilityError(
    "native_runtime_ineligible",
    `Native runner profile is ineligible: ${reason}`,
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveNativeRuntimeMode(input: {
  enabled: boolean;
  runtimeConfig: unknown;
  adapterConfig?: unknown;
  agent: { id?: string; status: string; adapterType: string | null };
  issue: { id: string; workMode: string; executionWorkspaceId?: string | null } | null;
  target: { kind?: string } | null | undefined;
  workspaceId: string | null;
}): NativeRuntimeResolution {
  const runnerAdapterSelected = input.agent.adapterType === "paperclip_runner";
  // Fresh direct-adapter runs never enter the native control plane, even if an
  // obsolete runtimeConfig.nativeRunner value is still present. Persisted
  // native runs are handled by resolveHeartbeatNativeRuntimeMode above this
  // fresh-selection seam so they remain recoverable after rollout changes.
  if (!runnerAdapterSelected) {
    return {
      kind: "legacy",
      resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
      reason: "direct_adapter",
    };
  }
  if (!input.enabled) {
    throw new NativeRuntimeEligibilityError(
      "paperclip_runner_rollout_disabled",
      "Paperclip Runner is experimental and disabled on this instance.",
    );
  }
  const runnerProvider = record(input.adapterConfig).provider ?? "codex";
  if (!["codex", "opencode", "claude_managed", "aws_agentcore", "acpx"].includes(String(runnerProvider))) {
    throw ineligible("paperclip_runner provider must be codex, opencode, claude_managed, aws_agentcore, or acpx");
  }
  if (runnerProvider === "opencode") {
    const model = record(input.adapterConfig).model;
    if (typeof model !== "string" || !model.includes("/") || model.trim().endsWith("/")) {
      throw ineligible("paperclip_runner OpenCode provider requires model in provider/model form");
    }
  }
  if (runnerProvider === "claude_managed") {
    const config = record(input.adapterConfig);
    for (const key of ["managedProfileId", "anthropicAgentId", "agentVersion", "anthropicEnvironmentId", "model"]) {
      if (typeof config[key] !== "string" || String(config[key]).trim().length === 0) {
        throw ineligible(`paperclip_runner Claude Agent provider requires ${key}`);
      }
    }
    if (config.managedAgentsRetentionAcknowledged !== true) {
      throw ineligible("paperclip_runner Claude Agent provider requires retention acknowledgement");
    }
    const cap = Number(config.maxSessionListCostUsd);
    if (!Number.isFinite(cap) || cap <= 0) {
      throw ineligible("paperclip_runner Claude Agent provider requires a positive spend ceiling");
    }
  }
  if (runnerProvider === "aws_agentcore") {
    const config = record(input.adapterConfig);
    for (const key of ["agentCoreProfileId", "model"]) {
      if (typeof config[key] !== "string" || String(config[key]).trim().length === 0) {
        throw ineligible(`paperclip_runner AWS AgentCore provider requires ${key}`);
      }
    }
    if (config.agentCoreRetentionAcknowledged !== true) {
      throw ineligible("paperclip_runner AWS AgentCore provider requires the 90-day retention acknowledgement");
    }
    const cap = Number(config.maxEstimatedSessionCostUsd);
    if (!Number.isFinite(cap) || cap <= 0) {
      throw ineligible("paperclip_runner AWS AgentCore provider requires a positive estimated spend ceiling");
    }
  }
  if (runnerProvider === "acpx") {
    const config = record(input.adapterConfig);
    const agent = config.acpxAgent;
    if (agent !== "pi" && agent !== "claude" && agent !== "codex") {
      throw ineligible("paperclip_runner ACPX provider requires acpxAgent pi, claude, or codex");
    }
    if (typeof config.model !== "string" || config.model.trim().length === 0) {
      throw ineligible("paperclip_runner ACPX provider requires an exact model");
    }
    const qualifiedModel = agent === "pi"
      ? "openrouter/deepseek/deepseek-v4-flash-0731"
      : agent === "claude"
        ? "claude-sonnet-5"
        : "gpt-5.6-sol";
    if (config.model !== qualifiedModel) {
      throw ineligible(`paperclip_runner ACPX ${agent} profile requires model ${qualifiedModel}`);
    }
  }
  if (
    input.agent.adapterType !== "paperclip_runner"
    || input.agent.status !== "active" && input.agent.status !== "running"
  ) {
    throw ineligible("agent must be an active Paperclip Runner agent");
  }
  const allowedWorkModes = ["standard", "planning", "ask"];
  if (!input.issue || !allowedWorkModes.includes(input.issue.workMode)) {
    throw ineligible("run must be bound to a standard, planning, or ask issue");
  }
  const rollout = resolveNativeMigrationStatus({
    facts: { applicationEnabled: true },
    priorIssueStatus: "in_progress",
    agentId: input.agent.id ?? "00000000-0000-4000-8000-000000000000",
  });
  if (!rollout.effects.some((effect) => effect.kind === "record_mode_native")) {
    throw ineligible("native rollout policy did not select native mode");
  }
  return {
    kind: "native",
    resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
    reason: "eligible_opt_in",
    profile: {
      mode: "native",
      backend: runnerProvider === "opencode"
        ? "opencode_server"
        : runnerProvider === "claude_managed"
          ? "claude_managed_agents_api"
          : runnerProvider === "aws_agentcore"
            ? "aws_agentcore_harness_api"
          : runnerProvider === "acpx"
            ? "acpx_runtime"
          : "codex_app_server",
      protocolVersion: 1,
    },
    authorityDecision: rollout,
  };
}

/**
 * Production heartbeat selection seam. A resolved run keeps its persisted
 * mode across configuration changes; only a fresh unresolved run consults the
 * current global flag and agent profile.
 */
export function resolveHeartbeatNativeRuntimeMode(input: {
  persisted: {
    runtimeMode: string | null;
    runtimeModeReason: string | null;
    runtimeModeResolvedAt: Date | null;
    driverKind?: string | null;
  };
  enabled: boolean;
  runtimeConfig: unknown;
  adapterConfig?: unknown;
  agent: { id?: string; status: string; adapterType: string | null };
  issue: { id: string; workMode: string; executionWorkspaceId?: string | null } | null;
  target: { kind?: string } | null | undefined;
  workspaceId: string | null;
}): NativeRuntimeResolution {
  if (input.persisted.runtimeModeResolvedAt) {
    if (input.persisted.runtimeMode === "native") {
      return {
        kind: "native",
        resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
        reason: "eligible_opt_in",
        profile: {
          mode: "native",
          backend: input.persisted.driverKind === "opencode_server"
            ? "opencode_server"
            : input.persisted.driverKind === "claude_managed_agents_api"
              ? "claude_managed_agents_api"
              : input.persisted.driverKind === "aws_agentcore_harness_api"
                ? "aws_agentcore_harness_api"
              : input.persisted.driverKind === "acpx_runtime"
                ? "acpx_runtime"
              : "codex_app_server",
          protocolVersion: 1,
        },
        authorityDecision: resolveNativeMigrationStatus({
          facts: input.enabled
            ? { applicationEnabled: true }
            : { killSwitchActiveForNewRuns: true },
          priorIssueStatus: "in_progress",
          agentId: input.agent.id ?? "00000000-0000-4000-8000-000000000000",
        }),
      };
    }
    return {
      kind: "legacy",
      resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
      reason: input.persisted.runtimeModeReason ?? "persisted_legacy_selection",
    };
  }
  return resolveNativeRuntimeMode(input);
}

/** Production read-model facts used by compatibility and mixed-ledger views. */
export function inspectNativeCompatibilityState(input: {
  resolution: NativeRuntimeResolution;
  nativeRecordCount: number;
  decisionCount: number;
  issueStatus: string;
  statusVersion: number;
  persistedEffectKinds: string[];
}) {
  const effects = input.persistedEffectKinds.length > 0
    ? [...input.persistedEffectKinds]
    : input.resolution.kind === "legacy"
      ? ["legacy_existing_behavior"]
      : input.nativeRecordCount === 0 && input.statusVersion === 0
        ? ["initialize_status_version_zero"]
        : [];
  return {
    mode: input.resolution.kind,
    native: input.nativeRecordCount > 0,
    hasNativeDecisionLineage: input.decisionCount > 0,
    issueStatus: input.issueStatus,
    statusVersion: input.statusVersion,
    statusAction: input.resolution.kind === "legacy" ? "legacy_finalizer" : "preserve",
    reasonCode: null,
    effects,
  } as const;
}

/** Expand-only migration evidence; it never mutates or synthesizes history. */
export function inspectNativeMigrationState(input: {
  resolution: NativeRuntimeResolution;
  nativeRecordCount: number;
  decisionCount: number;
  issueStatusBefore: string;
  issueStatusAfter: string;
  statusVersion: number;
  hasPendingReview: boolean;
}) {
  const effects = input.resolution.kind === "legacy"
    ? input.issueStatusBefore === "done"
      ? ["retain_legacy_mode", "retain_audit_lineage"]
      : ["return_native_false"]
    : input.nativeRecordCount === 0 && input.hasPendingReview && input.statusVersion > 0
      ? ["increment_status_version_once", "bind_reviewer"]
      : input.nativeRecordCount === 0
        ? ["expand_schema", "status_version_default_zero"]
        : [];
  return {
    mode: input.resolution.kind,
    native: input.nativeRecordCount > 0,
    hasSyntheticHistory: input.nativeRecordCount === 0 && input.decisionCount > 0,
    statusPreserved: input.issueStatusBefore === input.issueStatusAfter,
    statusVersion: input.statusVersion,
    statusAction: input.resolution.kind === "legacy" ? "legacy_finalizer"
      : input.hasPendingReview ? input.issueStatusAfter : "preserve",
    reasonCode: null,
    effects,
  } as const;
}

export type NativeCompatibilityFacts = {
  invalidNativeFinalization?: boolean;
  terminalResumeAuthorized?: boolean;
  shadowApplicationDisabled?: boolean;
  mixedLedger?: boolean;
  statusWriterAdvancedVersion?: boolean;
};

export function resolveNativeCompatibilityStatus(input: {
  facts: NativeCompatibilityFacts;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}): NativeStatusDecision {
  const preserve = (reasonCode: string, effects: NativeStatusDecision["effects"]): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  if (input.facts.invalidNativeFinalization) {
    return preserve("native_finalization_invalid", [{
      kind: "record_finalization_error",
      cause: "native_finalization_invalid",
      nextAction: "Repair the persisted native result.",
      agentId: input.agentId,
    }]);
  }
  if (input.facts.terminalResumeAuthorized) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "authorized_resume",
      unblockDescriptor: null,
      effects: [{
        kind: "enqueue_continuation",
        continuationKind: "same_agent",
        summary: "Resume the terminal issue through the authorized compatibility path.",
        idempotencyKey: "native-compatibility:authorized-resume",
        agentId: input.agentId,
      }],
    };
  }
  if (input.facts.shadowApplicationDisabled) {
    return preserve("completion_contract_satisfied", [{ kind: "record_shadow_decision" }]);
  }
  if (input.facts.mixedLedger) {
    return preserve("completion_contract_satisfied", [{ kind: "render_four_layers" }]);
  }
  if (input.facts.statusWriterAdvancedVersion) {
    return preserve("arbitration_conflict_reloaded", [
      { kind: "increment_status_version" },
      { kind: "schedule_reconciliation" },
    ]);
  }
  throw new Error("native_compatibility_facts_invalid");
}

export type NativeMigrationFacts = {
  shadowMaterialization?: boolean;
  classifiedDivergence?: boolean;
  applicationEnabled?: boolean;
  policyPinned?: boolean;
  killSwitchActiveForNewRuns?: boolean;
};

export function resolveNativeMigrationStatus(input: {
  facts: NativeMigrationFacts;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}): NativeStatusDecision {
  const preserve = (reasonCode: string, effects: NativeStatusDecision["effects"]): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  if (input.facts.shadowMaterialization) {
    return preserve("completion_contract_satisfied", [
      { kind: "materialize_contract" },
      { kind: "record_shadow_decision" },
    ]);
  }
  if (input.facts.classifiedDivergence) {
    return preserve("completion_evidence_incomplete", [{ kind: "record_mode_labeled_divergence" }]);
  }
  if (input.facts.killSwitchActiveForNewRuns) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "live_continuation_registered",
      unblockDescriptor: null,
      effects: [
        {
          kind: "enqueue_continuation",
          continuationKind: "same_agent",
          summary: "Finish the already-active run in native mode.",
          idempotencyKey: "native-migration:kill-switch-active-run",
          agentId: input.agentId,
        },
        { kind: "finish_as_native" },
      ],
    };
  }
  if (input.facts.policyPinned) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "record_mode_native" }, { kind: "record_policy_version" }],
    };
  }
  if (input.facts.applicationEnabled) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "live_continuation_registered",
      unblockDescriptor: null,
      effects: [
        {
          kind: "enqueue_continuation",
          continuationKind: "same_agent",
          summary: "Continue the allowlisted native run.",
          idempotencyKey: "native-migration:application-enabled",
          agentId: input.agentId,
        },
        { kind: "record_mode_native" },
      ],
    };
  }
  throw new Error("native_migration_facts_invalid");
}
