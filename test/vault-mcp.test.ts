import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detectVaultMcp, VAULT_MCP_SHA } from '../src/main/vault-mcp';

const venvPython = (root: string) => join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const OK = 'vault-mcp-web-ui standalone 1\r\n';
const noUv = () => undefined;
const uvAt = (path: string) => (names: string[]) => (names.includes('uvx') ? path : undefined);
const archive = (ref: string) => `https://github.com/Norman-else/vault-mcp/archive/${ref}.zip`;
const noReleases = async () => undefined;
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'vault-state-')), 'vault-mcp.json');

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'vault-mcp-'));
  const py = venvPython(root);
  mkdirSync(join(py, '..'), { recursive: true });
  writeFileSync(py, '');
  return root;
}

describe('detectVaultMcp: checkout', () => {
  it('auto prefers the checkout', async () => {
    const root = checkout();
    const run = vi.fn().mockResolvedValue(OK);
    const r = await detectVaultMcp({ vaultMcpPath: root }, { run, which: uvAt('C:/uv/uvx.exe'), fetchLatest: noReleases });
    expect(r).toMatchObject({ ok: true, source: 'checkout', command: [venvPython(root), '-m', 'vault_mcp.web_ui'], cwd: root, env: { PYTHONPATH: join(root, 'src') } });
    const [cmd, args, opts] = run.mock.calls[0];
    expect([cmd, ...args]).toEqual([venvPython(root), '-m', 'vault_mcp.web_ui', '--version']);
    expect(opts.env.PYTHONPATH).toBe(join(root, 'src'));
  });

  it('too old when --version fails or prints something else', async () => {
    const root = checkout();
    const failing = await detectVaultMcp({ vaultMcpPath: root }, { run: vi.fn().mockRejectedValue(new Error('No module named vault_mcp.web_ui')), which: noUv });
    expect(failing).toEqual({ ok: false, reason: `vault-mcp at ${root} has no standalone mode. Update it (git pull).` });
    const other = await detectVaultMcp({ vaultMcpPath: root }, { run: vi.fn().mockResolvedValue('usage: ...'), which: noUv });
    expect(other.ok).toBe(false);
  });

  it('configured path that does not exist is reported', async () => {
    const r = await detectVaultMcp({ vaultMcpPath: join(tmpdir(), 'no-such-vault-mcp') }, { run: vi.fn(), which: uvAt('uvx') });
    expect(r).toEqual({ ok: false, reason: `vault-mcp not found at ${join(tmpdir(), 'no-such-vault-mcp')}. Fix vaultMcpPath in settings.` });
  });
});

describe('detectVaultMcp: uvx', () => {
  it('falls back to the pinned commit without releases or cache', async () => {
    const run = vi.fn().mockResolvedValue(OK);
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, { run, which: uvAt('C:/uv/uvx.exe'), fetchLatest: noReleases, stateFile: stateFile() });
    expect(r).toMatchObject({ ok: true, source: 'uvx', ref: VAULT_MCP_SHA, command: ['C:/uv/uvx.exe', '--from', archive(VAULT_MCP_SHA), 'vault-mcp-web-ui'] });
    if (r.ok) expect(r.env.PYTHONPATH).toBeUndefined();
    expect(run.mock.calls[0][2].env.PYTHONPATH).toBeUndefined();
  });

  it('uses the latest vault-mcp release', async () => {
    const file = stateFile();
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, { run: vi.fn().mockResolvedValue(OK), which: uvAt('uvx'), fetchLatest: async () => 'v0.2.0', stateFile: file });
    expect(r.ok && r.ref).toBe('v0.2.0');
    expect(r.ok && r.command[2]).toBe(archive('v0.2.0'));
    expect(JSON.parse(readFileSync(file, 'utf8')).lastGood).toBe('v0.2.0');
  });

  it('falls back to the last good version when the latest fails its check', async () => {
    const file = stateFile();
    writeFileSync(file, JSON.stringify({ lastGood: 'v0.2.0' }));
    const run = vi.fn(async (_cmd: string, args: string[]) => (args.includes(archive('v0.3.0')) ? 'usage: nope' : OK));
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, { run, which: uvAt('uvx'), fetchLatest: async () => 'v0.3.0', stateFile: file });
    expect(r.ok && r.ref).toBe('v0.2.0');
  });

  it('uses the cache when GitHub is unreachable', async () => {
    const file = stateFile();
    writeFileSync(file, JSON.stringify({ lastGood: 'v0.2.0' }));
    const r = await detectVaultMcp(
      { vaultMcpSource: 'uvx' },
      { run: vi.fn().mockResolvedValue(OK), which: uvAt('uvx'), fetchLatest: () => Promise.reject(new Error('offline')), stateFile: file },
    );
    expect(r.ok && r.ref).toBe('v0.2.0');
  });

  it('does not ask GitHub again within 4 hours', async () => {
    const file = stateFile();
    const now = 1_000_000_000_000;
    writeFileSync(file, JSON.stringify({ latest: { tag: 'v0.2.0', checkedAt: now - 60 * 60_000 }, lastGood: 'v0.2.0' }));
    const fetchLatest = vi.fn(async () => 'v9.9.9');
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, { run: vi.fn().mockResolvedValue(OK), which: uvAt('uvx'), fetchLatest, stateFile: file, now: () => now });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(r.ok && r.ref).toBe('v0.2.0');
    const later = await detectVaultMcp({ vaultMcpSource: 'uvx' }, { run: vi.fn().mockResolvedValue(OK), which: uvAt('uvx'), fetchLatest, stateFile: file, now: () => now + 5 * 60 * 60_000 });
    expect(fetchLatest).toHaveBeenCalledOnce();
    expect(later.ok && later.ref).toBe('v9.9.9');
  });

  it('vaultMcpRef wins and skips the lookup', async () => {
    const fetchLatest = vi.fn(async () => 'v0.2.0');
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx', vaultMcpRef: 'v0.1.5' }, { run: vi.fn().mockResolvedValue(OK), which: uvAt('uvx'), fetchLatest, stateFile: stateFile() });
    expect(r.ok && r.command[2]).toBe(archive('v0.1.5'));
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("source 'uvx' forces uvx even with a checkout", async () => {
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx', vaultMcpPath: checkout() }, { run: vi.fn().mockResolvedValue(OK), which: uvAt('uvx'), fetchLatest: noReleases, stateFile: stateFile() });
    expect(r.ok && r.source).toBe('uvx');
  });

  it('uvx mode uses long timeouts', async () => {
    const run = vi.fn().mockResolvedValue(OK);
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, { run, which: uvAt('uvx'), fetchLatest: noReleases, stateFile: stateFile() });
    expect(r.ok && r.startTimeoutMs).toBe(300_000);
    expect(r.ok && r.firstRunHint).toBe('Preparing Vault (first run downloads vault-mcp)…');
    expect(run.mock.calls[0][2].timeoutMs).toBe(300_000);
  });

  it('unavailable without uv or checkout', async () => {
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, { run: vi.fn(), which: noUv, fetchLatest: noReleases });
    expect(r).toEqual({ ok: false, reason: 'Vault needs uv (https://docs.astral.sh/uv/) or a vault-mcp checkout (vaultMcpPath).' });
  });
});
