import { readFileSync } from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PROCESS_NICE_ENV,
  applyAgentProcessNice,
  resetAgentProcessNiceWarningsForTests,
  resolveAgentProcessNice,
} from "./agent-process-priority.js";
import { runChildProcess } from "./server-utils.js";

describe("resolveAgentProcessNice", () => {
  beforeEach(() => resetAgentProcessNiceWarningsForTests());

  it("keeps the default priority when the value is unset or empty", () => {
    const warn = vi.fn();
    expect(resolveAgentProcessNice(undefined, warn)).toBe(0);
    expect(resolveAgentProcessNice("", warn)).toBe(0);
    expect(resolveAgentProcessNice("   ", warn)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts integers from 0 to 19", () => {
    const warn = vi.fn();
    expect(resolveAgentProcessNice("0", warn)).toBe(0);
    expect(resolveAgentProcessNice("10", warn)).toBe(10);
    expect(resolveAgentProcessNice(" 19 ", warn)).toBe(19);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["20", "-1", "-10", "abc", "10abc", "5.5", "1e1"])(
    "ignores invalid value %j with a warning",
    (raw) => {
      const warn = vi.fn();
      expect(resolveAgentProcessNice(raw, warn)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(AGENT_PROCESS_NICE_ENV);
    },
  );

  it("warns only once per invalid value", () => {
    const warn = vi.fn();
    resolveAgentProcessNice("nope", warn);
    resolveAgentProcessNice("nope", warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("applyAgentProcessNice", () => {
  it("does nothing when the configured nice is 0", () => {
    const setPriority = vi.fn();
    applyAgentProcessNice(1234, { nice: 0, platform: "linux", setPriority });
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("does nothing on Windows", () => {
    const setPriority = vi.fn();
    applyAgentProcessNice(1234, { nice: 10, platform: "win32", setPriority });
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("does nothing without a valid pid", () => {
    const setPriority = vi.fn();
    applyAgentProcessNice(undefined, { nice: 10, platform: "linux", setPriority });
    applyAgentProcessNice(0, { nice: 10, platform: "linux", setPriority });
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("sets the process priority and every existing thread on Linux", () => {
    const setPriority = vi.fn();
    applyAgentProcessNice(1234, {
      nice: 10,
      platform: "linux",
      setPriority,
      listThreadIds: () => [1234, 1235, 1236],
    });
    expect(setPriority.mock.calls).toEqual([
      [1234, 10],
      [1235, 10],
      [1236, 10],
    ]);
  });

  it("only sets the process priority on macOS", () => {
    const setPriority = vi.fn();
    const listThreadIds = vi.fn(() => [1, 2]);
    applyAgentProcessNice(1234, { nice: 5, platform: "darwin", setPriority, listThreadIds });
    expect(setPriority.mock.calls).toEqual([[1234, 5]]);
    expect(listThreadIds).not.toHaveBeenCalled();
  });

  it("logs and swallows setPriority failures", () => {
    const warn = vi.fn();
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(() =>
      applyAgentProcessNice(1234, {
        nice: 10,
        platform: "linux",
        warn,
        setPriority: () => {
          throw error;
        },
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "failed to lower agent process priority",
      expect.objectContaining({ pid: 1234, nice: 10, code: "EACCES" }),
    );
  });

  it("tolerates a process that exits before its threads are listed", () => {
    const setPriority = vi.fn();
    expect(() =>
      applyAgentProcessNice(1234, {
        nice: 10,
        platform: "linux",
        setPriority,
        listThreadIds: () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
      }),
    ).not.toThrow();
    expect(setPriority).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(process.platform === "win32")("runChildProcess agent priority", () => {
  const previous = process.env[AGENT_PROCESS_NICE_ENV];

  afterEach(() => {
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env[AGENT_PROCESS_NICE_ENV];
    else process.env[AGENT_PROCESS_NICE_ENV] = previous;
  });

  async function runNode(script: string, onSpawn?: (pid: number) => void) {
    return runChildProcess(`nice-test-${Math.random()}`, process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 30,
      graceSec: 1,
      onLog: async () => {},
      onSpawn: async ({ pid }) => onSpawn?.(pid),
    });
  }

  it("applies the configured nice to the spawned child pid", async () => {
    process.env[AGENT_PROCESS_NICE_ENV] = "7";
    const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
    let childPid = 0;
    const result = await runNode("", (pid) => {
      childPid = pid;
    });
    expect(result.exitCode).toBe(0);
    expect(setPriority).toHaveBeenCalledWith(childPid, 7);
  });

  it("does not touch priority when unset", async () => {
    delete process.env[AGENT_PROCESS_NICE_ENV];
    const setPriority = vi.spyOn(os, "setPriority");
    const result = await runNode("");
    expect(result.exitCode).toBe(0);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("still runs the child when setPriority fails", async () => {
    process.env[AGENT_PROCESS_NICE_ENV] = "7";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(os, "setPriority").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    const result = await runNode("process.stdout.write('ok')");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it.skipIf(process.platform !== "linux")(
    "the child and the processes it starts really run at the configured nice",
    async () => {
      process.env[AGENT_PROCESS_NICE_ENV] = "9";
      // Field 19 of /proc/<pid>/stat is the nice value; the comm field (2) is
      // parenthesized and may contain spaces, so split after its closing paren.
      const niceOf = (pid: number | "self") => {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
      };
      const script = [
        "const { readFileSync } = require('node:fs');",
        "const { execFileSync } = require('node:child_process');",
        "setTimeout(() => {",
        "  const own = readFileSync('/proc/self/stat', 'utf8');",
        "  const grandchild = execFileSync('cat', ['/proc/self/stat'], { encoding: 'utf8' });",
        "  const nice = (s) => s.slice(s.lastIndexOf(')') + 2).split(' ')[16];",
        "  process.stdout.write(nice(own) + ' ' + nice(grandchild));",
        "}, 200);",
      ].join("\n");
      const result = await runNode(script);
      expect(result.exitCode).toBe(0);
      const serverNice = niceOf("self");
      expect(result.stdout.trim()).toBe(`${Math.max(9, serverNice)} ${Math.max(9, serverNice)}`);
    },
  );
});
