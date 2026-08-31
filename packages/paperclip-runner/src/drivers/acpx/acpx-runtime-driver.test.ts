import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcpRuntime } from "acpx/runtime";
import { describe, expect, it } from "vitest";

import {
  AcpxRuntimeDriver,
  acpxCapabilities,
  selectAcpxFinalAgentMessage,
} from "./acpx-runtime-driver.js";

describe("ACPX profile capabilities", () => {
  it.each([
    ["codex", "available"],
    ["claude", "available"],
  ] as const)("advertises structured plans for %s as %s", (agent, availability) => {
    const plan = acpxCapabilities(agent).typedEventFamilies
      .find((family) => family.family === "plan");
    expect(plan).toMatchObject({
      availability,
      detailLevel: availability === "available" ? "structured" : "summary",
    });
  });
});

describe("ACPX settled final response", () => {
  it("uses the exact assistant prose present when the semantic result was accepted", () => {
    expect(selectAcpxFinalAgentMessage({
      semanticResultCommitted: true,
      textAtSemanticResult: "- First fact\n- Second fact",
      textAfterLastWorkTool: "- First fact\n- Second fact\nCompleted: task done.",
    })).toBe("- First fact\n- Second fact");
  });

  it("does not promote a trailing acknowledgement when the semantic boundary had no answer", () => {
    expect(selectAcpxFinalAgentMessage({
      semanticResultCommitted: true,
      textAtSemanticResult: null,
      textAfterLastWorkTool: "Completed.",
    })).toBeNull();
  });

  it("preserves a result-less provider final emitted after its last work tool", () => {
    expect(selectAcpxFinalAgentMessage({
      semanticResultCommitted: false,
      textAtSemanticResult: null,
      textAfterLastWorkTool: "  Substantive answer.  ",
    })).toBe("Substantive answer.");
  });
});

describe("ACPX runtime input handoff", () => {
  it("expires a pending elicitation with its full normalized request exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-handoff-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let elicitationResponse: unknown = null;
    const runtimeFactory = (): AcpRuntime => ({
      ensureSession: async () => ({
        sessionKey: "handoff-session",
        backend: "acpx",
        runtimeSessionName: "handoff-runtime",
        acpxRecordId: "handoff-record",
        backendSessionId: "handoff-backend",
        agentSessionId: "handoff-agent",
      }),
      startTurn: (input) => {
        const controller = new AbortController();
        const response = Promise.resolve().then(async () => {
          const value = await input.onElicitation!({
            mode: "form",
            sessionId: "handoff-agent",
            message: "Choose a deployment region.",
            requestedSchema: {
              type: "object",
              title: "Deployment",
              required: ["region"],
              properties: {
                region: {
                  type: "string",
                  title: "Region",
                  oneOf: [
                    { const: "us", title: "US" },
                    { const: "eu", title: "Europe" },
                  ],
                },
              },
            },
          }, { requestId: "elicitation-handoff", signal: controller.signal });
          elicitationResponse = value;
          return value;
        });
        return {
          requestId: input.requestId,
          promptStarted: Promise.resolve(),
          events: { async *[Symbol.asyncIterator]() {} },
          result: response.then(() => ({ status: "cancelled" as const, stopReason: "cancelled" })),
          cancel: async () => controller.abort(),
          closeStream: async () => {},
        };
      },
      runTurn: async function* () {},
      getStatus: async () => ({
        acpxRecordId: "handoff-record",
        backendSessionId: "handoff-backend",
        agentSessionId: "handoff-agent",
        models: { currentModelId: "sonnet", availableModelIds: ["sonnet"] },
      }),
      setConfigOption: async () => {},
      cancel: async () => {},
      close: async () => {},
    });
    const driver = new AcpxRuntimeDriver({
      agent: "claude",
      model: "claude-sonnet-5",
      runtimeDirectory: root,
      runtimeFactory,
    });
    try {
      const session = await driver.openSession({
        runId: "run-acpx-handoff",
        normalizedSessionId: "normalized-acpx-handoff",
        workingDirectory: workspace,
      });
      const iterator = session.events()[Symbol.asyncIterator]();
      const { turnId } = await session.startTurn({ message: { role: "user", text: "Ask first." } });
      let created: Awaited<ReturnType<typeof iterator.next>>["value"] | null = null;
      for (let count = 0; count < 20; count += 1) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.eventType === "runtime_request.created") {
          created = next.value;
          break;
        }
      }
      expect(created).toMatchObject({
        payload: { request: { requestId: "elicitation-handoff", type: "input" } },
      });
      await expect(session.handoffRuntimeRequest?.({
        requestId: "elicitation-handoff",
        turnId,
        reason: "durable_handoff",
      })).resolves.toBe("handed_off");
      await expect(session.handoffRuntimeRequest?.({
        requestId: "elicitation-handoff",
        turnId,
        reason: "durable_handoff",
      })).resolves.toBe("already_settled");
      let expired: Awaited<ReturnType<typeof iterator.next>>["value"] | null = null;
      for (let count = 0; count < 20; count += 1) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value.eventType === "runtime_request.expired") {
          expired = next.value;
          break;
        }
      }
      expect(expired).toMatchObject({
        payload: {
          requestId: "elicitation-handoff",
          reason: "durable_handoff",
          replayAllowed: false,
          requestType: "input",
          request: {
            schema: "paperclip.runtime_request.v2",
            requestId: "elicitation-handoff",
            type: "input",
          },
        },
      });
      await Promise.resolve();
      expect(elicitationResponse).toEqual({ action: "cancel" });
      const terminal = (await session.transcript?.())?.events.filter((event) =>
        event.payload.requestId === "elicitation-handoff"
        && ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(event.eventType)
      );
      expect(terminal).toHaveLength(1);
      await session.close({ reason: "handoff test complete" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
