import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import YAML from 'yaml';
import type { UpdateState } from '../shared/types';

const REPO = 'Norman-else/infra-desktop';
const CHECK_INTERVAL_MS = 30 * 60_000;
/** A focus-triggered check runs only if the last one is at least this old. */
const FOCUS_CHECK_AFTER_MS = 10 * 60_000;

export interface Updater {
  state: UpdateState;
  check(): Promise<void>;
  /** Check unless one ran recently (used when the window gets focus). */
  checkIfStale(): void;
  install(): void;
}

/** semver-ish compare of "1.2.3" strings; prerelease suffixes are ignored. */
export function isNewer(remote: string, local: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const [a, b] = [parse(remote), parse(local)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/** The one .app bundle directly inside an extracted macOS update. */
export function findAppBundle(dir: string): string {
  const apps = readdirSync(dir).filter((n) => n.endsWith('.app') && statSync(join(dir, n)).isDirectory());
  if (apps.length !== 1) throw new Error(`Expected one .app in the update, found ${apps.length}`);
  return join(dir, apps[0]);
}

/** Where the updated bundle goes: the current bundle's folder, under the current product name. */
export function installTarget(currentBundle: string, productName: string): string {
  return join(dirname(currentBundle), `${productName}.app`);
}

/**
 * Windows: electron-updater (NSIS) downloads in the background and installs on restart.
 * macOS: the app is only ad-hoc signed, which Squirrel.Mac rejects, so we download the release zip ourselves
 * and swap the .app bundle after the app quits.
 */
export function createUpdater(onChange: (s: UpdateState) => void): Updater {
  const state: UpdateState = { status: app.isPackaged ? 'idle' : 'disabled', current: app.getVersion() };
  const set = (patch: Partial<UpdateState>) => {
    Object.assign(state, patch);
    onChange({ ...state });
  };
  let lastCheck = 0;
  const impl = process.platform === 'darwin' ? macUpdater(state, set) : winUpdater(state, set);
  const updater: Updater = {
    state,
    async check() {
      if (!app.isPackaged || ['checking', 'downloading'].includes(state.status)) return;
      lastCheck = Date.now();
      // Keep checking after a download: if a newer release appeared meanwhile, fetch that instead,
      // so the user always jumps straight to the latest version.
      const wasReady = state.status === 'ready';
      if (!wasReady) set({ status: 'checking', error: undefined });
      try {
        await impl.check();
      } catch (e) {
        set({ status: wasReady ? 'ready' : 'error', error: (e as Error).message });
      }
    },
    checkIfStale() {
      if (Date.now() - lastCheck >= FOCUS_CHECK_AFTER_MS) void updater.check();
    },
    install: () => impl.install(),
  };
  if (app.isPackaged) {
    setTimeout(() => void updater.check(), 10_000);
    setInterval(() => void updater.check(), CHECK_INTERVAL_MS);
  }
  return updater;
}

type Impl = { check(): Promise<void>; install(): void };

function winUpdater(state: UpdateState, set: (p: Partial<UpdateState>) => void): Impl {
  // Loaded lazily: electron-updater touches app paths at import time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Rechecking while an update is already downloaded reports that same version again; keep it as is.
  const sameAsReady = (version: string) => state.status === 'ready' && state.version === version;
  autoUpdater.on('update-available', (i) => {
    if (!sameAsReady(i.version)) set({ status: 'downloading', version: i.version, progress: 0 });
  });
  autoUpdater.on('update-not-available', () => {
    if (state.status !== 'ready') set({ status: 'latest' });
  });
  autoUpdater.on('download-progress', (p) => {
    if (state.status === 'downloading') set({ progress: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version, progress: 100 }));
  autoUpdater.on('error', (e) => set({ status: 'error', error: e.message }));
  return {
    check: async () => {
      await autoUpdater.checkForUpdates();
    },
    install: () => autoUpdater.quitAndInstall(false, true),
  };
}

interface MacManifest {
  version: string;
  files: { url: string; sha512: string; size?: number }[];
}

function macUpdater(state: UpdateState, set: (p: Partial<UpdateState>) => void): Impl {
  let staged: string | undefined; // path of the new .app, extracted and ready to swap in

  const appBundle = () => {
    // .../Infra Desktop.app/Contents/MacOS/Infra Desktop -> .../Infra Desktop.app
    const exe = app.getPath('exe');
    const i = exe.indexOf('.app/');
    return i > 0 ? exe.slice(0, i + 4) : undefined;
  };

  return {
    async check() {
      const res = await fetch(`https://github.com/${REPO}/releases/latest/download/latest-mac.yml`, { redirect: 'follow' });
      if (res.status === 404) return set({ status: 'latest' });
      if (!res.ok) throw new Error(`Update check failed: HTTP ${res.status}`);
      const manifest = YAML.parse(await res.text()) as MacManifest;
      // Compare with what's already downloaded, if anything, so a newer release replaces it.
      const have = staged && state.version ? state.version : state.current;
      if (!isNewer(manifest.version, have)) return set({ status: staged ? 'ready' : 'latest' });

      const wantArm = process.arch === 'arm64';
      const file = manifest.files.find((f) => f.url.endsWith('.zip') && f.url.includes('arm64') === wantArm);
      if (!file) throw new Error(`Version ${manifest.version} has no ${process.arch} zip`);

      set({ status: 'downloading', version: manifest.version, progress: 0 });
      const dir = mkdtempSync(join(tmpdir(), 'infra-desktop-update-'));
      const zip = join(dir, 'update.zip');
      const dl = await fetch(`https://github.com/${REPO}/releases/download/v${manifest.version}/${encodeURIComponent(file.url)}`);
      if (!dl.ok || !dl.body) throw new Error(`Update download failed: HTTP ${dl.status}`);
      const total = Number(dl.headers.get('content-length')) || file.size || 0;
      let received = 0;
      let lastPct = -1;
      const hash = createHash('sha512');
      const body = Readable.fromWeb(dl.body as import('node:stream/web').ReadableStream);
      body.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        const pct = total ? Math.floor((received / total) * 100) : 0;
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          set({ progress: pct });
        }
      });
      await pipeline(body, createWriteStream(zip));
      if (hash.digest('base64') !== file.sha512) throw new Error('Update failed verification (sha512 mismatch)');

      await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
      staged = findAppBundle(dir);
      set({ status: 'ready', progress: 100 });
    },
    install() {
      const current = appBundle();
      if (!staged || !current) return;
      // The bundle may have been renamed between versions (Radar Desktop.app → Infra Desktop.app).
      const target = installTarget(current, app.getName());
      // Wait for this process to exit, swap the bundle (restoring the old one if that fails), relaunch.
      const script = `
        while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
        rm -rf "$C.old"
        if mv "$C" "$C.old"; then
          [ "$T" != "$C" ] && rm -rf "$T"
          if mv "$S" "$T"; then rm -rf "$C.old"; else mv "$C.old" "$C"; T="$C"; fi
        fi
        xattr -cr "$T" 2>/dev/null
        open "$T"`;
      spawn('/bin/sh', ['-c', script], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PID: String(process.pid), C: current, T: target, S: staged },
      }).unref();
      app.quit();
    },
  };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}
