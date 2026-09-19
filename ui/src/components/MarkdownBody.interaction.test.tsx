// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { issuesApi } from "../api/issues";
import {
  MarkdownIssueSummariesContext,
  type MarkdownIssueSummary,
} from "../context/MarkdownIssueSummariesContext";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: { children: React.ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function renderMarkdown(children: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  flushSync(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MarkdownBody>{children}</MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });

  return container;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  flushSync(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("MarkdownBody code block interactions", () => {
  it("toggles line wrapping for indented preformatted markdown blocks", () => {
    const node = renderMarkdown("Plan:\n\n    source fetch/sync -> signal inbox");
    const pre = node.querySelector("pre");
    const wrapButton = node.querySelector<HTMLButtonElement>(".paperclip-markdown-codeblock-wrap");

    expect(pre?.style.whiteSpace).toBe("");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");

    click(wrapButton);

    expect(pre?.style.whiteSpace).toBe("pre-wrap");
    expect(pre?.style.overflowWrap).toBe("anywhere");
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Unwrap lines");

    click(wrapButton);

    expect(pre?.style.whiteSpace).toBe("");
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");
  });
});

describe("MarkdownBody issue links", () => {
  function renderWithSummaries(children: string, summaries: ReadonlyMap<string, MarkdownIssueSummary> | null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MarkdownIssueSummariesContext.Provider value={summaries}>
              <MarkdownBody>{children}</MarkdownBody>
            </MarkdownIssueSummariesContext.Provider>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    return container;
  }

  it("uses a page-provided summary instead of fetching the referenced issue", async () => {
    const get = vi.mocked(issuesApi.get);
    get.mockReset();
    get.mockReturnValue(new Promise(() => undefined));
    const summary: MarkdownIssueSummary = { id: "issue-7", identifier: "PAP-7", title: "Known task", status: "in_progress" };

    const node = renderWithSummaries("See [PAP-7](/issues/PAP-7) and [PAP-8](/issues/PAP-8).", new Map([["PAP-7", summary]]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(node.querySelector('a[aria-label="Issue PAP-7: Known task"]')).not.toBeNull();
    // Only the reference without a summary falls back to the per-link GET.
    expect(get.mock.calls.map(([id]) => id)).toEqual(["PAP-8"]);
  });
});
