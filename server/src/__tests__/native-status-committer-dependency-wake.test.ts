import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * Lets one test make the blocked-cycle guard fail the way a transient database
 * problem would: a real failing statement issued on the handle the guard was
 * given, i.e. inside the commit transaction.
 */
const guardFault = vi.hoisted(() => ({ mode: "off" as "off" | "database_error" }));

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    hasIssueBlockerResolutionInBlockedCycle: async (
      db: Parameters<typeof actual.hasIssueBlockerResolutionInBlockedCycle>[0],
      input: Parameters<typeof actual.hasIssueBlockerResolutionInBlockedCycle>[1],
    ) => {
      if (guardFault.mode === "database_error") {
        // Not a plain thrown Error: this is a genuine Postgres failure on the
        // caller's handle, which aborts the enclosing transaction unless the
        // caller isolated the lookup in a savepoint.
        await db.execute(sql`select 1 / 0`);
      }
      return actual.hasIssueBlockerResolutionInBlockedCycle(db, input);
    },
  };
});
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeStatusDecision,
} from "../services/native-runtime/status-arbiter.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import {
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
} from "../services/issue-dependency-wakeups.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native status committer dependency wake tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * MAI-1819 regression for the FOURTH `issue_blockers_resolved` producer.
 *
 * `commitNativeStatusDecision` emits the dependency wake when a blocker reaches
 * `done` inside the native status-decision transaction. It used the legacy
 * per-edge idempotency key, which never covers the dependency-ready state, so a
 * wake emitted here and then delivered did not stop the liveness backstop from
 * emitting a SECOND wake for the same ready state on its next tick. It also ran
 * without the blocked-cycle guard the other three producers use.
 */
