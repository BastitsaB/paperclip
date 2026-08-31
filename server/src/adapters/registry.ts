import type {
  AdapterModelProfileDefinition,
  AdapterRuntimeCommandSpec,
  ServerAdapterModule,
} from "./types.js";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import {
  AcpxRuntimeHost,
  inspectQualifiedAcpxInstallation,
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "../vendor/paperclip-runner/index.js";
import { parseAdapterModelsEnv } from "../services/adapter-models-env.js";
import { stampClaudeAgentIdHeader } from "./claude-agent-id-header.js";
import {
  buildSandboxNpmInstallCommand,
  getAdapterSessionManagement,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  redactDiagnosticText,
  resolvePaperclipRunnerPermissionMode,
  type PaperclipRunnerProvider,
} from "@paperclipai/adapter-utils";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import type { AdapterLoginCapability } from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  refreshClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
  readClaudeAuthStatus,
  getConfigSchema as getClaudeConfigSchema,
  CLAUDE_SETUP_TOKEN_COMMAND,
  parseSetupTokenPrompt,
  parseSetupTokenCredential,
} from "@paperclipai/adapter-claude-local/server";
import {
  agentConfigurationDoc as claudeAgentConfigurationDoc,
  models as claudeModels,
  modelProfiles as claudeModelProfiles,
} from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
  readCodexAuthInfo,
  getConfigSchema as getCodexConfigSchema,
  CODEX_DEVICE_LOGIN_COMMAND,
  parseDeviceLoginPrompt,
} from "@paperclipai/adapter-codex-local/server";
import {
  agentConfigurationDoc as codexAgentConfigurationDoc,
  models as codexModels,
  modelProfiles as codexModelProfiles,
} from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import {
  agentConfigurationDoc as cursorAgentConfigurationDoc,
  models as cursorModels,
  modelProfiles as cursorModelProfiles,
} from "@paperclipai/adapter-cursor-local";
import {
  execute as cursorCloudExecute,
  getConfigSchema as getCursorCloudConfigSchema,
  sessionCodec as cursorCloudSessionCodec,
  testEnvironment as cursorCloudTestEnvironment,
} from "@paperclipai/adapter-cursor-cloud/server";
import { agentConfigurationDoc as cursorCloudAgentConfigurationDoc } from "@paperclipai/adapter-cursor-cloud";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
  getConfigSchema as getGeminiConfigSchema,
} from "@paperclipai/adapter-gemini-local/server";
import {
  agentConfigurationDoc as geminiAgentConfigurationDoc,
  models as geminiModels,
  modelProfiles as geminiModelProfiles,
} from "@paperclipai/adapter-gemini-local";
import {
  execute as grokExecute,
  listGrokSkills,
  syncGrokSkills,
  testEnvironment as grokTestEnvironment,
  sessionCodec as grokSessionCodec,
  GROK_DEVICE_LOGIN_COMMAND,
  parseGrokDeviceLoginPrompt,
} from "@paperclipai/adapter-grok-local/server";
import {
  agentConfigurationDoc as grokAgentConfigurationDoc,
  models as grokModels,
} from "@paperclipai/adapter-grok-local";
import {
  execute as kimiExecute,
  listKimiSkills,
  syncKimiSkills,
  testEnvironment as kimiTestEnvironment,
  sessionCodec as kimiSessionCodec,
} from "@paperclipai/adapter-kimi-local/server";
import {
  agentConfigurationDoc as kimiAgentConfigurationDoc,
  models as kimiModels,
} from "@paperclipai/adapter-kimi-local";
import {
  createHermesGatewayServerAdapter,
  createHermesLocalServerAdapter,
} from "@paperclipai/hermes-paperclip-adapter";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
  modelProfiles as openCodeModelProfiles,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels, refreshCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  modelProfiles as piModelProfiles,
} from "@paperclipai/adapter-pi-local";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";
import { resolveAcpxCodexManagedCredentialEnvironment } from "../services/native-runtime/acpx-managed-credential.js";

const execFileAsync = promisify(execFile);

