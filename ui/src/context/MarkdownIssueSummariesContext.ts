import { createContext, useContext } from "react";
import type { IssueRelatedWorkSummary, IssueRelationIssueSummary } from "@paperclipai/shared";

/** Title/status an inline issue link needs; a subset of the full issue. */
export type MarkdownIssueSummary = Pick<IssueRelationIssueSummary, "id" | "identifier" | "title" | "status">;

/**
 * Issue summaries already loaded by the surrounding page (e.g. the task's
 * related-work references), keyed by id and upper-cased identifier. Inline
 * issue links read from here so a task with many references does not fire
 * one full issue GET per link.
 */
export const MarkdownIssueSummariesContext = createContext<ReadonlyMap<string, MarkdownIssueSummary> | null>(null);

export function buildMarkdownIssueSummaries(
  relatedWork: IssueRelatedWorkSummary | null | undefined,
): ReadonlyMap<string, MarkdownIssueSummary> | null {
  if (!relatedWork) return null;
  const summaries = new Map<string, MarkdownIssueSummary>();
  for (const { issue } of [...relatedWork.outbound, ...relatedWork.inbound]) {
    const summary = { id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status };
    summaries.set(issue.id, summary);
    if (issue.identifier) summaries.set(issue.identifier.toUpperCase(), summary);
  }
  return summaries.size > 0 ? summaries : null;
}

export function useMarkdownIssueSummary(issuePathId: string): MarkdownIssueSummary | null {
  const summaries = useContext(MarkdownIssueSummariesContext);
  return summaries?.get(issuePathId) ?? summaries?.get(issuePathId.toUpperCase()) ?? null;
}
