# Environment × Tool Framework (stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Infra Desktop 0.3.0 models each environment as shared credentials plus tools (`radar`, `vault`), with a `Radar | Vault` switch in the top bar; Radar works exactly as before, Vault is visible but disabled until stage 4.

**Architecture:** `EnvSession` keeps credentials, renewal and MFA; radar process management moves into `RadarTool` implementing a `Tool` interface. Tools start lazily when first shown for an env and get `onCredentialsRenewed()` after every credential update. `EnvManager` gains a global `activeTool`; the main process keys WebContentsViews by `env:tool`. The renderer shows per-tool status.

**Tech Stack:** Electron 44 + TypeScript, esbuild, vitest; fake aws-vault (`test/fake-aws-vault`) for session tests.

**Spec:** `docs/superpowers/specs/2026-10-19-infra-desktop-vault-design.md` (§1, §2, §6 step 2)

## Global Constraints

- `ToolKind = 'radar' | 'vault'`; default `activeTool` is `'radar'`; `activeTool` is global (switching env keeps it).
- WebContentsView partitions: radar stays `persist:radar-<env>` (keeps existing cookies), vault `persist:vault-<env>`.
- Shortcuts: `CmdOrCtrl+Shift+R` → Radar, `CmdOrCtrl+Shift+V` → Vault (app menu accelerators). Existing `CmdOrCtrl+Shift+E` switcher and `CmdOrCtrl+R` reload stay.
- In 0.3.0 Vault is never available: `available: false`, reason exactly `Vault support is coming in a later version.`
- Connecting an env obtains credentials only; a tool starts the first time it is shown for that env.
- Radar behaviour unchanged: fixed ports, health polling, reconnect + page reload after renewal, MCP URLs in ⚙ menu.
- Release version exactly `0.3.0`.

## Review Focus

1. Switching tool while credentials are still being fetched / MFA pending → the prompt stays, and the chosen tool starts once credentials arrive. (Task 2 test `starts the active tool after MFA completes`.)
2. Choosing Vault (disabled) by shortcut or IPC → ignored, Radar stays shown, no error state. (Task 3 test `ignores switching to an unavailable tool`.)
3. Radar exits unexpectedly → env credentials stay valid, only the Radar tool shows the error with Retry; Retry restarts radar without asking for MFA. (Task 2 test `tool failure keeps credentials and retry restarts the tool`.)
4. Disconnecting an env stops every tool of that env and drops its views. (Task 2 test `disconnect stops all tools`.)
5. Renewal while a tool is still starting → no crash; it gets the renewed credentials (served by the credential endpoint) and `onCredentialsRenewed` is only sent to tools in `ready`. (Task 2 test `renewal notifies only ready tools`.)

---

### Task 1: Tool interface and RadarTool

**Files:**
- Create: `src/main/tools/tool.ts`, `src/main/tools/radar.ts`
- Modify: `src/shared/types.ts`
- Test: `test/radar-tool.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`):
  - `type ToolKind = 'radar' | 'vault'`
  - `interface ToolState { status: 'stopped' | 'starting' | 'ready' | 'error'; step?: string; message?: string; logTail?: string[]; health?: ToolHealth; url?: string }`
  - `interface ToolHealth { state: 'ok' | 'pending' | 'failed'; text: string; detail?: string }` — `text` is the short label (`Cluster connected`, `Auth rejected`, …), `detail` the full reason.
  - `interface ToolAvailability { available: boolean; reason?: string }`
- Produces (`src/main/tools/tool.ts`):
  - `interface ToolContext { env: EnvInfo; credentialEnv(): NodeJS.ProcessEnv; kubeconfig(): string; settings: Settings; binaries: { radar?: string }; onChange(): void; emit(event: 'reload-view'): void }`
  - `interface Tool { readonly kind: ToolKind; readonly state: ToolState; start(): Promise<void>; stop(): void; onCredentialsRenewed(): Promise<void> }`
- Produces (`src/main/tools/radar.ts`): `class RadarTool implements Tool` (constructor `(ctx: ToolContext)`), containing what `EnvSession` does today in `startRadar`, `checkHealth`, `reconnectRadar` and the radar `onExit` handling; maps radar `/api/connection` to `ToolHealth`: `connected` → `{state:'ok', text:'Cluster connected'}`, `connecting` → `pending`, otherwise `failed` with `text` from the existing short labels (`Auth rejected`, `Cluster unreachable`, …) and `detail` = radar's error.

