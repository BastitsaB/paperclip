import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// Regression coverage for routine execution-lock contention at claim time.
// Two open routine_execution issues of the same routine identity can each get a
// queued run. issues_open_routine_execution_uq allows only one of them to hold
// execution_run_id. Before the fix, claimQueuedRun committed the loser as
// "running" and only then hit 23505 while stamping the lock; the error escaped,
// no process was ever started, and the orphan reaper later failed the run as
// process_lost. The contended run must instead stay queued and run once the
// sibling lock is released.

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Routine execution-lock contention test run.",
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
    `Skipping routine execution-lock contention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat routine execution-lock contention", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(
      (call) => ((call as unknown[])[0] as { runId?: string } | undefined)?.runId === runId,
    ).length;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-exec-lock-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((rows) => rows.map((row) => row.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Paid Ads Checker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      // Free slots so the contended run is actually offered to claimQueuedRun.
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRoutineExecutionIssue(input: {
    companyId: string;
    agentId: string;
    originId: string;
    originFingerprint: string;
    lockHeldByRunId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Paid Ads: 14-Tage-Health-Check",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
      originKind: "routine_execution",
      originId: input.originId,
      originFingerprint: input.originFingerprint,
      executionRunId: input.lockHeldByRunId ?? null,
      executionAgentNameKey: input.lockHeldByRunId ? "paid ads checker" : null,
      executionLockedAt: input.lockHeldByRunId ? new Date() : null,
    });
    return issueId;
  }

  // Run that owns the sibling's routine execution lock. Terminal on purpose:
  // it must not occupy a concurrency slot or be dispatched by the test.
  async function seedLockHolderRun(input: { companyId: string; agentId: string }) {
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
      contextSnapshot: {},
    });
    return runId;
  }

  async function seedQueuedRun(input: { companyId: string; agentId: string; issueId: string }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function readRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function readIssueLock(issueId: string) {
    return db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.executionRunId ?? null);
  }

  it("leaves a contended routine-execution run queued instead of orphaning it as running", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const originId = randomUUID();
    const originFingerprint = "default";
    const holderRunId = await seedLockHolderRun({ companyId, agentId });
    const priorIssueId = await seedRoutineExecutionIssue({
      companyId, agentId, originId, originFingerprint, lockHeldByRunId: holderRunId,
    });
    const nextIssueId = await seedRoutineExecutionIssue({ companyId, agentId, originId, originFingerprint });
    const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, issueId: nextIssueId });

    // Before the fix the 23505 escaped from here.
    await heartbeat.resumeQueuedRuns();
    // Give any (incorrect) background dispatch a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const run = await readRun(runId);
    expect(run?.status).toBe("queued");
    expect(run?.startedAt).toBeNull();
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(0);

    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    expect(wakeup?.status).toBe("queued");

    expect(await readIssueLock(nextIssueId)).toBeNull();
    expect(await readIssueLock(priorIssueId)).toBe(holderRunId);
  });

  it("runs the deferred routine-execution run once the sibling lock is released", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const originId = randomUUID();
    const originFingerprint = "default";
    const holderRunId = await seedLockHolderRun({ companyId, agentId });
    const priorIssueId = await seedRoutineExecutionIssue({
      companyId, agentId, originId, originFingerprint, lockHeldByRunId: holderRunId,
    });
    const nextIssueId = await seedRoutineExecutionIssue({ companyId, agentId, originId, originFingerprint });
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId: nextIssueId });

    await heartbeat.resumeQueuedRuns();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await readRun(runId))?.status).toBe("queued");

    await db
      .update(issues)
      .set({ status: "done", executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, priorIssueId));

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await readRun(runId))?.status === "succeeded");

    const run = await readRun(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });

  it("does not defer when the locked sibling belongs to a different routine fingerprint", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const originId = randomUUID();
    const holderRunId = await seedLockHolderRun({ companyId, agentId });
    await seedRoutineExecutionIssue({
      companyId, agentId, originId, originFingerprint: "fingerprint-a", lockHeldByRunId: holderRunId,
    });
    const nextIssueId = await seedRoutineExecutionIssue({
      companyId, agentId, originId, originFingerprint: "fingerprint-b",
    });
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId: nextIssueId });

    await heartbeat.resumeQueuedRuns();
    await waitForCondition(async () => (await readRun(runId))?.status === "succeeded");

    expect((await readRun(runId))?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(runId)).toBe(1);
  });
});
