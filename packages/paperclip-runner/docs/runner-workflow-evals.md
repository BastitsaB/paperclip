# Stress-derived Runner workflow evals

The Runner workflow eval system turns the `STRESS-001`–`STRESS-044` campaign into a credential-free deterministic conformance lane. It is additive to the 41-operation inventory, the 106 capability cases, and the v1 scoring/report readers.

## Lanes

- `pnpm --filter @paperclipai/paperclip-runner test:runner-workflow-evals` runs the credential-free deterministic gate. It exercises all twelve workflow families through sanitized Codex, OpenCode, and ACPX normalization fixtures and validates the versioned contracts, lifecycle gates, traceability, and reports.
- `pnpm --filter @paperclipai/paperclip-runner report:runner-workflow-evals` writes JSON, Markdown, JUnit, and GitHub-safe deterministic reports under `.paperclip-local/evals/workflows/`.

Provider-backed campaigns, paid schedules, and recorded evidence are intentionally outside this package slice. The deterministic lane scores visible activity and lifecycle facts; it does not inspect hidden chain-of-thought content or require exact natural-language phrasing.

The traceability manifest is `spec/evals/stress-workflow-traceability.json`. CI fails if a stress finding is missing, a workflow ID is unknown, or a referenced regression test no longer exists.
