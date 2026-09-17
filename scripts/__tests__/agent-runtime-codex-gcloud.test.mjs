import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dockerfilePath = fileURLToPath(
  new URL("../../docker/agent-runtime/Dockerfile.codex", import.meta.url),
);

function dockerfile() {
  return readFileSync(dockerfilePath, "utf8");
}

test("gcloud install is version- and checksum-pinned via ARGs", () => {
  const source = dockerfile();
  assert.match(source, /ARG GCLOUD_VERSION=\d+\.\d+\.\d+/);
  assert.match(source, /ARG GCLOUD_SHA256=[0-9a-f]{64}/);
  assert.match(
    source,
    /google-cloud-cli-\$\{GCLOUD_VERSION\}-linux-x86_64\.tar\.gz/,
    "the download URL must be built from GCLOUD_VERSION, not a hardcoded version",
  );
  assert.match(
    source,
    /echo "\$\{GCLOUD_SHA256\}\s+\/tmp\/gcloud\.tar\.gz" \| sha256sum -c -/,
    "the archive must be checksum-verified before it is unpacked",
  );
});

test("gcloud is exposed via a /usr/local/bin symlink, not a PATH/profile entry", () => {
  const source = dockerfile();
  assert.match(source, /ln -s \/opt\/google-cloud-sdk\/bin\/gcloud \/usr\/local\/bin\/gcloud/);
  assert.doesNotMatch(
    source,
    /ENV PATH=.*google-cloud-sdk/,
    "a login-shell-wrapping provider resets PATH from /etc/profile before an /opt PATH entry applies",
  );
});

test("CLOUDSDK_CONFIG points at a writable path, not the read-only root filesystem", () => {
  const source = dockerfile();
  assert.match(source, /ENV[\s\S]*CLOUDSDK_CONFIG=\/tmp\/gcloud\b/);
});

test("both PATH probes (direct exec and login shell) run before USER switches back", () => {
  const source = dockerfile();
  assert.match(source, /command -v gcloud >\/dev\/null 2>&1 \|\| \{ echo "gcloud not on PATH"/);
  assert.match(
    source,
    /sh -lc 'command -v gcloud >\/dev\/null 2>&1'\s*\\\s*\n\s*\|\| \{ echo "gcloud not on login-shell PATH"/,
  );
  assert.match(source, /gcloud --version >\/dev\/null/);
});

test("install runs as root before the image drops to the non-root user", () => {
  const source = dockerfile();
  const installIndex = source.indexOf("tar -xzf /tmp/gcloud.tar.gz");
  const userSwitchIndex = source.indexOf("USER 1000:1000");
  assert.ok(installIndex > 0 && userSwitchIndex > 0, "expected both anchors to be present");
  assert.ok(installIndex < userSwitchIndex, "gcloud must be installed while still root");
});

test("build fails closed on non-amd64 instead of shipping an interpreter-less gcloud", () => {
  const source = dockerfile();
  assert.match(source, /if \[ "\$arch" != "amd64" \]; then/);
  assert.match(source, /echo "gcloud install supports amd64 only, got \$arch"; exit 1/);
});
