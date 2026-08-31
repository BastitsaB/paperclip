import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../routes/openapi.js";

/**
 * Phase 1 calls the product concept a worktree, but the full HTTP/OpenAPI wire
 * contract intentionally retains its legacy workspace spellings.
 */
describe("worktree terminology OpenAPI contract freeze", () => {
  it("keeps the complete serialized OpenAPI document byte-identical", () => {
    const bytes = JSON.stringify(buildOpenApiSpec());
    const digest = createHash("sha256").update(bytes).digest("hex");

    expect(bytes).toHaveLength(864_411);
    expect(digest).toBe("aa16f3015d27190e647b7236984dfd49096a496a1ec64d7fea8683df6b2944c8");
  });
});
