import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, managedAgentProfiles } from "@paperclipai/db";

import { conflict, notFound, unprocessable } from "../errors.js";
import { assertProfileMetadataContainsNoSecrets } from "./remote-agent-profiles.js";

export const CLAUDE_MANAGED_BETA_VERSION = "managed-agents-2026-04-01" as const;

export interface ManagedAgentProfileInput {
  profileKey: string;
  displayName: string;
  anthropicAgentId: string;
  agentVersion: string;
  environmentId: string;
  defaultModel: string;
  defaultMaxListCostUsd: number;
  apiKeySecretId: string;
  enabled: boolean;
  retentionAcknowledged: boolean;
  qualification?: Record<string, unknown>;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw unprocessable(`${label} is required`);
  return normalized;
}

function toCents(value: number): number {
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw unprocessable("Managed Agent default spend ceiling must be positive");
  }
  return cents;
}

export function managedAgentProfileService(db: Db) {
  async function list(companyId: string) {
    return db.select().from(managedAgentProfiles)
      .where(eq(managedAgentProfiles.companyId, companyId))
      .orderBy(asc(managedAgentProfiles.displayName));
  }

  async function get(companyId: string, profileIdOrKey: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileIdOrKey);
    const rows = await db.select().from(managedAgentProfiles).where(and(
      eq(managedAgentProfiles.companyId, companyId),
      isUuid
        ? eq(managedAgentProfiles.id, profileIdOrKey)
        : eq(managedAgentProfiles.profileKey, profileIdOrKey),
    )).limit(1);
    return rows[0] ?? null;
  }

  async function requireQualified(companyId: string, profileIdOrKey: string) {
    const profile = await get(companyId, profileIdOrKey);
    if (!profile) throw notFound("Managed Agent profile not found");
    if (!profile.enabled || !profile.retentionAcknowledged || !profile.qualifiedAt) {
      throw conflict("Managed Agent profile is not enabled and qualified");
    }
    return profile;
  }

  async function upsert(companyId: string, input: ManagedAgentProfileInput) {
    assertProfileMetadataContainsNoSecrets(input.qualification ?? {}, "Managed Agent qualification");
    const secret = await db.select({ id: companySecrets.id })
      .from(companySecrets)
      .where(and(
        eq(companySecrets.companyId, companyId),
        eq(companySecrets.id, input.apiKeySecretId),
        eq(companySecrets.scope, "company"),
        ne(companySecrets.status, "deleted"),
      ))
      .limit(1);
    if (!secret[0]) throw unprocessable("Managed Agent API-key secret reference is invalid");
    if (input.enabled && !input.retentionAcknowledged) {
      throw unprocessable("Enabling Managed Agents requires the retention acknowledgement");
    }

    const profileKey = required(input.profileKey, "Profile key");
    const values = {
      companyId,
      profileKey,
      displayName: required(input.displayName, "Display name"),
      service: "anthropic_managed_agents",
      anthropicAgentId: required(input.anthropicAgentId, "Anthropic Agent ID"),
      agentVersion: required(input.agentVersion, "Agent version"),
      environmentId: required(input.environmentId, "Anthropic Environment ID"),
      betaVersion: CLAUDE_MANAGED_BETA_VERSION,
      defaultModel: required(input.defaultModel, "Default model"),
      defaultMaxListCostCents: toCents(input.defaultMaxListCostUsd),
      apiKeySecretId: input.apiKeySecretId,
      enabled: input.enabled,
      retentionAcknowledged: input.retentionAcknowledged,
      qualification: input.qualification ?? {},
      qualifiedAt: input.enabled ? new Date() : null,
      updatedAt: new Date(),
    } as const;
    const [row] = await db.insert(managedAgentProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: [managedAgentProfiles.companyId, managedAgentProfiles.profileKey],
        set: values,
      })
      .returning();
    return row!;
  }

  return { list, get, requireQualified, upsert };
}
