import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithCycle,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
  findExistingIssueBlockersResolvedWakeForReadyState,
} from "./issue-dependency-wakeups.js";

const dependentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockerIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherBlockerIssueId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const firstCycle = new Date("2026-04-01T12:00:00.000Z");
const secondCycle = new Date("2026-08-01T09:30:00.000Z");

type WakeRow = {
  id: string;
  status: string;
  idempotencyKey: string | null;
  requestedAt: Date;
};

type BlockerRow = { completedAt: Date | null };

// Die Funktion liest Wakes und (nur bei einem idempotenten Intent-Wake) die
// completedAt der Blocker; der Mock unterscheidet beide Queries an der Selektion.
function dbWithWakes(rows: WakeRow[], blockerRows: BlockerRow[] = []): Db {
  return {
    select(fields?: Record<string, unknown>) {
      const result = fields && "completedAt" in fields ? blockerRows : rows;
      return {
        from() {
          return {
            where() {
              return Promise.resolve(result);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

describe("buildIssueBlockersResolvedWakeStateKey", () => {
  it("ignores blockedTransitionAt so a repeated blocked cycle keeps the same key", () => {
    const first = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: secondCycle,
    });
    const none = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    expect(first).toBe(second);
    expect(first).toBe(none);
    expect(first).toContain(dependentIssueId);
  });

  it("is order-independent and changes with the blocker set", () => {
    const ab = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId, otherBlockerIssueId],
    });
    const ba = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [otherBlockerIssueId, blockerIssueId],
    });
    const a = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    expect(ab).toBe(ba);
    expect(ab).not.toBe(a);
  });

  it("differs from the cycle key and the no-cycle key", () => {
    const intentKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    expect(intentKey).not.toBe(
      buildIssueBlockersResolvedWakeStateKeyWithCycle({
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(intentKey).not.toBe(
      buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
  });
});

describe("buildIssueBlockersResolvedWakeStateKeyWithCycle", () => {
  it("is identical for the same dependent, blockers, and blockedTransitionAt", () => {
    const first = buildIssueBlockersResolvedWakeStateKeyWithCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKeyWithCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle.toISOString(),
    });
    expect(first).toBe(second);
    expect(first).toContain(dependentIssueId);
  });

  it("changes when blockedTransitionAt changes", () => {
    const first = buildIssueBlockersResolvedWakeStateKeyWithCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKeyWithCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: secondCycle,
    });
    expect(first).not.toBe(second);
  });

  it("hashes a null cycle as none and differs from any timestamp", () => {
    const noneKey = buildIssueBlockersResolvedWakeStateKeyWithCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: null,
    });
    const omittedKey = buildIssueBlockersResolvedWakeStateKeyWithCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const datedKey = buildIssueBlockersResolvedWakeStateKeyWithCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    expect(noneKey).toBe(omittedKey);
    expect(noneKey).not.toBe(datedKey);
    expect(noneKey).not.toBe(
      buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
  });
});

describe("findExistingIssueBlockersResolvedWakeForReadyState", () => {
  const readyState = {
    companyId,
    dependentIssueId,
    blockerIssueIds: [blockerIssueId],
    blockedTransitionAt: secondCycle,
  };

  const intentKey = buildIssueBlockersResolvedWakeStateKey(readyState);
  // Blocker wurde vor dem ersten Wake erledigt (firstCycle liegt davor).
  const blockerDoneBeforeWake = [{ completedAt: new Date("2026-03-31T12:00:00.000Z") }];

  it("suppresses a completed intent wake from an earlier blocked cycle for the same blocker set", async () => {
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes(
        [{ id: "wake-intent", status: "completed", idempotencyKey: intentKey, requestedAt: firstCycle }],
        blockerDoneBeforeWake,
      ),
      // Neuer blockedTransitionAt: der Agent hat das Ticket erneut auf blocked gesetzt.
      readyState,
    );
    expect(existing?.id).toBe("wake-intent");
  });

  it("does not let a completed intent wake cover once a blocker was completed again after it", async () => {
    // Blocker wurde nach dem Wake wiedereröffnet und erneut erledigt; NULL-Zeilen
    // (kein Erledigt-Zeitpunkt) dürfen das Maximum nicht verfälschen.
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes(
        [{ id: "wake-intent", status: "completed", idempotencyKey: intentKey, requestedAt: firstCycle }],
        [{ completedAt: null }, { completedAt: new Date(firstCycle.getTime() + 60_000) }],
      ),
      readyState,
    );
    expect(existing).toBeNull();
  });

  it("lets an in-flight intent wake cover even if a blocker completed after it was requested", async () => {
    // Ein queued/claimed Wake liest den Stand erst beim Run; ein zweiter Run wäre überflüssig.
    for (const status of ["queued", "claimed"]) {
      const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
        dbWithWakes(
          [{ id: `wake-${status}`, status, idempotencyKey: intentKey, requestedAt: firstCycle }],
          [{ completedAt: new Date(firstCycle.getTime() + 60_000) }],
        ),
        readyState,
      );
      expect(existing?.id).toBe(`wake-${status}`);
    }
  });

  it("does not let an intent wake for a different blocker set cover", async () => {
    const otherSetKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [otherBlockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes(
        [{ id: "wake-other-set", status: "completed", idempotencyKey: otherSetKey, requestedAt: secondCycle }],
        blockerDoneBeforeWake,
      ),
      readyState,
    );
    expect(existing).toBeNull();
  });

  it.each(["skipped", "failed", "cancelled"])("does not let a %s intent wake cover", async (status) => {
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes(
        [{ id: "wake-intent", status, idempotencyKey: intentKey, requestedAt: secondCycle }],
        blockerDoneBeforeWake,
      ),
      readyState,
    );
    expect(existing).toBeNull();
  });

  it("suppresses a completed wake on the cycle-aware state key", async () => {
    const cycleKey = buildIssueBlockersResolvedWakeStateKeyWithCycle(readyState);
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-cycle",
          status: "completed",
          idempotencyKey: cycleKey,
          requestedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-cycle");
  });

  it("does not let a completed old-key wake from a previous blocked cycle suppress", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-previous-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(existing).toBeNull();
  });

  it("suppresses a completed old-key wake requested at or after blockedTransitionAt", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-same-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: secondCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-old-same-cycle");
  });

  it("suppresses a completed old-key wake when blockedTransitionAt is null", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-no-cycle",
          status: "completed",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      {
        companyId,
        dependentIssueId,
        blockerIssueIds: [blockerIssueId],
        blockedTransitionAt: null,
      },
    );
    expect(existing?.id).toBe("wake-old-no-cycle");
  });

  it("suppresses an in-flight old-key wake across a later blocked cycle", async () => {
    const oldKey = buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const existing = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-old-queued",
          status: "queued",
          idempotencyKey: oldKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(existing?.id).toBe("wake-old-queued");
  });

  it("keeps legacy per-edge matching in-flight only", async () => {
    const legacyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
      dependentIssueId,
      resolvedBlockerIssueId: blockerIssueId,
    });
    const inFlight = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-legacy-claimed",
          status: "claimed",
          idempotencyKey: legacyKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(inFlight?.id).toBe("wake-legacy-claimed");

    const completed = await findExistingIssueBlockersResolvedWakeForReadyState(
      dbWithWakes([
        {
          id: "wake-legacy-completed",
          status: "completed",
          idempotencyKey: legacyKey,
          requestedAt: firstCycle,
        },
      ]),
      readyState,
    );
    expect(completed).toBeNull();
  });
});
