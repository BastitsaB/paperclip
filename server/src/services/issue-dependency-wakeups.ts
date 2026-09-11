import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issueRelations, issues } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

// A wake counts as "already delivered or in flight for the current ready state"
// for these statuses. The level-triggered state key uses this full set so that
// one wake for a ready state suppresses further wakes for the SAME state. This
// bounds reconciliation: after one wake, later passes find the completed row.
const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

// A wake counts as "still in flight" for these statuses. The `completed` status
// is not in this set on purpose. Dependency readiness is level-triggered, so a
// historical completed per-edge wake must never suppress a new wake for the
// current ready state. The dedup uses this set only for the legacy per-edge key
// and for old no-cycle state keys that are still queued after a deploy.
const IN_FLIGHT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

const IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IDEMPOTENT_DEPENDENCY_WAKE_STATUSES);
const IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET = new Set<string>(IN_FLIGHT_DEPENDENCY_WAKE_STATUSES);

export type IssueBlockersResolvedWakeCycleInput = Date | string | null | undefined;

export type IssueBlockersResolvedReadyStateInput = {
  dependentIssueId: string;
  blockerIssueIds: string[];
  blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
};

/**
 * Canonical blocked-cycle stamp for the dependency-ready state key.
 * `blockedTransitionAt` is UTC ISO-8601, or `none` when the dependent has no
 * recorded transition into `blocked`.
 */
export function formatIssueBlockersResolvedWakeCycle(
  blockedTransitionAt: IssueBlockersResolvedWakeCycleInput,
): string {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return "none";
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return "none";
  return parsed.toISOString();
}

function uniqueSortedBlockerIssueIds(blockerIssueIds: string[]): string[] {
  return [...new Set(blockerIssueIds.filter(Boolean))].sort();
}

