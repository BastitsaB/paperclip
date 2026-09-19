import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatRunIdMatchesText,
  heartbeatRunIssueMatchesText,
  heartbeatRunIssueMatchesUuid,
  isCanonicalUuidText,
} from "../services/conversation-continuation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-match tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("isCanonicalUuidText", () => {
  it("accepts only the lowercase hyphenated form uuid::text produces", () => {
    expect(isCanonicalUuidText("0b8f3f0e-9c1a-4c55-8a55-5f7d2f4b8e11")).toBe(true);
    expect(isCanonicalUuidText("0B8F3F0E-9C1A-4C55-8A55-5F7D2F4B8E11")).toBe(false);
    expect(isCanonicalUuidText("-".repeat(36))).toBe(false);
    expect(isCanonicalUuidText("0b8f3f0e9c1a4c558a555f7d2f4b8e11")).toBe(false);
    expect(isCanonicalUuidText(" 0b8f3f0e-9c1a-4c55-8a55-5f7d2f4b8e11")).toBe(false);
  });
});

// Equivalence guard: the indexable predicates must select exactly the rows the
// previous text-cast predicates selected, including for malformed evidence.
describeEmbeddedPostgres("conversation continuation run matching", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueA = randomUUID();
  const issueB = randomUUID();
  const runIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-conversation-run-match-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "CRM",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([issueA, issueB].map((id, index) => ({
      id,
      companyId,
      title: `Issue ${index + 1}`,
      status: "in_progress",
      priority: "medium",
      issueNumber: index + 1,
      identifier: `CRM-${index + 1}`,
    })));
    const runs: Array<{ nativeIssueId: string | null; contextSnapshot: Record<string, unknown> | null }> = [
      { nativeIssueId: issueA, contextSnapshot: { issueId: issueB } },
      { nativeIssueId: null, contextSnapshot: { issueId: issueA } },
      { nativeIssueId: null, contextSnapshot: {} },
      { nativeIssueId: null, contextSnapshot: null },
      { nativeIssueId: issueB, contextSnapshot: { issueId: issueA } },
      { nativeIssueId: null, contextSnapshot: { issueId: issueA.toUpperCase() } },
      { nativeIssueId: null, contextSnapshot: { issueId: "not-a-uuid" } },
    ];
    for (const run of runs) {
      const id = randomUUID();
      runIds.push(id);
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        nativeIssueId: run.nativeIssueId,
        contextSnapshot: run.contextSnapshot,
      });
    }
    const evidenceRunIds: Array<string | null> = [
      ...runIds,
      runIds[0]!.toUpperCase(),
      "-".repeat(36),
      "not-a-uuid",
      ` ${runIds[1]}`,
      randomUUID(),
      null,
    ];
    let fingerprint = 0;
    for (const sourceIssueId of [issueA, issueB]) {
      for (const runId of evidenceRunIds) {
        await db.insert(issueRecoveryActions).values({
          companyId,
          sourceIssueId,
          kind: "active_run_watchdog",
          status: "resolved",
          cause: "legacy_execution_requires_reconciliation",
          fingerprint: `fp-${fingerprint++}`,
          evidence: runId === null ? {} : { runId },
          nextAction: "none",
        });
      }
    }
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function joinedPairs(runMatch: SQL, issueMatch: SQL) {
    const rows = await db
      .select({ actionId: issueRecoveryActions.id, runId: heartbeatRuns.id })
      .from(issueRecoveryActions)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, issueRecoveryActions.companyId), runMatch, issueMatch));
    return rows.map((row) => `${row.actionId}:${row.runId}`).sort();
  }

  it("matches recovery evidence to runs exactly like the text-cast join", async () => {
    const before = await joinedPairs(
      sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text`,
    );
    const after = await joinedPairs(
      heartbeatRunIdMatchesText(sql`${issueRecoveryActions.evidence}->>'runId'`),
      heartbeatRunIssueMatchesUuid(sql`${issueRecoveryActions.sourceIssueId}`),
    );
    // Runs 0 (native A), 1 (context A) and 4 (native B) are the only matches.
    expect(before).toHaveLength(3);
    expect(after).toEqual(before);
  });

  it("matches a text issue id exactly like the coalesce comparison", async () => {
    for (const issueId of [issueA, issueB, issueA.toUpperCase(), "not-a-uuid", "", "-".repeat(36)]) {
      const select = (predicate: SQL) => db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), predicate))
        .then((rows) => rows.map((row) => row.id).sort());
      const before = await select(
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
      );
      expect(await select(heartbeatRunIssueMatchesText(issueId)), issueId).toEqual(before);
    }
  });
});
