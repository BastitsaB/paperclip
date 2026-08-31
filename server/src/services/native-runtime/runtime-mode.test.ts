import { describe, expect, it } from "vitest";
import {
  NativeRuntimeEligibilityError,
  resolveHeartbeatNativeRuntimeMode,
  resolveNativeRuntimeMode,
} from "./runtime-mode.js";

const eligible = {
  enabled: true,
  runtimeConfig: {},
  adapterConfig: { provider: "codex" },
  agent: { status: "running", adapterType: "paperclip_runner" },
  issue: { id: "issue", workMode: "standard" },
  target: { kind: "local" },
  workspaceId: "workspace",
} as const;

describe("resolveNativeRuntimeMode", () => {
  it("rejects a fresh Paperclip Runner start while the rollout flag is disabled", () => {
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      enabled: false,
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_rollout_disabled",
    }));
  });

  it("rejects unknown Paperclip Runner providers", () => {
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      runtimeConfig: {},
      adapterConfig: { provider: "claude" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toThrow(/provider must be codex, opencode, claude_managed, aws_agentcore, or acpx/);
  });

  it("selects OpenCode only with a provider/model value", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      runtimeConfig: {},
      adapterConfig: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toEqual(expect.objectContaining({
      profile: { mode: "native", backend: "opencode_server", protocolVersion: 1 },
    }));
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      runtimeConfig: {},
      adapterConfig: { provider: "opencode", model: "deepseek" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toThrow(/provider\/model/);
  });

  it("preserves legacy as the default and as the kill-switch behavior", () => {
    const direct = {
      ...eligible,
      agent: { ...eligible.agent, adapterType: "codex_local" },
      runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
    };
    expect(resolveNativeRuntimeMode(direct)).toEqual(expect.objectContaining({
      kind: "legacy",
      reason: "direct_adapter",
    }));
    expect(resolveNativeRuntimeMode({ ...direct, enabled: false })).toEqual(expect.objectContaining({
      kind: "legacy",
      reason: "direct_adapter",
    }));
  });

  it("selects native only for an eligible explicit profile", () => {
    expect(resolveNativeRuntimeMode(eligible)).toEqual(expect.objectContaining({
      kind: "native",
      reason: "eligible_opt_in",
    }));
  });

  it("keeps a persisted active run native while the global flag rejects a fresh runner start", () => {
    const disabled = { ...eligible, enabled: false };
    expect(resolveHeartbeatNativeRuntimeMode({
      ...disabled,
      persisted: {
        runtimeMode: "native",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
      },
    })).toEqual(expect.objectContaining({
      kind: "native",
      reason: "eligible_opt_in",
      authorityDecision: expect.objectContaining({ reasonCode: "live_continuation_registered" }),
    }));
    expect(() => resolveHeartbeatNativeRuntimeMode({
      ...disabled,
      persisted: { runtimeMode: null, runtimeModeReason: null, runtimeModeResolvedAt: null },
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_rollout_disabled",
    }));
  });

  it("keeps a persisted OpenCode recovery on its immutable driver", () => {
    expect(resolveHeartbeatNativeRuntimeMode({
      ...eligible,
      enabled: false,
      adapterConfig: { provider: "codex" },
      persisted: {
        runtimeMode: "native",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
        driverKind: "opencode_server",
      },
    })).toEqual(expect.objectContaining({
      profile: { mode: "native", backend: "opencode_server", protocolVersion: 1 },
    }));
  });

  it("rejects an explicit native profile outside the approved boundary", () => {
    expect(resolveNativeRuntimeMode({ ...eligible, agent: { ...eligible.agent, adapterType: "claude_local" } }))
      .toEqual(expect.objectContaining({ kind: "legacy", reason: "direct_adapter" }));
    expect(() => resolveNativeRuntimeMode({ ...eligible, issue: { id: "issue", workMode: "skill_test" } }))
      .toThrow(NativeRuntimeEligibilityError);
  });

  it("admits remote targets only through paperclip_runner", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      target: { kind: "remote" },
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toMatchObject({ kind: "native" });
  });

  it("allows paperclip_runner to use a transient local workspace for projectless issues", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      workspaceId: null,
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
    })).toEqual(expect.objectContaining({ kind: "native" }));
  });

  it("admits planning only through paperclip_runner", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      issue: { id: "plan-issue", workMode: "planning" },
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toMatchObject({ kind: "native", profile: { backend: "codex_app_server" } });
    expect(resolveNativeRuntimeMode({
      ...eligible,
      issue: { id: "plan-issue", workMode: "planning" },
      agent: { ...eligible.agent, adapterType: "codex_local" },
    })).toEqual(expect.objectContaining({ kind: "legacy", reason: "direct_adapter" }));
  });

  it("admits ask mode through paperclip_runner while preserving the legacy native boundary", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      issue: { id: "ask-issue", workMode: "ask" },
      runtimeConfig: {},
      adapterConfig: { provider: "opencode", model: "opencode/nemotron-3.5-lightning-free" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toMatchObject({ kind: "native", profile: { backend: "opencode_server" } });
    expect(resolveNativeRuntimeMode({
      ...eligible,
      issue: { id: "ask-issue", workMode: "ask" },
      agent: { ...eligible.agent, adapterType: "codex_local" },
    })).toEqual(expect.objectContaining({ kind: "legacy", reason: "direct_adapter" }));
  });
});
