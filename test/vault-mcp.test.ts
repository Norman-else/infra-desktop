import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detectVaultMcp } from '../src/main/vault-mcp';

const venvPython = (root: string) => join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'vault-mcp-'));
  const py = venvPython(root);
  mkdirSync(join(py, '..'), { recursive: true });
  writeFileSync(py, '');
  return root;
}

describe('detectVaultMcp', () => {
  it('not found when the path is missing', async () => {
    const r = await detectVaultMcp({ vaultMcpPath: join(tmpdir(), 'no-such-vault-mcp') }, vi.fn());
    expect(r).toEqual({ ok: false, reason: 'vault-mcp not found. Set vaultMcpPath in settings.' });
  });

  it('not found when python is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vault-mcp-'));
    const r = await detectVaultMcp({ vaultMcpPath: root }, vi.fn());
    expect(r.ok).toBe(false);
  });

  it('too old when --version fails or prints something else', async () => {
    const root = checkout();
    const failing = await detectVaultMcp({ vaultMcpPath: root }, vi.fn().mockRejectedValue(new Error('No module named vault_mcp.web_ui')));
    expect(failing).toEqual({ ok: false, reason: `vault-mcp at ${root} has no standalone mode. Update it (git pull).` });
    const other = await detectVaultMcp({ vaultMcpPath: root }, vi.fn().mockResolvedValue('usage: ...'));
    expect(other.ok).toBe(false);
  });

  it('ok with the capability line', async () => {
    const root = checkout();
    const run = vi.fn().mockResolvedValue('vault-mcp-web-ui standalone 1\r\n');
    const r = await detectVaultMcp({ vaultMcpPath: root }, run);
    expect(r).toEqual({ ok: true, root, python: venvPython(root) });
    const [cmd, args, opts] = run.mock.calls[0];
    expect(cmd).toBe(venvPython(root));
    expect(args).toEqual(['-m', 'vault_mcp.web_ui', '--version']);
    expect(opts.env.PYTHONPATH).toBe(join(root, 'src'));
  });
});
