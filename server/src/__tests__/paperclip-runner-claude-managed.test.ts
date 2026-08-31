import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findServerAdapter } from "../adapters/registry.js";

const CONFIG = {
  provider: "claude_managed",
  managedProfileId: "qualified",
  anthropicAgentId: "agent_test",
  agentVersion: "3",
  anthropicEnvironmentId: "env_test",
  model: "claude-sonnet-5",
  maxSessionListCostUsd: 1,
  managedAgentsRetentionAcknowledged: true,
  env: { ANTHROPIC_API_KEY: "anthropic-config-secret" },
};

describe("paperclip_runner Claude Agent environment probe", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the resolved adapter secret and performs only read-only qualified-resource probes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (url.includes("/versions")) {
        return new Response(JSON.stringify({ data: [{ version: 3 }] }), { status: 200 });
      }
      if (url.includes("/environments/")) {
        return new Response(JSON.stringify({
          id: "env_test",
          config: {
            type: "cloud",
            networking: {
              type: "limited",
              allow_mcp_servers: false,
              allow_package_managers: false,
              allowed_hosts: [],
            },
            packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "agent_test" }), { status: 200 });
    }));

    const result = await findServerAdapter("paperclip_runner")!.testEnvironment!({
      companyId: "company-1",
      adapterType: "paperclip_runner",
      config: CONFIG,
    });

    expect(result.status).toBe("warn");
    expect(result.checks.some((check) => check.code === "claude_managed_profile_qualified")).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.anthropic.com/v1/agents/agent_test?beta=true",
      "https://api.anthropic.com/v1/environments/env_test?beta=true",
      "https://api.anthropic.com/v1/agents/agent_test/versions?beta=true",
      "https://api.anthropic.com/v1/skills?limit=1&source=custom",
    ]);
    expect(calls.every((call) => (call.init.method ?? "GET") === "GET")).toBe(true);
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({
        "x-api-key": "anthropic-config-secret",
      });
    }
    expect(calls.slice(0, 3).every((call) =>
      (call.init.headers as Record<string, string>)["anthropic-beta"] === "managed-agents-2026-04-01"
    )).toBe(true);
    expect(calls[3]?.init.headers).toMatchObject({
      "anthropic-beta": "skills-2025-10-02",
    });
    expect(JSON.stringify(result)).not.toContain("anthropic-config-secret");
  });

  it("rejects unsafe Environment drift", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/versions")) return new Response(JSON.stringify({ data: [{ version: 3 }] }));
      if (url.includes("/environments/")) {
        return new Response(JSON.stringify({
          id: "env_test",
          config: {
            type: "cloud",
            networking: { type: "unrestricted" },
            packages: { type: "packages" },
          },
        }));
      }
      return new Response(JSON.stringify({ id: "agent_test" }));
    }));
    const result = await findServerAdapter("paperclip_runner")!.testEnvironment!({
      companyId: "company-1",
      adapterType: "paperclip_runner",
      config: CONFIG,
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "claude_managed_probe_failed")).toBe(true);
  });
});
