import { describe, expect, it } from "vitest";

import {
  ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS,
  resolveAcpxHandshakeTimeoutMs,
} from "./constants.js";

describe("resolveAcpxHandshakeTimeoutMs", () => {
  it("keeps the tight default when the override is absent or empty", () => {
    expect(resolveAcpxHandshakeTimeoutMs(undefined)).toBe(ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS);
    expect(resolveAcpxHandshakeTimeoutMs("   ")).toBe(ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS);
  });

  it("honours a widened deadline on a loaded host", () => {
    expect(resolveAcpxHandshakeTimeoutMs("180000")).toBe(180_000);
  });

  // A bad env var must never take the adapter down, and a deadline too small to
  // tell a hung provider from a slow one is a misconfiguration, not an intent.
  it("falls back to the default for unparsable or too-small values", () => {
    expect(resolveAcpxHandshakeTimeoutMs("abc")).toBe(ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS);
    expect(resolveAcpxHandshakeTimeoutMs("4999")).toBe(ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS);
  });

  it("caps an oversized value so a stuck handshake still terminalizes", () => {
    expect(resolveAcpxHandshakeTimeoutMs("99999999")).toBe(600_000);
  });
});
