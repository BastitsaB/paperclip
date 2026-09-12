export const DEFAULT_ACP_ENGINE_AGENT = "claude";
export const DEFAULT_ACP_ENGINE_MODE = "persistent";
export const DEFAULT_ACP_ENGINE_PERMISSION_MODE = "approve-all";
export const DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS = "deny";
export const DEFAULT_ACP_ENGINE_TIMEOUT_SEC = 0;
export const DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS = 0;

// The bound on the ACP startup handshake (`runtime.ensureSession()`). This
// deadline is separate from, and much smaller than, the whole-adapter
// execution timeout: it bounds only the handshake, not the agent turn. A real
// handshake completes in a few seconds; this value gives it generous room
// before the host gives up and reports a closed timeout code.
export const ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS = 60_000;

// Lower bound for the override. A deadline below this cannot distinguish a
// hung provider from a slow one, so a too-small value is treated as a
// misconfiguration and ignored rather than silently starving every start.
const ACPX_HANDSHAKE_TIMEOUT_MIN_MS = 5_000;

// Upper bound for the override. A stuck handshake still has to terminalize
// its run in reasonable time; without a cap a typo could park a run for hours.
const ACPX_HANDSHAKE_TIMEOUT_MAX_MS = 600_000;

/**
 * Resolves the handshake deadline, overridable via
 * `PAPERCLIP_ACPX_HANDSHAKE_TIMEOUT_MS`.
 *
 * The deadline is a property of the HOST, not of the protocol: the handshake
 * competes for CPU with everything else on the machine. On a self-hosted box
 * that also runs CI, a start that normally takes seconds can miss a 60s
 * deadline purely from scheduling delay, and every miss terminalizes the run
 * and leaves an execution hold behind. Operators of loaded hosts need to widen
 * the deadline without forking the engine; hosts with dedicated capacity keep
 * the tight default. An unparsable or out-of-range value falls back to the
 * default instead of failing the process, because a bad env var must not take
 * the adapter down.
 */
function resolveAcpxHandshakeTimeoutMs(
  raw: string | undefined = process.env.PAPERCLIP_ACPX_HANDSHAKE_TIMEOUT_MS,
): number {
  if (raw == null || raw.trim() === "") return ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS;
  if (parsed < ACPX_HANDSHAKE_TIMEOUT_MIN_MS) return ACPX_HANDSHAKE_TIMEOUT_DEFAULT_MS;
  if (parsed > ACPX_HANDSHAKE_TIMEOUT_MAX_MS) return ACPX_HANDSHAKE_TIMEOUT_MAX_MS;
  return parsed;
}

export { resolveAcpxHandshakeTimeoutMs };

export const ACPX_HANDSHAKE_TIMEOUT_MS = resolveAcpxHandshakeTimeoutMs();

// How often the host polls the duplex control-channel disposition while the
// handshake is in flight. The read is a cheap, non-mutating getter, so a
// short interval costs nothing while giving the host near-immediate notice
// of a channel loss.
export const ACPX_HANDSHAKE_TRANSPORT_POLL_MS = 250;

export const ACPX_ADAPTER_AGENT_IDS = {
  claude_local: "claude",
  codex_local: "codex",
  gemini_local: "gemini",
  kimi_local: "kimi",
  custom_acp: "custom",
} as const;

export type AcpxAdapterType = keyof typeof ACPX_ADAPTER_AGENT_IDS;
export type AcpxAgentId = (typeof ACPX_ADAPTER_AGENT_IDS)[AcpxAdapterType];

export function acpxAgentIdForAdapterType(adapterType: string | null | undefined): AcpxAgentId | null {
  if (!adapterType) return null;
  return ACPX_ADAPTER_AGENT_IDS[adapterType as AcpxAdapterType] ?? null;
}
