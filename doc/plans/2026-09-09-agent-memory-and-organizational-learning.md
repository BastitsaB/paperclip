# Agent Memory and Organizational Learning — Decision Proposal

Date: 2026-09-09
Status: proposal / RFC — no code changes attached
Related: `doc/memory-landscape.md`, `doc/plans/2026-03-17-memory-service-surface-api.md`,
`ROADMAP.md` (`Memory / Knowledge`, `MAXIMIZER MODE`, `Self-Organization`,
`Automatic Organizational Learning`)

---

## 1. Executive summary

The question behind this document is not "which memory engine should Paperclip use".
It is: **which routines make a Paperclip company measurably more autonomous and more
productive per human supervisor?**

Those are different problems, and the published evidence separates them cleanly:

- **Semantic / episodic memory** (remembering facts and past conversations) has the
  weakest and most contested evidence, and the best-documented failure modes.
- **Procedural memory** (remembering *how work gets done*, as reusable executable
  routines) has by far the strongest measured effects in the literature — with
  the transferability caveat in section 3.1, which the ranking below depends on.
- **Context curation** (evolving role playbooks with incremental updates) sits in
  between, with solid published gains and a low implementation cost.

**Recommendation: build the learning loop, defer the memory database.**

Concretely: a nightly consolidation routine (Option B) that produces two artifacts —
delta-updated **role playbooks** (Option C) and induced **executable routines / skills /
pipelines** (Option D) — behind the approval and eval machinery Paperclip already has,
with a non-optional governance layer (Option F). The generic memory-provider control
plane (Option A) stays on the shelf until Phases 1–3 hit a real retrieval limit.

Rationale in one line: a playbook or an induced routine is an **auditable, versioned,
revertible work object**; a vector store is an opaque dependency whose benchmark claims
are currently unreliable.

---

## 2. Critical reading of the premise

Four points before the options, because they change the answer.

**2.1 "Dreaming" is a metaphor, not a mechanism.** OpenClaw's Dreaming, stripped of the
sleep-cycle branding, is a scheduled job that scores candidate memories with weighted
heuristics and promotes those over a threshold. The biological analogy carries no
evidential weight. What is actually useful about it is operational: it is *scheduled*,
*explainable*, and it produces a human-readable digest. Copy those three properties, not
the vocabulary.

**2.2 Memory benchmarks are currently not a safe basis for architecture decisions.**
The public LoCoMo numbers are disputed between vendors: Zep published a rebuttal of
Mem0's SOTA claim, and Zep's own 84% claim was in turn corrected downward to ~58% by a
third party over an evaluation-protocol error. "Run LoCoMo" is not one fixed procedure,
and the conversations are short enough (~16k–26k tokens) to fit in a modern context
window anyway. Any decision that rests on a vendor's memory leaderboard position is
resting on sand.

**2.3 More memory is not monotonically better — there is measured harm.** Reported
comparison of an "add-all" strategy versus selective memory management: 2,400+
accumulated records with accuracy collapsing to 13%, versus 248 curated records at 39%.
Documented failure modes include memory drift from repeated lossy summarization, stale
facts overriding current authoritative evidence, and over-generalization of a stored
preference to unrelated tasks. A memory system without forgetting, contradiction
handling, and decay is a liability, not a feature.

**2.4 Efficiency is not the same as company success.** Token savings are a cost lever.
The stated goal — near-autonomous operation and maximized business outcome — is a
*throughput* lever: more work closed per human intervention. Those two are optimized by
different mechanisms, and conflating them is the most common failure in this space.
Sleep-time compute reduces cost; procedural memory increases autonomy. Prioritize
accordingly.

**Additional scoping point:** Paperclip is a control plane, not an agent runtime. Claude
Code (`CLAUDE.md`), OpenClaw (memory-core), and Codex already run their own per-agent
memory. Rebuilding that inside Paperclip is low-differentiation work. What no runtime can
see — and what only Paperclip sits on — is the *cross-agent, cross-provider record of how
the company actually got work done*: issues, runs, approvals, work products, costs. That
is the defensible asset.

