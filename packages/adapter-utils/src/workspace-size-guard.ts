import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";

/**
 * Upper bound for a workspace that an SSH run copies to the remote host and back.
 *
 * Why this exists: an SSH run uploads the whole local workspace (only `.git` and
 * `.paperclip-runtime` are excluded), hashes every file for the restore baseline, and
 * after the turn downloads and re-hashes the whole tree again. None of these phases has
 * a deadline, and only the byte transfer reports progress. A fallback workspace that
 * agents filled with dozens of git worktrees (node_modules, .venv) grew to ~57 GB; a
 * single run then spent hours uploading and merging silently, held the agent's only
 * concurrency slot, and wrote ~57 GB per run to the remote disk. Failing fast with a
 * clear message is cheaper and more honest than an unbounded silent copy.
 */
export const SSH_WORKSPACE_SYNC_MAX_MB_ENV = "PAPERCLIP_SSH_WORKSPACE_SYNC_MAX_MB";
export const DEFAULT_SSH_WORKSPACE_SYNC_MAX_MB = 10 * 1024;

/**
 * Mirrors the `tar --exclude` names `prepareWorkspaceForSshExecution` passes. tar matches an
 * exclude without a slash against every path component at any depth, so a nested worktree's
 * `.git` file is skipped too; the guard therefore matches by entry name, not by root path.
 */
export const SSH_WORKSPACE_SYNC_SIZE_EXCLUDES = [".git", ".paperclip-runtime"] as const;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Resolve the limit in bytes. `0` disables the guard; an unset, empty or invalid value
 * falls back to the default so a typo can never silently turn the guard off.
 */
export function resolveSshWorkspaceSyncMaxBytes(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[SSH_WORKSPACE_SYNC_MAX_MB_ENV]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  const mb = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SSH_WORKSPACE_SYNC_MAX_MB;
  return mb === 0 ? null : Math.floor(mb * 1024 * 1024);
}

/**
 * Sum regular-file sizes below `root`, stopping as soon as `limitBytes` is exceeded.
 * Early exit matters: the oversized trees this guard targets hold millions of files,
 * and a full walk would itself become the slow, silent phase we want to avoid.
 * Symlinks are counted by their link size only (the upload does not follow them).
 * Only ENOENT (an entry vanishing during the walk) is tolerated; any other read error is
 * thrown, because silently skipping it would under-count and let an oversized tree through.
 */
export async function measureDirectoryBytesUpTo(
  root: string,
  limitBytes: number,
  excludeNames: readonly string[],
): Promise<{ bytes: number; exceeded: boolean }> {
  const excluded = new Set(excludeNames);
  let bytes = 0;
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const sizedEntries: string[] = [];
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() || entry.isSymbolicLink()) sizedEntries.push(full);
    }
    // One directory's lstat calls run concurrently; across directories the walk stays
    // depth-first so the early exit still triggers soon on a huge tree.
    const sizes = await Promise.all(
      sizedEntries.map((full) =>
        fs.lstat(full).then(
          (stats) => stats.size,
          (error: unknown) => {
            if (isMissing(error)) return 0;
            throw error;
          },
        ),
      ),
    );
    for (const size of sizes) bytes += size;
    if (bytes > limitBytes) return { bytes, exceeded: true };
  }
  return { bytes, exceeded: false };
}

export class SshWorkspaceTooLargeError extends Error {
  constructor(
    readonly localDir: string,
    readonly limitBytes: number,
  ) {
    const limitMb = Math.round(limitBytes / (1024 * 1024));
    super(
      `SSH workspace sync refused: ${localDir} exceeds ${limitMb} MB (excluding .git and .paperclip-runtime). ` +
        `Remove stale worktrees, dependency folders or scratch data from the workspace, ` +
        `or raise ${SSH_WORKSPACE_SYNC_MAX_MB_ENV} (0 disables the check).`,
    );
    this.name = "SshWorkspaceTooLargeError";
  }
}

/** Throws `SshWorkspaceTooLargeError` before any byte is copied to the remote host. */
export async function assertSshWorkspaceWithinSyncLimit(
  localDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const limitBytes = resolveSshWorkspaceSyncMaxBytes(env);
  if (limitBytes === null) return;
  const { exceeded } = await measureDirectoryBytesUpTo(localDir, limitBytes, SSH_WORKSPACE_SYNC_SIZE_EXCLUDES);
  if (exceeded) throw new SshWorkspaceTooLargeError(localDir, limitBytes);
}
