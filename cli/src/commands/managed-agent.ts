import { Command } from "commander";

import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./client/common.js";

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const MANAGED_BETA = "managed-agents-2026-04-01";
const SYSTEM_PROMPT = `You are a Paperclip remote agent. Follow the current user turn and use only the custom tools supplied for that session. Paperclip tool authority, completion, blocking, review, and yielding are enforced by the runner. Never request or infer a Paperclip endpoint or credential.`;

interface ManagedAgentSetupOptions extends BaseClientOptions {
  companyId?: string;
  profileKey: string;
  displayName: string;
  apiKeySecretId: string;
  model: string;
  maxSessionListCostUsd: string;
  agentId?: string;
  agentVersion?: string;
  environmentId?: string;
  probe?: boolean;
  acknowledgeRetention?: boolean;
}

interface RemoteResource {
  id?: string;
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function anthropicRequest(
  key: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${ANTHROPIC_ORIGIN}${path}`, {
    method,
    headers: {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": MANAGED_BETA,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Anthropic Managed Agents request failed with HTTP ${response.status}`);
  }
  if (response.status === 204) return {};
  return record(await response.json());
}

async function listAll(key: string, path: string): Promise<RemoteResource[]> {
  const rows: RemoteResource[] = [];
  let page: string | null = null;
  do {
    const suffix = page ? `${path.includes("?") ? "&" : "?"}page=${encodeURIComponent(page)}` : "";
    const response = await anthropicRequest(key, "GET", `${path}${suffix}`);
    for (const value of Array.isArray(response.data) ? response.data : []) {
      const item = record(value);
      rows.push(item as RemoteResource);
    }
    page = typeof response.next_page === "string" && response.next_page ? response.next_page : null;
  } while (page);
  return rows;
}

function resourceByProfile(resources: RemoteResource[], profileKey: string): RemoteResource | null {
  return resources.find((resource) =>
    typeof resource.id === "string" && record(resource.metadata).paperclip_profile === profileKey
  ) ?? null;
}

function assertSafeEnvironment(environment: Record<string, unknown>): void {
  const config = record(environment.config);
  const networking = record(config.networking);
  const packages = record(config.packages);
  const installed = Object.entries(packages)
    .filter(([key]) => key !== "type")
    .flatMap(([, value]) => Array.isArray(value) ? value : []);
  if (
    config.type !== "cloud"
    || networking.type !== "limited"
    || networking.allow_mcp_servers === true
    || networking.allow_package_managers === true
    || !Array.isArray(networking.allowed_hosts)
    || networking.allowed_hosts.length > 0
    || installed.length > 0
  ) {
    throw new Error("Existing Anthropic Environment does not match Paperclip's no-network, no-package profile");
  }
}

function assertSafeAgent(agent: Record<string, unknown>): void {
  if (
    (Array.isArray(agent.tools) && agent.tools.length > 0)
    || (Array.isArray(agent.mcp_servers) && agent.mcp_servers.length > 0)
    || (Array.isArray(agent.skills) && agent.skills.length > 0)
    || agent.multiagent != null
  ) {
    throw new Error("Existing Anthropic Agent enables tools, MCP, skills, or multi-agent features outside this phase");
  }
}

async function resolveEnvironment(key: string, options: ManagedAgentSetupOptions): Promise<Record<string, unknown>> {
  if (options.environmentId) {
    const environment = await anthropicRequest(key, "GET", `/v1/environments/${encodeURIComponent(options.environmentId)}?beta=true`);
    assertSafeEnvironment(environment);
    return environment;
  }
  const existing = resourceByProfile(await listAll(key, "/v1/environments?beta=true"), options.profileKey);
  if (existing) {
    assertSafeEnvironment(existing);
    return existing;
  }
  if (options.probe) throw new Error("Probe found no matching Anthropic Environment");
  return anthropicRequest(key, "POST", "/v1/environments?beta=true", {
    name: `Paperclip · ${options.displayName}`,
    description: "Paperclip remote-agent environment: no network or added packages.",
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
    metadata: { paperclip_profile: options.profileKey },
  });
}

