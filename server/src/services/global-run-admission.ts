import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { globalRunAdmission, heartbeatRuns } from "@paperclipai/db";

/**
 * Instance-wide (cross-company, cross-agent) run admission gate — MAI-890/MAI-1035.
 *
 * The per-agent `agents.heartbeatPolicy.maxConcurrentRuns` cap (see heartbeat.ts
 * `countRunningRunsForAgent`) has no ceiling across agents: 14 agents at 20 each
 * is 280 theoretical concurrent runs. This service adds a single global cap
 * (default 20) plus a global emergency-stop flag ("Not-Aus") that pauses new
 * run admission instance-wide without touching any already-running run.
 *
 * `admitOne` is the only race-safe entry point: it must be called with the
 * same DB transaction that performs the queued->running row update, so the
 * count-check and the write are covered by one `pg_advisory_xact_lock` hold.
 * Every other export here is a cheap, non-authoritative pre-filter or a
 * config read/write — see services/heartbeat.ts `claimQueuedRun` for the
 * authoritative call site.
 */

const DEFAULT_SINGLETON_KEY = "default";
export const DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS = 20;
export const GLOBAL_RUN_ADMISSION_MIN_CAP = 1;
export const GLOBAL_RUN_ADMISSION_MAX_CAP = 500;
const GLOBAL_RUN_ADMISSION_LOCK_KEY = "paperclip_global_run_admission";
const STATE_CACHE_TTL_MS = 2_000;

type Runner = Pick<Db, "select" | "insert" | "update"> & {
  execute?: Db["execute"];
};

export interface GlobalRunAdmissionActor {
  type: "agent" | "user";
  id: string;
}

export interface GlobalRunAdmissionState {
  id: string;
  maxConcurrentRuns: number;
  emergencyStopActive: boolean;
  emergencyStopReason: string | null;
  emergencyStopActor: GlobalRunAdmissionActor | null;
  emergencyStopActivatedAt: Date | null;
  authorizedAgentIds: string[];
  updatedAt: Date;
}

export type GlobalRunAdmissionDenial =
  | { allowed: false; code: "emergency_stop"; reason: string }
  | { allowed: false; code: "cap_reached"; reason: string };

export type GlobalRunAdmissionResult = { allowed: true } | GlobalRunAdmissionDenial;

function clampCap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS;
  return Math.min(GLOBAL_RUN_ADMISSION_MAX_CAP, Math.max(GLOBAL_RUN_ADMISSION_MIN_CAP, Math.round(value)));
}

function toState(row: typeof globalRunAdmission.$inferSelect): GlobalRunAdmissionState {
  return {
    id: row.id,
    maxConcurrentRuns: clampCap(row.maxConcurrentRuns),
    emergencyStopActive: row.emergencyStopActive,
    emergencyStopReason: row.emergencyStopReason ?? null,
    emergencyStopActor:
      row.emergencyStopActorType === "agent" || row.emergencyStopActorType === "user"
        ? { type: row.emergencyStopActorType, id: row.emergencyStopActorId ?? "unknown" }
        : null,
    emergencyStopActivatedAt: row.emergencyStopActivatedAt ?? null,
    authorizedAgentIds: Array.isArray(row.authorizedAgentIds) ? row.authorizedAgentIds : [],
    updatedAt: row.updatedAt,
  };
}

