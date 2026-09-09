---
routineKey: nightly-consolidation
title: Consolidate recent company work into curated knowledge
description: Bounded nightly sweep over the company's recent work that promotes evidence-backed entries into the company knowledge case, drafts role playbook deltas, and publishes an operator digest. Proposal-only — never applies changes to any agent's configuration.
assigneeRef:
  resourceKind: agent
  resourceKey: learning
status: paused
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
activityGatePolicy: require_external_activity
activityGateScope: company
variables:
  - name: lookbackDays
    label: Lookback window (days)
    type: number
    defaultValue: 7
    required: false
    options: []
  - name: maxIssues
    label: Max issues read per sweep
    type: number
    defaultValue: 40
    required: false
    options: []
  - name: maxPlaybookDeltas
    label: Max playbook deltas proposed per sweep
    type: number
    defaultValue: 5
    required: false
    options: []
  - name: minScore
    label: Minimum promotion score
    type: number
    defaultValue: 0.35
    required: false
    options: []
triggers:
  - kind: schedule
    label: Nightly consolidation sweep
    enabled: false
    cronExpression: "0 3 * * *"
    timezone: UTC
    signingMode: none
    replayWindowSec: 0
issueTemplate:
  surfaceVisibility: normal
---

Consolidate the company's recent work into curated, append-only knowledge.

Read the bounded window of closed, in-review, and blocked issues with their comments. Promote only entries that carry provenance and pass the scoring gates. Supersede contradictions instead of letting both sides stand. Draft role playbook deltas where a pattern crosses several agents, route single-agent findings to Reflection Coach, and record recurring work shapes as induction candidates without building them.

Paused by default and gated on external activity: a quiet window exits early and spends almost nothing. Proposal-only — no change is applied to any agent's instructions, skills, tools, or routines.