function configuredProbeEnvironment(
  config: Record<string, unknown>,
): Record<string, string> {
  const configured = config.env && typeof config.env === "object"
    ? config.env as Record<string, unknown>
    : {};
  const credentialKeys = [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ] as const;
  return Object.fromEntries(
    [
      ...credentialKeys.map((key) => [key, process.env[key]] as const),
      ...Object.entries(configured),
    ].flatMap(
      ([key, value]) => typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

function redactedProbeTail(
  value: unknown,
  environment: Record<string, string> = {},
): string {
  let redacted = value instanceof Error ? value.message : String(value ?? "");
  for (const [key, secret] of Object.entries(environment)) {
    if (
      secret.length >= 4
      && /(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/i.test(key)
    ) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redactDiagnosticText(redacted, "[REDACTED]").slice(-1_000);
}

export async function remoteProviderPackRoot(
  context: Parameters<typeof codexTestEnvironment>[0],
): Promise<string> {
  const target = context.executionTarget;
  if (!target || target.kind !== "remote") {
    throw new Error("remote provider-pack probe requires a remote target");
  }
  const source = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH?.trim();
  const sandboxRunner = target.transport === "sandbox"
    ? target.runner
    : undefined;
  const preinstalled = "/opt/paperclip-runner/provider-pack";
  if (source) {
    await access(source);
    const expectedManifestSha = createHash("sha256")
      .update(await readFile(join(source, "provider-pack.json")))
      .digest("hex");
    const preinstalledManifest = await runAdapterExecutionTargetProcess(
      `provider-pack-manifest-environment-${randomUUID()}`,
      target,
      "sh",
      [
        "-c",
        `test -f ${preinstalled}/provider-pack.json && sha256sum ${preinstalled}/provider-pack.json`,
      ],
      {
        cwd: target.remoteCwd,
        env: {},
        timeoutSec: 30,
        graceSec: 2,
        onLog: async () => undefined,
      },
    );
    if (
      preinstalledManifest.exitCode === 0
      && !preinstalledManifest.timedOut
      && preinstalledManifest.stdout.trim().split(/\s+/, 1)[0]
        === expectedManifestSha
    ) {
      return preinstalled;
    }
    if (!sandboxRunner?.syncIn) {
      throw new Error(
        "runner_remote_provider_artifact_incompatible: the preinstalled provider-pack manifest does not match and this target cannot stage the configured pack",
      );
    }
    const destination = posix.join(
      target.remoteCwd,
      ".paperclip-runtime",
      "environment-probes",
      "provider-pack",
    );
    await sandboxRunner.syncIn([{
      operationId: `provider-pack-probe-${randomUUID()}`,
      files: [{
        sourcePath: source,
        targetPath: destination,
        kind: "directory",
        mode: 0o700,
      }],
    }]);
    return destination;
  }
  return preinstalled;
}

async function testPaperclipRunnerOpenCodeEnvironment(
  context: Parameters<typeof openCodeTestEnvironment>[0],
) {
  if (context.executionTarget?.kind === "remote") {
    const testedAt = new Date().toISOString();
    try {
      const packRoot = await remoteProviderPackRoot(context);
      const command = posix.join(packRoot, "node_modules", ".bin", "opencode");
      const providerNode = posix.join(
        packRoot,
        "node_modules",
        "node",
        "bin",
        "node",
      );
      const runtimeDirectory = posix.join(
        context.executionTarget.remoteCwd,
        ".paperclip-runtime",
        "environment-probes",
        "opencode",
      );
      const environment = {
        ...configuredProbeEnvironment(context.config),
        HOME: context.executionTarget.remoteCwd,
        PAPERCLIP_OPENCODE_COMMAND: command,
        PAPERCLIP_OPENCODE_MODEL:
          typeof context.config.model === "string" ? context.config.model : "",
        PAPERCLIP_OPENCODE_RUNTIME_DIR: runtimeDirectory,
        PAPERCLIP_RUNNER_INSTANCE_ID: "environment-probe",
        PAPERCLIP_RUN_ID: `environment-probe-${randomUUID()}`,
        PAPERCLIP_NORMALIZED_SESSION_ID: `environment-probe-${randomUUID()}`,
        XDG_CONFIG_HOME: posix.join(runtimeDirectory, "config"),
        XDG_CACHE_HOME: posix.join(runtimeDirectory, "cache"),
        XDG_DATA_HOME: posix.join(runtimeDirectory, "data"),
      };
      const version = await runAdapterExecutionTargetProcess(
        `opencode-environment-${randomUUID()}`,
        context.executionTarget,
        command,
        ["--version"],
        {
          cwd: context.executionTarget.remoteCwd,
          env: configuredProbeEnvironment(context.config),
          timeoutSec: 30,
          graceSec: 2,
          onLog: async () => undefined,
        },
      );
      const rpcInput = [
        JSON.stringify({ id: 1, method: "initialize", params: {} }),
        JSON.stringify({
          id: 2,
          method: "thread/start",
          params: {
            cwd: context.executionTarget.remoteCwd,
            model: context.config.model,
            baseInstructions: "Environment readiness probe. Do not start a turn.",
            dynamicTools: [],
          },
        }),
      ].join("\n") + "\n";
      const proxy = await runAdapterExecutionTargetProcess(
        `opencode-proxy-environment-${randomUUID()}`,
        context.executionTarget,
        providerNode,
        [posix.join(packRoot, "dist", "cli", "opencode-app-server-proxy.js")],
        {
          cwd: context.executionTarget.remoteCwd,
          env: environment,
          stdin: rpcInput,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => undefined,
        },
      );
      const frames = proxy.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line: string) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
      const initialized = frames.find((frame) => frame.id === 1);
      const opened = frames.find((frame) => frame.id === 2);
      const serverInfo = initialized?.result && typeof initialized.result === "object"
        ? (initialized.result as Record<string, unknown>).serverInfo as Record<string, unknown> | undefined
        : undefined;
      const thread = opened?.result && typeof opened.result === "object"
        ? ((opened.result as Record<string, unknown>).thread as Record<string, unknown> | undefined)
        : undefined;
      const proxyReady = proxy.exitCode === 0
        && !proxy.timedOut
        && serverInfo?.version === "1.18.17"
        && typeof thread?.id === "string"
        && thread.id.length > 0;
      const exact = version.exitCode === 0
        && !version.timedOut
        && version.stdout.trim() === "1.18.17";
      const versionCheck = exact
        ? {
            code: "opencode_version_qualified_remote",
            level: "info" as const,
            message: "OpenCode 1.18.17 and its hello probe succeeded inside the selected execution target.",
          }
        : {
            code: "opencode_version_incompatible_remote",
            level: "error" as const,
            message: `The selected execution target did not expose exact OpenCode 1.18.17 (received ${version.stdout.trim() || "no version"}).`,
          };
      const proxyCheck = proxyReady
        ? {
            code: "opencode_proxy_qualified_remote",
            level: "info" as const,
            message: "The packaged proxy launched OpenCode server, passed /global/health at exact version 1.18.17, and created a provider session inside the selected execution target.",
          }
        : {
            code: "opencode_proxy_failed_remote",
            level: "error" as const,
            message: `The packaged OpenCode proxy failed its initialize/session probe inside the selected execution target (${redactedProbeTail(proxy.stderr, environment) || "incomplete response"}).`,
          };
      return {
        adapterType: "paperclip_runner",
        testedAt,
        status: versionCheck.level === "error" || proxyCheck.level === "error"
          ? "fail" as const
          : "pass" as const,
        checks: [versionCheck, proxyCheck],
      };
    } catch (error) {
      return {
        adapterType: "paperclip_runner",
        status: "fail" as const,
        testedAt,
        checks: [{
          code: "opencode_remote_probe_failed",
          level: "error" as const,
          message: redactedProbeTail(error) || "Remote OpenCode probe failed.",
        }],
      };
    }
  }
  const result = await openCodeTestEnvironment(context);
  const command = readConfiguredCommand(context.config, "opencode");
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], {
      timeout: 5_000,
      env: process.env,
    });
    const output = `${stdout}\n${stderr}`;
    const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!match) throw new Error("OpenCode returned an unrecognized version string");
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const comparison = compareSemver(version, "1.18.17");
    const check = comparison < 0
      ? { code: "opencode_version_too_old", level: "error" as const, message: `OpenCode ${version} is older than required 1.18.17.` }
      : comparison > 0
        ? { code: "opencode_version_unqualified", level: "warn" as const, message: `OpenCode ${version} is newer than qualified version 1.18.17.` }
        : { code: "opencode_version_qualified", level: "info" as const, message: "OpenCode 1.18.17 is installed and qualified." };
    return {
      ...result,
      status: check.level === "error" ? "fail" as const
        : check.level === "warn" && result.status === "pass" ? "warn" as const
          : result.status,
      checks: [...result.checks, check],
    };
  } catch (error) {
    return {
      ...result,
      status: "fail" as const,
      checks: [...result.checks, {
        code: "opencode_version_probe_failed",
        level: "error" as const,
        message: error instanceof Error ? error.message : "OpenCode version probe failed.",
      }],
    };
  }
}

