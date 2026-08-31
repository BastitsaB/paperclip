import { describe, expect, it } from "vitest";
import { buildCodexLocalConfig, buildPaperclipRunnerConfig } from "./build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "codex_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "gpt-5.4",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: true,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildCodexLocalConfig", () => {
  it("omits engine for the auto default so runtime fallback remains available", () => {
    const config = buildCodexLocalConfig(makeValues({ codexEngine: "auto" }));

    expect(config).not.toHaveProperty("engine");
  });

  it("persists explicit engine pins", () => {
    expect(buildCodexLocalConfig(makeValues({ codexEngine: "cli" }))).toMatchObject({ engine: "cli" });
    expect(buildCodexLocalConfig(makeValues({ codexEngine: "acp" }))).toMatchObject({ engine: "acp" });
  });

  it("persists the fastMode toggle into adapter config", () => {
    const config = buildCodexLocalConfig(
      makeValues({
        search: true,
        fastMode: true,
      }),
    );

    expect(config).toMatchObject({
      model: "gpt-5.4",
      search: true,
      fastMode: true,
      dangerouslyBypassApprovalsAndSandbox: true,
    });
  });

  it("omits model when the operator leaves it blank", () => {
    const config = buildCodexLocalConfig(makeValues({ model: "" }));

    expect(config).not.toHaveProperty("model");
  });
});

describe("buildPaperclipRunnerConfig", () => {
  it("preserves the Codex provider default", () => {
    expect(buildPaperclipRunnerConfig(makeValues())).toMatchObject({
      provider: "codex",
      model: "gpt-5.4",
      lifecycleMode: "per_turn",
    });
  });

  it("builds a bounded OpenCode runner profile from schema values", () => {
    const config = buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      model: "",
      codexEngine: "acp",
      dangerouslyBypassSandbox: true,
      adapterSchemaValues: {
        provider: "opencode",
        opencodePermissionMode: "ask",
        lifecycleMode: "warm",
        idleTimeoutMs: 45_000,
      },
    }));

    expect(config).toMatchObject({
      provider: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      opencodePermissionMode: "ask",
      lifecycleMode: "warm",
      idleTimeoutMs: 45_000,
    });
    expect(config).not.toHaveProperty("engine");
    expect(config).not.toHaveProperty("dangerouslyBypassApprovalsAndSandbox");
  });

  it("falls back to safe OpenCode defaults for invalid schema values", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterSchemaValues: {
        provider: "opencode",
        opencodePermissionMode: "unrestricted",
        lifecycleMode: "forever",
        idleTimeoutMs: -1,
      },
    }))).toMatchObject({
      provider: "opencode",
      opencodePermissionMode: "allow",
      lifecycleMode: "per_turn",
    });
  });

  it("persists a warm lifecycle and its idle timeout", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      paperclipRunnerLifecycleMode: "warm",
      paperclipRunnerIdleTimeoutMs: 45_000,
    }))).toMatchObject({ lifecycleMode: "warm", idleTimeoutMs: 45_000 });
  });

  it("persists OpenCode and supplies the qualified model when blank", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      paperclipRunnerProvider: "opencode",
      model: "",
    }))).toMatchObject({
      provider: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      opencodePermissionMode: "allow",
    });
  });

  it("defaults every Paperclip Runner harness to its maximum permission mode", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      paperclipRunnerProvider: "acpx",
      paperclipRunnerAcpxAgent: "claude",
      model: "",
      dangerouslyBypassSandbox: true,
      adapterSchemaValues: {
        permissionPolicy: "interactive",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
    }))).toMatchObject({
      provider: "acpx",
      acpxAgent: "claude",
      model: "claude-sonnet-5",
      codexPermissionMode: "never",
      opencodePermissionMode: "allow",
      acpxPermissionMode: "approve-all",
    });
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      dangerouslyBypassSandbox: true,
      adapterSchemaValues: {
        permissionPolicy: "interactive",
        dangerouslyBypassSandbox: true,
      },
    }))).toEqual(expect.not.objectContaining({
      dangerouslyBypassApprovalsAndSandbox: expect.anything(),
      dangerouslyBypassSandbox: expect.anything(),
      permissionPolicy: expect.anything(),
    }));
  });

  it("persists lower provider-specific permission modes", () => {
    expect(buildPaperclipRunnerConfig(makeValues({
      adapterType: "paperclip_runner",
      codexPermissionMode: "on-request",
      opencodePermissionMode: "ask",
      acpxPermissionMode: "approve-reads",
    }))).toMatchObject({
      codexPermissionMode: "on-request",
      opencodePermissionMode: "ask",
      acpxPermissionMode: "approve-reads",
    });
  });
});
