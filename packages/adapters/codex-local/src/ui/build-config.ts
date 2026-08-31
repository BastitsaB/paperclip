import {
  buildAdapterEnvConfig,
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerPermissionMode,
  type CreateConfigValues,
} from "@paperclipai/adapter-utils";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "../index.js";

function parseCommaArgs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function buildCodexLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  if (v.thinkingEffort) ac.modelReasoningEffort = v.thinkingEffort;
  if (v.codexEngine === "cli" || v.codexEngine === "acp") ac.engine = v.codexEngine;
  if (v.codexEngine === "acp") {
    if (v.codexAcpAgentCommand) ac.agentCommand = v.codexAcpAgentCommand;
    ac.mode = v.codexAcpMode ?? "persistent";
    ac.nonInteractivePermissions = v.codexAcpNonInteractivePermissions ?? "deny";
    if (v.codexAcpStateDir) ac.stateDir = v.codexAcpStateDir;
    ac.warmHandleIdleMs = v.codexAcpWarmHandleIdleMs ?? 0;
  }
  ac.timeoutSec = 0;
  ac.graceSec = 15;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0) ac.env = env;
  ac.search = v.search;
  ac.fastMode = v.fastMode;
  ac.dangerouslyBypassApprovalsAndSandbox =
    typeof v.dangerouslyBypassSandbox === "boolean"
      ? v.dangerouslyBypassSandbox
      : DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
  if (v.workspaceStrategyType === "git_worktree") {
    ac.workspaceStrategy = {
      type: "git_worktree",
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {}),
      ...(v.workspaceBranchTemplate ? { branchTemplate: v.workspaceBranchTemplate } : {}),
      ...(v.worktreeParentDir ? { worktreeParentDir: v.worktreeParentDir } : {}),
    };
  }
  const runtimeServices = parseJsonObject(v.runtimeServicesJson ?? "");
  if (runtimeServices && Array.isArray(runtimeServices.services)) {
    ac.workspaceRuntime = runtimeServices;
  }
  if (v.command) ac.command = v.command;
  if (v.extraArgs) ac.extraArgs = parseCommaArgs(v.extraArgs);
  return ac;
}

/** Build a bounded Paperclip Runner profile without exposing legacy engines. */
export function buildPaperclipRunnerConfig(v: CreateConfigValues): Record<string, unknown> {
  const config = buildCodexLocalConfig(v);
  delete config.engine;
  delete config.agentCommand;
  delete config.mode;
  delete config.nonInteractivePermissions;
  delete config.stateDir;
  delete config.warmHandleIdleMs;
  delete config.dangerouslyBypassApprovalsAndSandbox;
  const schemaValues = { ...(v.adapterSchemaValues ?? {}) };
  const providerCandidate = v.paperclipRunnerProvider ?? schemaValues.provider;
  const provider = isPaperclipRunnerProvider(providerCandidate) ? providerCandidate : "codex";
  const acpxAgentCandidate = v.paperclipRunnerAcpxAgent ?? schemaValues.acpxAgent;
  const acpxAgent = acpxAgentCandidate === "claude" || acpxAgentCandidate === "codex"
    ? acpxAgentCandidate
    : "pi";
  const lifecycleCandidate = v.paperclipRunnerLifecycleMode ?? schemaValues.lifecycleMode;
  const lifecycleMode = lifecycleCandidate === "warm" ? "warm" : "per_turn";
  const idleTimeoutCandidate = v.paperclipRunnerIdleTimeoutMs ?? schemaValues.idleTimeoutMs;
  const idleTimeoutMs = typeof idleTimeoutCandidate === "number"
    && Number.isSafeInteger(idleTimeoutCandidate)
    && idleTimeoutCandidate > 0
    ? idleTimeoutCandidate
    : 300_000;
  const codexPermissionMode = resolvePaperclipRunnerPermissionMode(
    "codex",
    v.codexPermissionMode ?? schemaValues.codexPermissionMode,
  );
  const opencodePermissionMode = resolvePaperclipRunnerPermissionMode(
    "opencode",
    v.opencodePermissionMode ?? schemaValues.opencodePermissionMode,
  );
  const acpxPermissionMode = resolvePaperclipRunnerPermissionMode(
    "acpx",
    v.acpxPermissionMode ?? schemaValues.acpxPermissionMode,
  );
  for (const reservedKey of [
    "provider",
    "acpxAgent",
    "codexPermissionMode",
    "opencodePermissionMode",
    "acpxPermissionMode",
    "lifecycleMode",
    "idleTimeoutMs",
    "permissionPolicy",
    "dangerouslyBypassApprovalsAndSandbox",
    "dangerouslyBypassSandbox",
  ]) {
    delete schemaValues[reservedKey];
  }
  const acpxModel = acpxAgent === "claude"
    ? "claude-sonnet-5"
    : acpxAgent === "codex"
      ? "gpt-5.6-sol"
      : "openrouter/deepseek/deepseek-v4-flash-0731";
  return {
    ...config,
    ...schemaValues,
    provider,
    codexPermissionMode,
    opencodePermissionMode,
    acpxPermissionMode,
    ...(provider === "acpx" ? { acpxAgent, model: v.model || acpxModel } : {}),
    ...(provider === "claude_managed"
      ? {
          maxSessionListCostUsd: schemaValues.maxSessionListCostUsd ?? 1,
          managedAgentsRetentionAcknowledged:
            schemaValues.managedAgentsRetentionAcknowledged ?? false,
        }
      : {}),
    ...(provider === "aws_agentcore"
      ? {
          maxEstimatedSessionCostUsd: schemaValues.maxEstimatedSessionCostUsd ?? 1,
          qualificationRevision:
            schemaValues.qualificationRevision ?? "aws-agentcore-harness-v1",
          agentCoreRetentionAcknowledged:
            schemaValues.agentCoreRetentionAcknowledged ?? false,
        }
      : {}),
    lifecycleMode,
    ...(lifecycleMode === "warm" ? { idleTimeoutMs } : {}),
    ...(provider === "opencode" && !v.model
      ? { model: "openrouter/deepseek/deepseek-v4-flash-0731" }
      : {}),
  };
}