async function testPaperclipRunnerCodexEnvironment(
  context: Parameters<typeof codexTestEnvironment>[0],
) {
  if (context.executionTarget?.kind !== "remote") {
    return codexTestEnvironment(context);
  }
  const target = context.executionTarget;
  const testedAt = new Date().toISOString();
  const environment = {
    ...configuredProbeEnvironment(context.config),
    HOME: target.remoteCwd,
  };
  try {
    const version = await runAdapterExecutionTargetProcess(
      `codex-version-environment-${randomUUID()}`,
      target,
      "codex",
      ["--version"],
      {
        cwd: target.remoteCwd,
        env: environment,
        timeoutSec: 30,
        graceSec: 2,
        onLog: async () => undefined,
      },
    );
    const versionText = `${version.stdout}\n${version.stderr}`;
    const exactVersion = versionText.match(/\bcodex-cli\s+(\d+\.\d+\.\d+)\b/)?.[1];
    const initializeInput = [
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "paperclip-runner-environment-probe",
            title: "Paperclip Runner environment probe",
            version: "1",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
      }),
      JSON.stringify({ method: "initialized" }),
    ].join("\n") + "\n";
    const initializedProcess = await runAdapterExecutionTargetProcess(
      `codex-app-server-environment-${randomUUID()}`,
      target,
      "codex",
      ["app-server"],
      {
        cwd: target.remoteCwd,
        env: environment,
        stdin: initializeInput,
        timeoutSec: 30,
        graceSec: 5,
        onLog: async () => undefined,
      },
    );
    const initialized = initializedProcess.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line: string) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .find((frame) => frame.id === 1);
    const versionReady = version.exitCode === 0
      && !version.timedOut
      && exactVersion === "0.148.0";
    const initializeReady = initializedProcess.exitCode === 0
      && !initializedProcess.timedOut
      && initialized?.result !== undefined
      && initialized.error === undefined;
    return {
      adapterType: "paperclip_runner",
      status: versionReady && initializeReady ? "pass" as const : "fail" as const,
      testedAt,
      checks: [{
        code: versionReady
          ? "codex_version_qualified_remote"
          : "codex_version_incompatible_remote",
        level: versionReady ? "info" as const : "error" as const,
        message: versionReady
          ? "Codex 0.148.0 is installed inside the selected execution target."
          : `The selected execution target did not expose exact Codex 0.148.0 (received ${exactVersion ?? "an unrecognized version"}).`,
      }, {
        code: initializeReady
          ? "codex_app_server_initialized_remote"
          : "codex_app_server_initialize_failed_remote",
        level: initializeReady ? "info" as const : "error" as const,
        message: initializeReady
          ? "Codex app-server completed JSON-RPC initialize inside the selected execution target."
          : `Codex app-server did not complete JSON-RPC initialize inside the selected execution target (${redactedProbeTail(initializedProcess.stderr, environment) || "incomplete response"}).`,
      }],
    };
  } catch (error) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{
        code: "codex_remote_initialize_probe_failed",
        level: "error" as const,
        message: redactedProbeTail(error, environment) || "Remote Codex initialize probe failed.",
      }],
    };
  }
}