async function getOrCreateRow(runner: Runner) {
  const existing = await runner
    .select()
    .from(globalRunAdmission)
    .where(eq(globalRunAdmission.singletonKey, DEFAULT_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  if (existing) return existing;

  const now = new Date();
  const [created] = await runner
    .insert(globalRunAdmission)
    .values({
      singletonKey: DEFAULT_SINGLETON_KEY,
      maxConcurrentRuns: DEFAULT_GLOBAL_MAX_CONCURRENT_RUNS,
      authorizedAgentIds: [],
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [globalRunAdmission.singletonKey],
      set: { updatedAt: now },
    })
    .returning();
  if (created) return created;

  const raced = await runner
    .select()
    .from(globalRunAdmission)
    .where(eq(globalRunAdmission.singletonKey, DEFAULT_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  if (raced) return raced;

  throw new Error("Failed to initialize global run admission row");
}

export function globalRunAdmissionService(db: Db) {
  let cached: { state: GlobalRunAdmissionState; at: number } | null = null;

  function invalidateCache() {
    cached = null;
  }

  async function getState(
    options: { runner?: Runner; bypassCache?: boolean } = {},
  ): Promise<GlobalRunAdmissionState> {
    const runner = options.runner ?? db;
    const usesSharedCache = runner === db;
    if (usesSharedCache && !options.bypassCache && cached && Date.now() - cached.at < STATE_CACHE_TTL_MS) {
      return cached.state;
    }
    const row = await getOrCreateRow(runner);
    const state = toState(row);
    if (usesSharedCache) cached = { state, at: Date.now() };
    return state;
  }

  async function countGloballyRunning(runner: Runner = db): Promise<number> {
    const [{ count }] = await runner
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    return Number(count ?? 0);
  }

  /**
   * Cheap, non-authoritative pre-filter: lets callers skip expensive queued-run
   * enumeration when there is obviously no global capacity, without taking the
   * advisory lock. Must NOT be relied on alone for correctness — concurrent
   * callers can all pass this check and then race at the actual claim step.
   * Use `admitOne` (inside the claiming transaction) for the real gate.
   */
  async function checkAdmissionFast(): Promise<{ allowed: boolean; reason: string | null; availableSlots: number }> {
    const state = await getState();
    if (state.emergencyStopActive) {
      return {
        allowed: false,
        reason: `global_emergency_stop${state.emergencyStopReason ? `: ${state.emergencyStopReason}` : ""}`,
        availableSlots: 0,
      };
    }
    const running = await countGloballyRunning();
    const availableSlots = Math.max(0, state.maxConcurrentRuns - running);
    return { allowed: availableSlots > 0, reason: availableSlots > 0 ? null : "global_run_cap_reached", availableSlots };
  }

  /**
   * Authoritative, race-safe admission check for exactly one run. `runner`
   * MUST be an open DB transaction that also performs the queued->running
   * update for the same run, so the advisory lock held here covers both the
   * read and the write against every other concurrent claim attempt
   * instance-wide (any agent, any company).
   */
  async function admitOne(runner: Runner & { execute: Db["execute"] }): Promise<GlobalRunAdmissionResult> {
    await runner.execute(sql`select pg_advisory_xact_lock(hashtext(${GLOBAL_RUN_ADMISSION_LOCK_KEY}))`);
    const state = await getState({ runner, bypassCache: true });
    if (state.emergencyStopActive) {
      return {
        allowed: false,
        code: "emergency_stop",
        reason: `Global emergency stop is active${state.emergencyStopReason ? `: ${state.emergencyStopReason}` : ""}`,
      };
    }
    const running = await countGloballyRunning(runner);
    if (running >= state.maxConcurrentRuns) {
      return {
        allowed: false,
        code: "cap_reached",
        reason: `Global run cap of ${state.maxConcurrentRuns} concurrently running agent runs reached (currently ${running})`,
      };
    }
    return { allowed: true };
  }

  function isAuthorizedAgent(agentId: string, state: GlobalRunAdmissionState): boolean {
    return state.authorizedAgentIds.includes(agentId);
  }

  async function setCap(nextCap: number): Promise<GlobalRunAdmissionState> {
    const current = await getOrCreateRow(db);
    const now = new Date();
    const [updated] = await db
      .update(globalRunAdmission)
      .set({ maxConcurrentRuns: clampCap(nextCap), updatedAt: now })
      .where(eq(globalRunAdmission.id, current.id))
      .returning();
    invalidateCache();
    return toState(updated ?? current);
  }

  async function setAuthorizedAgentIds(agentIds: string[]): Promise<GlobalRunAdmissionState> {
    const current = await getOrCreateRow(db);
    const now = new Date();
    const deduped = [...new Set(agentIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
    const [updated] = await db
      .update(globalRunAdmission)
      .set({ authorizedAgentIds: deduped, updatedAt: now })
      .where(eq(globalRunAdmission.id, current.id))
      .returning();
    invalidateCache();
    return toState(updated ?? current);
  }

  async function activateEmergencyStop(input: {
    reason: string;
    actor: GlobalRunAdmissionActor;
    now?: Date;
  }): Promise<GlobalRunAdmissionState> {
    const current = await getOrCreateRow(db);
    const now = input.now ?? new Date();
    const [updated] = await db
      .update(globalRunAdmission)
      .set({
        emergencyStopActive: true,
        emergencyStopReason: input.reason,
        emergencyStopActorType: input.actor.type,
        emergencyStopActorId: input.actor.id,
        emergencyStopActivatedAt: now,
        updatedAt: now,
      })
      .where(eq(globalRunAdmission.id, current.id))
      .returning();
    invalidateCache();
    return toState(updated ?? current);
  }

  /**
   * Explicit, human/authorized-agent-triggered resume. Never called
   * automatically. Re-clears the stop flag only — the cap value (re-checked
   * on every subsequent admission) is untouched, satisfying "resume muss den
   * Cap erneut prüfen" without needing separate logic.
   */
  async function clearEmergencyStop(): Promise<GlobalRunAdmissionState> {
    const current = await getOrCreateRow(db);
    const now = new Date();
    const [updated] = await db
      .update(globalRunAdmission)
      .set({
        emergencyStopActive: false,
        emergencyStopReason: null,
        emergencyStopActorType: null,
        emergencyStopActorId: null,
        emergencyStopActivatedAt: null,
        updatedAt: now,
      })
      .where(eq(globalRunAdmission.id, current.id))
      .returning();
    invalidateCache();
    return toState(updated ?? current);
  }

  return {
    getState,
    invalidateCache,
    countGloballyRunning,
    checkAdmissionFast,
    admitOne,
    isAuthorizedAgent,
    setCap,
    setAuthorizedAgentIds,
    activateEmergencyStop,
    clearEmergencyStop,
  };
}

export type GlobalRunAdmissionService = ReturnType<typeof globalRunAdmissionService>;

