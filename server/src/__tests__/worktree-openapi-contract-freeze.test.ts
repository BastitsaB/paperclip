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

    expect(bytes).toHaveLength(846_788);
    expect(digest).toBe("c399d60ca6547d15a16f60fec378f891ce4a4bbda2f36a03322b22c3502a0c78");
  });
});