async function testPaperclipRunnerAcpxEnvironment(
  context: Parameters<typeof codexTestEnvironment>[0],
) {
  const testedAt = new Date().toISOString();
  const agent = context.config.acpxAgent;
  const model = typeof context.config.model === "string" ? context.config.model.trim() : "";
  if (agent !== "pi" && agent !== "claude" && agent !== "codex") {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_agent_invalid", level: "error" as const, message: "ACPX agent must be Pi, Claude, or Codex." }],
    };
  }
  let profile;
  try {
    profile = resolveQualifiedAcpxProfile(agent, model);
  } catch (error) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_model_unqualified", level: "error" as const, message: error instanceof Error ? error.message : "ACPX model is not qualified." }],
    };
  }
  if (context.executionTarget?.kind === "remote") {
    const target = context.executionTarget;
    try {
      const packRoot = await remoteProviderPackRoot(context);
      const providerNode = posix.join(
        packRoot,
        "node_modules",
        "node",
        "bin",
        "node",
      );
      const runtimeDirectory = posix.join(
        target.remoteCwd,
        ".paperclip-runtime",
        "environment-probes",
        `acpx-${agent}`,
      );
      const configuredEnvironment = configuredProbeEnvironment(context.config);
      const environment = {
        ...configuredEnvironment,
        ...(agent === "codex"
          ? resolveAcpxCodexManagedCredentialEnvironment(configuredEnvironment)
          : {}),
        HOME: target.remoteCwd,
        XDG_CONFIG_HOME: posix.join(runtimeDirectory, "config"),
        XDG_CACHE_HOME: posix.join(runtimeDirectory, "cache"),
        XDG_DATA_HOME: posix.join(runtimeDirectory, "data"),
      };
      const nodeVersion = await runAdapterExecutionTargetProcess(
        `acpx-node-environment-${randomUUID()}`,
        target,
        providerNode,
        ["-p", "process.versions.node"],
        {
          cwd: target.remoteCwd,
          env: environment,
          timeoutSec: 30,
          graceSec: 2,
          onLog: async () => undefined,
        },
      );
      const [nodeMajor = 0, nodeMinor = 0] = nodeVersion.stdout
        .trim()
        .split(".")
        .map(Number);
      if (
        nodeVersion.exitCode !== 0
        || nodeVersion.timedOut
        || nodeMajor < 24
        || (nodeMajor === 24 && nodeMinor < 11)
      ) {
        throw new Error(
          `ACPX provider pack requires Node 24.11 or newer inside the execution target; found ${nodeVersion.stdout.trim() || "no version"}.`,
        );
      }
      const request = (id: number, command: string, params: Record<string, unknown>) =>
        JSON.stringify({ protocolVersion: 2, id, command, params });
      const probeInput = [
        request(1, "initialize", { agent, model }),
        request(2, "session.open", {
          runtimeDirectory,
          normalizedSessionId: `environment-probe-${agent}`,
          workingDirectory: target.remoteCwd,
          agent,
          model,
          permissionMode: "deny-all",
          permissionModePinned: true,
          systemInstructions: "Environment readiness probe. Do not start a turn.",
          tools: [],
        }),
        request(3, "session.suspend", {
          reason: "environment probe complete",
        }),
      ].join("\n") + "\n";
      const probe = await runAdapterExecutionTargetProcess(
        `acpx-environment-${randomUUID()}`,
        target,
        providerNode,
        [posix.join(packRoot, "dist", "cli", "acpx-runtime-sidecar.js")],
        {
          cwd: target.remoteCwd,
          env: environment,
          stdin: probeInput,
          timeoutSec: 90,
          graceSec: 5,
          onLog: async () => undefined,
        },
      );
      const frames = probe.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line: string) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
      const initialized = frames.find((frame: Record<string, unknown>) => frame.id === 1);
      const opened = frames.find((frame: Record<string, unknown>) => frame.id === 2);
      const suspended = frames.find((frame: Record<string, unknown>) => frame.id === 3);
      const identity = opened?.result && typeof opened.result === "object"
        ? (opened.result as Record<string, unknown>).identity as Record<string, unknown> | undefined
        : undefined;
      const failures: string[] = [];
      if (probe.exitCode !== 0) failures.push(`process_exit=${probe.exitCode}`);
      if (probe.timedOut) failures.push("process_timeout");
      const responseFailure = (
        label: string,
        frame: Record<string, unknown> | undefined,
      ) => {
        if (frame?.ok === true) return;
        const error = frame?.error && typeof frame.error === "object"
          ? frame.error as Record<string, unknown>
          : {};
        const code = typeof error.code === "string" ? error.code : "missing_response";
        const message = redactedProbeTail(error.message, environment);
        failures.push(`${label}=${code}${message ? `:${message}` : ""}`);
      };
      responseFailure("initialize", initialized);
      responseFailure("session.open", opened);
      responseFailure("session.suspend", suspended);
      if (!identity) {
        failures.push("identity_missing");
      } else {
        const verifiedIdentity = identity;
        if (verifiedIdentity.requestedModel !== model) {
          failures.push(
            `requested_model_mismatch(expected=${model},received=${String(verifiedIdentity.requestedModel ?? "missing")})`,
          );
        }
        if (verifiedIdentity.effectiveModel !== profile.qualificationModel) {
          failures.push(
            `effective_model_mismatch(expected=${profile.qualificationModel},received=${String(verifiedIdentity.effectiveModel ?? "missing")})`,
          );
        }
        if (verifiedIdentity.profile === undefined) failures.push("profile_missing");
        const missingIdentityKeys = ["acpxRecordId", "backendSessionId", "agentSessionId"].filter(
          (key) => {
            const value = verifiedIdentity[key];
            return typeof value !== "string" || value.length === 0;
          },
        );
        if (missingIdentityKeys.length > 0) {
          failures.push(`persistent_identity_missing=${missingIdentityKeys.join(",")}`);
        }
      }
      if (failures.length > 0) {
        const stderr = redactedProbeTail(probe.stderr, environment);
        throw new Error(
          `ACPX ${agent} failed initialize/session.open/suspend inside the selected execution target: ${failures.join("; ")}${stderr ? `; stderr=${stderr}` : ""}`,
        );
      }
      return {
        adapterType: "paperclip_runner",
        status: "pass" as const,
        testedAt,
        checks: [{
          code: "acpx_profile_qualified_remote",
          level: "info" as const,
          message: `Verified ACPX ${profile.acpxVersion}, ${profile.agentServerPackage}@${profile.agentServerVersion}, Node ${nodeVersion.stdout.trim()}, exact model ${String(identity?.effectiveModel ?? "unverified")}, all persistent identities, and clean suspension inside the selected execution target.`,
        }],
      };
    } catch (error) {
      return {
        adapterType: "paperclip_runner",
        status: "fail" as const,
        testedAt,
        checks: [{
          code: "acpx_remote_handshake_failed",
          level: "error" as const,
          message: redactedProbeTail(error) || "Remote ACPX handshake failed.",
        }],
      };
    }
  }
  const nodeParts = process.versions.node.split(".").map(Number);
  if ((nodeParts[0] ?? 0) < 24 || ((nodeParts[0] ?? 0) === 24 && (nodeParts[1] ?? 0) < 11)) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_node_too_old", level: "error" as const, message: `The provider pack requires Node 24.11 or newer; found ${process.versions.node}.` }],
    };
  }
  const configuredEnv = context.config.env && typeof context.config.env === "object"
    ? context.config.env as Record<string, unknown>
    : {};
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(configuredEnv)) if (typeof value === "string") environment[key] = value;
  const managedClaudeAuth = agent === "claude" && !environment.ANTHROPIC_API_KEY && !environment.CLAUDE_CODE_OAUTH_TOKEN
    ? await readClaudeAuthStatus()
    : null;
  const managedCodexAuth = agent === "codex" && !environment.OPENAI_API_KEY && !environment.CODEX_API_KEY
    ? await readCodexAuthInfo()
    : null;
  const credentialReady = agent === "pi"
    ? Boolean(environment.OPENROUTER_API_KEY)
    : agent === "claude"
      ? Boolean(environment.ANTHROPIC_API_KEY || environment.CLAUDE_CODE_OAUTH_TOKEN || managedClaudeAuth?.loggedIn)
      : Boolean(environment.OPENAI_API_KEY || environment.CODEX_API_KEY || managedCodexAuth);
  if (!credentialReady) {
    const required = agent === "pi"
      ? "OPENROUTER_API_KEY"
      : agent === "claude"
        ? "ANTHROPIC_API_KEY or the managed Claude credential"
        : "the managed Codex credential or OPENAI_API_KEY";
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_auth_missing", level: "error" as const, message: `ACPX ${agent} requires ${required}.` }],
    };
  }
  let probeRoot: string | null = null;
  try {
    const installation = await inspectQualifiedAcpxInstallation(agent as QualifiedAcpxAgent, model);
    probeRoot = await mkdtemp(join(tmpdir(), "paperclip-acpx-probe-"));
    const host = await AcpxRuntimeHost.open({
      runtimeDirectory: probeRoot,
      normalizedSessionId: "environment-probe",
      workingDirectory: probeRoot,
      agent: agent as QualifiedAcpxAgent,
      model,
      environment,
      dynamicTools: [],
      dynamicToolHandler: async () => { throw new Error("environment probe exposes no semantic tools"); },
    });
    const identity = host.identity();
    await host.close({ reason: "environment probe complete", discardPersistentState: true });
    return {
      adapterType: "paperclip_runner",
      status: "pass" as const,
      testedAt,
      checks: [{
        code: "acpx_profile_qualified",
        level: "info" as const,
        message: `Verified ACPX ${profile.acpxVersion}, ${profile.agentServerPackage}@${profile.agentServerVersion}, exact model ${identity.effectiveModel}, semantic bridge startup, and clean shutdown (digest ${installation.commandDigest}).`,
      }, {
        code: "acpx_auth_ready",
        level: "info" as const,
        message: `Credential readiness was verified for ACPX ${agent}; no credential value was retained.`,
      }],
    };
  } catch (error) {
    return {
      adapterType: "paperclip_runner",
      status: "fail" as const,
      testedAt,
      checks: [{ code: "acpx_handshake_failed", level: "error" as const, message: error instanceof Error ? error.message : "ACPX handshake failed." }],
    };
  } finally {
    if (probeRoot) await rm(probeRoot, { recursive: true, force: true });
  }
}

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function readConfiguredCommand(config: Record<string, unknown>, fallback: string): string {
  const value = typeof config.command === "string" ? config.command.trim() : "";
  return value.length > 0 ? value : fallback;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildNpmRuntimeCommandSpec(
  config: Record<string, unknown>,
  fallbackCommand: string,
  packageName: string,
): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, fallbackCommand);
  const canSelfInstall = !hasPathSeparator(command) && command === fallbackCommand;
  const installLine = buildSandboxNpmInstallCommand(packageName);
  return {
    command,
    detectCommand: command,
    installCommand: canSelfInstall
      ? `if ! command -v ${shellQuote(command)} >/dev/null 2>&1; then ${installLine}; fi`
      : null,
  };
}

function buildCursorRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, "agent");
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}

const retiredAcpxMessage =
  "The acpx_local adapter has been retired. Existing Claude and Codex ACPX agents should be migrated to claude_local or codex_local with adapterConfig.engine=\"acp\".";

const retiredAcpxAgentConfigurationDoc = `# acpx_local retired

Adapter: acpx_local

The standalone ACPX adapter has been retired. Use:

- claude_local with adapterConfig.engine="acp" for Claude ACP execution.
- codex_local with adapterConfig.engine="acp" for Codex ACP execution.

Paperclip keeps this tombstone registered so stale acpx_local rows fail clearly instead of falling back to the process adapter.
`;

// The Claude interactive login capability. Claude runs `claude setup-token` on a
// real pseudo-terminal. The user pastes a browser code back into the flow. The
// flow uses a fixed host-side timeout and records a stored session identifier on
// success. The capability data holds no secret; the callbacks return runtime
// values only.
const claudeLoginCapability: AdapterLoginCapability = {
  panelMode: "submitted_browser_code",
  timeoutPolicy: "fixed",
  getCommand: () => CLAUDE_SETUP_TOKEN_COMMAND,
  parsePrompt: (output) => {
    const prompt = parseSetupTokenPrompt(output);
    return prompt ? { url: prompt.url } : null;
  },
  captureCredential: (output) => {
    const token = parseSetupTokenCredential(output);
    return token === null ? null : Buffer.from(token, "utf8");
  },
  completionClaim: "storedSessionId",
};

// The Codex interactive login capability. Codex runs `codex login --device-auth`
// on a real pseudo-terminal, because a pipe emits no login prompt. The flow shows
// a one-time code that the user enters in the browser. The caller sets the
// host-side timeout. The device-login flow writes its credential inside the
// sandbox, so the capability declares no terminal credential capture and no
// completion claim.
const codexLoginCapability: AdapterLoginCapability = {
  panelMode: "displayed_code",
  timeoutPolicy: "caller_bounded",
  getCommand: () => CODEX_DEVICE_LOGIN_COMMAND,
  parsePrompt: (output) => {
    const prompt = parseDeviceLoginPrompt(output);
    return prompt ? { url: prompt.url, code: prompt.code } : null;
  },
};

