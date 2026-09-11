import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  buildIssueBlockersResolvedWakeIdempotencyKey,
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
  findExistingIssueBlockersResolvedWakeForReadyState,
  hasBlockerResolutionInBlockedCycle,
  hasIssueBlockerResolutionInBlockedCycle,
  listIssueBlockerResolutionFacts,
} from "./issue-dependency-wakeups.js";

const dependentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const blockerIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const firstCycle = new Date("2026-04-01T12:00:00.000Z");
const secondCycle = new Date("2026-08-01T09:30:00.000Z");

type WakeRow = {
  id: string;
  status: string;
  idempotencyKey: string | null;
  requestedAt: Date;
};

function dbWithWakes(rows: WakeRow[]): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

type BlockerEdgeRow = {
  blockerIssueId: string;
  resolvedAt: Date | null;
  linkedAt: Date | null;
};

function dbWithBlockerEdges(rows: BlockerEdgeRow[]): Db {
  return {
    select() {
      return {
        from() {
          return {
            innerJoin() {
              return {
                where() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
}

describe("buildIssueBlockersResolvedWakeStateKey", () => {
  it("is identical for the same dependent, blockers, and blockedTransitionAt", () => {
    const first = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle,
    });
    const second = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: firstCycle.toISOString(),
    });
    expect(first).toBe(second);
    expect(first).toContain(dependentIssueId);
  });

  it("changes when blockedTransitionAt changes", () => {
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
    expect(first).not.toBe(second);
  });

  it("hashes a null cycle as none and differs from any timestamp", () => {
    const noneKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: null,
    });
    const omittedKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    const datedKey = buildIssueBlockersResolvedWakeStateKey({
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

  it("suppresses a completed wake on the cycle-aware state key", async () => {
    const cycleKey = buildIssueBlockersResolvedWakeStateKey(readyState);
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

// Regression suite for MAI-1819: a `blocked` issue whose real block lives in a
// free-text `unblockDescriptor` kept re-firing `issue_blockers_resolved` because
// every dispatch checks the issue out (status -> `in_progress`) and the agent
// sets it back to `blocked`, which rewrites `blockedTransitionAt` and therefore
// the level-triggered state key.
describe("hasBlockerResolutionInBlockedCycle", () => {
  const linkedLongAgo = new Date("2026-01-05T08:00:00.000Z");
  const blockerDoneBeforeBlock = new Date("2026-03-20T10:00:00.000Z");

  it("blocks a repeat wake when every edge was already terminal at block time", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({
        blockedTransitionAt: firstCycle,
        resolutions: [
          {
            blockerIssueId,
            resolvedAt: blockerDoneBeforeBlock,
            linkedAt: linkedLongAgo,
          },
        ],
      }),
    ).toBe(false);
  });

  it("stays suppressed across checkout-induced re-blocks with the same terminal edges", () => {
    const resolutions = [
      { blockerIssueId, resolvedAt: blockerDoneBeforeBlock, linkedAt: linkedLongAgo },
    ];
    // Each dispatch would rewrite blockedTransitionAt; none of them may re-open
    // the wake, because no edge changed in any of those cycles.
    for (const cycle of [firstCycle, secondCycle, new Date("2026-09-07T01:52:48.000Z")]) {
      expect(hasBlockerResolutionInBlockedCycle({ blockedTransitionAt: cycle, resolutions })).toBe(
        false,
      );
    }
  });

  it("allows the wake when a blocker reached done during the current blocked cycle", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({
        blockedTransitionAt: firstCycle,
        resolutions: [
          {
            blockerIssueId,
            resolvedAt: secondCycle,
            linkedAt: linkedLongAgo,
          },
        ],
      }),
    ).toBe(true);
  });

  it("treats a blocker resolved exactly at blockedTransitionAt as fresh", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({
        blockedTransitionAt: firstCycle,
        resolutions: [{ blockerIssueId, resolvedAt: firstCycle, linkedAt: linkedLongAgo }],
      }),
    ).toBe(true);
  });

  it("allows the wake when an already-done blocker is linked during the current cycle", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({
        blockedTransitionAt: firstCycle,
        resolutions: [
          {
            blockerIssueId,
            resolvedAt: blockerDoneBeforeBlock,
            linkedAt: secondCycle,
          },
        ],
      }),
    ).toBe(true);
  });

  it("allows the wake when only one of several edges is fresh", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({
        blockedTransitionAt: firstCycle,
        resolutions: [
          { blockerIssueId, resolvedAt: blockerDoneBeforeBlock, linkedAt: linkedLongAgo },
          {
            blockerIssueId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            resolvedAt: secondCycle,
            linkedAt: linkedLongAgo,
          },
        ],
      }),
    ).toBe(true);
  });

  it("fails open without a recorded blocked cycle", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({
        blockedTransitionAt: null,
        resolutions: [
          { blockerIssueId, resolvedAt: blockerDoneBeforeBlock, linkedAt: linkedLongAgo },
        ],
      }),
    ).toBe(true);
  });

  it("fails open when no edge rows are available", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({ blockedTransitionAt: firstCycle, resolutions: [] }),
    ).toBe(true);
  });

  it("fails open for a done blocker without a completedAt timestamp", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({
        blockedTransitionAt: firstCycle,
        resolutions: [{ blockerIssueId, resolvedAt: null, linkedAt: linkedLongAgo }],
      }),
    ).toBe(true);
  });

  it("ignores an unparsable linkedAt instead of treating it as fresh", () => {
    expect(
      hasBlockerResolutionInBlockedCycle({
        blockedTransitionAt: firstCycle,
        resolutions: [{ blockerIssueId, resolvedAt: blockerDoneBeforeBlock, linkedAt: "not-a-date" }],
      }),
    ).toBe(false);
  });
});

