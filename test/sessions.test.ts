import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolKind, ToolState } from '../src/shared/types';
import type { Tool, ToolContext } from '../src/main/tools/tool';
import { EnvManager } from '../src/main/sessions';

const fake = join(__dirname, 'fake-aws-vault', process.platform === 'win32' ? 'fake-aws-vault.exe' : 'fake-aws-vault');
// Own fake aws-vault state per test file: files run in parallel workers.
process.env.FAKE_AWS_VAULT_DIR = mkdtempSync(join(tmpdir(), 'fake-aws-vault-'));
const session = join(process.env.FAKE_AWS_VAULT_DIR, 'fake-aws-vault-session');
const usedCodes = join(process.env.FAKE_AWS_VAULT_DIR, 'fake-aws-vault-used');

/** Records calls; `failNext` makes the next start end in error. */
class FakeTool implements Tool {
  state: ToolState = { status: 'stopped' };
  starts = 0;
  stops = 0;
  renewals = 0;
  failNext = false;
  constructor(readonly kind: ToolKind, private ctx: ToolContext) {}
  async start() {
    this.starts++;
    this.state = this.failNext ? { status: 'error', message: 'boom' } : { status: 'ready', url: `http://127.0.0.1:1/${this.kind}` };
    this.failNext = false;
    this.ctx.onChange();
  }
  stop() {
    this.stops++;
    this.state = { status: 'stopped' };
  }
  async onCredentialsRenewed() {
    this.renewals++;
  }
}

describe.skipIf(!existsSync(fake))('EnvManager with tools', () => {
  let dir: string;
  let manager: EnvManager;
  let made: Record<string, FakeTool>;
  const oldAwsConfig = process.env.AWS_CONFIG_FILE;

  beforeEach(async () => {
    rmSync(session, { force: true });
    rmSync(usedCodes, { force: true });
    dir = mkdtempSync(join(tmpdir(), 'sessions-'));
    writeFileSync(join(dir, 'aws-config'), '[default]\nregion = us-west-2\n[profile root]\n[profile dev]\nsource_profile = root\nrole_arn = arn:aws:iam::222222222222:role/ops\n');
    const cluster = 'arn:aws:eks:us-west-2:222222222222:cluster/acme-dev';
    writeFileSync(
      join(dir, 'kubeconfig'),
      YAML.stringify({
        contexts: [{ name: 'acme-dev', context: { cluster, user: cluster } }],
        clusters: [{ name: cluster, cluster: { server: 'https://example.invalid' } }],
        users: [{ name: cluster, user: {} }],
      }),
    );
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ awsVaultPath: fake, kubeconfig: join(dir, 'kubeconfig') }));
    process.env.AWS_CONFIG_FILE = join(dir, 'aws-config');
    made = {};
    manager = new EnvManager(dir, {
      radar: (ctx) => (made[`radar:${ctx.env.name}`] = new FakeTool('radar', ctx)),
      vault: (ctx) => (made[`vault:${ctx.env.name}`] = new FakeTool('vault', ctx)),
    }, {
      detectVault: async () => ({ ok: true, root: dir, python: 'python' }),
      claudeJsonPath: join(dir, 'claude.json'),
    });
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ mcpServers: { vault: { env: { VAULT_ADDR_DEV: 'https://vault.dev.example' } } } }));
    await manager.init();
    await manager.vaultReady();
  });

  afterEach(() => {
    manager.shutdown();
    process.env.AWS_CONFIG_FILE = oldAwsConfig;
  });

  const env = () => manager.getState().envs.find((e) => e.name === 'dev')!;
  const connectWithMfa = async () => {
    await manager.switchTo('dev');
    if (env().prompt === 'mfa') await manager.session('dev').submitMfa('123456');
  };

  it('connect obtains credentials and starts only the active tool', async () => {
    await connectWithMfa();
    expect(env().status).toBe('ready');
    expect(made['radar:dev']?.starts).toBe(1);
    expect(made['vault:dev']?.starts ?? 0).toBe(0);
    expect(env().tools.radar.status).toBe('ready');
  });

  it('starts the active tool after MFA completes', async () => {
    await manager.switchTo('dev');
    expect(env().prompt).toBe('mfa');
    expect(made['radar:dev']?.starts ?? 0).toBe(0);
    await manager.session('dev').submitMfa('123456');
    expect(made['radar:dev'].starts).toBe(1);
  });

  it('renewal notifies only ready tools', async () => {
    await connectWithMfa();
    manager.session('dev').state.credsExpiresAt = Date.now() - 1000; // force a real renewal
    manager.session('dev').renew();
    await manager.session('dev').submitMfa('234567');
    expect(made['radar:dev'].renewals).toBe(1);
    expect(made['vault:dev']?.renewals ?? 0).toBe(0);
  });

  it('tool failure keeps credentials and retry restarts the tool', async () => {
    await connectWithMfa();
    made['radar:dev'].failNext = true;
    await manager.session('dev').retryTool('radar');
    expect(env().status).toBe('ready');
    expect(env().tools.radar.status).toBe('error');
    await manager.session('dev').retryTool('radar');
    expect(env().tools.radar.status).toBe('ready');
    expect(env().prompt).toBeUndefined();
  });

  it('disconnect stops all tools', async () => {
    await connectWithMfa();
    await manager.session('dev').ensureTool('vault');
    manager.session('dev').disconnect();
    expect(made['radar:dev'].stops).toBeGreaterThan(0);
    expect(made['vault:dev'].stops).toBeGreaterThan(0);
    expect(env().status).toBe('idle');
  });

  it('switching tool starts it for the active env', async () => {
    await connectWithMfa();
    await manager.setTool('vault');
    expect(manager.activeTool).toBe('vault');
    expect(made['vault:dev'].starts).toBe(1);
    expect(manager.getState().activeTool).toBe('vault');
  });

  it('switching env keeps the active tool', async () => {
    await connectWithMfa();
    await manager.setTool('vault');
    manager.session('dev').disconnect();
    await manager.switchTo('dev');
    expect(manager.activeTool).toBe('vault');
  });
});

