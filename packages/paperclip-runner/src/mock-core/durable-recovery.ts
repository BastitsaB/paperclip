/**
 * Test-harness compatibility exports. The durable PRP authority is production
 * code and lives under `control-plane/`; fault scenarios remain available here
 * so existing conformance imports do not become production dependencies.
 */
export * from "../control-plane/durable-prp-control-plane.js";
