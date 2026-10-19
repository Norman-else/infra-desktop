# Infra Desktop Rename (stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Radar Desktop as **Infra Desktop 0.2.0** from the renamed repo `Norman-else/infra-desktop`, with installed 0.1.x copies updating in place and keeping their settings.

**Architecture:** Product/repo names change in config and copy; `appId` stays `io.radar.desktop`. A small migration copies the old userData into the new one on first start. The macOS self-updater stops assuming the bundle name. Later stages (tool framework, vault-mcp, Vault tab) get their own plans.

**Tech Stack:** Electron 44 + TypeScript, esbuild, electron-builder (NSIS / dmg+zip), electron-updater, vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-19-infra-desktop-vault-design.md` (§5 Rename, §6 step 1)

## Global Constraints

- productName `Infra Desktop`; package/repo name `infra-desktop`; GitHub `Norman-else/infra-desktop`.
- `appId` stays `io.radar.desktop` (Windows AppUserModelID in `index.ts` stays `io.radar.desktop` too).
- Old userData dir name `Radar Desktop`, new `Infra Desktop`; copy `settings.json`, `kube/`, `aws/` only when the new dir has no `settings.json`; never modify or delete the old dir.
- Artifact names: `Infra-Desktop-Setup-${version}-${arch}.${ext}` (Windows), `Infra-Desktop-${version}-${arch}.${ext}` (macOS).
- Dev/test data-dir override env var: `INFRA_DESKTOP_DATA_DIR`, still accepting `RADAR_DESKTOP_DATA_DIR` as a fallback. When either is set, no migration runs.
- Release version: exactly `0.2.0` (workflow input `version`).

## Review Focus

1. User has settings in both old and new dirs (e.g. ran 0.2.0, then reinstalled 0.1.x) → new dir wins, nothing overwritten. (Task 1 test `does not overwrite an existing new settings.json`.)
2. Old dir missing or empty (fresh install) → migration is a no-op, no error. (Task 1 test `skips when there is nothing to migrate`.)
3. macOS user installed the app outside `/Applications` (e.g. `~/Applications`) → update lands in the same folder, renamed to `Infra Desktop.app`. (Task 2 test `targets the current bundle's folder with the new name`.)
4. macOS update zip contains zero or several `.app` bundles → clear error, current app untouched. (Task 2 test `rejects a zip without exactly one .app`.)
5. Windows 0.1.11 auto-updates to 0.2.0 → single uninstall entry, app starts, environments and `duration: 8h` still there. (Task 4 manual verification.)

---

### Task 1: userData migration

**Files:**
- Create: `src/main/migrate.ts`
- Modify: `src/main/index.ts` (data-dir override and migration call, before `new EnvManager`)
- Test: `test/migrate.test.ts`

**Interfaces:**
- Produces: `migrateUserData(oldDir: string, newDir: string): 'migrated' | 'skipped'` — synchronous, uses `node:fs` only (no Electron import), creates `newDir` if needed.

- [ ] **Step 1: Write the failing tests** in `test/migrate.test.ts` using `mkdtempSync` dirs:
  - `copies settings, kube and aws into an empty new dir` — old has `settings.json` (`{"duration":"8h"}`), `kube/dev.yaml`, `aws/credentials`; result `'migrated'`; all three exist in new with identical content.
  - `does not overwrite an existing new settings.json` — new already has `settings.json` `{"duration":"1h"}`; result `'skipped'`; new content still `1h`.
  - `skips when there is nothing to migrate` — old dir does not exist; result `'skipped'`; no throw.
  - `leaves the old dir untouched` — after migrating, old `settings.json` still exists with original content.
- [ ] **Step 2: Run** `npx vitest run test/migrate.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement `migrateUserData`** with `cpSync(..., { recursive: true })` for `kube`/`aws` (only if present) and `copyFileSync` for `settings.json`.
- [ ] **Step 4: Run** `npx vitest run test/migrate.test.ts` — expect 4 PASS.
- [ ] **Step 5: Wire it in `src/main/index.ts` `main()`**: data dir override = `process.env.INFRA_DESKTOP_DATA_DIR ?? process.env.RADAR_DESKTOP_DATA_DIR`; if set → `app.setPath('userData', it)` and skip migration; else after `app.whenReady()` call `migrateUserData(join(app.getPath('appData'), 'Radar Desktop'), app.getPath('userData'))` before `new EnvManager`. Rename the radar child env var `RADAR_DESKTOP_ENV` → `INFRA_DESKTOP_ENV` in `src/main/sessions.ts`.
- [ ] **Step 6: Run** `npx tsc --noEmit && npx vitest run` — expect all pass.
- [ ] **Step 7: Commit** `feat: migrate settings from Radar Desktop's data dir`.

### Task 2: macOS updater without a hard-coded bundle name