- [ ] **Step 1: Write failing tests** in `test/radar-tool.test.ts` with a stub HTTP server standing in for radar (no radar binary): construct `RadarTool` with a `ToolContext` whose `binaries.radar` points at a tiny Node script fixture `test/fixtures/fake-radar.mjs` that serves `/`, `/api/connection` (state from env var `FAKE_RADAR_STATE`) and `POST /api/connection/retry` (records calls to a file).
  - `starts and reports ok health` — `FAKE_RADAR_STATE=connected` → after `start()`, `state.status === 'ready'`, `state.health` equals `{ state: 'ok', text: 'Cluster connected' }`, `state.url` is `http://127.0.0.1:<env.port>/`.
  - `maps auth failures to a short label` — state `disconnected` + errorType `auth-rejected` → health `{ state: 'failed', text: 'Auth rejected' }` with `detail` containing the error.
  - `retries the connection after renewal when it was down` — health failed, then `onCredentialsRenewed()` → fixture recorded one retry call.
  - `reports an error when radar exits` — fixture started with `FAKE_RADAR_EXIT=1` → `state.status === 'error'`, `message` matches `/exited/`.
- [ ] **Step 2: Run** `npx vitest run test/radar-tool.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** types, `tool.ts`, `RadarTool` (reuse `RadarProcess` from `src/main/radar.ts` unchanged) and the fixture.
- [ ] **Step 4: Run** `npx vitest run test/radar-tool.test.ts` — expect 4 PASS.
- [ ] **Step 5: Commit** `refactor: radar as a Tool`.

### Task 2: EnvSession owns credentials, tools start lazily

**Files:**
- Modify: `src/main/sessions.ts`, `src/shared/types.ts`
- Test: `test/sessions.test.ts` (uses the fake aws-vault; `describe.skipIf` when its binary is missing, like `credentials.test.ts`)

**Interfaces:**
- Consumes: `Tool`, `ToolContext`, `RadarTool` (Task 1).
- Produces:
  - `EnvStatus` becomes credential-only: `'idle' | 'checking' | 'ready' | 'error'` (`'connecting'` removed; tool startup is `ToolState.status === 'starting'`).
  - `EnvState` drops `cluster` and `logTail` and gains `tools: Record<ToolKind, ToolState & ToolAvailability>`.
  - `EnvManager` constructor: `(dataDir: string, toolFactories?: Partial<Record<ToolKind, (ctx: ToolContext) => Tool>>)`, default `{ radar: (ctx) => new RadarTool(ctx) }`; a kind without a factory is unavailable with the reason from Global Constraints.
  - `EnvSession.ensureTool(kind: ToolKind): Promise<void>` — start the tool if credentials are ready and it isn't running; `retryTool(kind)`; `disconnect()` stops all tools.
  - Manager events: `'ready'` → `(env: string, tool: ToolKind)`, `'stopped'` → `(env: string, tool?: ToolKind)` (no tool = whole env), `'reload-view'` → `(env, tool)`.
  - `EnvManager.urlOf(env: string, tool: ToolKind): string | undefined`.

- [ ] **Step 1: Write failing tests** in `test/sessions.test.ts` using `new EnvManager(tmpDir, { radar: () => fakeTool })` where `fakeTool` is a small in-test `Tool` recording calls (start resolves to `ready`); settings in `tmpDir/settings.json` point `awsVaultPath` at the fake aws-vault; reuse the env-discovery inputs by pointing `AWS_CONFIG_FILE`/`KUBECONFIG` at fixture files written in the test.
  - `connect obtains credentials and starts only the active tool`
  - `starts the active tool after MFA completes` — no cached session → `prompt === 'mfa'`, tool not started; `submitMfa('123456')` → tool started once.
  - `renewal notifies only ready tools`
  - `tool failure keeps credentials and retry restarts the tool` — fake tool start rejects once → env `status === 'ready'`, `tools.radar.status === 'error'`; `retryTool('radar')` starts it again with no MFA prompt.
  - `disconnect stops all tools`
- [ ] **Step 2: Run** `npx vitest run test/sessions.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the split in `sessions.ts`: credential flow unchanged; replace `startRadar`/health/reconnect with tool calls; after an `ok` credential result call `ensureTool(manager.activeTool)` on connect and `onCredentialsRenewed()` on running tools otherwise.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run` — expect all pass (existing 19 + new).
- [ ] **Step 5: Commit** `refactor: env credentials with lazily started tools`.

### Task 3: Active tool in main process and IPC

**Files:**
- Modify: `src/main/sessions.ts` (`activeTool`, `setTool`), `src/main/index.ts` (views keyed `env:tool`, menu accelerators, IPC), `src/preload/index.ts`, `src/shared/types.ts` (`AppState.activeTool`, `RadarDesktopApi.setTool`)
- Test: `test/sessions.test.ts`

**Interfaces:**
- Consumes: Task 2 manager API.
- Produces: `EnvManager.activeTool: ToolKind`; `EnvManager.setTool(kind: ToolKind): Promise<void>` (no-op if unavailable; otherwise sets it, emits state and `'activate'`, and calls `ensureTool` on the active env); `AppState.activeTool`; IPC `tool:set`; preload `setTool(tool: ToolKind): Promise<void>`; menu command channel sends `'tool:radar'` / `'tool:vault'` or calls `setTool` directly.

- [ ] **Step 1: Write failing tests**: `switching tool starts it for the active env` (with a second fake tool factory for `vault` registered in the test), `ignores switching to an unavailable tool` (default factories → `setTool('vault')` leaves `activeTool === 'radar'`), `switching env keeps the active tool`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** in manager; in `index.ts` key `views` by `${env}:${tool}`, show `(active env, activeTool)`, partition per Global Constraints, menu items "Radar" / "Vault" with the accelerators, IPC handler.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run` — expect all pass.
- [ ] **Step 5: Commit** `feat: switch between tools per environment`.

