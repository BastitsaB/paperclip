// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RoutineActivityRow } from "./RoutineActivityRow";

const NOW = new Date("2026-09-24T18:00:00.000Z");

describe("RoutineActivityRow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a bare clock time for an event from today", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <RoutineActivityRow
          event={{ id: "e1", action: "issue.updated", details: null, createdAt: new Date("2026-09-24T16:08:00.000Z") }}
        />,
      );
    });
    // No comma means no date prefix was added — the row stayed compact.
    expect(container.textContent).not.toContain(",");
    flushSync(() => root.unmount());
  });

  it("prefixes the date for an event that is no longer from today", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <RoutineActivityRow
          event={{ id: "e2", action: "issue.updated", details: null, createdAt: new Date("2026-09-22T16:08:00.000Z") }}
        />,
      );
    });
    expect(container.textContent).toContain("Sep 22");
    flushSync(() => root.unmount());
  });
});
