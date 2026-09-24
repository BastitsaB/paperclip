// MAI-3047: a single, marker-bound exception to "in_progress issues require an
// assignee". The Task-Health routine needs a registered, synthetically overdue
// test issue that stays `in_progress` without an owner, blocker, execution
// policy or monitor until its qualifying scan. Any assignee would start an
// assignment run and let recovery mutate the test, so the only reliable
// fixture is an unassigned one.
//
// The exception is deliberately narrow: exactly one marker line, and only for an
// issue that is otherwise inert (no blockers, no execution policy). Everything
// else keeps the regular assignee requirement.

export const TASK_HEALTH_CONTROL_TEST_MARKER =
  "CONTROL_TEST_MODE: task-health-e2e-v1";

export function hasTaskHealthControlTestMarker(
  description: string | null | undefined,
): boolean {
  if (!description) return false;
  return description
    .split(/\r?\n/)
    .some((line) => line.trim() === TASK_HEALTH_CONTROL_TEST_MARKER);
}

export function allowsUnassignedInProgressControlTest(input: {
  description: string | null | undefined;
  blockerCount: number;
  executionPolicy: unknown;
}): boolean {
  return (
    hasTaskHealthControlTestMarker(input.description) &&
    input.blockerCount === 0 &&
    input.executionPolicy == null
  );
}
