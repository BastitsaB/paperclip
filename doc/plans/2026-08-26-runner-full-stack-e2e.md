# Paid Full-Stack Runner E2E Test System

**Status:** Implemented; live credentialed acceptance and nightly activation pending.

## Objective

Provide a browser-based, paid acceptance system that proves Paperclip can
configure an agent, create and assign a task through the UI, run that task in a
real local or Daytona execution environment, render the final answer, and
persist the correct task/run/runtime state.

The system now has two durable suites. **Core Runner Compatibility** preserves
the eight production-owned runner profiles × two environments × three
deterministic workflows: 48 cells and 80 expected paid agent turns.
**OpenRouter Model Breadth** adds five ranked, tool-capable OpenRouter models ×
native local OpenCode × three workflows: 15 cells and 25 expected turns. A
complete campaign is 63 independently scheduled cells and 105 expected turns.
It is independent of the general E2E suite and never runs on pull requests or
ordinary pushes.

## Implemented architecture

`tests/runner-e2e/launch.ts` is the billable entry point. It parses explicit
selectors, loads the ignored local credential file with shell precedence,
validates credential/image requirements, and schedules independent scenarios
through a bounded worker pool. Each profile/environment/case execution receives
its own Paperclip process. The dependent draft, revision, acceptance, and final
verification turns of the Plan scenario remain ordered inside that execution;
unrelated executions overlap. A retry receives a completely fresh harness.
Every attempt allocates a new OS temporary root with a Paperclip home, embedded
database, workspace, private artifacts, logs, port, instance ID, and signing
secrets.

Local runs default to one worker and are intended for a narrow `--id` smoke
test. The high-parallelism full matrix is a GitHub Actions responsibility; an
operator must explicitly raise `--max-parallel` to overlap local stacks. The
harness disables Paperclip's normal post-onboarding desktop browser launch so
Playwright is the only browser owner.

The launcher deletes ambient database URLs. `playwright.config.ts` separately
constructs the Paperclip child environment and strips OpenAI, Anthropic,
OpenRouter, and Daytona variables. It starts
`paperclipai onboard --yes --run`, waits on `/api/health`, refuses server reuse,
and requires the generated embedded Postgres path to remain below the allocated
temporary root. Local storage, database backups, logs, and the generated
encrypted-secrets master key are also pinned below that root and verified from
the resolved configuration.

`runner.spec.ts` performs the live path:

1. enable native runner flags required by the selected cell;
2. create a unique company through `/api/companies`;
3. POST required credential values once to the encrypted company-secrets API;
4. discover the isolated instance-managed local environment or create Daytona;
5. create the agent with secret references through the public agents API;
6. open the issues UI, create the nonce-bearing task, select the agent, and
   submit `Create Task`;
7. rely on assigned-task wake behavior;
8. discover the issue through the public API and open its task page;
9. execute any fixture-defined browser follow-ups and wait for the marker and
   `Done` state in the UI;
10. assert the fixture's expected successful run count, no recovery
    continuation or pending interaction,
    expected runtime mode, environment ID/lease, and isolated workspace through
    public APIs; and
11. capture selected-run token/provider-cost records and environment lease
    durations through public APIs;
12. capture phase screenshots (initial/revised Plan where applicable and final
    state) and tear fixtures down in reverse order.

No production endpoint/schema was added and direct database writes are absent.

## Suites, catalog, and deterministic tasks

`catalog.ts` imports production model/qualification constants. It defines the
legacy Codex, Claude, and OpenCode profiles and native Codex, OpenCode, ACPX Pi,
ACPX Claude, and ACPX Codex profiles. Each is crossed with local and Daytona.

Catalog startup validates unique IDs, shared agent/environment schemas,
declared credentials, supported combinations, raw secret-looking values,
known selectors, exact suite sizes of 48 and 15, and exactly 63 total
executions. Globally unique IDs are
`<suite>.<profile>.<environment>.<case>`. Interfaces are in `types.ts`;
fixture dependency management is in `fixture-registry.ts`; deterministic
matcher behavior is in `matchers.ts`.

