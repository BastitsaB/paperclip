import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, globalRunAdmission, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { globalRunAdmissionService } from "../services/global-run-admission.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres global run admission tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("global run admission service (MAI-890/MAI-1035)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof globalRunAdmissionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-global-run-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(globalRunAdmission);
  });

  async function seedCompanyAndAgent() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
    });
  }

  async function insertRunningRun() {
    const [row] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: "running",
        invocationSource: "on_demand",
      })
      .returning();
    return row.id;
  }

  it("defaults to a cap of 20, no emergency stop, and no authorized agents", async () => {
    svc = globalRunAdmissionService(db);
    const state = await svc.getState({ bypassCache: true });
    expect(state.maxConcurrentRuns).toBe(20);
    expect(state.emergencyStopActive).toBe(false);
    expect(state.emergencyStopReason).toBeNull();
    expect(state.authorizedAgentIds).toEqual([]);
  });

  it("clamps the cap to the documented [1, 500] range", async () => {
    svc = globalRunAdmissionService(db);
    expect((await svc.setCap(0)).maxConcurrentRuns).toBe(1);
    expect((await svc.setCap(-5)).maxConcurrentRuns).toBe(1);
    expect((await svc.setCap(10_000)).maxConcurrentRuns).toBe(500);
    expect((await svc.setCap(7)).maxConcurrentRuns).toBe(7);
  });

  it("dedupes and drops blank entries when setting the authorized-agent allowlist", async () => {
    svc = globalRunAdmissionService(db);
    const a = randomUUID();
    const state = await svc.setAuthorizedAgentIds([a, a, "  ", "", a]);
    expect(state.authorizedAgentIds).toEqual([a]);
  });

  describe("with a seeded company/agent", () => {
    beforeAll(async () => {
      svc = globalRunAdmissionService(db);
    });

    it("admitOne denies once the global running count reaches the cap, and allows again once a slot frees", async () => {
      await seedCompanyAndAgent();
      await svc.setCap(2);
      await insertRunningRun();
      await insertRunningRun();

      const denied = await db.transaction((tx) => svc.admitOne(tx as any));
      expect(denied).toMatchObject({ allowed: false, code: "cap_reached" });

      const runningCount = await svc.countGloballyRunning();
      expect(runningCount).toBe(2);

      // Free a slot and confirm admission reopens.
      const [oneRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).limit(1);
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, oneRun.id));

      const allowed = await db.transaction((tx) => svc.admitOne(tx as any));
      expect(allowed).toEqual({ allowed: true });
    });

    it("admitOne denies with emergency_stop even when there is spare cap, and allows again once cleared", async () => {
      await seedCompanyAndAgent();
      await svc.setCap(20);
      await svc.activateEmergencyStop({ reason: "runaway recovery storm", actor: { type: "user", id: "board-user-1" } });

      const denied = await db.transaction((tx) => svc.admitOne(tx as any));
      expect(denied).toMatchObject({ allowed: false, code: "emergency_stop" });
      expect((denied as any).reason).toContain("runaway recovery storm");

      const stateWhileStopped = await svc.getState({ bypassCache: true });
      expect(stateWhileStopped.emergencyStopActive).toBe(true);
      expect(stateWhileStopped.emergencyStopActor).toEqual({ type: "user", id: "board-user-1" });

      const resumed = await svc.clearEmergencyStop();
      expect(resumed.emergencyStopActive).toBe(false);
      expect(resumed.emergencyStopReason).toBeNull();
      // Cap is untouched by resume — resume re-checks the existing cap, it
      // does not reset or bypass it.
      expect(resumed.maxConcurrentRuns).toBe(20);

      const allowedAfterResume = await db.transaction((tx) => svc.admitOne(tx as any));
      expect(allowedAfterResume).toEqual({ allowed: true });
    });

    it("never lets concurrent admitOne callers collectively exceed the cap (race safety)", async () => {
      await seedCompanyAndAgent();
      const cap = 3;
      const concurrentAttempts = 12;
      await svc.setCap(cap);

      // Simulate `concurrentAttempts` agents racing to claim a run slot at
      // the same instant: each opens its own transaction, calls admitOne
      // (which takes the shared advisory lock), and if allowed, inserts its
      // own "running" row before committing — mirroring exactly what
      // heartbeat.ts claimQueuedRun does around the real queued->running
      // update. Without the advisory lock serializing these, every
      // concurrent reader would observe running=0 and all would be admitted.
      const results = await Promise.all(
        Array.from({ length: concurrentAttempts }, () =>
          db.transaction(async (tx) => {
            const admission = await svc.admitOne(tx as any);
            if (!admission.allowed) return admission;
            await (tx as any)
              .insert(heartbeatRuns)
              .values({ companyId, agentId, status: "running", invocationSource: "on_demand" });
            return admission;
          }),
        ),
      );

      const allowedCount = results.filter((r) => r.allowed).length;
      const deniedCount = results.filter((r) => !r.allowed).length;
      expect(allowedCount).toBe(cap);
      expect(deniedCount).toBe(concurrentAttempts - cap);
      expect(results.filter((r) => !r.allowed).every((r: any) => r.code === "cap_reached")).toBe(true);

      const finalRunningCount = await svc.countGloballyRunning();
      expect(finalRunningCount).toBe(cap);
    }, 20_000);
  });
});

