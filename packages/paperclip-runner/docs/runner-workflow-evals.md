# Stress-derived Runner workflow evals

The Runner workflow eval system turns the `STRESS-001`–`STRESS-044` campaign into three complementary lanes. It is additive to the 41-operation inventory, the 106 capability cases, and the v1 scoring/report readers.

## Lanes

- `pnpm --filter @paperclipai/paperclip-runner test:runner-workflow-evals` runs the credential-free deterministic PR gate. It exercises all twelve workflow families through sanitized Codex, OpenCode, and ACPX normalization fixtures and validates the versioned contracts, lifecycle gates, schedule, traceability, reports, and alert policy.
- `pnpm --filter @paperclipai/paperclip-runner report:runner-workflow-evals` writes JSON, Markdown, JUnit, and GitHub-safe deterministic reports under `.paperclip-local/evals/workflows/`.
- `pnpm --filter @paperclipai/paperclip-runner report:runner-live-evals` runs the balanced forty-execution nightly matrix against real provider sessions. Live candidate failures are trend-only. Missing credentials, qualification failures, and provider outages are unscored; one retry is allowed only for retryable infrastructure failures.
- `pnpm --filter @paperclipai/paperclip-runner report:runner-chaos-evals` writes the eight-scenario fault schedule. The weekly and pre-release workflow executes the corresponding Runner and server restart, replay, trace, finalization, interaction, and wake-race regression suites.

The checked-in candidate manifest stores only adapter, model, reasoning configuration, qualification variable names, and budgets. Credentials remain in the environment. `PAPERCLIP_EVAL_MAX_CAMPAIGN_COST_USD` defaults to 12 USD for scheduled live runs.

## Trace and reasoning safety

Every live execution opts into provider tracing in a run-local mode-`0600` sidecar. The evaluator verifies raw frame byte lengths, SHA-256 digests, order, dispositions, and lineage, retains only redacted observations plus a trace digest, and destroys the exact temporary trace after the execution. Exact prompts, credentials, tool arguments, and reasoning text never enter eval reports or GitHub artifacts. Production Runner traces continue to use the restricted 24-hour trace store and run inspector.

The evals score time to first visible progress and visible activity families. They do not inspect or grade hidden chain-of-thought content or require exact natural-language phrasing.

## Compatibility and trends

The live bundle ID binds the Runner version, prompt policy, schedule seed, adapters, resolved models, and reasoning settings. Comparisons and rolling seven-day alerts use only matching bundle IDs. Baseline alerts remain off until seven compatible reports exist. Safe reports are retained for 30 days; exact raw provider traces are never uploaded.

The traceability manifest is `spec/evals/stress-workflow-traceability.json`. CI fails if a stress finding is missing, a workflow ID is unknown, or a referenced regression test no longer exists.