describe('EnvManager default tools', () => {
  it('ignores switching to an unavailable tool', async () => {
    const m = new EnvManager(mkdtempSync(join(tmpdir(), 'sessions-default-')), undefined, {
      detectVault: async () => ({ ok: false, reason: 'vault-mcp not found. Set vaultMcpPath in settings.' }),
    });
    await m.init();
    await m.setTool('vault');
    expect(m.activeTool).toBe('radar');
    expect(m.availability('vault')).toEqual({ available: false, reason: 'vault-mcp not found. Set vaultMcpPath in settings.' });
    m.shutdown();
  });
});

describe('Vault availability', () => {
  const setup = async (detect: () => Promise<import('../src/main/vault-mcp').VaultMcp>) => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-avail-'));
    const ctx = (acct: string, name: string) => {
      const arn = `arn:aws:eks:us-west-2:${acct}:cluster/${name}`;
      return { context: { name, context: { cluster: arn, user: arn } }, cluster: { name: arn, cluster: { server: 'https://x.invalid' } }, user: { name: arn, user: {} } };
    };
    const d = ctx('222222222222', 'acme-dev');
    const s = ctx('333333333333', 'acme-sat');
    writeFileSync(join(dir, 'kubeconfig'), YAML.stringify({ contexts: [d.context, s.context], clusters: [d.cluster, s.cluster], users: [d.user, s.user] }));
    writeFileSync(join(dir, 'aws-config'), '[default]\nregion = us-west-2\n[profile dev]\nrole_arn = arn:aws:iam::222222222222:role/ops\n[profile sat]\nrole_arn = arn:aws:iam::333333333333:role/ops\n');
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ mcpServers: { vault: { env: { VAULT_ADDR_DEV: 'https://vault.dev.example' } } } }));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ kubeconfig: join(dir, 'kubeconfig') }));
    const old = process.env.AWS_CONFIG_FILE;
    process.env.AWS_CONFIG_FILE = join(dir, 'aws-config');
    const m = new EnvManager(dir, undefined, { detectVault: detect, claudeJsonPath: join(dir, 'claude.json') });
    await m.init();
    await m.vaultReady();
    process.env.AWS_CONFIG_FILE = old;
    return m;
  };

  it('vault availability is per environment', async () => {
    const m = await setup(async () => ({ ok: true, root: tmpdir(), python: 'python' }));
    expect(m.availability('vault', 'dev')).toEqual({ available: true });
    expect(m.availability('vault', 'sat')).toEqual({ available: false, reason: 'No Vault address for SAT. Add it to the vault MCP server or settings.' });
    expect(m.getState().envs.find((e) => e.name === 'sat')!.tools.vault.available).toBe(false);
    m.shutdown();
  });

  it('vault unavailable when vault-mcp is missing', async () => {
    const m = await setup(async () => ({ ok: false, reason: 'vault-mcp not found. Set vaultMcpPath in settings.' }));
    expect(m.availability('vault', 'dev')).toEqual({ available: false, reason: 'vault-mcp not found. Set vaultMcpPath in settings.' });
    m.shutdown();
  });
});
