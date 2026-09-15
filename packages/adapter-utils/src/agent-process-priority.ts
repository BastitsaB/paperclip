import { readdirSync } from "node:fs";
import os from "node:os";

/**
 * Scheduling priority for agent runtime processes.
 *
 * Paperclip usually shares its host (often one container) with the agent
 * runtimes it launches and with everything those agents start: builds, dev
 * servers, test suites, browsers. Under load those children starve the API
 * server's event loop and the board becomes unusable. Operators can set
 * `PAPERCLIP_AGENT_PROCESS_NICE` to launch agent processes with a higher nice
 * value, so the server keeps CPU precedence while agents still use every idle
 * core. Unix children inherit the nice value, so the whole agent subtree runs
 * at the lower priority.
 *
 * Unset, empty, or `0` keeps today's behavior byte-for-byte: no syscall runs.
 */
export const AGENT_PROCESS_NICE_ENV = "PAPERCLIP_AGENT_PROCESS_NICE";

// Unprivileged processes may only raise their nice value, so the useful range
// for this knob is the non-negative half of the Unix nice range.
const AGENT_PROCESS_NICE_MAX = 19;

const warnedInvalidValues = new Set<string>();
const warnedApplyErrorCodes = new Set<string>();

type Warn = (message: string, detail?: Record<string, unknown>) => void;

const defaultWarn: Warn = (message, detail) => {
  console.warn(detail ?? {}, message);
};

/**
 * Resolves the configured nice value. An unparsable or out-of-range value is
 * ignored (returns 0) with a single warning per distinct value, because a bad
 * env var must never keep agents from starting and must not spam the log on
 * every run.
 */
export function resolveAgentProcessNice(
  raw: string | undefined = process.env[AGENT_PROCESS_NICE_ENV],
  warn: Warn = defaultWarn,
): number {
  if (raw == null) return 0;
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  // Strict digits only: `parseInt("10abc")` would silently accept a typo.
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= AGENT_PROCESS_NICE_MAX) {
    return parsed;
  }
  if (!warnedInvalidValues.has(trimmed)) {
    warnedInvalidValues.add(trimmed);
    warn(
      `ignoring invalid ${AGENT_PROCESS_NICE_ENV}; expected an integer between 0 and ${AGENT_PROCESS_NICE_MAX}`,
      { value: trimmed },
    );
  }
  return 0;
}

/** Test hook: lets each test observe the warn-once behavior from a clean slate. */
export function resetAgentProcessNiceWarningsForTests(): void {
  warnedInvalidValues.clear();
  warnedApplyErrorCodes.clear();
}

export interface ApplyAgentProcessNiceOptions {
  nice?: number;
  platform?: NodeJS.Platform;
  getPriority?: (pid: number) => number;
  setPriority?: (pid: number, priority: number) => void;
  listThreadIds?: (pid: number) => number[];
  warn?: Warn;
}

function listLinuxThreadIds(pid: number): number[] {
  return readdirSync(`/proc/${pid}/task`)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((tid) => Number.isInteger(tid) && tid > 0);
}

/**
 * Lowers the scheduling priority of a freshly spawned agent process.
 *
 * Why `setpriority` after spawn instead of a `nice -n` command prefix: the
 * ACPX runtime spawns the agent itself and classifies the provider by its
 * command line, so a wrapper would change agent detection and session
 * fingerprints; it would also depend on a `nice` binary being on PATH. The
 * syscall keeps argv, PID, process group, signals, and stdio untouched.
 *
 * On Linux `setpriority(PRIO_PROCESS, pid)` only changes the thread whose TID
 * equals the PID. Runtimes such as Node or tokio create worker threads during
 * startup, and a worker thread that later spawns a tool would pass its own
 * (unchanged) nice value on. So every thread already listed in
 * `/proc/<pid>/task` is adjusted too; threads and processes created afterwards
 * inherit from an adjusted thread.
 *
 * The configured value is a floor, not a target: a process that already runs
 * at the same or a higher nice value (inherited from a deprioritized server) is
 * left alone. That keeps an unprivileged server from logging EACCES on every
 * spawn and keeps a root server from ever raising an agent's priority.
 *
 * Never throws: a failure (for example the process already exited) is logged
 * once per error code and the agent keeps running at its inherited priority.
 */
export function applyAgentProcessNice(
  pid: number | undefined,
  options: ApplyAgentProcessNiceOptions = {},
): void {
  const warn = options.warn ?? defaultWarn;
  const nice = options.nice ?? resolveAgentProcessNice(undefined, warn);
  if (nice === 0) return;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return;
  const getPriority = options.getPriority ?? os.getPriority;
  const setPriority = options.setPriority ?? os.setPriority;

  const lowerPriority = (id: number): void => {
    if (getPriority(id) >= nice) return;
    setPriority(id, nice);
  };

  try {
    lowerPriority(pid);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    // One entry per failure class is enough to diagnose a host; a per-spawn
    // warning would flood the log for every agent run.
    if (!warnedApplyErrorCodes.has(code)) {
      warnedApplyErrorCodes.add(code);
      warn("failed to lower agent process priority", {
        pid,
        nice,
        code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (platform !== "linux") return;
  const listThreadIds = options.listThreadIds ?? listLinuxThreadIds;
  let threadIds: number[];
  try {
    threadIds = listThreadIds(pid);
  } catch {
    // The process exited between the two calls; nothing left to adjust.
    return;
  }
  for (const tid of threadIds) {
    if (tid === pid) continue;
    try {
      lowerPriority(tid);
    } catch {
      // A thread can exit while we iterate; that is not an error.
    }
  }
}
