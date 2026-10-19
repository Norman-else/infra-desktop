# Vault Without Claude Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infra Desktop 0.5.0's Vault tab works for people who don't use Claude: no vault-mcp clone needed (the desktop runs a pinned vault-mcp with `uvx`), and Vault address/header/role are entered in the app when missing.

**Architecture:** vault-mcp gains a `vault-mcp-web-ui` console script. The desktop resolves a *launcher* — local checkout (today's behaviour) or `uvx --from <pinned GitHub archive> vault-mcp-web-ui` — and `VaultTool` just runs the launcher's argv. An env without a Vault address gets a setup state instead of a disabled tab; the Vault page shows a small form that saves to the desktop's `settings.json`. `~/.claude.json` stays an optional prefill.

**Tech Stack:** Electron + TypeScript, vitest; vault-mcp (hatchling, Python ≥ 3.10); uv ≥ 0.4.

**Spec:** conversation decision 2026-10-20 ("configure in the app + uvx", local checkout kept as an option) on top of `docs/superpowers/specs/2026-10-19-infra-desktop-vault-design.md` §3–§4.

## Global Constraints

- vault-mcp console script: `vault-mcp-web-ui = "vault_mcp.web_ui:main"`; the wheel must contain `vault_mcp/static/ui/index.html`.
- Pinned source: `https://github.com/Norman-else/vault-mcp/archive/<sha>.zip` (no git needed); the sha is a constant `VAULT_MCP_SHA` in `src/main/vault-mcp.ts`, overridable with setting `vaultMcpRef` (sha or tag).
- Setting `vaultMcpSource: 'auto' | 'checkout' | 'uvx'` (default `auto`): `checkout` when `vaultMcpPath` is set or the Windows default `K:/MCP/vault-mcp` exists, else `uvx` when `uvx` is on PATH, else unavailable with reason exactly `Vault needs uv (https://docs.astral.sh/uv/) or a vault-mcp checkout (vaultMcpPath).`
- uvx mode: no `PYTHONPATH`; capability check timeout 300 s (first run downloads dependencies) and startup ready timeout 300 s; startup step text `Preparing Vault (first run downloads vault-mcp)…` until the ready line.
- Missing Vault address → env tool availability `{ available: true, setup: 'vault' }`: the segment is enabled, the tool does not start, the body shows the form. Form fields: Address (required, must start with `https://` or `http://`), Header, Role; region is not asked (env's region is used).
- Saving writes `envs.<profile>.vault.{addr,header,role}` into `settings.json`, keeps every other key, then reloads config and starts Vault for the active env.
- Release version exactly `0.5.0`.

## Review Focus

1. Machine with neither uv nor a checkout → Vault segment disabled with the exact reason; Radar unaffected. (Task 2 test `unavailable without uv or checkout`.)
2. First uvx run takes minutes → no timeout error before 300 s, body shows the preparing text. (Task 2 test `uvx mode uses long timeouts`.)
3. Saving the form must not wipe other settings (`duration`, ports, overrides). (Task 3 test `saving keeps other settings`.)
4. Invalid address in the form → error shown, nothing written. (Task 3 test `rejects an address without a scheme`.)
5. User on today's setup (checkout at `K:/MCP/vault-mcp`, `.claude.json` values) sees no change. (Task 2 test `auto prefers the checkout`.)

---

### Task 1: vault-mcp console script

**Files:** `K:/MCP/vault-mcp/pyproject.toml`; test `K:/MCP/vault-mcp/tests/test_packaging.py`

- [ ] **Step 1: Failing test** `test_wheel_has_console_script_and_ui` — builds a wheel with `uv build --wheel -o <tmp>` (skip if `uv` missing), asserts `entry_points.txt` has `vault-mcp-web-ui = vault_mcp.web_ui:main` and the wheel contains `vault_mcp/static/ui/index.html`.
- [ ] **Step 2: Run** `PYTHONPATH=src .venv/Scripts/python.exe -m unittest tests.test_packaging -v` — expect FAIL.
- [ ] **Step 3:** add the script to `[project.scripts]`.
- [ ] **Step 4:** run the test (PASS) and the full suite; then `uvx --from <repo path> vault-mcp-web-ui --version` prints `vault-mcp-web-ui standalone 1`.
- [ ] **Step 5:** commit `feat: vault-mcp-web-ui console script`, push; record the sha for Task 2.

### Task 2: Launcher (checkout or uvx)

**Files:** `src/main/vault-mcp.ts`, `src/main/settings.ts`, `src/main/tools/vault.ts`; tests `test/vault-mcp.test.ts`, `test/vault-tool.test.ts`

**Interfaces:**
- `VaultMcpReady` becomes `{ ok: true; source: 'checkout' | 'uvx'; command: string[]; cwd?: string; env: Record<string, string>; startTimeoutMs: number; firstRunHint?: string }` (`command` = argv prefix before `--env …`; checkout: `[python, '-m', 'vault_mcp.web_ui']`, `cwd` root, `env` `{PYTHONPATH}`; uvx: `[uvx, '--from', archiveUrl, 'vault-mcp-web-ui']`).
- `detectVaultMcp(settings, run?, which?)` — `which(names: string[]) => string | undefined` injectable; runs `[...command, '--version']`.
- `VaultTool` uses `mcp.command`, `mcp.cwd`, `mcp.env`, `mcp.startTimeoutMs`, and shows `firstRunHint` as the starting step; `vaultProcessEnv` no longer sets `PYTHONPATH` itself.
- [ ] **Step 1: Failing tests**: `auto prefers the checkout` (default path exists → `source: 'checkout'`), `uvx when there is no checkout` (no path, `which` finds uvx → command `[uvx,'--from','https://github.com/Norman-else/vault-mcp/archive/<VAULT_MCP_SHA>.zip','vault-mcp-web-ui']`, no `PYTHONPATH`), `vaultMcpRef overrides the pinned sha`, `source 'uvx' forces uvx`, `unavailable without uv or checkout` (exact reason), `uvx mode uses long timeouts` (`startTimeoutMs === 300000`, and the `--version` run gets a 300 s timeout).
- [ ] **Step 2–4:** FAIL → implement → full suite + tsc PASS.
- [ ] **Step 5:** commit `feat: run vault-mcp with uvx when there is no checkout`.

### Task 3: Vault setup state and saving

**Files:** `src/main/sessions.ts`, `src/main/settings.ts` (`saveEnvVault`), `src/shared/types.ts` (`ToolAvailability.setup?: 'vault'`, API `saveVaultConfig`), `src/main/index.ts` (IPC `vault:configure`), `src/preload/index.ts`; test `test/sessions.test.ts`, `test/settings.test.ts`

**Interfaces:**
- `saveEnvVault(file: string, profile: string, v: { addr: string; header?: string; role?: string }): void` — read-modify-write JSON, creates `envs`/profile objects as needed.
- `EnvManager.saveVaultConfig(env: string, v): Promise<{ ok: true } | { ok: false; error: string }>` — validates (`^https?://` and parseable URL), saves, `reload()`, awaits vault detection, `ensureTool('vault')` when Vault is the active tool.
- `availability('vault', env)` returns `{ available: true, setup: 'vault' }` when the address is missing (instead of unavailable); `ensureTool` skips tools with `setup`.
- [ ] **Step 1: Failing tests**: `saving keeps other settings`, `rejects an address without a scheme` (nothing written), `missing address means setup, not unavailable`, `after saving, Vault becomes available for that env`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** commit `feat: configure Vault per environment in the app`.

### Task 4: Form in the renderer, docs, release

**Files:** `src/renderer/renderer.ts`, `src/renderer/styles.css`, `README.md`

- [ ] **Step 1:** Body when the active tool is Vault and `tools.vault.setup === 'vault'`: card "Set up Vault for DEV" with Address / Header / Role inputs (prefilled with whatever is known), Save (calls `api.saveVaultConfig`; shows the returned error inline) and a one-line note that values are stored in the desktop's settings file. Starting-step text shows `firstRunHint` (comes through `tools.vault.step`).
- [ ] **Step 2: Real checks** (dev instance, scratch data dir, ports 938x/939x, cached aws-vault session): (a) `vaultMcpSource: 'uvx'` + values from settings only (claude prefill disabled by pointing `claudeJsonPath`… via a fresh settings file with explicit vault values) → Vault signs in; (b) an env with no address → form appears, Save → Vault starts.
- [ ] **Step 3:** README: Vault requirements (uv or checkout), the form, settings keys (`vaultMcpSource`, `vaultMcpRef`), `.claude.json` as optional prefill.
- [ ] **Step 4:** tests + tsc green; push; `gh workflow run release.yml -R Norman-else/infra-desktop --ref master -f version=0.5.0`; wait for success.
