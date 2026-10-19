import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvInfo } from '../src/shared/types';
import type { ToolContext } from '../src/main/tools/tool';
import { VaultTool, vaultProcessEnv } from '../src/main/tools/vault';
import { freePort } from '../src/main/radar';
import type { VaultMcpReady } from '../src/main/vault-mcp';

const fixture = join(__dirname, 'fixtures', 'fake-vault-ui.mjs');
const fixtureLauncher = (extra: Partial<VaultMcpReady> = {}): VaultMcpReady => ({
  ok: true,
  source: 'uvx',
  command: [process.execPath, fixture],
  env: {},
  startTimeoutMs: 60_000,
  ...extra,
});
const tools: VaultTool[] = [];
const blockers: Server[] = [];
afterEach(() => {
  tools.splice(0).forEach((t) => t.stop());
  blockers.splice(0).forEach((b) => b.close());
});

async function makeTool(extraEnv: Record<string, string>, port?: number, launcher = fixtureLauncher()) {
  const vaultPort = port ?? (await freePort());
  const info: EnvInfo = { name: 'dev', label: 'DEV', color: '#1f8f4e', profile: 'dev', context: 'acme-dev', clusterName: 'acme-dev', port: 1, vaultPort };
  const steps: (string | undefined)[] = [];
  const ctx: ToolContext = {
    env: info,
    credentialEnv: () => ({ ...process.env, ...extraEnv }),
    kubeconfig: () => '',
    settings: {},
    binaries: {},
    onChange: () => steps.push(tool.state.step),
    emit: () => {},
    vault: {
      mcp: launcher,
      config: { env: 'dev', addr: 'https://vault.internal.dev.example', header: 'h', role: 'r', region: 'us-west-2', port: vaultPort },
    },
  };
  const tool = new VaultTool(ctx);
  tools.push(tool);
  return { tool, port: vaultPort, steps };
}

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

describe('VaultTool', () => {
  it('starts and reports signed in', async () => {
    const { tool, port } = await makeTool({ FAKE_VAULT_STATE: 'authenticated' });
    await tool.start();
    expect(tool.state.status).toBe('ready');
    expect(tool.state.url).toBe(`http://127.0.0.1:${port}/`);
    await waitFor(() => !!tool.state.health);
    expect(tool.state.health).toEqual({ state: 'ok', text: 'Vault signed in' });
  });

  it('shows the first-run hint while starting', async () => {
    const { tool, steps } = await makeTool({}, undefined, fixtureLauncher({ firstRunHint: 'Preparing Vault (first run downloads vault-mcp)…' }));
    await tool.start();
    expect(steps).toContain('Preparing Vault (first run downloads vault-mcp)…');
  });

  it('reports a pending sign-in right after start', async () => {
    const { tool } = await makeTool({ FAKE_VAULT_STATE: 'unauthenticated' });
    await tool.start();
    await waitFor(() => !!tool.state.health);
    expect(tool.state.health).toEqual({ state: 'pending', text: 'Signing in to Vault' });
  });

  it('treats an unreachable UI right after start as starting', async () => {
    const { tool } = await makeTool({ FAKE_VAULT_STATE: 'authenticated', FAKE_VAULT_READY_EARLY: '1' });
    await tool.start();
    expect(tool.state.health).toEqual({ state: 'pending', text: 'Starting Vault' });
  });

  it('renewal signs Vault in again', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'vault-log-')), 'requests.log');
    const { tool } = await makeTool({ FAKE_VAULT_STATE: 'unauthenticated', FAKE_VAULT_LOGIN_FIXES: '1', FAKE_VAULT_LOG: log });
    await tool.start();
    await tool.onCredentialsRenewed();
    expect(existsSync(log) && readFileSync(log, 'utf8')).toContain('POST /api/login {"environment":"dev"}');
    expect(tool.state.health).toEqual({ state: 'ok', text: 'Vault signed in' });
  });

  it('busy port is reported', async () => {
    const port = await freePort();
    const blocker = createServer().listen(port, '127.0.0.1');
    blockers.push(blocker);
    await new Promise((r) => blocker.once('listening', r));
    const { tool } = await makeTool({}, port);
    await tool.start();
    expect(tool.state.status).toBe('error');
    expect(tool.state.message).toContain(`Port ${port} is already in use`);
  });
});

describe('vaultProcessEnv', () => {
  it('vault host is excluded from the proxy', () => {
    const env = vaultProcessEnv(
      { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost', PYTHONPATH: 'J:/elsewhere' },
      { ok: true, source: 'checkout', command: ['py', '-m', 'vault_mcp.web_ui'], cwd: 'K:/MCP/vault-mcp', env: { PYTHONPATH: join('K:/MCP/vault-mcp', 'src') }, startTimeoutMs: 60_000 },
      { env: 'dev', addr: 'https://vault.internal.dev.example:8200', header: 'vault.dev.example', role: 'vault_admin', region: 'us-west-2', port: 9291 },
      'acme-dev',
    );
    for (const key of ['NO_PROXY', 'no_proxy']) {
      expect(env[key]?.split(',')).toEqual(expect.arrayContaining(['localhost', 'vault.internal.dev.example']));
    }
    expect(env.PYTHONPATH).toBe(join('K:/MCP/vault-mcp', 'src'));
    expect(env.VAULT_MCP_AWS_CREDENTIALS).toBe('ambient');
    expect(env.VAULT_ADDR_DEV).toBe('https://vault.internal.dev.example:8200');
    expect(env.VAULT_HEADER_DEV).toBe('vault.dev.example');
    expect(env.VAULT_ROLE_DEV).toBe('vault_admin');
    expect(env.AWS_REGION_DEV).toBe('us-west-2');
    expect(env.K8S_CONTEXT_DEV).toBe('acme-dev');
    expect(env.INHERIT_NETWORK_PROXY_FROM_SHELL).toBe('false');
  });
});
