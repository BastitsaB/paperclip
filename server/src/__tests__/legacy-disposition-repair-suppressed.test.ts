import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, applyPendingMigrations, companies, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import {
  LEGACY_DISPOSITION_REPAIR_SUPPRESSED, LEGACY_RECOVERY_CAUSE, legacyExecutionNeedsReconciliationWithEvidence, terminalizeLegacyExecution,
} from "../services/legacy-execution-recovery.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";

// Production shape (20.11.2026): a disposition repair cancelled at the dispatch
// gate left a resolved replay=blocked hold, and every later wake stayed deferred.
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_LEGACY_REPAIR_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("suppressed disposition repair holds", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let companyId: string, agentId: string, issueId: string;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("repair-suppressed-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 4 });
  }, 90000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    companyId = randomUUID(); agentId = randomUUID(); issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Repair", issuePrefix: "REP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "codex_local" });
    // The automatic disposition projected the task to blocked, as in production.
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", status: "blocked", assigneeAgentId: agentId });
  });

  async function historicalHold(run: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const startedAt = new Date(Date.now() - 60_000);
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "legacy", status: "cancelled",
      errorCode: LEGACY_DISPOSITION_REPAIR_SUPPRESSED, startedAt, finishedAt: new Date(startedAt.getTime() + 8_000),
      contextSnapshot: { issueId }, resultJson: { cancellation: { source: "unknown", expected: false } }, ...run }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: LEGACY_RECOVERY_CAUSE, fingerprint: `legacy-execution:${source!.id}`, status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: agentId, attemptCount: 1, resolvedAt: new Date(),
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
      evidence: { runId: source!.id, originalFailureCode: LEGACY_DISPOSITION_REPAIR_SUPPRESSED, adapterRecovery: "unsupported_or_unknown",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: source!.id, replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      status: "deferred_issue_execution", payload: { issueId, wakeCommentIds: [randomUUID()] } }).returning();
    return { source: source!, hold: action!, wake: wake! };
  }
  const readHold = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const resolvedLogs = () => db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
    eq(activityLog.action, "issue.recovery_action_resolved")));

  it("lifts the execution block without promoting old wakes, changing status or replaying the run", async () => {
    const { source, hold, wake } = await historicalHold();
    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();

    await settleUnrecoverableExecutions(db);

    const settled = await readHold(hold.id);
    expect(settled).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect(settled.evidence.automaticRecovery).toMatchObject({ policy: "preserve_without_replay_v1", replay: "allowed" });
    expect(settled.evidence.dispositionRepairSuppressedSettledAt).toEqual(expect.any(String));
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id));
    expect(run).toMatchObject({ status: "cancelled", resultJson: source.resultJson });
    // The stranded-queue drain decides from this run: it must keep releasing
    // instead of promoting comment wakes that predate the release.
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, run!)).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    const [queued] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(queued!.status).toBe("deferred_issue_execution");
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task!.status).toBe("blocked");
    const logged = await resolvedLogs();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.details).toMatchObject({ reason: "disposition_repair_suppressed_before_dispatch", replay: "not_performed" });

    // Later sweeps of the same terminal run neither log again nor reinstate a hold.
    await terminalizeLegacyExecution({ db, run: run!, status: "cancelled", fromStatuses: ["cancelled"], reconcileIfNeeded: true });
    await settleUnrecoverableExecutions(db);
    expect(await resolvedLogs()).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(1);
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
  });

  it("releases a still active hold before the disposition settles it as blocked", async () => {
    const { hold } = await historicalHold();
    await db.update(issueRecoveryActions).set({ status: "active", outcome: null, resolvedAt: null,
      evidence: { runId: hold.evidence.runId, originalFailureCode: LEGACY_DISPOSITION_REPAIR_SUPPRESSED } })
      .where(eq(issueRecoveryActions.id, hold.id));
    await settleUnrecoverableExecutions(db);
    expect(await readHold(hold.id)).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
  });

  const missingProof: Array<[string, Partial<typeof heartbeatRuns.$inferInsert>]> = [
    ["a recorded process id", { processPid: 4242 }],
    ["a recorded process group", { processGroupId: 4242 }],
    ["a recorded process start", { processStartedAt: new Date() }],
    ["another error code", { errorCode: "cancelled" }],
    ["a failed status", { status: "failed" }],
  ];
  it.each(missingProof)("keeps the hold for %s", async (_label, run) => {
    const { hold } = await historicalHold(run);
    await settleUnrecoverableExecutions(db);
    const kept = await readHold(hold.id);
    expect(kept.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
    expect(kept.outcome).not.toBe("false_positive");
    expect(await getExecutionBlocker(db, companyId, issueId)).not.toBeNull();
  });

  it("keeps the hold while the run still owns an unreleased lease", async () => {
    const { source, hold } = await historicalHold();
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: source.id, provider: "local", status: "active",
      leasePolicy: "ephemeral" } as typeof environmentLeases.$inferInsert);
    await settleUnrecoverableExecutions(db);
    expect((await readHold(hold.id)).evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
  });

  it("does not release closed tasks whose old comment wakes would reopen them", async () => {
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    const { hold } = await historicalHold();
    await settleUnrecoverableExecutions(db);
    expect((await readHold(hold.id)).evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
    expect(await resolvedLogs()).toHaveLength(0);
  });

  it("keeps the hold when its creation displaced an open reconciliation duty", async () => {
    const { hold } = await historicalHold();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: LEGACY_RECOVERY_CAUSE, fingerprint: `legacy-execution:${randomUUID()}`, status: "cancelled", outcome: "cancelled",
      ownerType: "board", attemptCount: 1, resolvedAt: hold.createdAt, nextAction: "Reconcile the earlier run.",
      resolutionNote: "A new failure with a different identity superseded this recovery action.", evidence: { runId: randomUUID() } });
    await settleUnrecoverableExecutions(db);
    expect((await readHold(hold.id)).evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
  });

  it("does not create a hold when the dispatch gate records that the adapter never started", async () => {
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const holdsFor = async (evidence: Record<string, unknown> | undefined) => {
      const [running] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "legacy", status: "running",
        startedAt: new Date(), contextSnapshot: { issueId } }).returning();
      await db.update(issues).set({ executionRunId: running!.id }).where(eq(issues.id, issueId));
      await terminalizeLegacyExecution({ db, run: running!, status: "cancelled", reconcileIfNeeded: true,
        patch: { finishedAt: new Date(), errorCode: LEGACY_DISPOSITION_REPAIR_SUPPRESSED,
          ...(evidence ? { resultJson: { executionRecovery: evidence } } : {}) } });
      return db.select().from(issueRecoveryActions).where(sql`${issueRecoveryActions.evidence}->>'runId' = ${running!.id}`);
    };
    expect(await holdsFor({ kind: "bootstrap", providerWorkStarted: false })).toHaveLength(0);
    expect(await holdsFor(undefined)).toHaveLength(1);
  });
});
