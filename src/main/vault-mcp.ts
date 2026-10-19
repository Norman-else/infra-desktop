import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { which as whichOnPath } from './paths';
import type { Settings } from './settings';

/** How to run vault-mcp's standalone web UI (always a vault-mcp release via uvx), or why it can't run. */
export type VaultMcp =
  | {
      ok: true;
      /** argv before `--env … --port …` */
      command: string[];
      cwd?: string;
      /** Extra environment for the process */
      env: Record<string, string>;
      startTimeoutMs: number;
      /** Shown while starting; the first uvx run downloads vault-mcp and its dependencies */
      firstRunHint?: string;
      /** The vault-mcp release tag or commit being run */
      ref?: string;
    }
  | { ok: false; reason: string };
export type VaultMcpReady = Extract<VaultMcp, { ok: true }>;

export const STANDALONE_VERSION = 'vault-mcp-web-ui standalone 1';
/** Used in uvx mode when there is no usable vault-mcp release (and nothing cached). */
export const VAULT_MCP_SHA = 'ba9274b3be0227f7632449058badc223cba01c03';
const REPO = 'Norman-else/vault-mcp';
const UVX_TIMEOUT_MS = 300_000;
/** How long a "latest release" lookup is reused before asking GitHub again. */
export const LATEST_CHECK_INTERVAL_MS = 4 * 60 * 60_000;

type Runner = (cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;
type Which = (names: string[]) => string | undefined;
export interface DetectDeps {
  run?: Runner;
  which?: Which;
  /** Tag of the latest vault-mcp GitHub release, undefined when there is none */
  fetchLatest?: () => Promise<string | undefined>;
  /** Where the latest-release lookup and last working ref are remembered */
  stateFile?: string;
  now?: () => number;
}
interface State {
  latest?: { tag?: string; checkedAt: number };
  lastGood?: string;
}

const defaultRun: Runner = (cmd, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

export async function fetchLatestRelease(): Promise<string | undefined> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  return ((await res.json()) as { tag_name?: string }).tag_name;
}

/** Base environment for a vault-mcp process: no Python settings leaking in from elsewhere. */
export function vaultMcpEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  return Object.assign(env, extra);
}

const readState = (file?: string): State => {
  try {
    return file ? (JSON.parse(readFileSync(file, 'utf8')) as State) : {};
  } catch {
    return {};
  }
};
const writeState = (file: string | undefined, state: State) => {
  try {
    if (file) writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    /* only a cache */
  }
};

const passes = async (launcher: VaultMcpReady, run: Runner): Promise<boolean> => {
  try {
    const [cmd, ...args] = [...launcher.command, '--version'];
    const out = await run(cmd, args, { cwd: launcher.cwd, env: vaultMcpEnv(launcher.env), timeoutMs: UVX_TIMEOUT_MS });
    return out.trim() === STANDALONE_VERSION;
  } catch {
    return false;
  }
};

/** uvx: the configured ref, else the latest release, else the last ref that worked, else the pinned commit. */
async function detectUvx(settings: Settings, deps: Required<Pick<DetectDeps, 'run' | 'which' | 'fetchLatest' | 'now'>> & DetectDeps): Promise<VaultMcp> {
  const uvx = deps.which(['uvx']);
  if (!uvx) return { ok: false, reason: 'Vault needs uv. Install it from https://docs.astral.sh/uv/ and reload the config.' };
  const launcher = (ref: string): VaultMcpReady => ({
    ok: true,
    ref,
    command: [uvx, '--from', `https://github.com/${REPO}/archive/${ref}.zip`, 'vault-mcp-web-ui'],
    env: {},
    startTimeoutMs: UVX_TIMEOUT_MS,
    firstRunHint: 'Preparing Vault (first run downloads vault-mcp)…',
  });

  if (settings.vaultMcpRef) {
    const pinned = launcher(settings.vaultMcpRef);
    return (await passes(pinned, deps.run)) ? pinned : { ok: false, reason: `Could not run vault-mcp ${settings.vaultMcpRef} with uvx. Check vaultMcpRef, your network or uv.` };
  }

  const state = readState(deps.stateFile);
  let latest = state.latest?.tag;
  if (!state.latest || deps.now() - state.latest.checkedAt >= LATEST_CHECK_INTERVAL_MS) {
    try {
      latest = await deps.fetchLatest();
      state.latest = { tag: latest, checkedAt: deps.now() };
    } catch {
      /* offline / rate limited: use what is cached */
    }
  }
  const candidates = [...new Set([latest, state.lastGood, VAULT_MCP_SHA].filter((r): r is string => !!r))];
  for (const ref of candidates) {
    const candidate = launcher(ref);
    if (await passes(candidate, deps.run)) {
      writeState(deps.stateFile, { ...state, lastGood: ref });
      return candidate;
    }
  }
  writeState(deps.stateFile, state);
  return { ok: false, reason: 'Could not run vault-mcp with uvx. Check your network or uv installation.' };
}

/** Find the vault-mcp release to run with uvx and check it supports standalone mode. A local checkout is never used. */
export async function detectVaultMcp(settings: Settings, deps: DetectDeps = {}): Promise<VaultMcp> {
  return detectUvx(settings, { ...deps, run: deps.run ?? defaultRun, which: deps.which ?? whichOnPath, fetchLatest: deps.fetchLatest ?? fetchLatestRelease, now: deps.now ?? Date.now });
}
