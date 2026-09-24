import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";
import { issueService } from "../services/issues.ts";
import {
  allowsUnassignedInProgressControlTest,
  hasTaskHealthControlTestMarker,
  TASK_HEALTH_CONTROL_TEST_MARKER,
} from "../services/task-health-control-test.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MARKER_DESCRIPTION = [
  TASK_HEALTH_CONTROL_TEST_MARKER,
  "TEST_START_UTC: 2026-09-19T18:00:00Z",
  "",
  "Synthetischer Kontrolltest.",
].join("\n");

const NEAR_MISS_DESCRIPTIONS = [
  "CONTROL_TEST_MODE: task-health-e2e-v2",
  "CONTROL_TEST_MODE: task-health-e2e-v10",
  "CONTROL_TEST_MODE: task-health-e2e-v1-extra",
  "control_test_mode: task-health-e2e-v1",
  "CONTROL_TEST_MODE:task-health-e2e-v1",
  `Siehe ${TASK_HEALTH_CONTROL_TEST_MARKER}`,
  `\`${TASK_HEALTH_CONTROL_TEST_MARKER}\``,
];

describe("task-health control test marker", () => {
  it("matches only the exact marker line", () => {
    expect(hasTaskHealthControlTestMarker(MARKER_DESCRIPTION)).toBe(true);
    expect(hasTaskHealthControlTestMarker(`Kopf\r\n  ${TASK_HEALTH_CONTROL_TEST_MARKER}  \r\nRest`)).toBe(true);
    for (const description of NEAR_MISS_DESCRIPTIONS) {
      expect(hasTaskHealthControlTestMarker(description), description).toBe(false);
    }
    expect(hasTaskHealthControlTestMarker(null)).toBe(false);
    expect(hasTaskHealthControlTestMarker(undefined)).toBe(false);
    expect(hasTaskHealthControlTestMarker("")).toBe(false);
  });

  it("requires the issue to be blocker-free and without execution policy", () => {
    const base = { description: MARKER_DESCRIPTION, blockerCount: 0, executionPolicy: null };
    expect(allowsUnassignedInProgressControlTest(base)).toBe(true);
    expect(allowsUnassignedInProgressControlTest({ ...base, executionPolicy: undefined })).toBe(true);
    expect(allowsUnassignedInProgressControlTest({ ...base, blockerCount: 1 })).toBe(false);
    expect(allowsUnassignedInProgressControlTest({ ...base, executionPolicy: {} })).toBe(false);
    expect(allowsUnassignedInProgressControlTest({ ...base, description: "ohne Marker" })).toBe(false);
  });
});

