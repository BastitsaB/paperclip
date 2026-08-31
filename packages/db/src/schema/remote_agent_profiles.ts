import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Provider-neutral company resource profile. `configuration` is a closed,
 * nonsecret provider snapshot; credentials remain optional references to the
 * company secret store (AWS commonly uses workload identity instead).
 */
export const remoteAgentProfiles = pgTable("remote_agent_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  profileKey: text("profile_key").notNull(),
  displayName: text("display_name").notNull(),
  service: text("service").notNull(),
  configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull().default({}),
  credentialSecretId: uuid("credential_secret_id").references(() => companySecrets.id, { onDelete: "restrict" }),
  enabled: boolean("enabled").notNull().default(false),
  retentionAcknowledged: boolean("retention_acknowledged").notNull().default(false),
  qualification: jsonb("qualification").$type<Record<string, unknown>>().notNull().default({}),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyIdx: index("remote_agent_profiles_company_idx").on(table.companyId),
  companyKeyUq: uniqueIndex("remote_agent_profiles_company_key_uq").on(table.companyId, table.profileKey),
  serviceCheck: check("remote_agent_profiles_service_check", sql`${table.service} in ('anthropic_managed_agents', 'aws_bedrock_agentcore_harness')`),
}));
