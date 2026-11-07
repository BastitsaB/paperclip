import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SSH_WORKSPACE_SYNC_MAX_MB,
  SSH_WORKSPACE_SYNC_MAX_MB_ENV,
  SSH_WORKSPACE_SYNC_SIZE_EXCLUDES,
  SshWorkspaceTooLargeError,
  assertSshWorkspaceWithinSyncLimit,
  measureDirectoryBytesUpTo,
  resolveSshWorkspaceSyncMaxBytes,
} from "./workspace-size-guard.js";

const MB = 1024 * 1024;

describe("workspace size guard", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function fixture(files: Record<string, number>): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-size-guard-"));
    cleanupDirs.push(root);
    for (const [relative, size] of Object.entries(files)) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, Buffer.alloc(size));
    }
    return root;
  }

  it("resolves the default, an explicit value and the disable switch", () => {
    expect(resolveSshWorkspaceSyncMaxBytes({})).toBe(DEFAULT_SSH_WORKSPACE_SYNC_MAX_MB * MB);
    expect(resolveSshWorkspaceSyncMaxBytes({ [SSH_WORKSPACE_SYNC_MAX_MB_ENV]: "2" })).toBe(2 * MB);
    expect(resolveSshWorkspaceSyncMaxBytes({ [SSH_WORKSPACE_SYNC_MAX_MB_ENV]: "0" })).toBeNull();
  });

  it("falls back to the default for invalid values instead of disabling the guard", () => {
    for (const raw of ["", "abc", "-5"]) {
      expect(resolveSshWorkspaceSyncMaxBytes({ [SSH_WORKSPACE_SYNC_MAX_MB_ENV]: raw })).toBe(
        DEFAULT_SSH_WORKSPACE_SYNC_MAX_MB * MB,
      );
    }
  });

  it("ignores .git and .paperclip-runtime like the upload does", async () => {
    const root = await fixture({
      "src/a.txt": 100,
      ".git/objects/pack/big.pack": 5000,
      ".paperclip-runtime/runs/x/blob": 5000,
    });
    const result = await measureDirectoryBytesUpTo(root, 1000, SSH_WORKSPACE_SYNC_SIZE_EXCLUDES);
    expect(result).toEqual({ bytes: 100, exceeded: false });
  });

  it("skips .git at any depth, like tar --exclude does for nested worktrees", async () => {
    const root = await fixture({
      "wt-1/src/a.txt": 100,
      "wt-1/.git": 5000,
      "vendor/lib/.git/objects/x": 5000,
    });
    const result = await measureDirectoryBytesUpTo(root, 1000, SSH_WORKSPACE_SYNC_SIZE_EXCLUDES);
    expect(result).toEqual({ bytes: 100, exceeded: false });
  });

  it("stops early once the limit is exceeded", async () => {
    const root = await fixture({ "a/one.bin": 600, "b/two.bin": 600, "c/three.bin": 600 });
    const result = await measureDirectoryBytesUpTo(root, 1000, SSH_WORKSPACE_SYNC_SIZE_EXCLUDES);
    expect(result.exceeded).toBe(true);
    expect(result.bytes).toBe(1200);
  });

  it("refuses an oversized workspace with a named error and accepts a small one", async () => {
    const big = await fixture({ "wt-1/node_modules/x.bin": 2 * MB });
    const env = { [SSH_WORKSPACE_SYNC_MAX_MB_ENV]: "1" };
    await expect(assertSshWorkspaceWithinSyncLimit(big, env)).rejects.toBeInstanceOf(SshWorkspaceTooLargeError);
    await expect(assertSshWorkspaceWithinSyncLimit(big, env)).rejects.toThrow(SSH_WORKSPACE_SYNC_MAX_MB_ENV);

    const small = await fixture({ "src/a.txt": 10 });
    await expect(assertSshWorkspaceWithinSyncLimit(small, env)).resolves.toBeUndefined();
    await expect(
      assertSshWorkspaceWithinSyncLimit(big, { [SSH_WORKSPACE_SYNC_MAX_MB_ENV]: "0" }),
    ).resolves.toBeUndefined();
  });
});
