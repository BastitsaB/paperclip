/**
 * Provider-neutral debug channel. It is deliberately separate from PRP event
 * delivery: its sequence and acknowledgement cannot influence run authority,
 * replay cursors, or terminal completion.
 */
export type ProviderTraceRecord =
  | ({ kind: "frame" } & Record<string, unknown>)
  | ({ kind: "interpretation" } & Record<string, unknown>)
  | ({ kind: "trace_status" } & Record<string, unknown>);

export interface ProviderTraceBatch {
  traceId: string;
  debugSequence: number;
  records: ProviderTraceRecord[];
}

export interface ProviderTraceAck {
  traceId: string;
  acknowledgedDebugSequence: number;
}

export interface ProviderTraceSink {
  appendBatch(batch: ProviderTraceBatch): Promise<ProviderTraceAck>;
  finish(input: {
    traceId: string;
    status: "complete" | "incomplete" | "truncated";
    reason?: string | null;
  }): Promise<void>;
}
