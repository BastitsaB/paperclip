import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  globalRunAdmission,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { globalRunAdmissionService } from "../services/global-run-admission.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Global run admission test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres global run admission heartbeat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("global run admission wired into heartbeat start paths (MAI-890/MAI-1035)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let admission!: ReturnType<typeof globalRunAdmissionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-global-run-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    // Fresh service instances per test: each keeps its own short-TTL
    // in-memory cache of the global admission state (see
    // services/global-run-admission.ts), so reusing one instance across
    // tests would let a cache entry from a previous test's emergency-stop
    // activation leak into the next test as a stale read. This mirrors how
    // a real server process's cache would also eventually expire (same TTL
    // order of magnitude as the existing worktree-suppression override
    // cache) — it is not itself a correctness gap: the authoritative,
    // never-cached check is `admitOne()` inside the claiming transaction.
    heartbeat = heartbeatService(db);
    admission = globalRunAdmissionService(db);
  });

  afterEach(async () => {
    // Always resume — an emergency stop left active would otherwise leak
    // into (and silently break admission for) the next test.
    await admission.clearEmergencyStop();
    await admission.setCap(20);

    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).then((rows) => rows.map((r) => r.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Global run admission test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(globalRunAdmission);
    await db.delete(companySkills);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  async function seedAgent(overrides: { maxConcurrentRuns?: number } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: overrides.maxConcurrentRuns ?? 5,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("blocks a manual/on-demand wakeup while the global emergency stop is active, and lets it through once resumed", async () => {
    const { agentId } = await seedAgent();
    await admission.activateEmergencyStop({ reason: "MAI-890 drill", actor: { type: "user", id: "board-user" } });

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_invoke",
    });
    expect(blockedWake).toBeNull();

    const runsWhileStopped = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    expect(runsWhileStopped).toHaveLength(0);

    await admission.clearEmergencyStop();

    // The emergency-stop check always reads the DB fresh (see
    // getSchedulingSuppression in heartbeat.ts) rather than the service's
    // short-TTL cache, precisely so resume — like activation — takes effect
    // immediately rather than waiting out a cache window.
    const resumedWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_invoke",
    });
    expect(resumedWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, resumedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });
  });

  it("blocks a fan-out/assignment-triggered wakeup while the global emergency stop is active", async () => {
    const { agentId } = await seedAgent();
    const issueId = randomUUID();
    await admission.activateEmergencyStop({ reason: "MAI-890 drill", actor: { type: "agent", id: randomUUID() } });

    const assignmentWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(assignmentWake).toBeNull();

    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    expect(runs).toHaveLength(0);
  });

  it("blocks the timer/cron scheduling scan while the global emergency stop is active", async () => {
    await admission.activateEmergencyStop({ reason: "MAI-890 drill", actor: { type: "user", id: "board-user" } });

    const result = await heartbeat.tickTimers(new Date());
    expect(result).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
  });

  it("lets an already-running run finish normally while the global emergency stop is active (no forced cancellation)", async () => {
    const { agentId, companyId } = await seedAgent();
    let finishRun!: () => void;
    const runCanFinish = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await runCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Draining run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    const wake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_invoke",
    });
    expect(wake).not.toBeNull();
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "running";
    });

    // Emergency stop flips on AFTER the run is already admitted/running.
    await admission.activateEmergencyStop({ reason: "MAI-890 drill mid-flight", actor: { type: "user", id: "board-user" } });

    // A second, new wakeup for the same agent is correctly blocked...
    const blockedSecondWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_invoke",
    });
    expect(blockedSecondWake).toBeNull();

    // ...but the already-admitted run is left alone to finish its current step.
    finishRun();

    const drained = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, wake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });
    expect(drained).toBe(true);
  });

  it("enforces the global cap across two different agents, and re-checks the cap on resume rather than lifting it", async () => {
    const first = await seedAgent();
    const second = await seedAgent();
    await admission.setCap(1);

    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First agent run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    const firstWake = await heartbeat.wakeup(first.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_invoke",
    });
    expect(firstWake).not.toBeNull();
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, firstWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "running";
    });

    // A DIFFERENT agent's wakeup is admitted (a queued row is created — its
    // own per-agent policy allows it) but must be deferred (stay "queued")
    // because the global cap of 1 is already fully consumed.
    const secondWake = await heartbeat.wakeup(second.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_invoke",
    });
    expect(secondWake).not.toBeNull();

    const secondWhileFirstRunning = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, secondWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(secondWhileFirstRunning?.status).toBe("queued");

    const runningCountWhileCapped = await admission.countGloballyRunning();
    expect(runningCountWhileCapped).toBe(1);

    finishFirstRun();
    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, firstWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    // Freeing the slot only re-checks the agent that just finished (see
    // `executeRun`'s own-agent follow-up dispatch) — a DIFFERENT agent's
    // queued run, deferred purely by the global cap, only gets re-admitted on
    // the next general sweep. In production that sweep runs on the same
    // periodic scheduler tick as tickTimers (index.ts); here we invoke it
    // directly to simulate "the next tick", exactly like the existing
    // "cancels stale queued runs" test above does via resumeQueuedRuns().
    await heartbeat.resumeQueuedRuns();

    const secondPromoted = await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    }, 10_000);
    expect(secondPromoted).toBe(true);
  }, 20_000);
});

