import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { paperclipRunnerBinaryNeedsBuild } from "../../../scripts/dev-runner-native-binary.mjs";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createRunnerCheckout(): { root: string; source: string; binary: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-runner-binary-"));
  tempRoots.add(root);

  const runnerRoot = path.join(root, "packages", "paperclip-runner", "runner");
  const source = path.join(runnerRoot, "crates", "runner-core", "src", "main.rs");
  const binary = path.join(
    root,
    "packages",
    "paperclip-runner",
    "dist",
    "bin",
    process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd",
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(path.join(runnerRoot, "Cargo.toml"), "[workspace]\n", "utf8");
  fs.writeFileSync(path.join(runnerRoot, "Cargo.lock"), "", "utf8");
  fs.writeFileSync(source, "fn main() {}\n", "utf8");
  fs.writeFileSync(binary, "runnerd", "utf8");
  return { root, source, binary };
}

describe("paperclip runner native dev prerequisite", () => {
  it("builds only when the staged binary is missing or older than Rust inputs", () => {
    const checkout = createRunnerCheckout();
    const now = Date.now();
    const old = new Date(now - 2_000);
    const current = new Date(now + 2_000);
    const next = new Date(now + 4_000);

    fs.utimesSync(checkout.source, old, old);
    fs.utimesSync(checkout.binary, current, current);
    expect(paperclipRunnerBinaryNeedsBuild({ repoRoot: checkout.root })).toBe(false);

    fs.utimesSync(checkout.source, next, next);
    expect(paperclipRunnerBinaryNeedsBuild({ repoRoot: checkout.root })).toBe(true);

    fs.rmSync(checkout.binary);
    expect(paperclipRunnerBinaryNeedsBuild({ repoRoot: checkout.root })).toBe(true);
  });

  it("does not build a workspace binary when an explicit binary is configured", () => {
    expect(
      paperclipRunnerBinaryNeedsBuild({
        repoRoot: "/checkout/without/a/staged/binary",
        configuredBinary: "/opt/paperclip/paperclip-runnerd",
      }),
    ).toBe(false);
  });
});
