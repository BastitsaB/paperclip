import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";

// MAI-1501/MAI-1502: the atomic PATCH {status:"in_review", assigneeAgentId}
// was rejected with 409 "Issue follow-up requires an assigned agent" even
// when the very same payload set a valid agent assignee, because the
// follow-up authority check evaluated the pre-mutation assigneeAgentId
// instead of the value the payload was atomically setting.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres atomic review-assignee transition route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("atomic assignee/review transition on PATCH /api/issues/:id", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-atomic-review-assignee-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  async function seedCompanyAndAgent(name: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
    });
    return { companyId, agentId, issuePrefix };
  }

  async function seedBlockedIssue(input: {
    companyId: string;
    issuePrefix: string;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Directly assigned owner task",
      status: "blocked",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      issueNumber: 1,
      identifier: `${input.issuePrefix}-1`,
    });
    return issueId;
  }

  async function seedOwnRunContext(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
  }

  it("keeps the 409 follow-up error when in_review is requested without a valid agent assignee", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent("Chief of Staff");
    // Issue is directly assigned to a human only (assigneeAgentId=null) —
    // exactly the MAI-1405-style state.
    const issueId = await seedBlockedIssue({ companyId, issuePrefix, assigneeUserId: "board-user" });

    const res = await request(createApp(agentActor(companyId, agentId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue follow-up requires an assigned agent");

    const stillBlocked = await svc.getById(issueId);
    expect(stillBlocked?.status).toBe("blocked");
  });

  it("allows the atomic PATCH to in_review when the same payload sets a valid agent assignee, and reports the review as covered", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent("Chief of Staff");
    const issueId = await seedBlockedIssue({ companyId, issuePrefix, assigneeUserId: "board-user" });
    const actor = agentActor(companyId, agentId) as { runId: string };
    await seedOwnRunContext({ companyId, agentId, runId: actor.runId, issueId });
    // An issue can never carry both an agent and a user assignee at once
    // (services/issues.ts "Issue can only have one assignee"), so the atomic
    // takeover must clear assigneeUserId in the same payload that sets the
    // new agent assignee. Clearing it also means the pre-existing
    // agent-authored in_review disposition guard (routes/issues.ts
    // assertInReviewReviewPath, unrelated to this fix) needs its own real
    // review path — a pending interaction is the simplest one a PATCH can
    // rely on already existing.
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Review before proceeding?" },
    });

    const res = await request(createApp(actor))
      .patch(`/api/issues/${issueId}`)
      .set("X-Paperclip-Run-Id", actor.runId)
      .send({ status: "in_review", assigneeAgentId: agentId, assigneeUserId: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.assigneeAgentId).toBe(agentId);
    expect(res.body.assigneeUserId).toBeNull();

    const rows = await svc.list(companyId, { status: "in_review" });
    const updated = rows.find((row) => row.id === issueId);
    expect(updated?.reviewAttention).toMatchObject({ state: "covered" });
  });

  it("still allows a regular already-assigned agent task to resume without an atomic reassignment (regression)", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent("Regular Agent");
    const issueId = await seedBlockedIssue({ companyId, issuePrefix, assigneeAgentId: agentId });
    const actor = agentActor(companyId, agentId) as { runId: string };
    await seedOwnRunContext({ companyId, agentId, runId: actor.runId, issueId });

    const res = await request(createApp(actor))
      .patch(`/api/issues/${issueId}`)
      .set("X-Paperclip-Run-Id", actor.runId)
      .send({ status: "in_progress" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("still rejects a non-in_review status transition without an assignee even if the payload sets one (scope stays minimal)", async () => {
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent("Chief of Staff");
    const issueId = await seedBlockedIssue({ companyId, issuePrefix, assigneeUserId: "board-user" });

    const res = await request(createApp(agentActor(companyId, agentId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", assigneeAgentId: agentId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue follow-up requires an assigned agent");
  });
});