describe("listIssueBlockerResolutionFacts", () => {
  it("returns an empty list without blocker ids and never queries", async () => {
    const db = {
      select() {
        throw new Error("must not query");
      },
    } as unknown as Db;
    await expect(
      listIssueBlockerResolutionFacts(db, {
        companyId,
        dependentIssueId,
        blockerIssueIds: [],
      }),
    ).resolves.toEqual([]);
  });

  it("maps edge rows to resolution facts", async () => {
    const facts = await listIssueBlockerResolutionFacts(
      dbWithBlockerEdges([
        { blockerIssueId, resolvedAt: firstCycle, linkedAt: secondCycle },
      ]),
      { companyId, dependentIssueId, blockerIssueIds: [blockerIssueId] },
    );
    expect(facts).toEqual([
      { blockerIssueId, resolvedAt: firstCycle, linkedAt: secondCycle },
    ]);
  });
});

describe("hasIssueBlockerResolutionInBlockedCycle", () => {
  it("suppresses the MAI-1819 pattern: blocked later than every terminal edge", async () => {
    await expect(
      hasIssueBlockerResolutionInBlockedCycle(
        dbWithBlockerEdges([
          {
            blockerIssueId,
            resolvedAt: firstCycle,
            linkedAt: new Date("2026-01-05T08:00:00.000Z"),
          },
        ]),
        {
          companyId,
          dependentIssueId,
          blockerIssueIds: [blockerIssueId],
          blockedTransitionAt: secondCycle,
        },
      ),
    ).resolves.toBe(false);
  });

  it("keeps a legitimate open -> done wake", async () => {
    await expect(
      hasIssueBlockerResolutionInBlockedCycle(
        dbWithBlockerEdges([
          {
            blockerIssueId,
            resolvedAt: secondCycle,
            linkedAt: new Date("2026-01-05T08:00:00.000Z"),
          },
        ]),
        {
          companyId,
          dependentIssueId,
          blockerIssueIds: [blockerIssueId],
          blockedTransitionAt: firstCycle,
        },
      ),
    ).resolves.toBe(true);
  });
});
