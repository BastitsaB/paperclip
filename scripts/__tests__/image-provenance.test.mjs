import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// MAI-3579: the local production build must bind an image ID to the commit it
// was built from, and a read-only check must read that binding back. These
// tests drive both scripts against a fake `docker` so they run without a
// daemon; the MAI-2845 workflow checks the real image.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const verifyScript = path.join(repoRoot, "scripts", "verify-image-provenance.sh");
const buildScript = path.join(repoRoot, "scripts", "docker-build-local-image.sh");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const IMAGE_ID = `sha256:${"1".repeat(64)}`;

// Images are files under $FAKE_DOCKER_STATE/images named by image ID, with
// `ref=`, `label=`, and `env=` lines. Containers map a name to an image ID.
const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
state="$FAKE_DOCKER_STATE"
find_image() {
  for f in "$state"/images/*; do
    [ -e "$f" ] || continue
    id="$(basename "$f" | tr _ :)"
    if [ "$1" = "$id" ] || grep -qx "ref=$1" "$f"; then echo "$f"; return 0; fi
  done
  return 1
}
field() { sed -n "s/^$1=//p" "$2" | head -n 1; }
if [ "$1" = container ] && [ "$2" = inspect ]; then
  [ -f "$state/containers/$5" ] || exit 1
  cat "$state/containers/$5"; exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  f="$(find_image "$5")" || exit 1
  case "$4" in
    *.Id*) basename "$f" | tr _ : ;;
    *Labels*) if grep -q '^label=' "$f"; then field label "$f"; else echo "<no value>"; fi ;;
    *Config.Env*) echo "NODE_ENV=production"; grep -q '^env=' "$f" && echo "PAPERCLIP_BUILD_COMMIT=$(field env "$f")"; echo "HOME=/paperclip" ;;
    *RepoDigests*) echo "" ;;
  esac
  exit 0
fi
if [ "$1" = build ]; then
  printf '%s\\n' "$@" > "$state/build-args"
  context="\${!#}"
  (cd "$context" && find . -type f | sed 's|^\\./||' | sort) > "$state/context-files"
  commit=""; iid=""; tag=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --build-arg) case "$2" in PAPERCLIP_BUILD_COMMIT=*) commit="\${2#PAPERCLIP_BUILD_COMMIT=}";; esac; shift ;;
      --iidfile) iid="$2"; shift ;;
      -t) tag="$2"; shift ;;
    esac
    shift
  done
  printf 'ref=%s\\nlabel=%s\\nenv=%s\\n' "$tag" "$commit" "$commit" > "$state/images/$(echo "${IMAGE_ID}" | tr : _)"
  [ -n "\${FAKE_DOCKER_NO_IID:-}" ] || printf '%s' "${IMAGE_ID}" > "$iid"
  exit 0
fi
echo "fake docker: unsupported $*" >&2; exit 99
`;

function makeState() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "image-provenance-"));
  mkdirSync(path.join(dir, "images"));
  mkdirSync(path.join(dir, "containers"));
  mkdirSync(path.join(dir, "bin"));
  const docker = path.join(dir, "bin", "docker");
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);
  return dir;
}

function addImage(state, { id = IMAGE_ID, ref, label, env }) {
  const lines = [`ref=${ref}`];
  if (label !== undefined) lines.push(`label=${label}`);
  if (env !== undefined) lines.push(`env=${env}`);
  writeFileSync(path.join(state, "images", id.replace(":", "_")), `${lines.join("\n")}\n`);
}

function run(script, args, state, extraEnv = {}, cwd = repoRoot) {
  return spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(state, "bin")}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: state,
      CONTAINER_RUNTIME: "docker",
      ...extraEnv,
    },
  });
}

test("Dockerfile writes the build commit into the OCI revision label of the production stage", () => {
  const production = dockerfile.slice(
    dockerfile.indexOf("FROM base AS production"),
    dockerfile.indexOf("FROM build AS cloud-plugins"),
  );
  const arg = production.search(/^ARG PAPERCLIP_BUILD_COMMIT\b/m);
  const label = production.search(
    /^LABEL org\.opencontainers\.image\.revision=\$\{PAPERCLIP_BUILD_COMMIT\}$/m,
  );
  assert.ok(arg >= 0, "production stage must declare ARG PAPERCLIP_BUILD_COMMIT");
  assert.ok(label > arg, "the revision LABEL must follow the ARG it references");
});

test("verify passes when label and ENV carry the same commit", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  addImage(state, { ref: "paperclip-local:dev", label: SHA_A, env: SHA_A });
  const res = run(verifyScript, ["paperclip-local:dev", SHA_A.toUpperCase()], state);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`^image=${IMAGE_ID}$`, "m"));
  assert.match(res.stdout, new RegExp(`^revision=${SHA_A}$`, "m"));
  assert.doesNotMatch(res.stdout, /NODE_ENV|HOME=/, "must not print other ENV entries");
});

test("verify resolves a container to the image it runs", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  addImage(state, { ref: "paperclip-local:dev", label: SHA_A, env: SHA_A });
  writeFileSync(path.join(state, "containers", "compose-server-1"), IMAGE_ID);
  const res = run(verifyScript, ["compose-server-1"], state);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^source=container:compose-server-1$/m);
});

test("verify fails for an image without a revision label (plain docker build)", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  addImage(state, { ref: "paperclip-local:dev" });
  const res = run(verifyScript, ["paperclip-local:dev"], state);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^revision=missing$/m);
  assert.match(res.stderr, /label org\.opencontainers\.image\.revision is missing/);
});

test("verify fails for an empty label (plain docker build with the new Dockerfile)", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  addImage(state, { ref: "paperclip-local:dev", label: "", env: "" });
  const res = run(verifyScript, ["paperclip-local:dev"], state);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /^revision=missing$/m);
});

test("verify fails when only the ENV carries a commit", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  addImage(state, { ref: "paperclip-local:dev", env: SHA_A });
  const res = run(verifyScript, ["paperclip-local:dev"], state);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /label org\.opencontainers\.image\.revision is missing/);
  assert.match(res.stderr, /differs from the revision label/);
});

test("verify fails when ENV and label disagree", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  addImage(state, { ref: "paperclip-local:dev", label: SHA_A, env: SHA_B });
  const res = run(verifyScript, ["paperclip-local:dev"], state);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /differs from the revision label/);
});

test("verify fails when the commit differs from the expected one", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  addImage(state, { ref: "paperclip-local:dev", label: SHA_A, env: SHA_A });
  const res = run(verifyScript, ["paperclip-local:dev", SHA_B], state);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /differs from expected commit/);
});

test("verify rejects unknown references and malformed expected commits", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  assert.equal(run(verifyScript, ["nope"], state).status, 2);
  addImage(state, { ref: "paperclip-local:dev", label: SHA_A, env: SHA_A });
  assert.equal(run(verifyScript, ["paperclip-local:dev", "abc123"], state).status, 2);
});

// The build script resolves the repo from its own location, so each test
// copies both scripts into a throwaway git repository with a remote.
function makeRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "image-provenance-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  git("init", "-q", "-b", "master");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  mkdirSync(path.join(dir, "scripts"));
  for (const script of [verifyScript, buildScript]) {
    copyFileSync(script, path.join(dir, "scripts", path.basename(script)));
  }
  writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(dir, ".gitignore"), ".env\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { dir, git, build: path.join(dir, "scripts", "docker-build-local-image.sh") };
}

function publish(git) {
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/master", head);
  return head;
}

test("build passes the checked-out commit and verifies the new image", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const repo = makeRepo(t);
  const head = publish(repo.git);
  const res = run(repo.build, ["paperclip-local:dev", "--no-cache-filter", "production"], state, {}, repo.dir);
  assert.equal(res.status, 0, res.stderr);
  const args = readFileSync(path.join(state, "build-args"), "utf8").split("\n");
  assert.ok(args.includes(`PAPERCLIP_BUILD_COMMIT=${head}`));
  assert.ok(args.includes("--no-cache-filter"));
  assert.ok(args.includes("production"));
  // The context is a directory holding the archived commit, not the worktree.
  const [flag, file, context] = args.filter(Boolean).slice(-3);
  assert.equal(flag, "-f");
  assert.equal(file, path.join(context, "Dockerfile"));
  assert.notEqual(context, repo.dir);
  assert.match(res.stdout, new RegExp(`^provenance commit=${head} image=${IMAGE_ID} tag=paperclip-local:dev$`, "m"));
});

test("build context excludes gitignored files that .dockerignore would let through", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const repo = makeRepo(t);
  publish(repo.git);
  writeFileSync(path.join(repo.dir, ".env"), "NOT_IN_IMAGE=1\n");
  const res = run(repo.build, ["paperclip-local:dev"], state, {}, repo.dir);
  assert.equal(res.status, 0, res.stderr);
  const files = readFileSync(path.join(state, "context-files"), "utf8").split("\n");
  assert.ok(files.includes("Dockerfile"));
  assert.ok(!files.includes(".env"));
});

test("build fails clearly when the builder writes no image ID", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const repo = makeRepo(t);
  publish(repo.git);
  const res = run(repo.build, ["paperclip-local:dev"], state, { FAKE_DOCKER_NO_IID: "1" }, repo.dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /wrote no image ID/);
});

test("build refuses a dirty worktree", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const repo = makeRepo(t);
  publish(repo.git);
  writeFileSync(path.join(repo.dir, "untracked.txt"), "x");
  const res = run(repo.build, ["paperclip-local:dev"], state, {}, repo.dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /uncommitted or untracked changes/);
});

test("build refuses an unpublished commit unless explicitly allowed", (t) => {
  const state = makeState();
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const repo = makeRepo(t);
  const refused = run(repo.build, ["paperclip-local:dev"], state, {}, repo.dir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /on no remote-tracking branch/);
  const allowed = run(repo.build, ["paperclip-local:dev"], state, { PAPERCLIP_ALLOW_UNPUBLISHED_COMMIT: "1" }, repo.dir);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /warning: commit .* on no remote-tracking branch/);
});
