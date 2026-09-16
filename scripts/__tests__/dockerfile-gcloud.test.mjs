import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

// MAI-2368: a codex_local run with no sandbox provider configured executes
// directly in this image, not in the k8s sandbox-provider's
// agent-runtime-codex image, so it needs its own gcloud install. This image
// builds both linux/amd64 and linux/arm64.

test("the production image pins the gcloud archive and verifies it before unpacking, per architecture", () => {
  const version = dockerfile.match(/^ARG GCLOUD_VERSION=(\S+)$/m);
  const shaAmd64 = dockerfile.match(/^ARG GCLOUD_SHA256_AMD64=(\S+)$/m);
  const shaArm64 = dockerfile.match(/^ARG GCLOUD_SHA256_ARM64=(\S+)$/m);
  assert.ok(version, "Dockerfile must pin ARG GCLOUD_VERSION");
  assert.ok(shaAmd64, "Dockerfile must pin ARG GCLOUD_SHA256_AMD64");
  assert.ok(shaArm64, "Dockerfile must pin ARG GCLOUD_SHA256_ARM64");
  assert.match(version[1], /^\d+\.\d+\.\d+$/);
  assert.match(shaAmd64[1], /^[0-9a-f]{64}$/);
  assert.match(shaArm64[1], /^[0-9a-f]{64}$/);
  assert.notEqual(
    shaAmd64[1],
    shaArm64[1],
    "the two architectures ship different archives and must not share a checksum",
  );

  // The URL must be built from the ARGs, otherwise a version bump can leave
  // the download pointing at an old archive while a checksum moves on.
  assert.match(
    dockerfile,
    /cloud-sdk-release\/google-cloud-cli-\$\{GCLOUD_VERSION\}-linux-\$\{gcloud_arch\}\.tar\.gz/,
  );

  const verifiedAt = dockerfile.indexOf("sha256sum -c -");
  const unpackedAt = dockerfile.indexOf("tar -xzf /tmp/gcloud.tar.gz");
  assert.ok(verifiedAt > 0, "the download must be checksum-verified");
  assert.ok(
    verifiedAt < unpackedAt,
    "the checksum must be verified before the archive is unpacked",
  );
});

test("gcloud's arch selection covers amd64 and arm64 and fails closed on anything else", () => {
  const installBlock = dockerfile.slice(
    dockerfile.indexOf("dpkg --print-architecture"),
    dockerfile.indexOf("ln -s /opt/google-cloud-sdk/bin/gcloud"),
  );
  assert.match(installBlock, /amd64\)\s*gcloud_arch=x86_64/);
  // Google's release bucket names the 64-bit ARM archive "linux-arm", not
  // "linux-arm64" -- verified against the ELF e_machine of a compiled binary
  // inside that archive (EM_AARCH64).
  assert.match(installBlock, /arm64\)\s*gcloud_arch=arm;/);
  assert.match(installBlock, /\*\)\s*echo "gcloud install supports amd64\/arm64 only/);
});

test("gcloud resolves on a login-shell PATH, not only on the image PATH", () => {
  // /etc/profile resets PATH for both root and non-root login shells in this
  // image's base (Debian trixie), and neither reset PATH includes anything
  // under /opt -- only /usr/local/bin, which is why the install symlinks
  // there instead of relying on an ENV PATH entry.
  assert.match(
    dockerfile,
    /ln -s \/opt\/google-cloud-sdk\/bin\/gcloud \/usr\/local\/bin\/gcloud/,
  );
  assert.doesNotMatch(
    dockerfile,
    /^\s*ENV PATH=/m,
    "gcloud must not be exposed through an image PATH entry",
  );
  assert.match(dockerfile, /sh -lc 'command -v gcloud/);
});

test("gcloud is probed as the runtime user via gosu, since this image never switches USER", () => {
  assert.doesNotMatch(
    dockerfile,
    /^USER /m,
    "the production stage builds entirely as root and drops privilege only in docker-entrypoint.sh",
  );
  const probeAt = dockerfile.indexOf("gosu node sh -lc");
  assert.ok(probeAt > 0, "Dockerfile must probe gcloud as the node user via gosu");
  assert.match(
    dockerfile.slice(probeAt - 40, probeAt),
    /HOME=\/paperclip/,
    "the gosu probe must set HOME explicitly -- ENV HOME=/paperclip is declared later in this stage",
  );
});