async function resolveAgent(key: string, options: ManagedAgentSetupOptions): Promise<Record<string, unknown>> {
  if (options.agentId) {
    const agent = await anthropicRequest(key, "GET", `/v1/agents/${encodeURIComponent(options.agentId)}?beta=true`);
    assertSafeAgent(agent);
    return agent;
  }
  const existing = resourceByProfile(await listAll(key, "/v1/agents?beta=true"), options.profileKey);
  if (existing) {
    assertSafeAgent(existing);
    return existing;
  }
  if (options.probe) throw new Error("Probe found no matching Anthropic Agent");
  return anthropicRequest(key, "POST", "/v1/agents?beta=true", {
    name: `Paperclip · ${options.displayName}`,
    description: "Versioned Paperclip remote agent; runnerd supplies session tools.",
    model: options.model,
    system: SYSTEM_PROMPT,
    tools: [],
    mcp_servers: [],
    skills: [],
    metadata: { paperclip_profile: options.profileKey },
  });
}

async function setupManagedAgent(options: ManagedAgentSetupOptions): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY is required in the CLI process environment");
  if (!options.acknowledgeRetention) {
    throw new Error("Pass --acknowledge-retention to enable the stateful beta Managed Agents service");
  }
  const cap = Number(options.maxSessionListCostUsd);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("--max-session-list-cost-usd must be positive");

  const [environment, agent] = await Promise.all([
    resolveEnvironment(key, options),
    resolveAgent(key, options),
  ]);
  const agentId = String(agent.id ?? "");
  const environmentId = String(environment.id ?? "");
  const versions = await listAll(key, `/v1/agents/${encodeURIComponent(agentId)}/versions?beta=true`);
  const version = options.agentVersion
    ?? String(agent.version ?? versions.at(-1)?.version ?? "");
  if (!agentId || !environmentId || !version || !versions.some((entry) => String(entry.version) === version)) {
    throw new Error("Anthropic did not return a usable pinned Agent version and Environment identity");
  }

  const qualification = {
    probedAt: new Date().toISOString(),
    betaVersion: MANAGED_BETA,
    environmentPolicy: "limited_no_hosts_no_packages",
    agentCapabilities: "no_tools_no_mcp_no_skills_no_multiagent",
  };
  const profile = {
    profileKey: options.profileKey,
    displayName: options.displayName,
    anthropicAgentId: agentId,
    agentVersion: version,
    environmentId,
    defaultModel: options.model,
    defaultMaxListCostUsd: cap,
    apiKeySecretId: options.apiKeySecretId,
    enabled: !options.probe,
    retentionAcknowledged: true,
    qualification,
  };

  if (options.probe) {
    printOutput({ mode: "probe", qualified: true, profile }, { json: options.json });
    return;
  }
  const context = resolveCommandContext(options, { requireCompany: true });
  const stored = await context.api.post(
    apiPath`/api/companies/${context.companyId}/managed-agent-profiles`,
    profile,
  );
  printOutput(stored, { json: context.json });
}

export function registerManagedAgentCommands(program: Command): void {
  const command = program.command("managed-agent").description("Provision and qualify remote managed-agent providers");
  addCommonClientOptions(
    command
      .command("setup")
      .description("Create or adopt a locked-down Anthropic Agent and Environment, then store a company profile")
      .requiredOption("--profile-key <key>", "Stable company profile key")
      .requiredOption("--display-name <name>", "Profile display name")
      .requiredOption("--api-key-secret-id <id>", "Existing company secret containing ANTHROPIC_API_KEY")
      .option("--model <id>", "Pinned Claude model", "claude-sonnet-5")
      .option("--max-session-list-cost-usd <usd>", "Default hard session ceiling", "1.00")
      .option("--agent-id <id>", "Adopt an existing Anthropic Agent")
      .option("--agent-version <version>", "Pin an existing Agent version")
      .option("--environment-id <id>", "Adopt an existing Anthropic Environment")
      .option("--probe", "Read-only qualification; create or persist nothing", false)
      .option("--acknowledge-retention", "Acknowledge beta retention and non-ZDR/non-HIPAA status", false)
      .action(async (options: ManagedAgentSetupOptions) => {
        try {
          await setupManagedAgent(options);
        } catch (error) {
          handleCommandError(error);
        }
      }),
    { includeCompany: true },
  );
}
