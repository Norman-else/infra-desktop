import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { which as whichOnPath } from './paths';
import type { Settings } from './settings';

/** How to run vault-mcp's standalone web UI, or why it can't run. */
export type VaultMcp =
  | {
      ok: true;
      source: 'checkout' | 'uvx';
      /** argv before `--env … --port …` */
      command: string[];
      cwd?: string;
      /** Extra environment for the process (checkout: its sources on PYTHONPATH) */
      env: Record<string, string>;
      startTimeoutMs: number;
      /** Shown while starting; the first uvx run downloads vault-mcp and its dependencies */
      firstRunHint?: string;
    }
  | { ok: false; reason: string };
export type VaultMcpReady = Extract<VaultMcp, { ok: true }>;

export const STANDALONE_VERSION = 'vault-mcp-web-ui standalone 1';
/** vault-mcp commit run with uvx; bump when the desktop needs a newer vault-mcp. */
export const VAULT_MCP_SHA = 'ba9274b3be0227f7632449058badc223cba01c03';
const DEFAULT_WINDOWS_ROOT = 'K:/MCP/vault-mcp';
const UVX_TIMEOUT_MS = 300_000;

type Runner = (cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;
type Which = (names: string[]) => string | undefined;

const defaultRun: Runner = (cmd, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

/** Base environment for a vault-mcp process: no Python settings leaking in from elsewhere. */
export function vaultMcpEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  return Object.assign(env, extra);
}

function checkoutLauncher(root: string, settings: Settings): VaultMcp {
  const python = settings.vaultPython ?? join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) return { ok: false, reason: `Python for vault-mcp not found at ${python}. Set vaultPython in settings.` };
  return { ok: true, source: 'checkout', command: [python, '-m', 'vault_mcp.web_ui'], cwd: root, env: { PYTHONPATH: join(root, 'src') }, startTimeoutMs: 60_000 };
}

function uvxLauncher(settings: Settings, which: Which): VaultMcp {
  const uvx = which(['uvx']);
  if (!uvx) return { ok: false, reason: 'Vault needs uv (https://docs.astral.sh/uv/) or a vault-mcp checkout (vaultMcpPath).' };
  const ref = settings.vaultMcpRef ?? VAULT_MCP_SHA;
  return {
    ok: true,
    source: 'uvx',
    command: [uvx, '--from', `https://github.com/Norman-else/vault-mcp/archive/${ref}.zip`, 'vault-mcp-web-ui'],
    env: {},
    startTimeoutMs: UVX_TIMEOUT_MS,
    firstRunHint: 'Preparing Vault (first run downloads vault-mcp)…',
  };
}

/** Pick the launcher (checkout when configured or present, else uvx) and check it supports standalone mode. */
export async function detectVaultMcp(settings: Settings, run: Runner = defaultRun, which: Which = whichOnPath): Promise<VaultMcp> {
  const source = settings.vaultMcpSource ?? 'auto';
  let launcher: VaultMcp;
  if (source !== 'uvx' && settings.vaultMcpPath) {
    if (!existsSync(settings.vaultMcpPath)) return { ok: false, reason: `vault-mcp not found at ${settings.vaultMcpPath}. Fix vaultMcpPath in settings.` };
    launcher = checkoutLauncher(settings.vaultMcpPath, settings);
  } else if (source === 'auto' && process.platform === 'win32' && existsSync(DEFAULT_WINDOWS_ROOT)) {
    launcher = checkoutLauncher(DEFAULT_WINDOWS_ROOT, settings);
  } else if (source === 'checkout') {
    return { ok: false, reason: 'vault-mcp not found. Set vaultMcpPath in settings.' };
  } else {
    launcher = uvxLauncher(settings, which);
  }
  if (!launcher.ok) return launcher;

  try {
    const [cmd, ...args] = [...launcher.command, '--version'];
    const out = await run(cmd, args, { cwd: launcher.cwd, env: vaultMcpEnv(launcher.env), timeoutMs: launcher.source === 'uvx' ? UVX_TIMEOUT_MS : 15_000 });
    if (out.trim() === STANDALONE_VERSION) return launcher;
  } catch {
    /* older vault-mcp without the standalone entry point, or uvx failed */
  }
  return launcher.source === 'checkout'
    ? { ok: false, reason: `vault-mcp at ${launcher.cwd} has no standalone mode. Update it (git pull).` }
    : { ok: false, reason: `Could not run vault-mcp with uvx (${settings.vaultMcpRef ?? VAULT_MCP_SHA}). Check your network or uv installation.` };
}