// The Grok interactive login capability. Grok runs `grok login --device-auth`
// on a real pseudo-terminal, the same way Codex does. The flow shows a
// one-time code that the user enters in the browser. The caller sets the
// host-side timeout. The device-login flow writes its credential inside the
// sandbox, so the capability declares no terminal credential capture and no
// completion claim. `getCommand` is descriptive only: the login path selects
// the real command from the closed key map in `login-command.ts`, never from
// this member.
const grokLoginCapability: AdapterLoginCapability = {
  panelMode: "displayed_code",
  timeoutPolicy: "caller_bounded",
  getCommand: () => GROK_DEVICE_LOGIN_COMMAND,
  parsePrompt: (output) => {
    const prompt = parseGrokDeviceLoginPrompt(output);
    return prompt ? { url: prompt.url, code: prompt.code } : null;
  },
};

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  runtimeToolDelivery: "native_mcp",
  execute: stampClaudeAgentIdHeader(claudeExecute),
  testEnvironment: claudeTestEnvironment,
  acp: {
    agentId: "claude",
    skillsMode: "ephemeral",
    prerequisites: {
      nodeRange: ">=24.11.0",
      packages: ["@agentclientprotocol/claude-agent-acp"],
    },
  },
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  modelProfiles: claudeModelProfiles,
  listModels: listClaudeModels,
  refreshModels: refreshClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "claude", "@anthropic-ai/claude-code"),
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getConfigSchema: getClaudeConfigSchema,
  getQuotaWindows: claudeGetQuotaWindows,
  loginCapability: claudeLoginCapability,
};

const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  runtimeToolDelivery: "environment",
  async execute(ctx) {
    await ctx.onLog("stderr", `${retiredAcpxMessage}\n`);
    await ctx.onMeta?.({
      adapterType: "acpx_local",
      command: "acpx_local-retired",
      commandNotes: [retiredAcpxMessage],
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: retiredAcpxMessage,
      errorCode: "acpx_local_retired",
      provider: "acpx",
      summary: retiredAcpxMessage,
    };
  },
  async testEnvironment() {
    return {
      adapterType: "acpx_local",
      status: "fail",
      testedAt: new Date().toISOString(),
      checks: [
        {
          code: "acpx_local_retired",
          level: "error",
          message: retiredAcpxMessage,
          hint: "Set the agent adapter to claude_local or codex_local and set adapterConfig.engine to acp.",
        },
      ],
    };
  },
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: retiredAcpxAgentConfigurationDoc,
  getConfigSchema: () => ({ fields: [] }),
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  runtimeToolDelivery: "native_mcp",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  acp: {
    agentId: "codex",
    skillsMode: "ephemeral",
    prerequisites: {
      nodeRange: ">=24.11.0",
      packages: ["@agentclientprotocol/codex-acp"],
    },
  },
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  modelProfiles: codexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "codex", "@openai/codex"),
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getConfigSchema: getCodexConfigSchema,
  getQuotaWindows: codexGetQuotaWindows,
  loginCapability: codexLoginCapability,
};