### Task 4: Renderer — Radar | Vault switch and per-tool status

**Files:**
- Modify: `src/renderer/renderer.ts`, `src/renderer/styles.css`
- Test: manual check in a dev instance (`INFRA_DESKTOP_DATA_DIR` scratch dir + fake aws-vault), screenshots of: bar with switch, Vault disabled tooltip, env menu rows, Radar error page with Retry.

**Interfaces:**
- Consumes: `AppState.activeTool`, `EnvState.tools`, `api.setTool`.

- [ ] **Step 1: Bar**: segmented control `Radar | Vault` between the pills and `Switch environment`, active segment highlighted, Vault segment `disabled` with `title` = its `reason`. Health pill shows `tools[activeTool].health` (`ok` → `● <text>`, `failed` → white pill `⚠ <text>` with `detail` as tooltip, `pending` → `<text>…`).
- [ ] **Step 2: Body**: placeholders per active tool — `starting` → spinner with `step`; `error` → "Could not start Radar" with `message`, `logTail`, buttons Retry (`api.retry(env)` now retries the active tool when credentials are ready) / Switch environment; credential states (`checking`, MFA prompt, credential error) unchanged.
- [ ] **Step 3: Env menu rows**: status text becomes per tool, e.g. `Radar ✓` / `Radar ⚠ Auth rejected` (short, existing ellipsis rules), plus `Vault —` when unavailable; tooltip carries details.
- [ ] **Step 4: Verify** in a dev instance: build, launch with fake aws-vault, connect dev, screenshot bar + menu; hover Vault shows the reason; `Ctrl+Shift+V` does nothing; kill the dev instance's radar **by PID** → error page with Retry → Retry brings Radar back without MFA.
- [ ] **Step 5: Commit** `feat: Radar | Vault switch in the top bar`.

### Task 5: Release 0.3.0

- [ ] **Step 1:** README: document the switch and shortcuts; `npx vitest run && npx tsc --noEmit` green; push.
- [ ] **Step 2:** `gh workflow run release.yml -R Norman-else/infra-desktop --ref master -f version=0.3.0`; wait for success; assets present as in 0.2.0 (`Infra-Desktop-*0.3.0*`).
