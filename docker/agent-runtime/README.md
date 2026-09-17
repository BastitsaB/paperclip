# Agent Runtime Image Family

Container images for running coding-agent harnesses in sandboxed environments (for example the kubernetes sandbox provider, stage 1 of the k8s contribution). Images are named `agent-runtime-{harness}:{version}` and published to `ghcr.io/paperclipai/` by the `agent-runtime-images` workflow. The registry is overridable: every reference flows through the `REGISTRY` bake variable.

## Image Lineup

- **`agent-runtime-base`**: Foundation. Ubuntu 22.04 + Node 24 + git + tini + non-root user (uid 1000) + the agent shim.
- **`agent-runtime-opencode`**: Extends base with `opencode-ai` globally installed.
- **`agent-runtime-pi`**: Extends base with `@mariozechner/pi-coding-agent`.
- **`agent-runtime-codex`**: Extends base with `@openai/codex`.
- **`agent-runtime-gemini`**: Extends base with `@google/gemini-cli` plus headless auth-mode settings.
- **`agent-runtime-claude`**: Extends base with `@anthropic-ai/claude-code` (symlinked as `claude-code`).
- **`agent-runtime-hermes`**: Dockerfile included in the bake group, not in the default publish scope (stub until a CLI package exists).

## Base Image Contents

**OS & Runtime:**
- Ubuntu 22.04
- Node.js 24 (via NodeSource APT repo)
- git
- tini (PID-1 init, ensures signal propagation)
- Non-root user `paperclip` (uid/gid 1000)

The NodeSource install puts `node` on the default `PATH`. The agent shim in this
image runs the harness directly with that `PATH`. The shim does not source a
login profile, and the runtime never writes a profile or an rc file. Some
sandbox providers instead wrap each command in a login shell. That shell sources
`/etc/profile` and the user profile files to read an owner-supplied `PATH`. No
exec path sources `nvm`. For the full exec-path contract, see
`packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md`.

**Paperclip Binaries:**
- `/usr/local/bin/paperclip-agent-shim`: Go binary compiled from `tools/agent-shim/`. Reads `/run/paperclip/runtime-command.json` and `syscall.Exec`s the harness CLI.

**Defaults:**
- `USER`: 1000:1000 (paperclip, non-root)
- `WORKDIR`: `/workspace` (mount workspace volumes here)
- `ENTRYPOINT`: `/usr/bin/tini --` (PID-1 reaper, forwards signals)
- `CMD`: `/usr/local/bin/paperclip-agent-shim`

## Building Locally

All targets build `linux/amd64` by default (see `buildx-bake.hcl`). Derived images chain off the `base` target through bake `contexts`, so the literal registry in each `FROM` line is overridden at build time and the whole family builds in one pass without pushing intermediates.

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
```

### Custom tag or registry

```bash
REGISTRY=myregistry VERSION=mytag \
  docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
```

## Quickstart Smoke Test

Build and verify the `agent-runtime-claude` image runs locally:

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl base claude --load
docker run --rm ghcr.io/paperclipai/agent-runtime-claude:dev claude-code --version
```

## Google Cloud CLI in the Codex Image

`agent-runtime-codex` bundles `gcloud`, pinned via `GCLOUD_VERSION`/`GCLOUD_SHA256` in `Dockerfile.codex` against an immutable object in the `cloud-sdk-release` bucket — both ARGs move together on a version bump. The CLI is a build-time install baked into the published image (no per-run installation, no runtime write access needed to `/opt`). `CLOUDSDK_CONFIG=/tmp/gcloud` keeps writable state off the read-only root filesystem; the symlink lives in `/usr/local/bin` instead of a `PATH`/profile entry because a login-shell-wrapping provider resets `PATH` from `/etc/profile` before an `/opt` entry would apply (see `packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md`, "Firm rule"). The install only targets `linux/amd64` — the release archive's bundled Python interpreter has no other-arch build, so the build fails closed rather than shipping a `gcloud` with no interpreter.

Smoke-test the CLI directly:

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl codex --load
docker run --rm ghcr.io/paperclipai/agent-runtime-codex:dev sh -lc 'command -v gcloud && gcloud --version && command -v codex'
```

Scope note: this covers `agent-runtime-codex`, consumed by the kubernetes sandbox provider (`packages/plugins/sandbox-providers/kubernetes/src/adapter-defaults.ts`). A `codex_local` run that does not go through that provider (e.g. the plain Paperclip container defined by the top-level `Dockerfile`) does not get `gcloud` from this image — that path is tracked separately.

## Agent Container (paperclip-agent-shim)

The main agent process runs as the shim (PID 1 under tini). The shim:

1. Reads `/run/paperclip/runtime-command.json` (path overridable via `-spec`), a JSON file mounted by whatever schedules the run
2. Parses `{ "command", "args" }`: the harness CLI and arguments
3. Resolves the command on PATH and `syscall.Exec`s it, replacing itself
4. SIGTERM from the kubelet propagates directly to the harness (no zombie processes)

**runtime-command.json Contract:**
```json
{
  "command": "claude-code",
  "args": ["--token", "xyz", "--workspace", "/workspace"]
}
```

The shim makes no assumptions about command structure; it is harness-agnostic. New harnesses swap the command/args; the base image stays the same.

## Security Model

- **Non-root execution**: user 1000:1000, no capability grants
- **PSS Restricted compatible**: no privileged containers, no host mounts; works with a read-only root filesystem (writable `/workspace` + `/tmp` mounts)
- **No secrets baked in**: API tokens and credentials come from per-run ephemeral Secrets mounted as env vars or files
- **Image signing**: cosign keyless OIDC in the publish workflow

## Publishing

`.github/workflows/agent-runtime-images.yml` builds and pushes the default scope (base, opencode, pi, codex, gemini, claude) on `workflow_dispatch` (with an explicit version tag) or on pushes to `master` touching these paths, then signs each digest with cosign keyless OIDC.
