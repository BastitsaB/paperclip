#!/usr/bin/env bash
# Read-only check that a Paperclip image carries a consistent build commit.
#
# Usage: scripts/verify-image-provenance.sh <image-or-container> [expected-commit]
#
# The argument may be an image reference (tag, image ID, repo digest) or a
# container name/ID; a container resolves to the exact image ID it runs.
# The script only runs `docker container inspect` and `docker image inspect`.
# It starts nothing and prints only the image ID, repo digests, and the commit
# — never the container's runtime environment.
#
# Checks (MAI-3579):
#   - label org.opencontainers.image.revision is a full 40-hex commit SHA
#   - the image ENV PAPERCLIP_BUILD_COMMIT equals that label
#   - optional: both equal the expected commit
#
# The image ID is a content digest over the image config (classic image
# store) or over the manifest that references the config (containerd image
# store). Either way it covers the label, so the printed pair `image=` /
# `revision=` cannot be separated.
#
# Exit codes: 0 consistent, 1 missing or inconsistent marker, 2 usage error.
set -euo pipefail

RUNTIME="${CONTAINER_RUNTIME:-docker}"
REVISION_LABEL="org.opencontainers.image.revision"

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <image-or-container> [expected-commit]" >&2
  exit 2
fi

ref="$1"
expected="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"
if [ -n "$expected" ] && ! [[ "$expected" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: expected commit must be a full 40-hex SHA, got '$expected'" >&2
  exit 2
fi

if image_id="$("$RUNTIME" container inspect --format '{{.Image}}' "$ref" 2>/dev/null)"; then
  source_kind="container"
elif image_id="$("$RUNTIME" image inspect --format '{{.Id}}' "$ref" 2>/dev/null)"; then
  source_kind="image"
else
  echo "error: '$ref' is neither a container nor an image known to $RUNTIME" >&2
  exit 2
fi

revision="$("$RUNTIME" image inspect --format "{{index .Config.Labels \"$REVISION_LABEL\"}}" "$image_id")"
[ "$revision" = "<no value>" ] && revision=""
env_commit="$("$RUNTIME" image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image_id" \
  | sed -n 's/^PAPERCLIP_BUILD_COMMIT=//p' | head -n 1)"
repo_digests="$("$RUNTIME" image inspect --format '{{join .RepoDigests " "}}' "$image_id" 2>/dev/null || true)"

echo "source=${source_kind}:${ref}"
echo "image=${image_id}"
echo "repo_digests=${repo_digests:-none}"
echo "revision=${revision:-missing}"

fail=0
if ! [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "FAIL: label $REVISION_LABEL is missing or not a full 40-hex SHA" >&2
  fail=1
fi
if [ "$env_commit" != "$revision" ]; then
  echo "FAIL: image ENV PAPERCLIP_BUILD_COMMIT ('${env_commit:-missing}') differs from the revision label" >&2
  fail=1
fi
if [ -n "$expected" ] && [ "$revision" != "$expected" ]; then
  echo "FAIL: revision differs from expected commit $expected" >&2
  fail=1
fi
if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "OK: ${image_id} was built from commit ${revision}"
