import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues } from "@paperclipai/db";

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

function buildStateKey(
  dependentIssueId: string,
  digest: string,
  blockerCount: number,
  segment: "state" | "intent" = "state",
): string {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    segment,
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
 * Zyklus-Key der Vorversion: Blocker-Satz plus `blockedTransitionAt` (oder
 * `none`). Er wird nicht mehr geschrieben, der Lookup liest ihn aber weiter, damit
 * während der Deploy-Überlappung ein Wake, den die alte Version geschrieben hat,
 * ein Duplikat für denselben Zyklus unterdrückt.
 */
export function buildIssueBlockersResolvedWakeStateKeyWithCycle(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  const cycle = formatIssueBlockersResolvedWakeCycle(input.blockedTransitionAt);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, cycle),
    sortedBlockerIssueIds.length,
  );
}

/**
 * Intent-Key, den alle Emit-Pfade (Route, Finalize, periodischer Backstop) als
 * idempotencyKey schreiben: nur Abhängiges plus sortierter Blocker-Satz.
 *
 * Bewusst OHNE `blockedTransitionAt`: Setzt ein Agent sein Ticket trotz erledigter
 * Blocker erneut auf `blocked`, entstand mit dem Zyklus-Key pro Eintritt ein neuer
 * Key und damit ein neuer Wake, der den Agenten wieder weckte (Endlosschleife).
 * Ob ein neuer Wake nötig ist, entscheidet stattdessen
 * `findExistingIssueBlockersResolvedWakeForReadyState` am `completedAt` der
 * Blocker. Bewusst auch ohne Freitext (z. B. Unblock-Beschreibung): variiert der
 * Text pro Zyklus, wäre der Key wieder pro Zyklus neu. Das eigene Segment `intent`
 * trennt ihn vom gleich gehashten No-Cycle-Key der Vor-Vorversion, dessen
 * Lookup-Regel eine andere ist.
 *
 * `blockedTransitionAt` bleibt im Eingabetyp, damit die Aufrufer unverändert
 * bleiben; der Wert fließt hier nicht ein.
 */
export function buildIssueBlockersResolvedWakeStateKey(input: IssueBlockersResolvedReadyStateInput) {
  const sortedBlockerIssueIds = uniqueSortedBlockerIssueIds(input.blockerIssueIds);
  return buildStateKey(
    input.dependentIssueId,
    hashBlockerReadyStateDigest(sortedBlockerIssueIds, null),
    sortedBlockerIssueIds.length,
    "intent",
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
    intentKey: string;
    cycleKey: string;
    oldStateKey: string;
    legacyKeys: Set<string>;
    blockedTransitionAt: Date | null;
    latestBlockerCompletedAt: Date | null;
  },
): boolean {
  const idempotencyKey = wake.idempotencyKey;
  if (!idempotencyKey) return false;

  if (idempotencyKey === keys.intentKey) {
    if (!IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(wake.status)) return false;
    // Wurde ein Blocker nach diesem Wake erneut erledigt (reopen + done), ist das
    // ein neues Bereit-Ereignis, über das der Agent noch nicht informiert wurde.
    if (!keys.latestBlockerCompletedAt) return true;
    return wake.requestedAt.getTime() >= keys.latestBlockerCompletedAt.getTime();
  }

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
 * dependent issue. The check is level-triggered:
 *
 * - Der Intent-Key (ohne Blockiert-Zyklus) deckt in jedem idempotenten Status
 *   (inkl. `completed`), solange `requestedAt >= max(completedAt)` der Blocker
 *   des Satzes gilt. Warum ohne Zyklus: Der Agent wurde über genau diesen
 *   Bereit-Zustand schon informiert; setzt er das Ticket danach erneut auf
 *   `blocked`, ist das kein neues Ereignis und darf ihn nicht erneut wecken
 *   (sonst Schleife je `blocked`-Eintritt). Warum der `completedAt`-Vergleich:
 *   Ein abgeschlossener Wake darf nicht dauerhaft decken. Wird ein Blocker nach
 *   dem Wake wiedereröffnet und erneut erledigt, ist das ein echtes neues
 *   Bereit-Ereignis; ohne den Vergleich bliebe das Ticket still hängen.
 *   `completedAt = NULL` zählt nicht (kein Erledigt-Zeitpunkt bekannt).
 * - The cycle-aware state key of the previous version matches a wake in any
 *   idempotent status (including `completed`) for the SAME blocked cycle
 *   (deploy overlap).
 * - The old no-cycle state key matches in-flight statuses (deploy overlap),
 *   or a `completed` wake whose `requestedAt` is at or after the current
 *   `blockedTransitionAt` (same cycle). A completed old-key wake from a
 *   previous cycle does not suppress.
 * - Each legacy per-edge key matches only a wake that is still in flight.
 *
 * `skipped`, `failed` and `cancelled` wakes never cover.
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
  const intentKey = buildIssueBlockersResolvedWakeStateKey(input);
  const cycleKey = buildIssueBlockersResolvedWakeStateKeyWithCycle(input);
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
  const lookupKeys = [...new Set([intentKey, cycleKey, oldStateKey, ...legacyKeyList])];
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

  // Die Blocker-Zeitstempel werden nur gelesen, wenn ein Intent-Wake überhaupt
  // decken könnte; im Normalfall (kein solcher Wake) bleibt es bei einer Query.
  const hasIdempotentIntentWake = rows.some(
    (row) => row.idempotencyKey === intentKey && IDEMPOTENT_DEPENDENCY_WAKE_STATUS_SET.has(row.status),
  );
  const latestBlockerCompletedAt = hasIdempotentIntentWake
    ? await findLatestBlockerCompletedAt(db, input.companyId, input.blockerIssueIds)
    : null;

  const covering = rows.find((row) =>
    wakeCoversIssueBlockersResolvedReadyState(row, {
      intentKey,
      cycleKey,
      oldStateKey,
      legacyKeys: new Set(legacyKeyList),
      blockedTransitionAt,
      latestBlockerCompletedAt,
    }),
  );
  return covering ?? null;
}

/**
 * Spätester `completedAt` über die Blocker des Satzes. Das Maximum wird in JS
 * gebildet statt per SQL-`max()`, weil ein rohes `max()` ohne Spalten-Mapping den
 * Zeitstempel als String statt als Date liefert; Blocker-Sätze sind klein.
 */
async function findLatestBlockerCompletedAt(
  db: Db,
  companyId: string,
  blockerIssueIds: string[],
): Promise<Date | null> {
  const ids = uniqueSortedBlockerIssueIds(blockerIssueIds);
  if (ids.length === 0) return null;
  const rows = await db
    .select({ completedAt: issues.completedAt })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
  let latest: Date | null = null;
  for (const row of rows) {
    const completedAt = row.completedAt;
    if (!completedAt) continue;
    if (!latest || completedAt.getTime() > latest.getTime()) latest = completedAt;
  }
  return latest;
}
