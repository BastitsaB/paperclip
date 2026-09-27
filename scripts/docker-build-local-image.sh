#!/usr/bin/env bash
# Build the self-hosted production image with a verifiable commit marker.
#
# Usage: scripts/docker-build-local-image.sh <tag> [extra docker build args...]
#   e.g. scripts/docker-build-local-image.sh paperclip-local:dev --no-cache-filter production
#
# A plain `docker build` leaves PAPERCLIP_BUILD_COMMIT empty, so the image
# carries no commit and /api/health reports `commit: null` (MAI-3579). This
# wrapper passes the checked-out commit and makes the build context exactly
# that commit: it extracts `git archive HEAD` into a temporary directory and
# builds from there, so neither local edits nor gitignored files (a root .env,
# stale dist/ output) can enter the image, while .dockerignore still applies
# as in CI (a tar on stdin would bypass it). It also refuses to build
#   - from a dirty worktree, because the local edits would silently be left
#     out of the image;
#   - from a commit that is on no remote-tracking branch, because nobody can
#     resolve the SHA outside this host. Run `git fetch` first so the refs are
#     current. PAPERCLIP_ALLOW_UNPUBLISHED_COMMIT=1 skips only this check.
# After the build it runs scripts/verify-image-provenance.sh on the new image
# ID and prints one `provenance commit=... image=...` line to keep as the build
# record.
set -euo pipefail

RUNTIME="${CONTAINER_RUNTIME:-docker}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$#" -lt 1 ] || [[ "$1" == -* ]]; then
  echo "usage: $0 <tag> [extra docker build args...]" >&2
  exit 2
fi
tag="$1"
shift

commit="$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}')"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
  echo "error: worktree has uncommitted or untracked changes; they would not be in the image of commit $commit" >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

if [ -z "$(git -C "$REPO_ROOT" branch --remotes --contains "$commit" 2>/dev/null)" ]; then
  if [ "${PAPERCLIP_ALLOW_UNPUBLISHED_COMMIT:-}" = "1" ]; then
    echo "warning: commit $commit is on no remote-tracking branch; only this host can resolve it" >&2
  else
    echo "error: commit $commit is on no remote-tracking branch. Push it (or git fetch) first," >&2
    echo "       or set PAPERCLIP_ALLOW_UNPUBLISHED_COMMIT=1 to build anyway." >&2
    exit 1
  fi
fi

iidfile="$(mktemp)"
context="$(mktemp -d)"
trap 'rm -rf "$iidfile" "$context"' EXIT
git -C "$REPO_ROOT" archive --format=tar "$commit" | tar -x -C "$context"

# The wrapper's flags come last so a passed-through argument cannot replace
# the context or the Dockerfile.
"$RUNTIME" build \
  --target production \
  --build-arg "PAPERCLIP_BUILD_COMMIT=$commit" \
  --iidfile "$iidfile" \
  -t "$tag" \
  "$@" \
  -f "$context/Dockerfile" \
  "$context"

if [ ! -s "$iidfile" ]; then
  echo "error: $RUNTIME build wrote no image ID; the builder must load the image into the local daemon" >&2
  exit 1
fi
image_id="$(cat "$iidfile")"
"$SCRIPT_DIR/verify-image-provenance.sh" "$image_id" "$commit"
echo "provenance commit=$commit image=$image_id tag=$tag"
