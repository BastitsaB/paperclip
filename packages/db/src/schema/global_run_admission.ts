import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Singleton, instance-wide (not per-company) row gating how many agent runs
 * may be "running" at once across the whole Paperclip instance, and holding
 * the global emergency-stop ("Not-Aus") flag. See MAI-890/MAI-1035: the
 * per-agent `agents.heartbeatPolicy.maxConcurrentRuns` cap has no cross-agent
 * ceiling, so a recovery storm across many agents could still exhaust the
 * shared upstream quota. `authorizedAgentIds` lets specific governance-role
 * agents (e.g. a "Chief of Staff"/"CTO" persona) trigger/resume the stop via
 * the agent API in addition to a human board instance-admin — see
 * services/global-run-admission.ts for the authorization + admission logic.
 */
export const globalRunAdmission = pgTable(
  "global_run_admission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(20),
    emergencyStopActive: boolean("emergency_stop_active").notNull().default(false),
    emergencyStopReason: text("emergency_stop_reason"),
    emergencyStopActorType: text("emergency_stop_actor_type"),
    emergencyStopActorId: text("emergency_stop_actor_id"),
    emergencyStopActivatedAt: timestamp("emergency_stop_activated_at", { withTimezone: true }),
    authorizedAgentIds: jsonb("authorized_agent_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyUniqueIdx: uniqueIndex("global_run_admission_singleton_key_idx").on(table.singletonKey),
  }),
);

