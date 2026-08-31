import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  assessProviderTraceEntries,
  providerTraceRequiredChannels,
  redactProviderTraceFrame,
} from "../services/provider-trace-store.js";

function frame(payload: unknown) {
  return {
    kind: "frame",
    schema: "paperclip.provider_trace_frame.v1",
    frameId: 1,
    rawBase64: Buffer.from(JSON.stringify(payload)).toString("base64"),
  };
}

describe("provider trace redaction", () => {
  it("removes exact bytes and masks secret-shaped fields and values", () => {
    const redacted = redactProviderTraceFrame(
      frame({
        authorization: "Bearer exact-token-value",
        message: "sk-abcdefghijklmnopqrstuvwxyz",
        nested: { apiKey: "also-secret", safe: "visible" },
      }),
    );

    expect(redacted).not.toHaveProperty("rawBase64");
    expect(redacted.parsed).toEqual({
      authorization: "[withheld]",
      message: "[withheld]",
      nested: { apiKey: "[withheld]", safe: "visible" },
    });
    expect(redacted.withheldPaths).toEqual([
      "authorization",
      "message",
      "nested.apiKey",
    ]);
  });

  it("withholds reasoning item content while retaining routing metadata", () => {
    const redacted = redactProviderTraceFrame(
      frame({
        item: {
          id: "reason-1",
          type: "reasoning",
          status: "completed",
          summary: ["private chain"],
          encrypted_content: "ciphertext",
        },
      }),
    );

    expect(redacted.parsed).toEqual({
      item: {
        id: "reason-1",
        type: "reasoning",
        status: "completed",
        summary: "[withheld]",
        encrypted_content: "[withheld]",
      },
    });
    expect(redacted.withheldPaths).toContain("item.summary");
  });
});

describe("provider trace channel integrity", () => {
  it("requires each provider's actual native transport topology", () => {
    expect(providerTraceRequiredChannels("codex")).toEqual([
      "rust_native",
      "typescript_runnerd_rehydration",
    ]);
    expect(providerTraceRequiredChannels("opencode")).toEqual(["typescript_opencode_native"]);
    expect(providerTraceRequiredChannels("acpx")).toEqual(["typescript_acpx_native"]);
  });

  function completeChannel(channel: string, raw = Buffer.from("{}")) {
    return [
      {
        kind: "frame",
        debugChannel: channel,
        debugSequence: 1,
        frameId: 1,
        rawBase64: raw.toString("base64"),
        byteLength: raw.byteLength,
        digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      },
      {
        kind: "trace_status",
        debugChannel: channel,
        debugSequence: 2,
        acknowledgedDebugSequence: 1,
        status: "complete",
        reason: null,
      },
    ];
  }

  it("accepts independently sequenced and acknowledged debug channels", () => {
    expect(
      assessProviderTraceEntries([
        ...completeChannel("rust_native"),
        ...completeChannel("typescript_runnerd_rehydration"),
      ]),
    ).toEqual({ status: "complete", reason: null });
  });

  it("marks gaps, missing acknowledgements, and digest changes incomplete", () => {
    const gap = completeChannel("rust_native");
    gap[1]!.debugSequence = 3;
    expect(assessProviderTraceEntries(gap).reason).toBe(
      "trace_debug_sequence_gap:rust_native",
    );

    const noAck = completeChannel("rust_native").slice(0, 1);
    expect(assessProviderTraceEntries(noAck).reason).toBe(
      "trace_channel_ack_missing:rust_native",
    );

    const changed = completeChannel("rust_native");
    changed[0]!.rawBase64 = Buffer.from("changed").toString("base64");
    expect(assessProviderTraceEntries(changed).reason).toBe(
      "provider_frame_digest_mismatch",
    );
  });
});
