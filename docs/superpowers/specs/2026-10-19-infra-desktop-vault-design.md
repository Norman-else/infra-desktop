# Infra Desktop: Radar + Vault per environment

Date: 2026-10-19
Status: draft for review

## Why

Radar Desktop removed the terminal ritual for Kubernetes: pick an environment, enter MFA once, use radar in the window. Vault has the same ritual today: the `vault-web-ui` skill asks the vault-mcp server (running inside Claude) to start its Flask web UI on a random port, and vault-mcp runs aws-vault itself, popping its own MFA dialog. Two tools, two logins, two places.

The goal is one desktop app, **Infra Desktop**, where an environment (DEV / SAT / PROD) is unlocked once and both tools for it, **Radar** and **Vault**, are a click apart.

## Goals

- Rename the repo to `infra-desktop` and the app to **Infra Desktop**; existing installs update in place and keep their settings.
- A `Radar | Vault` switch next to the environment switcher. The environment colour bar stays the single "where am I" signal.
- One MFA per environment covers both tools. Credential renewal (silent or MFA) refreshes both.
- Vault runs as a vault-mcp web UI process managed by the app, embedded like radar, on a fixed port per environment.
- Each tool view stays alive in the background per environment, so switching tool or environment is instant.

## Non-goals

- Rebuilding the Vault UI in the desktop app. vault-mcp's React UI is used as is.
- Changing how vault-mcp behaves when used as an MCP server from Claude/Cursor.
- Bundling Python or vault-mcp into the installer. vault-mcp stays a separate checkout the user already has.
- A "local" Vault environment (vault-mcp's `local`) in the desktop app.

## Anti-goals (would make this a failure even if it works)

- A second MFA prompt for Vault, or a different credential lifetime between Radar and Vault for the same environment.
- Being unsure which environment a Vault page belongs to (Vault edits on PROD must look like PROD).
- Breaking auto-update for people on Radar Desktop ≤ 0.1.11, or losing their `settings.json`.
- Making Radar depend on vault-mcp: without vault-mcp configured, the app works exactly as today.

## Decisions already made (by the user)

- vault-mcp may be changed: add a standalone launch mode and a mode that uses AWS credentials provided by the caller instead of running aws-vault.
- Both the repo and the app are renamed to infra-desktop / Infra Desktop.

## Design

### 1. Environment × tool model

- `EnvSession` today owns: credentials (aws-vault export + local ECS credential endpoint), renewal, radar process, cluster health.
- Split the tool part out: an env has **credentials** (shared) and **tools** (`radar`, `vault`), each a small process manager with `start / stop / waitReady / health / url / port`.
- Connecting an env only obtains credentials. A tool's process starts the first time that tool is shown for that env (lazy), so a user who only uses Radar never starts Python.
- After any credential update the env notifies each running tool (`onCredentialsRenewed`): radar → existing `/api/connection/retry` when disconnected; vault → re-login (see §3).
- App state gains `activeTool: 'radar' | 'vault'` (global, not per env: switching env keeps the tool you were looking at). The view shown is `(activeEnv, activeTool)`; WebContentsViews are keyed by `env:tool`, with partitions `persist:radar-<env>` (unchanged, keeps existing cookies) and `persist:vault-<env>`.

### 2. UI

- Top bar, left to right: env label + cluster (unchanged), spacer, health/credential pills, **segmented control `Radar | Vault`**, `Switch environment`, ⚙.
- The health pill shows the active tool's health: cluster status for Radar, Vault login status for Vault (`● Vault signed in`, `⚠ Vault sign-in failed`).
- Shortcut: `Ctrl/⌘+Shift+R` Radar, `Ctrl/⌘+Shift+V` Vault (menu accelerators, like the switcher).
- Vault tab disabled (greyed, tooltip explains) when vault-mcp is not configured or doesn't support standalone mode.
- Environment menu rows show both tools' state compactly, e.g. `Radar ✓ · Vault ✓` or `Radar ⚠ Auth rejected`.
- ⚙ menu: MCP endpoints section keeps listing radar MCP URLs (Vault UI is not an MCP endpoint).
- The body placeholder (connecting / error) is per tool: e.g. "Starting Vault UI…", and a Vault-specific error page with the vault-mcp log tail.

### 3. vault-mcp changes (repo `Norman-else/vault-mcp`)

1. **Standalone web UI entry point**: `python -m vault_mcp.web_ui --env <dev|sat|prod> --port <n> [--host 127.0.0.1]`.
   - Starts only the Flask web UI (no MCP stdio loop), bound to the given host/port; fails fast with a clear message if the port is taken.
   - Idle shutdown (`WEB_UI_TIMEOUT_MINUTES`) disabled in this mode; the desktop app owns the lifetime.
   - Pre-selects `--env` and logs in on start; the UI's environment selector is hidden or locked to that env (one process = one env, matching the colour bar).
   - Prints a machine-readable ready line, e.g. `VAULT_WEB_UI_READY http://127.0.0.1:9291`, and exposes `GET /api/health` → `{ "vault": "authenticated" | "unauthenticated" | "error", "message"?, "token_ttl"? }`.
2. **Caller-provided AWS credentials**: env var `VAULT_MCP_AWS_CREDENTIALS=ambient`.
   - `_aws_login` skips aws-vault and gets credentials from boto3's default chain (`boto3.Session().get_credentials().get_frozen_credentials()`), which reads the desktop's `AWS_CONTAINER_CREDENTIALS_FULL_URI` endpoint and therefore always sees renewed credentials.
   - When the Vault token is near expiry or a Vault call returns 403, re-login with fresh ambient credentials automatically (no MFA as long as AWS credentials are valid).
   - `POST /api/login` in this mode re-logs in with ambient credentials (the desktop calls it after renewal).
   - The web UI's Kubernetes features (`/api/k8s/*`, deployment restart/status) also fetch AWS credentials via aws-vault for kubectl's EKS exec plugin; in ambient mode they must use the same ambient credentials (pass the container-credentials env through to kubectl), so they never trigger their own MFA. The desktop passes `K8S_CONTEXT_<ENV>` and the env's single-context kubeconfig.
3. Capability detection: `python -m vault_mcp.web_ui --version` (or `--help` listing `--env`) so the desktop can grey out the Vault tab for older checkouts.
4. MCP mode unchanged; existing tests keep passing; new tests for ambient login and the standalone entry point.

### 4. Desktop ↔ vault-mcp wiring

- Settings: `vaultMcpPath` (checkout root, default `K:/MCP/vault-mcp` on Windows if it exists, else unset) and optional `vaultPython` (default `<root>/.venv/Scripts/python.exe` on Windows, `<root>/.venv/bin/python` on macOS).
- Vault per-env addresses/roles: vault-mcp already reads `VAULT_ADDR_<ENV>`, `VAULT_HEADER_<ENV>`, `VAULT_ROLE_<ENV>`, `AWS_REGION_<ENV>` from its environment. The desktop passes them from settings `envs.<profile>.vault = { addr, header, role }`. To avoid copying secrets/config by hand, a one-time import fills these from the `vault` server entry in `~/.claude.json` if present (only the non-secret `VAULT_*` / `AWS_REGION_*` keys; Slack tokens etc. are not copied).
- Env mapping: desktop profile `dev|sat|prod` → vault-mcp `--env` of the same name; override with `envs.<profile>.vault.env`.
- Process env for vault-mcp: the same isolated AWS env the radar process gets (`AWS_CONTAINER_CREDENTIALS_FULL_URI`, token, isolated config files, region), plus `VAULT_MCP_AWS_CREDENTIALS=ambient` and the `VAULT_*` values. `PYTHONPATH` is not inherited.
- Ports: Vault UI gets radar port + 10 by default (dev 9291, sat 9292, prod 9293), overridable with `envs.<profile>.vault.port`.
- Readiness: wait for the ready line or `GET /api/health` answering; health polled like radar's `/api/connection`.
- On credential renewal: `POST /api/login`, then re-check health.

### 5. Rename

- GitHub: rename `Norman-else/radar-desktop` → `infra-desktop` (GitHub redirects API, git and release download URLs from the old name).
- `package.json` name `infra-desktop`, productName `Infra Desktop`, `build.publish.repo` `infra-desktop`, artifact names `Infra-Desktop-…`, updater `REPO` constant.
- Keep `appId` `io.radar.desktop` so Windows treats it as the same app and the NSIS update replaces it in place. (Changing appId would install a second app.)
- userData moves from `…/Radar Desktop` to `…/Infra Desktop` (Electron derives it from productName). On first start, if the new dir has no `settings.json` and the old one does, copy `settings.json`, `kube/` and `aws/`, and leave the old dir untouched.
- macOS self-updater: stop hard-coding `Radar Desktop.app`; take the single `.app` found in the extracted zip and install it at the current bundle's path (keeps the user's location), renaming to `Infra Desktop.app`.
- Windows: the NSIS installer for the new productName installs to `…\Programs\Infra Desktop`. The in-place update from 0.1.x must be checked (electron-updater runs the new installer with the old install dir; verify shortcuts are renamed and the old uninstall entry is replaced, not duplicated).
- Docs/README/window titles/notifications say Infra Desktop.