The `message-marker` case requires one basic final marker and task completion.
The `ask-question` case creates the task in Ask mode, asks a deterministic
question, verifies its visible answer marker, and verifies Done. The
`plan-revise-accept` case creates a planning task, verifies a two-step canonical
Plan and revision-bound confirmation, requests a three-step revision through
the browser, verifies the new canonical revision and confirmation target,
accepts it through the browser, and verifies the final implementation marker,
three successful runs, and Done. `message_contains` is normalized rather than
exact to tolerate harmless provider framing. Plan markers also normalize
provider-added Markdown underscore escaping.

The OpenRouter suite generates its five profiles from the reviewed
`openrouter-models.json` weekly tool-capable ranking snapshot. Rank, canonical
ID, display name, supported parameters, source URL, capture time, and content
hash are preserved as definition metadata; rankings are usage/adoption signals,
not quality claims. Nightly campaigns never mutate the snapshot. The manual
update command fetches `sort=top-weekly&supported_parameters=tools`, validates
exactly five unique available models, and rewrites the snapshot for review.

Its `hello-complete` case verifies a basic visible response and Done.
`question-resume-complete` captures the pending structured question, selects
“Cobalt” in the browser, and proves the second run consumed it and completed.
`plan-approve-complete` captures the pending exact two-step canonical Plan,
approves that revision in the browser, and proves the second run completed.

## Failure, retry, and cleanup policy

Candidate failures, missing/invalid credentials, incompatible models or
artifacts, secret leakage, and cleanup invariant failures are final.
Server/bootstrap, browser handshake, 429/5xx/network, and classified Daytona
transport failures (including a transport-level cleanup failure) may retry
once. A retry receives a completely new Paperclip instance/database/workspace.
There is no USD ceiling; bounded cases, per-case deadlines, and one
infrastructure retry are the runaway bounds.

Playwright owns the foreground server process, while wrapper/launcher process
groups ensure child runners are terminated. Fixture teardown deletes agents,
destroys Daytona environments/leases, and removes companies. The launcher then
packages evidence and removes the complete temporary root. Daytona auto-stop,
archive, and delete remain provider-side backstops for abrupt job cancellation.

## Evidence security

Private attempt state is never uploaded wholesale. `evidence.ts` allowlists
screenshots, videos, traces/blob reports, sanitized logs/snapshots, HTML, JUnit,
and result JSON. Text is redacted using exact loaded values and known key
shapes. Raw API snapshots are scanned before sanitization, ZIPs are expanded,
and the closed Paperclip home/database plus workspace receive a streaming
exact-value scan before deletion. Unsafe binary/ZIP files are omitted, any
detected leak fails the cell, and a pass without `final-state.png` is rejected.
Paperclip home, database, workspace, master key, and raw logs are deleted after
packaging.

Each normalized result records profile, environment, case, provider/model,
runtime mode, issue/run IDs, timing, cleanup, retry attempt, and usage/cost when
the provider reports it. Native usage normalization accepts the flat legacy
shape plus runner `runDelta`/`total` and ACPX `cumulative`/USD-cost shapes. A
per-test billing summary reports input/output/cached tokens, provider-reported
LLM dollars and coverage, agent runtime, Daytona lease duration, and a
versioned public-list-price Daytona estimate. The campaign report aggregates
the same dimensions. Unpriced and unavailable runs remain visible and excluded
from the reported-dollar subtotal rather than being treated as free. It also
records each matcher result and the labeled screenshot phases used by the
screenshot-first campaign dashboard.

## CI campaign

`.github/workflows/runner-full-stack-e2e.yml` has a `08:47 UTC` cron and manual
dispatch inputs mirroring local selectors, including repeatable suite selection.
The catalog job emits 63 independently schedulable jobs for a full run. The
paid matrix uses `ubuntu-latest-m`, `fail-fast:false`, a validated
`RUNNER_E2E_MAX_PARALLEL` default of 32, and 25-minute local or 40-minute
Daytona job limits that cover the scenario deadline plus one fresh-harness
retry. Multi-turn steps stay sequential only within their own cell.