const paperclipRunnerAdapter: ServerAdapterModule = {
  type: "paperclip_runner",
  runtimeToolDelivery: "environment",
  async execute(ctx) {
    const message = "paperclip_runner must be executed by the native runner coordinator";
    await ctx.onLog("stderr", `${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "paperclip_runner_coordinator_required",
      provider: ctx.config.provider === "acpx"
        ? "acpx"
        : ctx.config.provider === "opencode"
          ? "opencode"
          : "codex",
      summary: message,
    };
  },
  async testEnvironment(context) {
    const provider = context.config.provider === "opencode"
      ? "opencode"
      : context.config.provider === "acpx"
        ? "acpx"
        : "codex";
    const permissionCapability = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
    const configuredMode = context.config[permissionCapability.configKey];
    if (
      configuredMode !== undefined
      && resolvePaperclipRunnerPermissionMode(provider as PaperclipRunnerProvider, configuredMode) !== configuredMode
    ) {
      return {
        adapterType: "paperclip_runner",
        status: "fail" as const,
        testedAt: new Date().toISOString(),
        checks: [{
          code: "runner_permission_mode_invalid",
          level: "error" as const,
          message: `${permissionCapability.configKey} is not supported by ${provider}.`,
        }],
      };
    }
    const result = provider === "opencode"
      ? await testPaperclipRunnerOpenCodeEnvironment(context)
      : provider === "acpx"
      ? await testPaperclipRunnerAcpxEnvironment(context)
      : await testPaperclipRunnerCodexEnvironment(context);
    return { ...result, adapterType: "paperclip_runner" };
  },
  async listSkills(context) {
    const availableEntries = await readPaperclipRuntimeSkillEntries(context.config, import.meta.dirname);
    return buildRuntimeMountedSkillSnapshot({
      adapterType: "paperclip_runner",
      availableEntries,
      desiredSkills: resolvePaperclipDesiredSkillNames(context.config, availableEntries),
      configuredDetail: "Will be copied into the immutable Paperclip Runner context on the next run.",
    });
  },
  async syncSkills(context) {
    const availableEntries = await readPaperclipRuntimeSkillEntries(context.config, import.meta.dirname);
    return buildRuntimeMountedSkillSnapshot({
      adapterType: "paperclip_runner",
      availableEntries,
      desiredSkills: resolvePaperclipDesiredSkillNames(context.config, availableEntries),
      configuredDetail: "Will be copied into the immutable Paperclip Runner context on the next run.",
    });
  },
  sessionCodec: codexSessionCodec,
  models: [
    ...codexModels,
    { id: "openrouter/deepseek/deepseek-v4-flash-0731", label: "OpenRouter · DeepSeek V4 Flash 0731" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5 (ACPX)" },
  ],
  modelProfiles: codexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) => config.provider === "acpx"
    ? { command: "paperclip-runnerd", detectCommand: null, installCommand: null }
    : config.provider === "opencode"
    ? buildNpmRuntimeCommandSpec(config, "opencode", "opencode-ai@1.18.17")
    : buildNpmRuntimeCommandSpec(config, "codex", "@openai/codex@0.148.0"),
  agentConfigurationDoc: `# Paperclip Runner\n\nAdapter: paperclip_runner\n\nRuns native Codex, OpenCode, or a qualified Pi/Claude/Codex ACP agent through ACPX 0.13.1 and authenticated PRP. Provider processes never receive a Paperclip credential or unrestricted server environment.\n\nFresh executions default to the highest non-interactive harness mode: Codex \`codexPermissionMode=never\`, OpenCode \`opencodePermissionMode=allow\`, and ACPX \`acpxPermissionMode=approve-all\`. Lower modes remain configurable per provider. Full auto suppresses harness approval pauses but does not widen Paperclip workspace, network, credential, protected-path, or read-only planning boundaries.\n`,
  getConfigSchema: () => ({
    fields: [{
      key: "provider",
      label: "Provider",
      type: "select",
      default: "codex",
      options: [
        { value: "codex", label: "Codex" },
        { value: "opencode", label: "OpenCode 1.18.17" },
        { value: "acpx", label: "ACPX" },
      ],
      hint: "Select a local Codex/OpenCode harness or a qualified ACPX agent.",
    }, {
      key: "acpxAgent",
      label: "ACP agent",
      type: "select",
      default: "pi",
      options: [
        { value: "pi", label: "Pi via ACPX" },
        { value: "claude", label: "Claude via ACPX" },
        { value: "codex", label: "Codex via ACPX (control)" },
      ],
      hint: "Qualified ACP server profile. Configuration is immutable after session creation.",
      meta: { provider: "acpx" },
    }, {
      key: "codexPermissionMode",
      label: "Permission mode",
      type: "select",
      default: PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.codex.defaultMode,
      options: PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.codex.options.map(({ value, label }) => ({ value, label })),
      hint: `${PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.codex.description} Full auto retains Paperclip isolation.`,
      meta: { visibleWhen: { key: "provider", value: "codex" } },
    }, {
      key: "opencodePermissionMode",
      label: "Permission mode",
      type: "select",
      default: PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.opencode.defaultMode,
      options: PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.opencode.options.map(({ value, label }) => ({ value, label })),
      hint: `${PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.opencode.description} Full auto retains Paperclip isolation.`,
      meta: { visibleWhen: { key: "provider", value: "opencode" } },
    }, {
      key: "acpxPermissionMode",
      label: "Permission mode",
      type: "select",
      default: PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.acpx.defaultMode,
      options: PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.acpx.options.map(({ value, label }) => ({ value, label })),
      hint: `${PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES.acpx.description} Full auto retains Paperclip isolation.`,
      meta: { visibleWhen: { key: "provider", value: "acpx" } },
    }, {
      key: "lifecycleMode",
      label: "Runner lifecycle",
      type: "select",
      default: "per_turn",
      options: [
        { value: "per_turn", label: "Turn by turn" },
        { value: "warm", label: "Warm session" },
      ],
      hint: "Warm sessions retain runnerd and the provider between separately governed runs.",
    }, {
      key: "idleTimeoutMs",
      label: "Warm idle timeout (ms)",
      type: "number",
      default: 300000,
      hint: "Warm sessions suspend resumably after this much inactivity.",
    }, {
      key: "model",
      label: "Model",
      type: "text",
      default: "openrouter/deepseek/deepseek-v4-flash-0731",
      placeholder: "openrouter/deepseek/deepseek-v4-flash-0731",
      hint: "OpenCode uses provider/model form; ACPX requires its qualified exact model.",
    }, {
      key: "command",
      label: "OpenCode command",
      type: "text",
      default: "opencode",
      hint: "OpenCode executable. Version 1.18.17 is qualified.",
    }],
  }),
  loginCapability: codexLoginCapability,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  runtimeToolDelivery: "environment",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  modelProfiles: cursorModelProfiles,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: buildCursorRuntimeCommandSpec,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const cursorCloudAdapter: ServerAdapterModule = {
  type: "cursor_cloud",
  runtimeToolDelivery: "invocation_context",
  execute: cursorCloudExecute,
  testEnvironment: cursorCloudTestEnvironment,
  sessionCodec: cursorCloudSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor_cloud") ?? undefined,
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: cursorCloudAgentConfigurationDoc,
  getConfigSchema: getCursorCloudConfigSchema,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  runtimeToolDelivery: "environment",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  acp: {
    agentId: "gemini",
    skillsMode: "ephemeral",
    prerequisites: {
      nodeRange: ">=24.11.0",
      packages: ["@google/gemini-cli"],
    },
  },
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  modelProfiles: geminiModelProfiles,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "gemini", "@google/gemini-cli"),
  agentConfigurationDoc: geminiAgentConfigurationDoc,
  getConfigSchema: getGeminiConfigSchema,
};

const grokLocalAdapter: ServerAdapterModule = {
  type: "grok_local",
  runtimeToolDelivery: "environment",
  execute: grokExecute,
  testEnvironment: grokTestEnvironment,
  listSkills: listGrokSkills,
  syncSkills: syncGrokSkills,
  sessionCodec: grokSessionCodec,
  sessionManagement: getAdapterSessionManagement("grok_local") ?? undefined,
  models: grokModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => ({
    command: readConfiguredCommand(config, "grok"),
    detectCommand: readConfiguredCommand(config, "grok"),
    installCommand: null,
  }),
  agentConfigurationDoc: grokAgentConfigurationDoc,
  loginCapability: grokLoginCapability,
};

const kimiLocalAdapter: ServerAdapterModule = {
  type: "kimi_local",
  runtimeToolDelivery: "environment",
  execute: kimiExecute,
  testEnvironment: kimiTestEnvironment,
  acp: {
    agentId: "kimi",
    skillsMode: "ephemeral",
    prerequisites: {
      nodeRange: ">=20.0.0",
      packages: ["@moonshot-ai/kimi-code"],
    },
  },
  listSkills: listKimiSkills,
  syncSkills: syncKimiSkills,
  sessionCodec: kimiSessionCodec,
  sessionManagement: getAdapterSessionManagement("kimi_local") ?? undefined,
  models: kimiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "kimi", "@moonshot-ai/kimi-code"),
  agentConfigurationDoc: kimiAgentConfigurationDoc,
};

const hermesGatewayAdapter: ServerAdapterModule = {
  ...createHermesGatewayServerAdapter(),
  runtimeToolDelivery: "invocation_context",
};

const hermesLocalAdapter: ServerAdapterModule = {
  ...createHermesLocalServerAdapter(),
  runtimeToolDelivery: "environment",
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  runtimeToolDelivery: "invocation_context",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  runtimeToolDelivery: "environment",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  modelProfiles: openCodeModelProfiles,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "opencode", "opencode-ai"),
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  runtimeToolDelivery: "environment",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  modelProfiles: piModelProfiles,
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "pi", "@mariozechner/pi-coding-agent"),
  agentConfigurationDoc: piAgentConfigurationDoc,
};

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

