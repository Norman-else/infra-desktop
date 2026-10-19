# Follow vault-mcp Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vault-mcp publishes GitHub Releases from a manual workflow on `main`; Infra Desktop (uvx mode) runs the latest vault-mcp release that passes its capability check, without a desktop release.

**Architecture:** vault-mcp gets `.github/workflows/release.yml` (tests on Windows, bump `pyproject` version with `uv version --bump`, tag `vX.Y.Z`, GitHub Release). The desktop's uvx launcher picks a ref in this order: `vaultMcpRef` setting → latest release tag → last known-good ref → pinned `VAULT_MCP_SHA`, keeping the first that prints the capability line; the latest-release lookup and the last good ref are cached in `<userData>/vault-mcp.json`.

**Tech Stack:** GitHub Actions + uv (vault-mcp); Electron/TypeScript + vitest (desktop).

**Spec:** conversation decision 2026-10-20 ("vault-mcp releases, desktop auto-upgrades") on top of `docs/superpowers/plans/2026-10-20-vault-without-claude.md`.

## Global Constraints

- vault-mcp workflow: `workflow_dispatch` on `main` only, input `bump` (`patch|minor|major`, default `patch`); runs Python (`unittest`) and frontend tests first; commits `release: vX.Y.Z`, tags, `gh release create --generate-notes`.
- Latest release: `GET https://api.github.com/repos/Norman-else/vault-mcp/releases/latest` → `tag_name`; 5 s timeout; 404 / error → no latest.
- Lookup cached for 4 hours (`latest.checkedAt`); the desktop re-detects every 4 hours while running.
- A candidate ref is accepted only if `uvx --from <archive>/<ref>.zip vault-mcp-web-ui --version` prints `vault-mcp-web-ui standalone 1`; accepted ref saved as `lastGood`.
- Running Vault processes are never restarted by an update; new tools pick up the new launcher.
- `vaultMcpRef` setting, when set, is the only candidate and no lookup happens.

## Review Focus

1. Latest release broken / incompatible → previous good version keeps working. (`falls back to the last good version when the latest fails its check`.)
2. Offline or rate-limited GitHub → cached version, no long hang. (`uses the cache when GitHub is unreachable`.)
3. No releases yet → pinned commit. (`falls back to the pinned commit without releases or cache`.)
4. GitHub not hammered → one lookup per 4 h. (`does not ask GitHub again within 4 hours`.)
5. Release workflow run from a non-main branch → refused. (workflow `if: github.ref == 'refs/heads/main'`.)

---

### Task 1: vault-mcp release workflow

**Files:** `K:/MCP/vault-mcp/.github/workflows/release.yml`, `README.md`
- [ ] Workflow as in Global Constraints (windows-latest; `astral-sh/setup-uv`; `uv sync`; `PYTHONPATH=src uv run python -m unittest discover -s tests`; `npm --prefix frontend ci && npm --prefix frontend test`; `uv version --bump $BUMP`; commit, tag, push, release).
- [ ] README: how to release; desktop picks it up automatically.
- [ ] Commit + push; run it (`bump=minor` → `v0.2.0`); check the release exists.

### Task 2: Desktop resolves the latest good vault-mcp

**Files:** `src/main/vault-mcp.ts`, `src/main/sessions.ts`; test `test/vault-mcp.test.ts`

**Interfaces:**
- `detectVaultMcp(settings: Settings, deps?: { run?, which?, fetchLatest?: () => Promise<string | undefined>, stateFile?: string, now?: () => number }): Promise<VaultMcp>` (replaces the positional `run, which` params).
- `VaultMcpReady` gains `ref?: string` (uvx mode).
- `EnvManager` passes `stateFile = <dataDir>/vault-mcp.json` and re-runs detection every 4 h (`vaultRefresh` timer, cleared on shutdown).
- [ ] **Failing tests**: `uses the latest vault-mcp release`, `falls back to the last good version when the latest fails its check`, `uses the cache when GitHub is unreachable`, `falls back to the pinned commit without releases or cache`, `vaultMcpRef wins and skips the lookup`, `does not ask GitHub again within 4 hours`; existing tests ported to `deps`.
- [ ] Implement → full suite + tsc green → commit.

### Task 3: Ship and verify

- [ ] Desktop real check: `vaultMcpSource: 'uvx'`, scratch data dir → launcher ref is the vault-mcp release tag from Task 1; Vault signs in on DEV.
- [ ] README (desktop): uvx mode follows vault-mcp releases; `vaultMcpRef` pins.
- [ ] Release desktop `0.6.0`.
