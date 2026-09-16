import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
import { validateExecutionReconciliation } from "../services/execution-recovery-resolution.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-run lease reconciliation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression coverage for the stranded leases of interrupted runs. A platform
// restart terminalizes a running run ("orphaned_running_run" /
// "server_shutdown_interrupted") without releasing its environment lease. The
// lease keeps `released_at IS NULL`, and every later
// `POST /api/issues/:id/recovery-actions/resolve` fails with the 409 from
// `validateExecutionReconciliation`. The reconciler closes those leases.
describeEmbeddedPostgres("terminal-run environment lease reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-run-lease-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The local environment is instance-scoped, not company-scoped: the schema
  // permits exactly one row with `driver = 'local'`
  // (`environments_local_driver_idx`) and unique environment names
  // (`environments_name_idx`). A fixture that inserts its own row therefore
  // collides with any local environment that already exists. So resolve the
  // single local environment instead of creating a second one — the same
  // select-or-insert shape `environmentService.ensureLocalEnvironment` uses in
  // production. The `afterEach` truncation still removes the row, so each case
  // starts from an empty table and shares no state with the next.
  async function ensureLocalEnvironment(): Promise<string> {
    const readLocal = () =>
      db
        .select({ id: environments.id })
        .from(environments)
        .where(eq(environments.driver, "local"))
        .then((rows) => rows[0]?.id ?? null);

    const existing = await readLocal();
    if (existing) return existing;

    // The bare `do nothing` covers both partial unique indexes at once.
    const inserted = await db
      .insert(environments)
      .values({ name: "Local", driver: "local", status: "active", config: {} })
      .onConflictDoNothing()
      .returning({ id: environments.id })
      .then((rows) => rows[0]?.id ?? null);
    if (inserted) return inserted;

    const winner = await readLocal();
    if (!winner) throw new Error("could not resolve the local environment fixture");
    return winner;
  }

  // The production shape of the stranded rows: a `local` provider, an
  // `ephemeral` lease policy, and a `shared_workspace` execution workspace mode
  // whose path is the shared project folder.
  async function seed(input: {
    runStatus: string;
    runErrorCode?: string;
    processPid?: number | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const environmentId = await ensureLocalEnvironment();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked by a stranded lease",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: input.runStatus,
      invocationSource: "manual",
      startedAt: new Date(),
      ...(input.runErrorCode
        ? { error: "Interrupted by platform restart", errorCode: input.runErrorCode }
        : {}),
      ...(input.processPid === undefined ? {} : { processPid: input.processPid }),
      contextSnapshot: { issueId },
    });
    const [lease] = await db
      .insert(environmentLeases)
      .values({
        companyId,
        environmentId,
        issueId,
        heartbeatRunId: runId,
        status: "active",
        leasePolicy: "ephemeral",
        provider: "local",
        releasedAt: null,
        metadata: { driver: "local", executionWorkspaceMode: "shared_workspace" },
      })
      .returning();

    return { companyId, agentId, environmentId, issueId, runId, leaseId: lease!.id };
  }

  async function readLease(leaseId: string) {
    return db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
  }

  it("closes the open lease of a run the platform restart interrupted", async () => {
    const { leaseId } = await seed({
      runStatus: "interrupted",
      runErrorCode: "orphaned_running_run",
    });

    const result = await heartbeatService(db).reconcileLeasesOfTerminalRuns();

    expect(result).toMatchObject({ scanned: 1, released: 1, skipped: 0 });
    const lease = await readLease(leaseId);
    expect(lease?.releasedAt).not.toBeNull();
    expect(lease?.status).toBe("released");
    expect(lease?.failureReason).toBeTruthy();
  });

  it("leaves the lease of a still running run untouched", async () => {
    const { leaseId } = await seed({ runStatus: "running" });

    const result = await heartbeatService(db).reconcileLeasesOfTerminalRuns();

    expect(result).toMatchObject({ scanned: 0, released: 0 });
    const lease = await readLease(leaseId);
    expect(lease?.releasedAt).toBeNull();
    expect(lease?.status).toBe("active");
  });

  it("leaves the lease of a terminal run whose recorded process still answers", async () => {
    // `process.pid` is this test process, so the liveness probe reports the
    // recorded process as alive and the reconciler must not revoke authority.
    const { leaseId } = await seed({
      runStatus: "failed",
      runErrorCode: "process_lost",
      processPid: process.pid,
    });

    const result = await heartbeatService(db).reconcileLeasesOfTerminalRuns();

    expect(result).toMatchObject({ scanned: 1, released: 0, skipped: 1 });
    const lease = await readLease(leaseId);
    expect(lease?.releasedAt).toBeNull();
  });

  it("is idempotent across repeated ticks", async () => {
    const { leaseId } = await seed({
      runStatus: "interrupted",
      runErrorCode: "server_shutdown_interrupted",
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reconcileLeasesOfTerminalRuns();
    const releasedAt = (await readLease(leaseId))?.releasedAt ?? null;
    const second = await heartbeat.reconcileLeasesOfTerminalRuns();

    expect(second).toMatchObject({ scanned: 0, released: 0 });
    expect((await readLease(leaseId))?.releasedAt).toEqual(releasedAt);
  });

  it("releases the lease of a run the stale-lock sweep terminalizes", async () => {
    // The recovery backstop owns this finalization: a terminal issue still
    // holding `executionRunId` gives it the issue-terminal authority to
    // terminalize the run. Before the fix it left the lease open.
    const { issueId, runId, leaseId } = await seed({ runStatus: "running" });
    await db
      .update(issues)
      .set({ status: "done", executionRunId: runId })
      .where(eq(issues.id, issueId));

    const swept = await heartbeatService(db).sweepStaleIssueLocks();

    expect(swept.terminalizedRunIds).toContain(runId);
    const lease = await readLease(leaseId);
    expect(lease?.releasedAt).not.toBeNull();
    expect(lease?.status).toBe("released");
  });

  it("unblocks the recovery resolve that the open lease rejected with a 409", async () => {
    const { companyId, agentId, issueId, runId } = await seed({
      runStatus: "interrupted",
      runErrorCode: "orphaned_running_run",
    });
    const LEASE_CONFLICT =
      "The previous execution environment has not finished releasing its authority.";
    const validate = () =>
      validateExecutionReconciliation({
        db,
        companyId,
        issueId,
        agentId,
        sourceRunId: runId,
        decision: {
          runId,
          providerStopped: true,
          actionOutcome: "not_performed",
          outcomeEvidence: "platform restart interrupted the run before any action",
        },
      });

    await expect(validate()).rejects.toThrow(LEASE_CONFLICT);

    await heartbeatService(db).reconcileLeasesOfTerminalRuns();

    // The resolve may still fail on a later step of the continuation build, so
    // assert on the message rather than on whether it settles: it must never
    // again be the lease condition this fix closes.
    const afterReconcile = await validate().then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(afterReconcile ?? "").not.toContain(LEASE_CONFLICT);
  });
});