### 6. Rollout (each step is its own release)

1. **Rename** (0.2.0): repo + product rename, userData migration, macOS updater fix. Verify update from an installed 0.1.11 on Windows; macOS verified via the same logic in a test install.
2. **Environment × tool framework** (0.3.0): tool abstraction, `Radar | Vault` switch with Vault disabled ("vault-mcp not configured").
3. **vault-mcp**: standalone mode + ambient credentials + health endpoint, released in vault-mcp.
4. **Vault tab** (0.4.0): settings, import from `~/.claude.json`, process management, renewal hook.

## Constraints

- Windows and macOS, Electron + TypeScript as today; vault-mcp is Python 3 with its own `.venv`.
- Vault web UI is plain HTTP on loopback only; nothing listens on 0.0.0.0 (vault-mcp's default `WEB_UI_HOST` is `0.0.0.0`, the desktop always passes `127.0.0.1`).
- Never log or display Vault secrets or AWS credentials; the desktop only reads vault-mcp's health/status, never secret APIs.

## Calls made by Claude (not discussed; check these)

- One vault-mcp process per environment, its env selector locked, rather than one process switching environments.
- Tool processes start lazily (Vault only starts the first time its tab is opened for that env).
- `activeTool` is global: switching environment keeps the tool you were on.
- Vault ports default to radar port + 10 (9291/9292/9293).
- Vault settings are imported once from the `vault` MCP entry in `~/.claude.json` (non-secret keys only).
- Version numbers: rename 0.2.0, framework 0.3.0, Vault tab 0.4.0.

## Left to the builder

- Exact tool-process interface and file layout in `src/main` (keep `RadarProcess` behaviour; extract a shared base where it helps).
- Exact visual of the segmented control and Vault health pill, within the existing bar style.
- How vault-mcp locks the UI's env selector (hide vs. disable) and the ready-line format, as long as the desktop can detect readiness and capability.
- Test strategy for vault-mcp ambient login (mock STS/Vault vs. a local Vault dev server).
