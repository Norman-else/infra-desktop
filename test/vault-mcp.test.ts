import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detectVaultMcp, VAULT_MCP_SHA } from '../src/main/vault-mcp';

const venvPython = (root: string) => join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const OK = 'vault-mcp-web-ui standalone 1\r\n';
const noUv = () => undefined;
const uvAt = (path: string) => (names: string[]) => (names.includes('uvx') ? path : undefined);

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
    const r = await detectVaultMcp({ vaultMcpPath: root }, run, uvAt('C:/uv/uvx.exe'));
    expect(r).toMatchObject({ ok: true, source: 'checkout', command: [venvPython(root), '-m', 'vault_mcp.web_ui'], cwd: root, env: { PYTHONPATH: join(root, 'src') } });
    const [cmd, args, opts] = run.mock.calls[0];
    expect([cmd, ...args]).toEqual([venvPython(root), '-m', 'vault_mcp.web_ui', '--version']);
    expect(opts.env.PYTHONPATH).toBe(join(root, 'src'));
  });

  it('too old when --version fails or prints something else', async () => {
    const root = checkout();
    const failing = await detectVaultMcp({ vaultMcpPath: root }, vi.fn().mockRejectedValue(new Error('No module named vault_mcp.web_ui')), noUv);
    expect(failing).toEqual({ ok: false, reason: `vault-mcp at ${root} has no standalone mode. Update it (git pull).` });
    const other = await detectVaultMcp({ vaultMcpPath: root }, vi.fn().mockResolvedValue('usage: ...'), noUv);
    expect(other.ok).toBe(false);
  });

  it('configured path that does not exist is reported', async () => {
    const r = await detectVaultMcp({ vaultMcpPath: join(tmpdir(), 'no-such-vault-mcp') }, vi.fn(), uvAt('uvx'));
    expect(r).toEqual({ ok: false, reason: `vault-mcp not found at ${join(tmpdir(), 'no-such-vault-mcp')}. Fix vaultMcpPath in settings.` });
  });
});

describe('detectVaultMcp: uvx', () => {
  const archive = (ref: string) => `https://github.com/Norman-else/vault-mcp/archive/${ref}.zip`;

  it('uvx when there is no checkout', async () => {
    const run = vi.fn().mockResolvedValue(OK);
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, run, uvAt('C:/uv/uvx.exe'));
    expect(r).toMatchObject({ ok: true, source: 'uvx', command: ['C:/uv/uvx.exe', '--from', archive(VAULT_MCP_SHA), 'vault-mcp-web-ui'] });
    if (r.ok) expect(r.env.PYTHONPATH).toBeUndefined();
    expect(run.mock.calls[0][2].env.PYTHONPATH).toBeUndefined();
  });

  it('vaultMcpRef overrides the pinned sha', async () => {
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx', vaultMcpRef: 'v1.2.3' }, vi.fn().mockResolvedValue(OK), uvAt('uvx'));
    expect(r.ok && r.command[2]).toBe(archive('v1.2.3'));
  });

  it("source 'uvx' forces uvx even with a checkout", async () => {
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx', vaultMcpPath: checkout() }, vi.fn().mockResolvedValue(OK), uvAt('uvx'));
    expect(r.ok && r.source).toBe('uvx');
  });

  it('uvx mode uses long timeouts', async () => {
    const run = vi.fn().mockResolvedValue(OK);
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, run, uvAt('uvx'));
    expect(r.ok && r.startTimeoutMs).toBe(300_000);
    expect(r.ok && r.firstRunHint).toBe('Preparing Vault (first run downloads vault-mcp)…');
    expect(run.mock.calls[0][2].timeoutMs).toBe(300_000);
  });

  it('unavailable without uv or checkout', async () => {
    const r = await detectVaultMcp({ vaultMcpSource: 'uvx' }, vi.fn(), noUv);
    expect(r).toEqual({ ok: false, reason: 'Vault needs uv (https://docs.astral.sh/uv/) or a vault-mcp checkout (vaultMcpPath).' });
  });
});