describeEmbeddedPostgres("native status committer dependency wake", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-dependency-wake-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    guardFault.mode = "off";
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(statusDecisionEffects);
    await db.delete(nativeRunFinalizations);
    await db.delete(statusDecisions);
    await db.delete(workAssessments);
    await db.delete(nativeRunResults);
    await db.delete(completionContracts);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  /**
   * A blocker owned by a native run, plus a dependent that is `blocked` on a
   * free-text `unblockDescriptor` and linked to that blocker by a `blocks` edge
   * created long before the dependent's current blocked cycle.
   */
  async function seedBlockerWithBlockedDependent(opts: {
    blockedTransitionAt: Date;
    withParent?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const dependentAgentId = randomUUID();
    const parentAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const dependentIssueId = randomUUID();
    const parentIssueId = opts.withParent === true ? randomUUID() : null;
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const issuePrefix = `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({ id: companyId, name: "Native wake", issuePrefix });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Blocker agent", adapterType: "codex_local", status: "running" },
      {
        id: dependentAgentId,
        companyId,
        name: "Dependent agent",
        adapterType: "codex_local",
        status: "idle",
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      },
      {
        id: parentAgentId,
        companyId,
        name: "Parent agent",
        adapterType: "codex_local",
        status: "idle",
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      },
    ]);
    if (parentIssueId) {
      await db.insert(issues).values({
        id: parentIssueId,
        companyId,
        title: "Native parent",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: parentAgentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
      });
    }
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        parentId: parentIssueId,
        title: "Native blocker",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        workMode: "standard",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: dependentIssueId,
        companyId,
        title: "Free-text blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: dependentAgentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        blockedTransitionAt: opts.blockedTransitionAt,
        unblockDescriptor: { owner: "board", action: "Auftraggeberentscheidung" },
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
      createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      nativeIssueId: blockerIssueId,
      contextSnapshot: { issueId: blockerIssueId },
      completionContractId: contractId,
      completionContractSha256: `contract:${runId}`,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId: blockerIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "native-wake-v1", criteria: [{ id: "objective", requirement: "ship" }] },
      canonicalSha256: `contract:${runId}`,
      createdByActorType: "system",
      createdByActorId: "native-dependency-wake-test",
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId: blockerIssueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fingerprint:${runId}`,
      schemaStatus: "accepted",
      resultJson: { result: { summary: "Blocker erledigt." } },
      canonicalSha256: `result:${runId}`,
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId: blockerIssueId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress",
      priorStatusVersion: 0,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: { allCriteriaSatisfied: true },
      inputDigest: `assessment:${assessmentId}`,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId: blockerIssueId,
      phase: "assessing",
      resultId,
      assessmentId,
    });

    return {
      companyId,
      agentId,
      dependentAgentId,
      parentAgentId,
      blockerIssueId,
      dependentIssueId,
      parentIssueId,
      runId,
      assessmentId,
    };
  }

  function doneDecision(): NativeStatusDecision {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "contract_satisfied",
      unblockDescriptor: null,
      effects: [],
    };
  }

  function commitDone(seeded: Awaited<ReturnType<typeof seedBlockerWithBlockedDependent>>) {
    return commitNativeStatusDecision({
      db,
      companyId: seeded.companyId,
      issueId: seeded.blockerIssueId,
      runId: seeded.runId,
      assessmentId: seeded.assessmentId,
      priorStatus: "in_progress",
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision: doneDecision(),
    });
  }

  function dependencyWakes(companyId: string, dependentAgentId: string) {
    return db
      .select({
        id: agentWakeupRequests.id,
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, dependentAgentId),
        ),
      );
  }

  it("emits exactly one wake under the cycle-aware state key for a real open -> done transition", async () => {
    const seeded = await seedBlockerWithBlockedDependent({
      blockedTransitionAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await commitDone(seeded);

    const wakes = await dependencyWakes(seeded.companyId, seeded.dependentAgentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].reason).toBe("issue_blockers_resolved");

    const dependent = await db
      .select({ blockedTransitionAt: issues.blockedTransitionAt })
      .from(issues)
      .where(eq(issues.id, seeded.dependentIssueId))
      .then((rows) => rows[0]!);
    expect(wakes[0].idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: seeded.dependentIssueId,
        blockerIssueIds: [seeded.blockerIssueId],
        blockedTransitionAt: dependent.blockedTransitionAt,
      }),
    );
    // The legacy per-edge key is what made this producer invisible to the
    // shared ready-state dedup.
    expect(wakes[0].idempotencyKey).not.toBe(
      buildIssueBlockersResolvedWakeIdempotencyKey({
        dependentIssueId: seeded.dependentIssueId,
        resolvedBlockerIssueId: seeded.blockerIssueId,
      }),
    );
  });

  it("does not emit a second wake on a replayed commit of the same decision", async () => {
    const seeded = await seedBlockerWithBlockedDependent({
      blockedTransitionAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const first = await commitDone(seeded);
    const replayed = await commitNativeStatusDecision({
      db,
      companyId: seeded.companyId,
      issueId: seeded.blockerIssueId,
      runId: seeded.runId,
      assessmentId: seeded.assessmentId,
      priorStatus: "in_progress",
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision: doneDecision(),
    });

    expect(replayed.decision.id).toBe(first.decision.id);
    expect(await dependencyWakes(seeded.companyId, seeded.dependentAgentId)).toHaveLength(1);
  });

  it("does not let the liveness backstop add a second wake after this one was delivered", async () => {
    const seeded = await seedBlockerWithBlockedDependent({
      blockedTransitionAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await commitDone(seeded);
    // The wake was dispatched and the run finished: mark it `completed`. A
    // completed LEGACY per-edge wake does not cover the ready state, so before
    // the fix the next backstop tick emitted a duplicate for the same state.
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed" })
      .where(eq(agentWakeupRequests.agentId, seeded.dependentAgentId));

    const backstop = await heartbeatService(db).reconcileResolvedDependencyWakes();

    // Primary proof: no second wake row for the same ready state. The dependent
    // agent has wake-on-demand disabled, so a duplicate would land as an extra
    // `skipped` row rather than a dispatched run — still an extra row.
    expect(await dependencyWakes(seeded.companyId, seeded.dependentAgentId)).toHaveLength(1);
    expect(backstop.existingWakeSkipped).toBe(1);
    expect(backstop.healed).toBe(0);
    expect(backstop.deferredOrFailed).toBe(0);
  });

  it("skips the wake when no blocker edge changed during the dependent's blocked cycle", async () => {
    // Defensive case: the dependent's blocked cycle starts after the blocker
    // resolution this commit records (clock skew between writers). Nothing
    // resolved inside the current cycle, so this producer must stay quiet —
    // the same rule the other three producers apply.
    const seeded = await seedBlockerWithBlockedDependent({
      blockedTransitionAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await commitDone(seeded);

    expect(await dependencyWakes(seeded.companyId, seeded.dependentAgentId)).toHaveLength(0);
    const blocker = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, seeded.blockerIssueId))
      .then((rows) => rows[0]!);
    // The status projection itself is unaffected — only the wake is suppressed.
    expect(blocker.status).toBe("done");
  });

  it("commits the status and still emits the wake when the guard lookup fails", async () => {
    const seeded = await seedBlockerWithBlockedDependent({
      blockedTransitionAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    guardFault.mode = "database_error";

    // Must not reject: a lookup failure may neither abort the status commit nor
    // swallow the wake. Catching alone is not enough — the failing statement
    // poisons the enclosing transaction unless the lookup sits in a savepoint.
    const committed = await commitDone(seeded);
    expect(committed.decision.id).toBeTruthy();

    const blocker = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, seeded.blockerIssueId))
      .then((rows) => rows[0]!);
    expect(blocker.status).toBe("done");

    const wakes = await dependencyWakes(seeded.companyId, seeded.dependentAgentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].reason).toBe("issue_blockers_resolved");
    const dependent = await db
      .select({ blockedTransitionAt: issues.blockedTransitionAt })
      .from(issues)
      .where(eq(issues.id, seeded.dependentIssueId))
      .then((rows) => rows[0]!);
    // Fail-open keeps the shared state key, so the wake stays deduplicated.
    expect(wakes[0].idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: seeded.dependentIssueId,
        blockerIssueIds: [seeded.blockerIssueId],
        blockedTransitionAt: dependent.blockedTransitionAt,
      }),
    );
  });

  it("keeps the parent issue_children_completed wake when the guard lookup fails", async () => {
    const seeded = await seedBlockerWithBlockedDependent({
      blockedTransitionAt: new Date(Date.now() - 60 * 60 * 1000),
      withParent: true,
    });
    guardFault.mode = "database_error";

    await commitDone(seeded);

    expect(await dependencyWakes(seeded.companyId, seeded.dependentAgentId)).toHaveLength(1);
    const parentWakes = await dependencyWakes(seeded.companyId, seeded.parentAgentId);
    expect(parentWakes).toHaveLength(1);
    expect(parentWakes[0].reason).toBe("issue_children_completed");
    expect(parentWakes[0].idempotencyKey).toBe(
      `issue_children_completed:${seeded.parentIssueId}:${seeded.blockerIssueId}`,
    );
  });
});