function hashBlockerReadyStateDigest(sortedBlockerIssueIds: string[], cycle: string | null): string {
  const payload = cycle == null
    ? sortedBlockerIssueIds.join(",")
    : `${sortedBlockerIssueIds.join(",")}\n${cycle}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function buildStateKey(dependentIssueId: string, digest: string, blockerCount: number): string {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    "state",
    dependentIssueId,
    String(blockerCount),
    digest,
  ].join(":");
}

/**
 * Legacy per-edge idempotency key. One key encodes a single resolved blocker
 * edge `issue_blockers_resolved:{dependentIssueId}:{resolvedBlockerIssueId}`.
 * The dedup keeps this format only to read wake rows written before the
 * level-triggered state key existed.
 */
export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

/**
 * Pre-cycle level-triggered key. Rows written before the ready state included
 * `blockedTransitionAt` hashed only the sorted blocker ids. Lookup still reads
 * this format so an in-flight deploy-overlap wake can suppress a duplicate.
 */
export function buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input: {
  dependentIssueId: string;
  blockerIssueIds: string[];
}) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, null),
    sortedBlockerIssueIds.length,
  );
}

/**
 * Level-triggered idempotency key. One key encodes the full set of blockers that
 * defines the current dependency-ready state plus the dependent's current
 * blocked cycle (`blockedTransitionAt`, or `none`). Two wakes for the same ready
 * state share the key. A wake from an earlier blocked cycle has a different
 * cycle stamp, so it produces a different key and never suppresses the current
 * wake. All three emit paths (route-time, finalize-time, periodic backstop) use
 * this key so they share one idempotency rule.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const cycle = formatIssueBlockersResolvedWakeCycle(input.blockedTransitionAt);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, cycle),
    sortedBlockerIssueIds.length,
  );
}

function parseWakeCycleDate(blockedTransitionAt: IssueBlockersResolvedWakeCycleInput): Date | null {
  if (blockedTransitionAt == null || blockedTransitionAt === "") return null;
  const parsed = blockedTransitionAt instanceof Date
    ? blockedTransitionAt
    : new Date(blockedTransitionAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function wakeCoversIssueBlockersResolvedReadyState(
  wake: {
    status: string;
    idempotencyKey: string | null;
    requestedAt: Date;
  },
  keys: {
    cycleKey: string;
    oldStateKey: string;
    legacyKeys: Set<string>;
    blockedTransitionAt: Date | null;
  },
): boolean {
  const idempotencyKey = wake.idempotencyKey;
  if (!idempotencyKey) return false;

  if (idempotencyKey === keys.cycleKey) {
    return IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  if (idempotencyKey === keys.oldStateKey) {
    if (IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return true;
    if (wake.status !== "completed") return false;
    if (!keys.blockedTransitionAt) return true;
    return wake.requestedAt.getTime() >= keys.blockedTransitionAt.getTime();
  }

  if (keys.legacyKeys.has(idempotencyKey)) {
    return IN_FLIGHT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status);
  }

  return false;
}

/**
 * Find a wake that already covers the current dependency-ready state of the
 * dependent issue. The check is level-triggered and cycle-aware:
 *
 * - The cycle-aware state key matches a wake in any idempotent status
 *   (including `completed`). This suppresses a duplicate for the SAME ready
 *   state, including the current blocked cycle.
 * - The old no-cycle state key matches in-flight statuses (deploy overlap),
 *   or a `completed` wake whose `requestedAt` is at or after the current
 *   `blockedTransitionAt` (same cycle). A completed old-key wake from a
 *   previous cycle does not suppress.
 * - Each legacy per-edge key matches only a wake that is still in flight.
 *
 * Returns the first matching wake or `null`.
 */
export async function findExistingIssueBlockersResolvedWakeForReadyState(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
  },
) {
  const cycleKey = buildIssueBlockersResolvedWakeStateKey(input);
  const oldStateKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle(input);
  const legacyKeyList = [
    ...new Set(
      input.blockerIssueIds
        .filter(Boolean)
        .map((resolvedBlockerIssueId) =>
          buildIssueBlockersResolvedWakeIdempotencyKey({
            dependentIssueId: input.dependentIssueId,
            resolvedBlockerIssueId,
          }),
        ),
    ),
  ];
  const lookupKeys = [...new Set([cycleKey, oldStateKey, ...legacyKeyList])];
  const blockedTransitionAt = parseWakeCycleDate(input.blockedTransitionAt);

  const rows = await db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, lookupKeys),
      ),
    );

  const covering = rows.find((row) =>
    wakeCoversIssueBlockersResolvedReadyState(row, {
      cycleKey,
      oldStateKey,
      legacyKeys: new Set(legacyKeyList),
      blockedTransitionAt,
    }),
  );
  return covering ?? null;
}

/**
 * One blocker edge of a dependent, reduced to the two timestamps that decide
 * whether the edge carries news for the dependent's current blocked cycle:
 *
 * - `resolvedAt`: when the blocker issue reached `done` (`issues.completedAt`).
 * - `linkedAt`: when the `blocks` edge itself was created
 *   (`issue_relations.created_at`).
 */
export type IssueBlockerResolutionFact = {
  blockerIssueId: string;
  resolvedAt: IssueBlockersResolvedWakeCycleInput;
  linkedAt: IssueBlockersResolvedWakeCycleInput;
};

/**
 * Edge-triggered guard for `issue_blockers_resolved`.
 *
 * The level-triggered state key suppresses a duplicate wake only for one blocked
 * cycle. A dependent that keeps re-entering `blocked` (each dispatch checks the
 * issue out, which flips it to `in_progress`, and the agent sets it back to
 * `blocked`) gets a fresh `blockedTransitionAt` and therefore a fresh key on
 * every round, so a dependent whose formal edges were ALREADY terminal when it
 * entered `blocked` was re-woken forever without any new fact. That is the
 * MAI-1819 loop: the real block lives in the free-text `unblockDescriptor`, not
 * in an edge.
 *
 * A blocker edge only carries news for the current blocked cycle if it changed
 * at or after the dependent entered `blocked`:
 *
 * - the blocker reached `done` at/after `blockedTransitionAt` (the real
 *   `open -> done` transition the wake reason is named after), or
 * - the edge itself was attached at/after `blockedTransitionAt` (an already-done
 *   blocker linked during this cycle is new information too).
 *
 * Fails open (returns `true`) whenever the decision cannot be made from the
 * available facts — no recorded blocked cycle, no edge rows, or a `done` blocker
 * without a `completedAt` (rows predating that column). A permitted wake is then
 * still bounded by the state-key dedup, so failing open costs at most one wake
 * per ready state instead of dropping a legitimate one.
 */
export function hasBlockerResolutionInBlockedCycle(input: {
  blockedTransitionAt: IssueBlockersResolvedWakeCycleInput;
  resolutions: IssueBlockerResolutionFact[];
}): boolean {
  const cycleStart = parseWakeCycleDate(input.blockedTransitionAt);
  if (!cycleStart) return true;
  if (input.resolutions.length === 0) return true;

  return input.resolutions.some((resolution) => {
    const resolvedAt = parseWakeCycleDate(resolution.resolvedAt);
    if (!resolvedAt) return true;
    if (resolvedAt.getTime() >= cycleStart.getTime()) return true;
    const linkedAt = parseWakeCycleDate(resolution.linkedAt);
    return linkedAt != null && linkedAt.getTime() >= cycleStart.getTime();
  });
}

/**
 * Load the `blocks` edges of `dependentIssueId` that point at the given blockers,
 * with the timestamps `hasBlockerResolutionInBlockedCycle` needs.
 */
export async function listIssueBlockerResolutionFacts(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
  },
): Promise<IssueBlockerResolutionFact[]> {
  const blockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  if (blockerIssueIds.length === 0) return [];

  const rows = await db
    .select({
      blockerIssueId: issueRelations.issueId,
      resolvedAt: issues.completedAt,
      linkedAt: issueRelations.createdAt,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, input.companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, input.dependentIssueId),
        inArray(issueRelations.issueId, blockerIssueIds),
      ),
    );

  return rows.map((row) => ({
    blockerIssueId: row.blockerIssueId,
    resolvedAt: row.resolvedAt,
    linkedAt: row.linkedAt,
  }));
}

/**
 * Edge-triggered gate used by all three `issue_blockers_resolved` emit paths
 * (route-time update, route-time comment, periodic/finalize backstop). Returns
 * `true` when at least one blocker edge changed during the dependent's current
 * blocked cycle. See `hasBlockerResolutionInBlockedCycle` for the rule and its
 * fail-open cases. Callers wrap this in the same try/catch they already use for
 * `findExistingIssueBlockersResolvedWakeForReadyState` and fail open on a lookup
 * error, so a transient DB problem can never swallow a legitimate wake.
 */
export async function hasIssueBlockerResolutionInBlockedCycle(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    blockerIssueIds: string[];
    blockedTransitionAt?: IssueBlockersResolvedWakeCycleInput;
  },
): Promise<boolean> {
  const resolutions = await listIssueBlockerResolutionFacts(db, input);
  return hasBlockerResolutionInBlockedCycle({
    blockedTransitionAt: input.blockedTransitionAt,
    resolutions,
  });
}