**Files:**
- Modify: `src/main/updater.ts` (`REPO`, temp dir prefix, `macUpdater` extract/install)
- Test: `test/updater.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (exported for tests, pure, `node:fs`/`node:path` only):
  - `findAppBundle(dir: string): string` — returns the path of the single `*.app` directory directly inside `dir`; throws `Error('Expected one .app in the update, found N')` otherwise.
  - `installTarget(currentBundle: string, productName: string): string` — `join(dirname(currentBundle), \`${productName}.app\`)`.

- [ ] **Step 1: Write the failing tests** in `test/updater.test.ts` (keep the existing `vi.mock('electron')`):
  - `finds the single .app in an extracted update` — temp dir with `Infra Desktop.app/` and `__MACOSX/` → returns the `.app` path.
  - `rejects a zip without exactly one .app` — empty dir throws `/found 0/`; dir with two `.app` throws `/found 2/`.
  - `targets the current bundle's folder with the new name` — `installTarget('/Users/u/Applications/Radar Desktop.app', 'Infra Desktop')` → `'/Users/u/Applications/Infra Desktop.app'` (compare with `path.join`).
- [ ] **Step 2: Run** `npx vitest run test/updater.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** both helpers; in `macUpdater` use `findAppBundle(dir)` instead of the fixed path, and in `install()` swap into `installTarget(current, app.getName())`: the shell script moves the current bundle to `$T_OLD.old`, moves the staged bundle to the target, restores on failure, deletes the old bundle (which may have the old name) on success, then `xattr -cr` and `open` the target. `REPO = 'Norman-else/infra-desktop'`; temp prefix `infra-desktop-update-`.
- [ ] **Step 4: Run** `npx tsc --noEmit && npx vitest run` — expect all pass.
- [ ] **Step 5: Commit** `fix(mac updater): install whatever bundle the update contains`.

### Task 3: Rename product, copy and build config

**Files:**
- Modify: `package.json` (+ `package-lock.json` via `npm install`), `src/main/index.ts` (window titles), `src/renderer/index.html` (`<title>`), `src/renderer/renderer.ts` (version line), `README.md`, `test/fake-aws-vault/main.go` (comment), `.github/workflows/release.yml` (no logic change; only if it names the product)
- Test: build + grep checks below

**Interfaces:** none (copy/config only).

- [ ] **Step 1: Edit `package.json`**: `name: "infra-desktop"`, top-level and `build.productName: "Infra Desktop"`, `description` mentions Radar and Vault, `repository.url` `https://github.com/Norman-else/infra-desktop.git`, `build.publish[0].repo: "infra-desktop"`, `build.nsis.artifactName: "Infra-Desktop-Setup-${version}-${arch}.${ext}"`, `build.mac.artifactName: "Infra-Desktop-${version}-${arch}.${ext}"`. Keep `appId`. Run `npm install` to refresh the lockfile name.
- [ ] **Step 2: Replace user-visible "Radar Desktop"** with "Infra Desktop" in the files listed above (README: title, macOS paths, data-dir env var `INFRA_DESKTOP_DATA_DIR`; add a short "Renamed from Radar Desktop" note explaining settings migrate automatically).
- [ ] **Step 3: Verify no stale names**: `git grep -nE "Radar Desktop|radar-desktop|RADAR_DESKTOP" -- . ':!docs' ':!package-lock.json'` — expect only the deliberate compatibility hits: `RADAR_DESKTOP_DATA_DIR` fallback and the `'Radar Desktop'` old-dir name in `index.ts`, the README rename note.
- [ ] **Step 4: Build the installer locally**: `npm run build && npx electron-builder --win -c.directories.output=release-local` — expect `release-local/Infra-Desktop-Setup-0.1.11-x64.exe` and `release-local/win-unpacked/resources/app-update.yml` containing `repo: infra-desktop`.
- [ ] **Step 5: Commit** `chore: rename to Infra Desktop`.

### Task 4: Rename the GitHub repo, release 0.2.0, verify in-place update

**Files:** none (repo settings, git remote, release).

- [ ] **Step 1: Rename the repo**: `gh repo rename infra-desktop -R Norman-else/radar-desktop --yes`; `git remote set-url origin https://github.com/Norman-else/infra-desktop.git`; `git push`.
- [ ] **Step 2: Verify the redirect old apps rely on**: `curl -sIL https://github.com/Norman-else/radar-desktop/releases/latest/download/latest.yml | grep -iE "^(HTTP|location)"` — expect a redirect chain ending in HTTP 200 under `infra-desktop`.
- [ ] **Step 3: Release**: `gh workflow run release.yml -R Norman-else/infra-desktop --ref master -f version=0.2.0`; wait for success; `gh release view v0.2.0 -R Norman-else/infra-desktop --json assets` lists `Infra-Desktop-Setup-0.2.0-x64.exe`, both `.dmg`/`.zip`, `latest.yml`, `latest-mac.yml`.
- [ ] **Step 4: Verify the Windows update path** on a throwaway install: silently install the v0.1.11 release installer into a scratch dir (`/S /D=<scratch>`), start it with a scratch `RADAR_DESKTOP_DATA_DIR` containing a `settings.json` with `"duration": "8h"`, trigger ⚙ → Check for updates (or wait 10 s), install the update; then confirm: the running exe is Infra Desktop 0.2.0, Settings → Apps shows one entry, the scratch settings are still used. Uninstall the scratch install by its own uninstaller; stop only processes by PID.
- [ ] **Step 5: Verify migration on the real profile**, read-only: after the user's own app updates, `%APPDATA%\Infra Desktop\settings.json` exists and matches `%APPDATA%\Radar Desktop\settings.json`.
