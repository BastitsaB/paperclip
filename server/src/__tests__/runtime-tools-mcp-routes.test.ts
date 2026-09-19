import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockConnectionIntentService = vi.hoisted(() => ({
  validate: vi.fn(),
}));
const mockVerifyRuntimeToolsToken = vi.hoisted(() => vi.fn());

vi.mock("../services/connection-intents.js", () => ({
  connectionIntentService: () => mockConnectionIntentService,
}));
vi.mock("../runtime-tools-token.js", () => ({
  verifyRuntimeToolsToken: mockVerifyRuntimeToolsToken,
}));

const { runtimeConnectionIntentRoutes } = await import("../routes/connection-intents.js");
const { errorHandler } = await import("../middleware/index.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(runtimeConnectionIntentRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

describe("GET /mcp/runtime-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyRuntimeToolsToken.mockImplementation((token: string) =>
      token === "valid" ? { sub: "agent-1", company_id: "company-1", run_id: "run-1" } : null);
    mockConnectionIntentService.validate.mockResolvedValue(undefined);
  });

  it("answers the Streamable HTTP SSE probe with 405 so MCP clients do not reconnect in a loop", async () => {
    const res = await request(createApp())
      .get("/mcp/runtime-tools")
      .set("Authorization", "Bearer valid")
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(res.text).toBe("");
    expect(mockConnectionIntentService.validate).toHaveBeenCalledTimes(1);
  });

  it("keeps the JSON description for plain GETs", async () => {
    const res = await request(createApp())
      .get("/mcp/runtime-tools")
      .set("Authorization", "Bearer valid")
      .set("Accept", "application/json");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "paperclip-runtime-tools", protocolVersion: "2025-03-26" });
  });

  it("still rejects an invalid token before answering the SSE probe", async () => {
    const res = await request(createApp())
      .get("/mcp/runtime-tools")
      .set("Authorization", "Bearer invalid")
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(401);
    expect(mockConnectionIntentService.validate).not.toHaveBeenCalled();
  });
});