describeEmbeddedPostgres("issueService task-health control test mode", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-health-control-test-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function readBack(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const blockers = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, issueId));
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, row!.companyId));
    return { row: row!, comments, blockers, runs };
  }

  function expectInertControlTest(readback: Awaited<ReturnType<typeof readBack>>) {
    expect(readback.row).toMatchObject({
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: null,
      executionPolicy: null,
      monitorNextCheckAt: null,
      monitorWakeRequestedAt: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(readback.comments).toEqual([]);
    expect(readback.blockers).toEqual([]);
    expect(readback.runs).toEqual([]);
  }

  it("creates an unassigned in_progress issue only for the exact marker", async () => {
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      title: "Task-Health E2E CONTROL_TEST_MODE task-health-e2e-v1 (synthetisch)",
      description: MARKER_DESCRIPTION,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      blockedByIssueIds: [],
    });

    expectInertControlTest(await readBack(created.id));

    // The create route hands every new issue to the assignment wakeup; without an
    // assignee agent that must not start a run.
    const wakeup = vi.fn(async () => undefined);
    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: created,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("keeps rejecting unassigned in_progress issues without the exact marker", async () => {
    const companyId = await seedCompany();

    for (const description of [null, "Normaler Vorgang", ...NEAR_MISS_DESCRIPTIONS]) {
      await expect(svc.create(companyId, {
        title: "Kein Kontrolltest",
        description,
        status: "in_progress",
        priority: "medium",
      }), String(description)).rejects.toMatchObject({
        status: 422,
        message: "in_progress issues require an assignee",
      });
    }
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toEqual([]);
  });

  it("rejects the marker when the issue carries blockers or an execution policy", async () => {
    const companyId = await seedCompany();
    const blocker = await svc.create(companyId, {
      title: "Blocker",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.create(companyId, {
      title: "Kontrolltest mit Blocker",
      description: MARKER_DESCRIPTION,
      status: "in_progress",
      priority: "medium",
      blockedByIssueIds: [blocker.id],
    })).rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });

    await expect(svc.create(companyId, {
      title: "Kontrolltest mit Policy",
      description: MARKER_DESCRIPTION,
      status: "in_progress",
      priority: "medium",
      executionPolicy: { mode: "normal", commentRequired: true, stages: [] },
    })).rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });

    await expect(svc.create(companyId, {
      title: "Kontrolltest mit Watchdog",
      description: MARKER_DESCRIPTION,
      status: "in_progress",
      priority: "medium",
      watchdog: { agentId: randomUUID() },
    })).rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });

    const rows = await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, companyId));
    expect(rows.map((row) => row.id)).toEqual([blocker.id]);
  });

  it("keeps the invariants of a running control test on later edits", async () => {
    const companyId = await seedCompany();
    const issue = await svc.create(companyId, {
      title: "Kontrolltest",
      description: MARKER_DESCRIPTION,
      status: "in_progress",
      priority: "medium",
    });
    const blocker = await svc.create(companyId, {
      title: "Blocker",
      status: "todo",
      priority: "medium",
    });

    for (const patch of [
      { description: "Marker entfernt" },
      { blockedByIssueIds: [blocker.id] },
      { executionPolicy: { mode: "normal", commentRequired: true, stages: [] } },
    ]) {
      await expect(svc.update(issue.id, patch), JSON.stringify(patch))
        .rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });
    }

    await svc.update(issue.id, { title: "Kontrolltest umbenannt" });
    const readback = await readBack(issue.id);
    expectInertControlTest(readback);
    expect(readback.row.description).toBe(MARKER_DESCRIPTION);
  });

  it("counts only relations that block the marker issue", async () => {
    const companyId = await seedCompany();
    const marked = await svc.create(companyId, {
      title: "Kontrolltest",
      description: MARKER_DESCRIPTION,
      status: "todo",
      priority: "medium",
    });
    const dependent = await svc.create(companyId, {
      title: "Wartet auf den Kontrolltest",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: marked.id,
      relatedIssueId: dependent.id,
      type: "blocks",
    });

    await svc.update(marked.id, { status: "in_progress" });

    const [row] = await db.select().from(issues).where(eq(issues.id, marked.id));
    expect(row).toMatchObject({ status: "in_progress", assigneeAgentId: null, assigneeUserId: null });
  });

  it("accepts clearing existing blockers in the same update", async () => {
    const companyId = await seedCompany();
    const blocker = await svc.create(companyId, {
      title: "Blocker",
      status: "todo",
      priority: "medium",
    });
    const marked = await svc.create(companyId, {
      title: "Kontrolltest",
      description: MARKER_DESCRIPTION,
      status: "todo",
      priority: "medium",
      blockedByIssueIds: [blocker.id],
    });

    await svc.update(marked.id, { status: "in_progress", blockedByIssueIds: [] });

    expectInertControlTest(await readBack(marked.id));
  });

  it("rejects the marker when a stored execution policy stays in place", async () => {
    const companyId = await seedCompany();
    const marked = await svc.create(companyId, {
      title: "Kontrolltest",
      description: MARKER_DESCRIPTION,
      status: "todo",
      priority: "medium",
    });
    await db
      .update(issues)
      .set({ executionPolicy: { mode: "normal", commentRequired: true, stages: [] } })
      .where(eq(issues.id, marked.id));

    await expect(svc.update(marked.id, { status: "in_progress" }))
      .rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });
  });

  it("moves an unassigned marker issue into progress via update", async () => {
    const companyId = await seedCompany();
    const issue = await svc.create(companyId, {
      title: "Kontrolltest",
      description: MARKER_DESCRIPTION,
      status: "todo",
      priority: "medium",
    });

    await svc.update(issue.id, { status: "in_progress" });

    expectInertControlTest(await readBack(issue.id));
  });

  it("keeps rejecting updates without the marker, with a removed marker, or with blockers", async () => {
    const companyId = await seedCompany();
    const plain = await svc.create(companyId, {
      title: "Normaler Vorgang",
      description: "Ohne Marker",
      status: "todo",
      priority: "medium",
    });
    await expect(svc.update(plain.id, { status: "in_progress" }))
      .rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });

    const marked = await svc.create(companyId, {
      title: "Kontrolltest",
      description: MARKER_DESCRIPTION,
      status: "todo",
      priority: "medium",
    });
    await expect(svc.update(marked.id, { status: "in_progress", description: "Marker entfernt" }))
      .rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });

    const blocker = await svc.create(companyId, {
      title: "Blocker",
      status: "todo",
      priority: "medium",
    });
    await expect(svc.update(marked.id, { status: "in_progress", blockedByIssueIds: [blocker.id] }))
      .rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });

    await db.insert(issueRelations).values({
      companyId,
      issueId: blocker.id,
      relatedIssueId: marked.id,
      type: "blocks",
    });
    await expect(svc.update(marked.id, { status: "in_progress" }))
      .rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });

    const plainAssigned = await db.insert(issues).values({
      companyId,
      title: "Normaler Vorgang mit Assignee",
      status: "todo",
      priority: "medium",
      assigneeUserId: "board-user",
    }).returning().then((rows) => rows[0]!);
    await expect(svc.update(plainAssigned.id, { status: "in_progress", assigneeUserId: null }))
      .rejects.toMatchObject({ status: 422, message: "in_progress issues require an assignee" });

    const statuses = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(statuses.every((row) => row.status === "todo")).toBe(true);
  });
});