When Daytona is selected, one image job computes an audited content ID from the
`linux/amd64` platform, Dockerfile, root package/lock/build configuration,
dependency patches, eval-kernel package, and runner package. It reuses the
verified `e2e-content-<sha256>` image when that dependency closure is unchanged,
or builds and publishes it otherwise. The tested Git SHA remains separate image
provenance. Reuse reads that original revision back into the controller-side
provider-pack build so its manifest remains byte-identical to the preinstalled
pack. The job signs with Cosign/OIDC, verifies anonymous pull, checks the content
label and runner contract/transport metadata, and exposes the immutable digest
to every Daytona cell.

Every execution uploads a 30-day sanitized bundle. The final job always downloads
evidence, merges Playwright blob reports into HTML/JUnit, stages the sanitized
screenshots, and emits a screenshot grid whose expandable cards contain matcher
results and execution context. It fails unless every selected latest attempt
passed with cleanup and required evidence. Result/campaign v2 schemas retain
suite-definition fingerprints, source SHA/ref/run URL, overall and per-suite
tokens/cost/runtime/lease time, and per-execution evidence.

The report remains a 30-day GitHub Actions operational artifact. A globally
serialized publisher exchanges GitHub OIDC for short-lived AWS credentials,
writes an immutable content-digested campaign bundle to private, versioned S3,
and updates compact `history.json`, `latest.json`, and `latest-green.json`
pointers. The role has Get/List/Put only below one prefix and no Delete. S3
Block Public Access stays enabled; CloudFront reads through Origin Access
Control. Pages remains the stable current landing URL with the compact history
embedded, while immutable CloudFront URLs preserve every green or red campaign.
The workflow follows
[Playwright blob report merging](https://playwright.dev/docs/test-sharding#merge-reports)
and [GitHub dynamic matrix outputs](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs).

Because the repository is public, a dedicated authorization job runs before
checkout. It requires the default branch and, for manual dispatches and reruns,
requires both GitHub actor contexts to resolve to numeric IDs present in the
non-empty `RUNNER_E2E_ALLOWED_ACTOR_IDS` JSON array. The paid secret-bearing
jobs and OIDC publisher also use separate protected environments restricted to
the default branch. Branch protection/CODEOWNERS protect workflow and harness
changes; environment secrets never reach authorization, catalog, image, report,
or publishing jobs. A first scheduled attempt is trusted automation; a human
rerun of a scheduled campaign must have an allowlisted triggering actor. The
`ubuntu-latest-m` runner group is restricted to this repository and workflow,
is unavailable to PR/fork workflows, and uses ephemeral/reimaged workers rather
than sharing persistent state with untrusted jobs.

The cron is present but billable scheduled execution requires repository
variable `RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED=true`. This enforces the launch
gate below rather than spending before live qualification is complete.

## Live activation sequence

Run in order, recording the produced campaign artifacts:

1. headed `legacy-codex.local.message-marker`;
2. headless one local legacy and one local native cell;
3. one Daytona legacy and one Daytona native cell, confirming lease cleanup;
4. all 15 OpenRouter breadth cells;
5. one manually dispatched complete 63-execution campaign, verifying private
   S3/CloudFront history and Pages navigation; and
6. set `RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED=true` only after step 5 is green.

For every cell verify UI ownership/assignment, visible marker, `done` issue,
the expected successful heartbeat run count, correct legacy/native mode, correct local or
Daytona execution context, native runner metadata, no pending interaction,
secret-free persisted/evidence state, and confirmed local/lease cleanup.

## Deferred scope

Claude Managed Agents, AWS AgentCore, CircleCI-specific output, SSH/E2B/Modal/
Cloudflare/Kubernetes/Novita/exe.dev environments, LLM judges, ASCII-art
rubrics, and file-writing cases remain outside v1. The typed environment/task/
matcher contracts and dependency registry are the extension points for those
fixtures and for future Paperclip objects such as projects, goals, apps, and
configuration.
