import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertValidAdapterLoginCapability } from "@paperclipai/adapter-utils";
import {
  listServerAdapters,
  remoteProviderPackRoot,
  requireServerAdapter,
} from "./registry.js";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";

const originalProviderPackPath =
  process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;

afterEach(() => {
  if (originalProviderPackPath === undefined) {
    delete process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
  } else {
    process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH =
      originalProviderPackPath;
  }
});

// The registry registers a login capability for the two built-in interactive
// adapters. The test checks the scalar values and the presence of the required
// callbacks. It also runs the shared validator, so the built-in capabilities
// obey the same fail-closed contract as an external adapter.

describe("built-in adapter login capabilities", () => {
  it("reuses an exact preinstalled provider pack without staging it", async () => {
    const source = await mkdtemp(join(tmpdir(), "paperclip-provider-pack-"));
    const manifest = '{"schema":"paperclip-runner/remote-provider-pack/v1"}\n';
    await writeFile(join(source, "provider-pack.json"), manifest);
    process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH = source;
    const manifestSha = createHash("sha256").update(manifest).digest("hex");
    const syncIn = vi.fn();
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      stdout: `${manifestSha}  /opt/paperclip-runner/provider-pack/provider-pack.json\n`,
      stderr: "",
    });

    try {
      const root = await remoteProviderPackRoot({
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: "/workspace",
          providerKey: "daytona",
          runner: { execute, syncIn },
        },
      } as never);

      expect(root).toBe("/opt/paperclip-runner/provider-pack");
      expect(execute).toHaveBeenCalledOnce();
      expect(syncIn).not.toHaveBeenCalled();
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("stages the configured provider pack when the preinstalled manifest differs", async () => {
    const source = await mkdtemp(join(tmpdir(), "paperclip-provider-pack-"));
    await writeFile(join(source, "provider-pack.json"), "{}\n");
    process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH = source;
    const syncIn = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      stdout: `${"0".repeat(64)}  /opt/paperclip-runner/provider-pack/provider-pack.json\n`,
      stderr: "",
    });

    try {
      const root = await remoteProviderPackRoot({
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: "/workspace",
          providerKey: "daytona",
          runner: { execute, syncIn },
        },
      } as never);

      expect(root).toBe(
        "/workspace/.paperclip-runtime/environment-probes/provider-pack",
      );
      expect(syncIn).toHaveBeenCalledWith([
        expect.objectContaining({
          files: [expect.objectContaining({ sourcePath: source })],
        }),
      ]);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("publishes the qualified OpenCode runner configuration", async () => {
    const adapter = requireServerAdapter("paperclip_runner");
    expect(adapter.models).toContainEqual({
      id: "openrouter/deepseek/deepseek-v4-flash-0731",
      label: "OpenRouter · DeepSeek V4 Flash 0731",
    });
    expect(adapter.getRuntimeCommandSpec?.({ provider: "opencode" }))
      .toMatchObject({ command: "opencode", installCommand: expect.stringContaining("opencode-ai@1.18.17") });
    const schema = await adapter.getConfigSchema?.();
    expect(schema?.fields.map((field) => field.key))
      .toEqual(expect.arrayContaining([
        "provider",
        "model",
        "command",
        "codexPermissionMode",
        "opencodePermissionMode",
        "acpxPermissionMode",
      ]));
    expect(schema?.fields.find((field) => field.key === "codexPermissionMode")).toMatchObject({
      default: "never",
      options: [{ value: "never" }, { value: "on-request" }, { value: "untrusted" }],
    });
    expect(schema?.fields.find((field) => field.key === "opencodePermissionMode")).toMatchObject({
      default: "allow",
      options: [{ value: "allow" }, { value: "ask" }, { value: "deny" }],
    });
    expect(schema?.fields.find((field) => field.key === "acpxPermissionMode")).toMatchObject({
      default: "approve-all",
      options: [{ value: "approve-all" }, { value: "approve-reads" }, { value: "deny-all" }],
    });
    expect(schema?.fields.map((field) => field.key)).not.toContain("dangerouslyBypassApprovalsAndSandbox");
    expect(schema?.fields.map((field) => field.key)).not.toContain("permissionPolicy");
  });

  it("rejects a permission mode not supported by the selected runner provider", async () => {
    const result = await requireServerAdapter("paperclip_runner").testEnvironment!({
      companyId: "company-1",
      adapterType: "paperclip_runner",
      config: { provider: "opencode", opencodePermissionMode: "never" },
    });
    expect(result).toMatchObject({
      status: "fail",
      checks: [{ code: "runner_permission_mode_invalid", level: "error" }],
    });
  });

  it("registers the Codex device-login capability", () => {
    const capability = requireServerAdapter("codex_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("displayed_code");
    expect(capability.timeoutPolicy).toBe("caller_bounded");
    expect(capability.completionClaim).toBeUndefined();
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "codex_local")).not.toThrow();
  });

  it("registers the Grok device-login capability", () => {
    const capability = requireServerAdapter("grok_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("displayed_code");
    expect(capability.timeoutPolicy).toBe("caller_bounded");
    expect(capability.completionClaim).toBeUndefined();
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "grok_local")).not.toThrow();
  });

  it("registers the Claude setup-token capability", () => {
    const capability = requireServerAdapter("claude_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    expect(capability.panelMode).toBe("submitted_browser_code");
    expect(capability.timeoutPolicy).toBe("fixed");
    expect(capability.completionClaim).toBe("storedSessionId");
    expect(typeof capability.getCommand).toBe("function");
    expect(typeof capability.parsePrompt).toBe("function");
    expect(typeof capability.captureCredential).toBe("function");
    expect(() => assertValidAdapterLoginCapability(capability, "claude_local")).not.toThrow();
  });
});

describe("built-in runtime connection tool delivery", () => {
  const expectedStrategies = new Map([
    ["acpx_local", "environment"],
    ["claude_local", "native_mcp"],
    ["codex_local", "native_mcp"],
    ["cursor_cloud", "invocation_context"],
    ["cursor", "environment"],
    ["gemini_local", "environment"],
    ["grok_local", "environment"],
    ["hermes_gateway", "invocation_context"],
    ["hermes_local", "environment"],
    ["kimi_local", "environment"],
    ["openclaw_gateway", "invocation_context"],
    ["opencode_local", "environment"],
    ["paperclip_runner", "environment"],
    ["pi_local", "environment"],
    ["process", "environment"],
    ["http", "invocation_context"],
  ] as const);

  it("requires every built-in adapter to declare its expected delivery strategy", () => {
    const builtIns = listServerAdapters().filter((adapter) => BUILTIN_ADAPTER_TYPES.has(adapter.type));
    expect(new Set(builtIns.map((adapter) => adapter.type))).toEqual(BUILTIN_ADAPTER_TYPES);
    expect(new Map(builtIns.map((adapter) => [adapter.type, adapter.runtimeToolDelivery]))).toEqual(
      expectedStrategies,
    );
  });

  it.each([...expectedStrategies])("delivers %s runtime tools through %s", (type, strategy) => {
    expect(requireServerAdapter(type).runtimeToolDelivery).toBe(strategy);
  });
});
