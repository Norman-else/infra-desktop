import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from './settings';

/** A vault-mcp checkout that can run the standalone web UI, or why it can't. */
export type VaultMcp = { ok: true; root: string; python: string } | { ok: false; reason: string };
export type VaultMcpReady = Extract<VaultMcp, { ok: true }>;

export const STANDALONE_VERSION = 'vault-mcp-web-ui standalone 1';
const DEFAULT_WINDOWS_ROOT = 'K:/MCP/vault-mcp';

type Runner = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;

const defaultRun: Runner = (cmd, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { ...opts, timeout: 15_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

/** Environment for any vault-mcp process: its sources on PYTHONPATH (it isn't installed into the venv). */
export function vaultMcpEnv(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PYTHONPATH: join(root, 'src') };
  delete env.PYTHONHOME;
  return env;
}

export async function detectVaultMcp(settings: Settings, run: Runner = defaultRun): Promise<VaultMcp> {
  const root = settings.vaultMcpPath ?? (process.platform === 'win32' && existsSync(DEFAULT_WINDOWS_ROOT) ? DEFAULT_WINDOWS_ROOT : undefined);
  if (!root || !existsSync(root)) return { ok: false, reason: 'vault-mcp not found. Set vaultMcpPath in settings.' };
  const python = settings.vaultPython ?? join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(python)) return { ok: false, reason: `Python for vault-mcp not found at ${python}. Set vaultPython in settings.` };
  try {
    const out = await run(python, ['-m', 'vault_mcp.web_ui', '--version'], { cwd: root, env: vaultMcpEnv(root) });
    if (out.trim() === STANDALONE_VERSION) return { ok: true, root, python };
  } catch {
    /* older checkout without the standalone entry point */
  }
  return { ok: false, reason: `vault-mcp at ${root} has no standalone mode. Update it (git pull).` };
}