---

## 3. Evidence base

Source quality is marked explicitly. Note: this session's network egress blocked direct
access to `arxiv.org`, `docs.openclaw.ai`, `dev.to`, `huggingface.co` and `alphaxiv.org`.
Items marked (S) were read via search-engine summaries or secondary reporting rather than
the primary text, and their exact figures should be re-verified before they are quoted
externally.

| # | Concept | Core mechanism | Reported effect | Source class |
|---|---|---|---|---|
| 1 | **Agent Workflow Memory** (arXiv 2409.07429, ICML 2025) | Induce reusable *workflows* from past trajectories; inject selectively | **+51.1% relative success on WebArena**, fewer steps; beats human-written workflows by 7.9% | peer-reviewed (S) |
| 2 | **Voyager** (arXiv 2305.16291) | Ever-growing library of verified, executable, composable skills | 3.3× unique items, **15.3× faster milestones**; ablation without the skill library loses nearly all of it | peer-reviewed (S) |
| 3 | **ACE — Agentic Context Engineering** (arXiv 2510.04618, ICLR 2026) | Generator / Reflector / Curator; context as an evolving playbook with **incremental delta updates** | **+10.6% agents, +8.6% finance**; names and avoids *brevity bias* and *context collapse* | peer-reviewed (S) |
| 4 | **Sleep-time compute** (arXiv 2504.13171, Letta) | Precompute a "learned context" from raw context while idle; thin serve-agent at query time | Same accuracy at **~5× fewer test-time tokens** on Stateful GSM-Symbolic | peer-reviewed (S) |
| 5 | **Generative Agents** (Stanford, UIST '23) | Memory stream + retrieval scored by `recency + importance + relevance`; periodic **reflection** into higher-level inferences | Qualitative; the scoring triple is the durable contribution | peer-reviewed (S) |
| 6 | **Anthropic context engineering** | Compaction, **structured note-taking** to external files, sub-agents with clean windows | Practitioner evidence (Claude Code todo lists; Pokémon agent holding state across thousands of steps / context resets) | vendor engineering blog |
| 7 | **OpenClaw Dreaming** | Cron sweep (default 03:00), light/REM/deep phases, six weighted signals, three threshold gates, Dream Diary for humans | No independent benchmark published | vendor docs (S) |
| 8 | **openclaw-auto-dream** (verified, read directly) | 3 phases (Collect/Consolidate/Evaluate), 5 layers, `importance = (base × recency × ref_boost)/8`, decay over 180d, archive at >90d unreferenced AND score <0.3, 5-metric health score, daily 04:00 | Self-reported: "Smart Skip" cuts ~90% of tokens on idle days | community repo README |
| 9 | **Compound Engineering** (Every) | brainstorm → plan → work → simplify → review → **compound**; learnings written to `docs/solutions/`, read back by the next plan | Anecdotal ("run one teaches it, run two remembers"); a documented learning was reused 18 days later | practitioner plugin |
| 10 | **Memory poisoning** (arXiv 2606.04329, 2601.05504) | One successful write persists across sessions; 4 write channels, 9 structural vulnerabilities, 6 attack classes | MINJA: **>95% injection, ~70% attack success**; existing prompt-injection defenses do not cover it | peer-reviewed (S) |
| 11 | **Memory as liability** | Unbounded stores degrade; drift from iterative summarization; stale facts override live evidence | **add-all: 2,400 records → 13%** vs **selective: 248 records → 39%** | secondary reporting (S) — verify before external use |
| 12 | **LoCoMo dispute** | Vendor benchmark claims not comparable across setups | Zep vs Mem0 rebuttal; Zep's 84% corrected to ~58.44% | vendor blogs + GitHub issue |

**What the evidence actually says, ranked by effect size:** procedural memory (#1, #2)
≫ context curation (#3) > efficiency scheduling (#4) > semantic recall (#12, contested).
The strongest negative evidence (#10, #11) applies specifically to unbounded semantic
memory — the exact category with the weakest positive effect.

### 3.1 Transferability caveat — read before using these numbers

The ranking above is the honest reading of the literature. The **magnitudes are not
transferable to Paperclip**, and the recommendation should not be sold as if they were:

- AWM's +51.1% is WebArena: deterministic web tasks with a programmatic success oracle.
- Voyager's 15.3× is Minecraft: every skill is verified by running it.
- Both benchmarks can *label a trajectory as successful automatically*. Paperclip's work
  is open-ended business execution, where "did this succeed" is itself a judgment call.

What survives the transfer is the **direction** — reusing verified procedure beats
recalling facts — and the **causal claim** from Voyager's ablation, that the skill library
is where the gain lives. The size of the gain in this domain is unknown until measured.
That is precisely why every phase below carries an eval gate and a stop condition rather
than a promised number.

The number this document leans on most heavily and trusts least is #11 (add-all 13% vs
selective 39%): it is secondary-sourced and was measured on medical reasoning, a domain
far from ours. It is used only to justify that forgetting must be designed in from the
start — a conclusion that also follows from #10 and #12 independently.

---

## 4. What Paperclip already has

This matters, because most of the substrate for the recommendation is already built.

| Capability | Where | Relevance |
|---|---|---|
| Scheduled recurring work with concurrency, catch-up, and activity gates | `server/src/routes/routines.ts`, `packages/db/src/schema/routines.ts`, `skills/paperclip/references/routines.md` | The consolidation sweep needs **no new scheduler** |
| Heartbeat runs + events + watchdog decisions | `heartbeat_runs.ts`, `heartbeat_run_events.ts`, `heartbeat_run_watchdog_decisions.ts` | Raw trajectory data for induction |
| Structured work records | `cases.ts`, `issue_work_products.ts`, `completion_contracts.ts`, `work_assessments.ts` | Outcome signal — only partly typed; see the precondition under Option D |
| Human-labeled decision examples | `decision_training_examples.ts`, `server/src/routes/decision-training.ts` (interaction / approval / execution_decision) | An existing supervised signal, currently under-exploited |
| Versioned agent instructions | `agent_config_revisions.ts`, `server/src/services/agent-instructions.ts` (bundle mode, per-adapter instruction paths) | **The injection point for playbooks — versioned and revertible** |
| Company skill library + Skill Studio + catalog | `company_skills.ts`, `packages/skills-catalog/`, `skills/paperclip/references/company-skills.md` | The store for induced procedural knowledge |
| Approvals, review gates, decision queues | `approvals.ts`, `decisions.ts`, `decision_queues.ts` | The gate for anything self-modifying |
| Evals & feedback | `packages/paperclip-eval-kernel/`, `evals/`, `doc/plans/2026-03-13-agent-evals-framework.md` | The only honest way to prove a learning loop works |
| Cost ledger | `cost_events.ts`, `finance_events.ts`, budget policies | ROI measurement for the loop itself |
| Activity log & attribution | `activity_log.ts` | Provenance and audit |
| **Reflection Coach** (built-in agent + bundled skill + weekly routine) | `server/src/built-ins/agents/reflection-coach/`, `packages/skills-catalog/catalog/bundled/paperclip-operations/reflection-coach/` | **Option C already exists at the per-agent level**, gated by displayed diff + accepted interaction + separate apply run |
| **Learning Agent** (built-in agent, bundle-less stub before this proposal) | `server/src/services/built-in-agents.ts` | The reserved slot for company-level consolidation |
| Pipelines | `pipelines.ts`, `pipeline_cases.ts` | Target format for induced multi-step workflows |

**Not present:** any memory table, any `/api/.../memory` route. The March plan
(`doc/plans/2026-03-17-memory-service-surface-api.md`) is designed but unimplemented.

**Correction, made while implementing Phase 1.** The first version of this table missed
the two rows now marked in bold. That omission mattered: `reflection-coach` already
implements Option C for a *single* agent, complete with the governance gates this document
argues for. The version of Option C below is therefore narrower than first written — it is
the *cross-agent* playbook layer, and single-agent findings are routed to the coach rather
than reimplemented. The `learning` built-in existed as a bundle-less stub whose stated
purpose was exactly this work, which is where Phase 1 now lives.

**The gap is therefore not storage.** Paperclip records what happened in great detail and
never converts it into anything that changes future behaviour. Every finished issue is a
dead end. That is the actual defect.

---

## 5. Options

Effort is rough engineering weeks for one competent contributor including tests. These
figures are unvalidated estimates without task decomposition. Treat them as relative
ordering — B is much cheaper than A, D is the largest of the recommended set — not as
a plan a schedule can be built on.

### Option 0 — Do nothing beyond runtime-native memory

Let Claude Code / OpenClaw / Codex handle their own memory; Paperclip stays a coordinator.

| Pro | Contra |
|---|---|
| Zero cost, zero new attack surface | Knowledge dies with the workspace; nothing compounds |
| No drift, no poisoning risk introduced by us | Per-agent, per-provider silos — the company as a whole learns nothing |
| Runtimes improve for free | Four open roadmap items stay open; contradicts the product thesis |

**Verdict:** valid baseline for comparison, not a strategy. Every other option must beat
this on eval, or it should not ship.

---

### Option A — Memory provider control plane (the March 2026 plan)

Company-scoped bindings, provider adapters (mem0 / memsearch / MemOS / …), hooks
(`pre_run_hydrate`, `post_run_capture`, comment/document capture), `memory_operations`
audit, browse UI, cost attribution.

| Pro | Contra |
|---|---|
| Already designed in detail; vendor-neutral; keeps core thin | **Largest surface**: schema, bindings, hooks, tools, UI, cost plumbing, plugin contract |
| Correct long-term substrate; provenance back to Paperclip work objects | Delivers *recall*, not *autonomy* — no direct line to the stated goal |
| Unblocks the `Memory / Knowledge` roadmap item as advertised | Provider payoff evidence is the contested category (#12); we would be buying into a market whose numbers are unreliable |
| Plugin path avoids vendor lock-in | Imports the full poisoning/drift surface (#10, #11) before we have any governance layer |

**Effort:** 8–12 weeks for Phases 1–4 of that plan. **Risk:** medium-high. **Business
ROI:** indirect.

---

### Option B0 — Agent-authored lessons file, no sweep at all

The cheapest intervention in the whole space, and the one this document originally
skipped. At the end of a run, the agent appends what it learned to its own instructions —
the `learnings.md` / compound-engineering pattern (#9) — landing as an
`agent_config_revisions` change that a human can read and revert. No consolidation job,
no scoring, no clustering.

| Pro | Contra |
|---|---|
| Days, not weeks. Uses only the instructions bundle that already exists | No curation: the file grows monotonically until it poisons the context (#11) |
| Practitioner-proven at small scale (#9) | Each agent learns alone — nothing crosses roles or agents, so the *company* still does not learn |
| Honest floor for measuring everything else against | Wholesale self-rewrites invite context collapse (#3), the failure ACE exists to prevent |

**Effort:** under 1 week. **Risk:** low short-term, rising with file size. **Verdict:**
worth running in Phase 1 as the **active control arm** against the curated playbook, not
as the answer. If B0 matches C on eval, the sweep is not earning its cost — and that is a
result worth knowing early and cheaply.

---

### Option B — Nightly consolidation sweep ("Dreaming"), as a routine, not as core

Implement the OpenClaw pattern using existing primitives: a company-scoped Routine that
fires nightly, assigned to a dedicated agent running a `company-consolidation` skill. It
reads the last N days of issues, comments, runs, work products and assessments; scores
candidates; appends deltas; archives stale entries; emits a digest (a `case`) for the
board.

Adopt from #8 verbatim where it is sound: recency decay, reference boost, explicit
`PERMANENT` pins, archive-don't-delete, a health score, and **Smart Skip on idle days**
(the ~90% token saving comes from *not running* when there is nothing new — Paperclip
already has `activityGatePolicy: require_external_activity` for exactly this).

| Pro | Contra |
|---|---|
| Near-zero core change — routines, cases, documents, agents all exist | Evidence is vendor/community, not benchmarked (#7, #8) |
| Fully auditable: the sweep *is* an issue with a run, comments and costs | Risk of ritual: a nightly job that burns tokens and changes nothing |
| Operator-legible digest builds trust in autonomy | Naive implementation rewrites files → **context collapse / drift** (#3, #11) |
| Blast radius is one company, one agent, one budget | Adds a nightly recurring cost line per company |

**Mitigation for the collapse risk is non-negotiable:** append-only deltas, never
"rewrite the whole memory file". This is ACE's central finding (#3).

**Effort:** 1–2 weeks. **Risk:** low. **Business ROI:** none on its own — B is the
*mechanism*; the value comes from what it produces (C and D).

---

### Option C — Role playbooks with delta updates (ACE-style)

The consolidation sweep maintains a versioned **playbook per role** (CEO, coder, QA,
security, UX — cf. `skills/paperclip-create-agent/references/agents/`): numbered bullets
of situation → tactic → known pitfall, each with provenance to the issue that produced
it. Updates are candidate deltas, curated and merged, never wholesale rewrites. The
playbook is injected through the existing agent instructions bundle, so every change
lands as an `agent_config_revisions` row.

| Pro | Contra |
|---|---|
| Best published gain for pure context-side learning: **+10.6% / +8.6%** (#3) | Quality depends entirely on the Reflector step; a weak reflector produces noise |
| Zero training, zero new storage engine — it is text in an existing versioned object | Playbook bloat: needs a token budget and periodic pruning by usage |
| **Revertible**: bad playbook → roll back the config revision | Risk of overfitting to recent incidents; needs eval gating |
| Directly serves `Automatic Organizational Learning` | Cross-company reuse raises IP/leak questions — keep it company-scoped |

**Effort:** 2–3 weeks on top of B. **Risk:** low-medium (bounded by revert). **Business
ROI:** direct — fewer repeated mistakes per role.

---

### Option D — Procedural induction: successful runs → routines / skills / pipelines

The highest-value option. Mine completed issues and heartbeat runs for **recurring task
shapes** with good outcomes. Where a shape repeats N times, the sweep **proposes an
executable asset**:

- a **Routine** when the shape is periodic,
- a **Pipeline** when it is a fixed multi-step flow,
- a **Company Skill** when it is a reusable procedure.

Every proposal goes through an approval (existing `approvals` / `decision_queues`) and
must pass an eval in `paperclip-eval-kernel` before it is attached to any agent.

| Pro | Contra |
|---|---|
| **Strongest measured effects in the entire field**: AWM +51.1% relative (#1); Voyager 15.3× with the skill library as *the* causal factor (#2) — magnitudes not transferable, see 3.1 | Depends on trajectory-data quality; noisy runs produce noisy inductions |
| Output is an **executable asset**, not a hint — it converts human-triggered work into scheduled work, which is precisely "more automation" | Real risk of **automating a bad process** at scale |
| Verifiable before adoption: a skill either passes its eval or it does not | Approval overhead per proposal (a feature, not a bug, at this maturity) |
| Serves `Self-Organization` + `MAXIMIZER MODE` with a governed, non-hidden mechanism | Needs a similarity/clustering step over issues that does not exist yet |
| Produces the single cleanest KPI: share of work closed without a human turn | Cold start: a young company has nothing to induce from |
| | **Outcome selection is not query-ready today** — see the precondition below |

**Precondition, discovered while verifying this document.** Selecting "successful" runs
at scale is not as cheap as it looks. `issue_work_products` carries typed columns that a
query can filter on (`status`, `review_state`, `health_status`), and reopened issues and
`issue_recovery_actions` are queryable negatives. But `work_assessments` keeps the actual
verdict in an opaque `assessment_json` JSONB blob keyed to a `completion_contracts`
contract — there is no outcome column to cluster on. Phase 3 therefore needs a typed
outcome projection over `assessment_json` before induction can select on it. That work is
not in the estimate below.

**Effort:** 4–6 weeks after B, plus the outcome projection above. **Risk:** medium, fully
bounded by the approval gate. **Business ROI:** highest and most direct.

---

### Option E — Sleep-time pre-hydration of queued work

An idle "sleeper" pass builds a briefing pack for issues already queued or for the next
scheduled routine run, so the expensive online run starts pre-loaded.

| Pro | Contra |
|---|---|
| Published: same accuracy at **~5× fewer test-time tokens** (#4) | The paper's own condition: it pays off only when the precomputed context is *reused across several queries* |
| Reduces perceived latency on the board | Speculative burn if the prediction is wrong — cost with no work attached |
| Measurable immediately via `cost_events` | Optimizes cost, **not** autonomy — wrong lever for the stated goal |
| Fits the existing heartbeat/queue model | Interacts badly with budget hard-stops if not attributed carefully |

**Effort:** 2–3 weeks. **Risk:** low-medium (spend). **Business ROI:** cost-side only.
**Sequencing: after** the queue work lands, not before.

---

### Option F — Governance layer (cross-cutting, mandatory)

Not an alternative — a precondition for B/C/D/A. Requirements:

1. **Memory is data, never instruction.** Anything retrieved from a store, a playbook or
   a digest is rendered to the agent as untrusted content and must not be able to change
   the agent's mandate, permissions or tool access.
2. **Gated writes.** Only the consolidation agent and explicit agent tool calls write.
   Content originating from external sources (web, PR comments, third-party MCP output)
   is quarantined and never auto-promoted (#10: one write is enough).
3. **Provenance mandatory.** Every entry carries the issue/run/comment it came from and
   the actor. No provenance → not promotable.
4. **Decay and forgetting by default.** Recency decay, archive-not-delete, and a hard cap
   per scope (#11).
5. **Contradiction handling.** New evidence supersedes rather than coexists (the
   `superseded_by` pattern already used in `skills/para-memory-files`).
6. **Auditability.** Every promotion and every archival is in `activity_log`.
7. **Kill switch.** Disable the sweep and revert the config revision in one action.

**Effort:** ~1 week, folded into B/C. **Skipping this is the single largest risk in the
whole proposal.**

---

## 6. Recommendation

**Build D + C on the mechanism of B, under F. Defer A. Schedule E last.**

| Option | Decision | Reason |
|---|---|---|
| 0 Baseline | Keep as eval control | Every change must beat it |
| A Memory provider plane | **Defer** | Highest cost, weakest and most contested evidence, delivers recall not autonomy |
| B0 Agent-authored lessons file | **Adopt as control arm** | Cheapest possible baseline; makes the case for C falsifiable |
| B Consolidation sweep | **Adopt as mechanism** | Cheap, auditable, already-built primitives |
| C Role playbooks | **Adopt** | Best context-side gain per engineering week; revertible |
| D Procedural induction | **Adopt — highest priority** | Largest measured effect; produces executable automation |
| E Sleep-time pre-hydration | **Later, opt-in** | Cost lever, not an autonomy lever |
| F Governance | **Mandatory, ships with Phase 1** | Without it the rest is a liability |

### Phasing

**Phase 1 — Consolidation sweep + governance (2–3 weeks). Shipped.**

Implemented as a bundle on the existing `learning` built-in agent: instructions
(`server/src/built-ins/agents/learning/AGENTS.md`), the `company-consolidation` skill
(`packages/skills-catalog/catalog/bundled/paperclip-operations/company-consolidation/`),
and a nightly routine (`nightly-consolidation`, `0 3 * * *`) that ships **paused** and
gated on `require_external_activity`, so it spends nothing until an operator enables it
and skips quiet windows. No new tables, no new routes. Governance (Option F) is written
into both the instructions and the skill: memory-as-data, append-only deltas, mandatory
provenance, external-origin quarantine, supersede-not-delete, and proposal-only authority.

Original scope, for reference:
`company-consolidation` skill + a nightly Routine with
`activityGatePolicy: require_external_activity`. Reads the last 7 days of company work,
writes append-only deltas into a company knowledge `case`, emits an operator digest.
No new tables. F implemented in full. Ship B0 alongside it as the control arm, so Phase 2
has something to beat. Deliverable: a nightly digest an operator wants to read.

**Phase 2 — Role playbooks + eval gate (2–3 weeks).**
Sweep maintains per-role playbooks; injection through the agent instructions bundle as an
`agent_config_revisions` change. A/B against the Phase-0 baseline in
`paperclip-eval-kernel`. **No playbook ships without beating baseline.**

**Phase 3 — Procedural induction (4–6 weeks).**
Cluster completed work by shape and outcome; propose Routines / Pipelines / Company
Skills through the approval queue; each proposal carries its supporting trajectories and
must pass an eval before attachment. This is where the automation share moves.

**Phase 4 — Memory provider contract, narrow (only if needed).**
Implement Phase 1+2 of the March plan with exactly one built-in (local markdown +
index) and one plugin example — and only if Phases 1–3 demonstrably hit a retrieval
ceiling. Trigger condition, not a schedule.

**Phase 5 — Sleep-time pre-hydration (2–3 weeks).**
Only for work already in a queue, attributed to the target issue's budget.

### Metrics and kill criteria

Measure on the existing ledger, per company, weekly:

- **Automation share** — issues closed with zero human comment / total closed. *Primary.*
  Computable directly: `issue_comments` carries `author_type`, `author_agent_id` and
  `author_user_id`. Two cautions. First, the table also carries `derived_author_agent_id`
  for comments written by a non-human sentinel such as `local-board`, so "has an
  `author_user_id`" is not the same as "a human spoke" — define the metric against
  `author_type` and validate it before trusting a trend. Second, this metric is gameable:
  an agent raises it by *not asking* when it should have. It is only meaningful read
  together with the rework rate below, which is the guardrail against exactly that.
- **Rework rate** — reopened issues + triggered recovery actions / total.
- **Cost per closed issue** — from `cost_events`.
- **Role eval pass rate** — playbook variant vs. baseline.
- **Loop ROI** — nightly consolidation spend vs. measured savings; if the sweep costs
  more than it saves and does not raise automation share, it is theatre.
- **Memory hygiene** — entries per scope, share with provenance, archive rate.

**Kill criteria.** If after two iterations a playbook variant does not beat baseline on
eval, revert the config revision and stop Phase 2. If induced routines raise the rework
rate, revoke them and stop Phase 3. Both reverts must be one action.

---

## 7. Open questions

1. **Company vs. instance scope for playbooks.** Company-scoped is the safe default;
   cross-company templates raise IP and leakage questions. Needs a product decision.
2. **Who owns the consolidation agent?** A dedicated system agent, or the CEO agent? A
   dedicated one keeps the budget and the blast radius clean — but it is another hire.
3. **Cold start.** Below roughly 50 completed issues there is likely nothing to induce
   from. The number 50 is an assumption, not a finding — it is not derived from any
   source in section 3 and needs calibration against a real company's history. Should
   Phases 2–3 gate on a data threshold at all?
4. **Human-labeled examples.** `decision_training_examples` is an existing supervised
   signal. Feeding it into the Reflector is likely the cheapest quality win available —
   worth validating in Phase 2.
5. **Who writes the evals?** The eval gate is the load-bearing safety property of this
   whole proposal, and it is circular if the same loop that writes playbooks also writes
   the evals that approve them. Phase 2 needs a held-out, human-authored eval set that
   the loop cannot edit. That set does not exist yet and is not costed here.
6. **Figure verification.** Items marked (S) in §3 were read via search summaries because
   direct access to the primary sources was blocked in this environment. Before any of
   these numbers is used externally, re-verify against the primary papers.

---

## 8. Bottom line

Paperclip does not need to become a memory engine, and the "dreaming" framing points at
the least valuable third of the problem. What Paperclip uniquely sees is *how the company
got work done across every agent and provider*. Turning that into versioned playbooks and
approved, eval-gated executable routines is the shortest path from "agents that work" to
"a company that compounds" — and unlike a vector store, every step of it is inspectable,
attributable and revertible.