function registerBuiltInAdapters() {
  for (const adapter of [
    acpxLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    paperclipRunnerAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorCloudAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    grokLocalAdapter,
    kimiLocalAdapter,
    hermesGatewayAdapter,
    hermesLocalAdapter,
    openclawGatewayAdapter,
    processAdapter,
    httpAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}

registerBuiltInAdapters();

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
//
// External adapter packages export createServerAdapter() which returns a
// ServerAdapterModule. When the module provides its own sessionManagement
// it is preserved; otherwise the host falls back to the built-in registry
// lookup (so externals that override a built-in type inherit the builtin's
// policy). This brings init-time registration to at-least-as-good behavior
// as the hot-install path (routes/adapters.ts:179 -> registerServerAdapter):
// both preserve module-provided sessionManagement, and init-time additionally
// applies the registry fallback for externals overriding a built-in type.
// ---------------------------------------------------------------------------

/** Cached sync wrapper — the store is a simple JSON file read, safe to call frequently. */
function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

/**
 * Merge an external adapter module with host-provided session management.
 *
 * Module-provided `sessionManagement` takes precedence. When absent, fall
 * back to the hardcoded registry keyed by adapter type (so externals that
 * override a built-in — same `type` — inherit the builtin's policy). If
 * neither is available, `sessionManagement` remains `undefined`.
 *
 * Used by both the init-time IIFE below (external-adapter load pass on
 * server start) and the hot-install path in `routes/adapters.ts`
 * (`registerWithSessionManagement`), so the two load paths resolve
 * `sessionManagement` identically.
 */
export function resolveExternalAdapterRegistration(
  externalAdapter: ServerAdapterModule,
): ServerAdapterModule {
  return {
    ...externalAdapter,
    sessionManagement:
      externalAdapter.sessionManagement
        ?? getAdapterSessionManagement(externalAdapter.type)
        ?? undefined,
  };
}

/**
 * Load external adapters from the plugin store and hardcoded sources.
 * Called once at module initialization. The promise is exported so that
 * callers (e.g. assertKnownAdapterType, app startup) can await completion
 * and avoid racing against the loading window.
 */
const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
        resolveExternalAdapterRegistration(externalAdapter),
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

/**
 * Await this before validating adapter types to avoid race conditions
 * during server startup. External adapters are loaded asynchronously;
 * calling assertKnownAdapterType before this resolves will reject
 * valid external adapter types.
 */
export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return findActiveServerAdapter(type) ?? processAdapter;
}

/**
 * Memoized view of PAPERCLIP_ADAPTER_MODELS, keyed by the raw env string so
 * tests (and live env mutation) that change the variable are still observed.
 * Parsing happens at most once per distinct raw value instead of per
 * `listAdapterModels` request, and malformed values fail SOFT here: we log the
 * parse error once (per distinct raw value) and fall back to adapter-discovered
 * models rather than throwing at request time.
 */
let adapterModelsEnvCache: {
  raw: string | undefined;
  value: ReturnType<typeof parseAdapterModelsEnv>;
} | null = null;

function getDeclaredAdapterModels(): ReturnType<typeof parseAdapterModelsEnv> {
  const raw = process.env.PAPERCLIP_ADAPTER_MODELS;
  if (adapterModelsEnvCache && adapterModelsEnvCache.raw === raw) {
    return adapterModelsEnvCache.value;
  }
  let value: ReturnType<typeof parseAdapterModelsEnv> = null;
  try {
    value = parseAdapterModelsEnv(process.env);
  } catch (err) {
    console.error(
      "[paperclip] Invalid PAPERCLIP_ADAPTER_MODELS; ignoring declared model lists:",
      err,
    );
  }
  adapterModelsEnvCache = { raw, value };
  return value;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const declaredModels = getDeclaredAdapterModels();
  if (declaredModels && declaredModels[type]?.length) {
    return declaredModels[type].map((m) => ({ id: m.id, label: m.label ?? m.id }));
  }
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function refreshAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.refreshModels) {
    const refreshed = await adapter.refreshModels();
    if (refreshed.length > 0) return refreshed;
  }
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function listAdapterModelProfiles(type: string): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModelProfiles) {
    const discovered = await adapter.listModelProfiles();
    if (discovered.length > 0) return discovered;
  }
  return adapter.modelProfiles ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * List adapters excluding those that are disabled in settings.
 * Used for menus and agent creation flows — disabled adapters remain
 * functional for existing agents but hidden from selection.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Override pause / resume
// ---------------------------------------------------------------------------

/**
 * Pause or resume an external override for a builtin adapter type.
 *
 * - `paused = true`  → subsequent calls to `getServerAdapter(type)` return
 *   the builtin fallback instead of the external adapter.  Already-running
 *   agent sessions are unaffected (they hold a reference to the module they
 *   started with).
 *
 * - `paused = false` → the external adapter is active again.
 *
 * Returns `true` if the state actually changed, `false` if the type is not
 * an override or was already in the requested state.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

/** Check whether the external override for a builtin type is currently paused. */
export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/** Get the set of types whose overrides are currently paused. */
export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }
  return adaptersByType.get(type) ?? null;
}
