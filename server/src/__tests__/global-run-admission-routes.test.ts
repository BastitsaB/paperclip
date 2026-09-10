import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSvc = vi.hoisted(() => ({
  getState: vi.fn(),
  countGloballyRunning: vi.fn(),
  setCap: vi.fn(),
  setAuthorizedAgentIds: vi.fn(),
  activateEmergencyStop: vi.fn(),
  clearEmergencyStop: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  listCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/global-run-admission.js", () => ({
    globalRunAdmissionService: () => mockSvc,
    GLOBAL_RUN_ADMISSION_MIN_CAP: 1,
    GLOBAL_RUN_ADMISSION_MAX_CAP: 500,
  }));
  vi.doMock("../services/index.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
}

const AUTHORIZED_AGENT_ID = "agent-cos-1";

function baseState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "singleton-1",
    maxConcurrentRuns: 20,
    emergencyStopActive: false,
    emergencyStopReason: null,
    emergencyStopActor: null,
    emergencyStopActivatedAt: null,
    authorizedAgentIds: [AUTHORIZED_AGENT_ID],
    updatedAt: new Date("2026-08-30T00:00:00.000Z"),
    ...overrides,
  };
}

async function createApp(actor: any) {
  const [{ errorHandler }, { globalRunAdmissionRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/global-run-admission.js")>("../routes/global-run-admission.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", globalRunAdmissionRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const LOCAL_BOARD_ADMIN = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
const NON_ADMIN_BOARD = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: ["company-1"] };
const AUTHORIZED_AGENT = { type: "agent", agentId: AUTHORIZED_AGENT_ID, companyId: "company-1", source: "agent_key" };
const UNAUTHORIZED_AGENT = { type: "agent", agentId: "agent-random", companyId: "company-1", source: "agent_key" };

describe("global run admission routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/global-run-admission.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/global-run-admission.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockSvc.getState.mockResolvedValue(baseState());
    mockSvc.countGloballyRunning.mockResolvedValue(0);
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1", "company-2"]);
  });

  describe("GET /run-admission/status", () => {
    // Generous timeout: this is the first test in the file to exercise the
    // vi.resetModules()+dynamic-import(createApp) path, which pays a one-time
    // TS transform/import cost that can exceed vitest's default 5s budget.
    it("is readable by any board or agent actor", async () => {
      const app = await createApp(NON_ADMIN_BOARD);
      const res = await request(app).get("/api/run-admission/status");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ maxConcurrentRuns: 20, emergencyStopActive: false, currentlyRunning: 0 });
    }, 15000);

    it("rejects unauthenticated callers", async () => {
      const app = await createApp({ type: "none" });
      const res = await request(app).get("/api/run-admission/status");
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /run-admission/cap", () => {
    it("allows a local board instance admin", async () => {
      mockSvc.setCap.mockResolvedValue(baseState({ maxConcurrentRuns: 15 }));
      const app = await createApp(LOCAL_BOARD_ADMIN);
      const res = await request(app).patch("/api/run-admission/cap").send({ maxConcurrentRuns: 15, reason: "load test" });
      expect(res.status).toBe(200);
      expect(mockSvc.setCap).toHaveBeenCalledWith(15);
      expect(mockLogActivity).toHaveBeenCalledTimes(2); // fan-out per company
    });

    it("rejects a non-admin board user", async () => {
      const app = await createApp(NON_ADMIN_BOARD);
      const res = await request(app).patch("/api/run-admission/cap").send({ maxConcurrentRuns: 15, reason: "load test" });
      expect(res.status).toBe(403);
      expect(mockSvc.setCap).not.toHaveBeenCalled();
    });

    it("allows an agent on the authorized allowlist", async () => {
      mockSvc.setCap.mockResolvedValue(baseState({ maxConcurrentRuns: 5 }));
      const app = await createApp(AUTHORIZED_AGENT);
      const res = await request(app).patch("/api/run-admission/cap").send({ maxConcurrentRuns: 5, reason: "incident throttling" });
      expect(res.status).toBe(200);
      expect(mockSvc.setCap).toHaveBeenCalledWith(5);
    });

    it("rejects an agent that is not on the authorized allowlist", async () => {
      const app = await createApp(UNAUTHORIZED_AGENT);
      const res = await request(app).patch("/api/run-admission/cap").send({ maxConcurrentRuns: 5, reason: "incident throttling" });
      expect(res.status).toBe(403);
      expect(mockSvc.setCap).not.toHaveBeenCalled();
    });

    it("rejects a missing reason and an out-of-range cap", async () => {
      const app = await createApp(LOCAL_BOARD_ADMIN);
      const missingReason = await request(app).patch("/api/run-admission/cap").send({ maxConcurrentRuns: 5 });
      expect(missingReason.status).toBe(400);
      const outOfRange = await request(app).patch("/api/run-admission/cap").send({ maxConcurrentRuns: 0, reason: "x" });
      expect(outOfRange.status).toBe(400);
      expect(mockSvc.setCap).not.toHaveBeenCalled();
    });
  });

  describe("POST /run-admission/emergency-stop", () => {
    it("allows a local board instance admin and audits the action", async () => {
      mockSvc.activateEmergencyStop.mockResolvedValue(
        baseState({ emergencyStopActive: true, emergencyStopReason: "recovery storm" }),
      );
      const app = await createApp(LOCAL_BOARD_ADMIN);
      const res = await request(app).post("/api/run-admission/emergency-stop").send({ reason: "recovery storm" });
      expect(res.status).toBe(200);
      expect(mockSvc.activateEmergencyStop).toHaveBeenCalledWith({
        reason: "recovery storm",
        actor: { type: "user", id: "local-board" },
      });
      expect(mockLogActivity).toHaveBeenCalledTimes(2);
      expect(mockLogActivity.mock.calls[0][1]).toMatchObject({
        action: "global_run_admission.emergency_stop_activated",
      });
    });

    it("allows an authorized agent (e.g. a Chief-of-Staff/CTO incident-delegate persona) and audits the agent id", async () => {
      mockSvc.activateEmergencyStop.mockResolvedValue(
        baseState({ emergencyStopActive: true, emergencyStopReason: "recovery storm" }),
      );
      const app = await createApp(AUTHORIZED_AGENT);
      const res = await request(app).post("/api/run-admission/emergency-stop").send({ reason: "recovery storm" });
      expect(res.status).toBe(200);
      expect(mockSvc.activateEmergencyStop).toHaveBeenCalledWith({
        reason: "recovery storm",
        actor: { type: "agent", id: AUTHORIZED_AGENT_ID },
      });
    });

    it("rejects an unauthorized agent, a non-admin board user, and requires a reason", async () => {
      const unauthorizedApp = await createApp(UNAUTHORIZED_AGENT);
      const unauthorizedRes = await request(unauthorizedApp).post("/api/run-admission/emergency-stop").send({ reason: "x" });
      expect(unauthorizedRes.status).toBe(403);

      const nonAdminApp = await createApp(NON_ADMIN_BOARD);
      const nonAdminRes = await request(nonAdminApp).post("/api/run-admission/emergency-stop").send({ reason: "x" });
      expect(nonAdminRes.status).toBe(403);

      const missingReasonApp = await createApp(LOCAL_BOARD_ADMIN);
      const missingReasonRes = await request(missingReasonApp).post("/api/run-admission/emergency-stop").send({});
      expect(missingReasonRes.status).toBe(400);

      expect(mockSvc.activateEmergencyStop).not.toHaveBeenCalled();
    });

    it("rejects activating an already-active emergency stop", async () => {
      mockSvc.getState.mockResolvedValue(baseState({ emergencyStopActive: true, emergencyStopReason: "already stopped" }));
      const app = await createApp(LOCAL_BOARD_ADMIN);
      const res = await request(app).post("/api/run-admission/emergency-stop").send({ reason: "second attempt" });
      expect(res.status).toBe(400);
      expect(mockSvc.activateEmergencyStop).not.toHaveBeenCalled();
    });
  });

  describe("POST /run-admission/resume", () => {
    it("requires the same governance access as the stop, and never resumes automatically", async () => {
      mockSvc.getState.mockResolvedValue(baseState({ emergencyStopActive: true, emergencyStopReason: "recovery storm" }));
      mockSvc.clearEmergencyStop.mockResolvedValue(baseState({ emergencyStopActive: false }));

      const unauthorizedApp = await createApp(UNAUTHORIZED_AGENT);
      const unauthorizedRes = await request(unauthorizedApp).post("/api/run-admission/resume").send({});
      expect(unauthorizedRes.status).toBe(403);
      expect(mockSvc.clearEmergencyStop).not.toHaveBeenCalled();

      const app = await createApp(LOCAL_BOARD_ADMIN);
      const res = await request(app).post("/api/run-admission/resume").send({ reason: "root cause fixed, quota confirmed" });
      expect(res.status).toBe(200);
      expect(mockSvc.clearEmergencyStop).toHaveBeenCalledTimes(1);
      expect(mockLogActivity.mock.calls.some(([, entry]: any) =>
        entry.action === "global_run_admission.emergency_stop_resumed")).toBe(true);
    });

    it("rejects resuming when the stop is not active", async () => {
      mockSvc.getState.mockResolvedValue(baseState({ emergencyStopActive: false }));
      const app = await createApp(LOCAL_BOARD_ADMIN);
      const res = await request(app).post("/api/run-admission/resume").send({});
      expect(res.status).toBe(400);
      expect(mockSvc.clearEmergencyStop).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /run-admission/authorized-agents", () => {
    it("allows only a human instance admin, never an agent even if already authorized", async () => {
      mockSvc.setAuthorizedAgentIds.mockResolvedValue(baseState({ authorizedAgentIds: ["agent-cos-2"] }));
      const adminApp = await createApp(LOCAL_BOARD_ADMIN);
      const adminRes = await request(adminApp)
        .patch("/api/run-admission/authorized-agents")
        .send({ agentIds: ["agent-cos-2"], reason: "swap incident delegate" });
      expect(adminRes.status).toBe(200);
      expect(mockSvc.setAuthorizedAgentIds).toHaveBeenCalledWith(["agent-cos-2"]);

      const agentApp = await createApp(AUTHORIZED_AGENT);
      const agentRes = await request(agentApp)
        .patch("/api/run-admission/authorized-agents")
        .send({ agentIds: [AUTHORIZED_AGENT_ID, "agent-extra"], reason: "self-escalation attempt" });
      expect(agentRes.status).toBe(403);

      const nonAdminApp = await createApp(NON_ADMIN_BOARD);
      const nonAdminRes = await request(nonAdminApp)
        .patch("/api/run-admission/authorized-agents")
        .send({ agentIds: [], reason: "x" });
      expect(nonAdminRes.status).toBe(403);

      expect(mockSvc.setAuthorizedAgentIds).toHaveBeenCalledTimes(1);
    });
  });
});

