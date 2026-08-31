export interface RunnerEvalScenario<TInput = unknown> {
  readonly id: string;
  readonly input: TInput;
}

export interface RunnerEvalCandidate<TCandidate = unknown> {
  readonly id: string;
  readonly config: TCandidate;
  readonly preflight?: () => void | Promise<void>;
}

export interface RunnerEvalResult<TOutput = unknown, TScore = unknown> {
  readonly scenarioId: string;
  readonly candidateId: string;
  readonly output: TOutput;
  readonly score: TScore;
}

export class RunnerEvalMatrixConfigurationError extends Error {
  readonly code = "paperclip_runner_eval_matrix_configuration_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "RunnerEvalMatrixConfigurationError";
  }
}

/** Package-local deterministic matrix orchestration for conformance tests. */
export async function runRunnerEvalMatrix<TInput, TCandidate, TOutput, TScore>(input: {
  readonly scenarios: readonly RunnerEvalScenario<TInput>[];
  readonly candidates: readonly RunnerEvalCandidate<TCandidate>[];
  readonly execute: (context: {
    readonly scenario: RunnerEvalScenario<TInput>;
    readonly candidate: RunnerEvalCandidate<TCandidate>;
  }) => Promise<TOutput>;
  readonly score: (context: {
    readonly scenario: RunnerEvalScenario<TInput>;
    readonly candidate: RunnerEvalCandidate<TCandidate>;
    readonly output: TOutput;
  }) => Promise<TScore> | TScore;
}): Promise<readonly RunnerEvalResult<TOutput, TScore>[]> {
  assertUniqueNonEmptyIds("scenario", input.scenarios);
  assertUniqueNonEmptyIds("candidate", input.candidates);

  for (const candidate of input.candidates) await candidate.preflight?.();

  const results: RunnerEvalResult<TOutput, TScore>[] = [];
  for (const scenario of input.scenarios) {
    for (const candidate of input.candidates) {
      const output = await input.execute({ scenario, candidate });
      const score = await input.score({ scenario, candidate, output });
      results.push(Object.freeze({
        scenarioId: scenario.id,
        candidateId: candidate.id,
        output,
        score,
      }));
    }
  }
  return Object.freeze(results);
}

function assertUniqueNonEmptyIds(
  kind: "scenario" | "candidate",
  values: readonly { readonly id: string }[],
): void {
  if (values.length === 0) {
    throw new RunnerEvalMatrixConfigurationError(`${kind} list must not be empty`);
  }
  const ids = new Set<string>();
  for (const value of values) {
    if (value.id.trim().length === 0) {
      throw new RunnerEvalMatrixConfigurationError(`${kind} id must not be empty`);
    }
    if (ids.has(value.id)) {
      throw new RunnerEvalMatrixConfigurationError(`duplicate ${kind} id: ${value.id}`);
    }
    ids.add(value.id);
  }
}
