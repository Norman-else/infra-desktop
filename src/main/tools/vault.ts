import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolHealth, ToolState } from '../../shared/types';
import type { VaultEnvConfig } from '../vault-config';
import { reclaimPort } from '../orphans';
import { killTree, treeSpawnOptions } from '../process-tree';
import { portFree } from '../radar';
import { vaultMcpEnv, type VaultMcpReady } from '../vault-mcp';
import type { Tool, ToolContext } from './tool';

const READY_LINE = /VAULT_WEB_UI_READY (\S+)/;
/** After a (re-)login, "unauthenticated" means "still signing in" for this long. */
const SIGN_IN_GRACE_MS = 45_000;

/** Process env for vault-mcp's standalone UI on top of the env's isolated credential env. */
export function vaultProcessEnv(base: NodeJS.ProcessEnv, mcp: VaultMcpReady, config: VaultEnvConfig, kubeContext: string): NodeJS.ProcessEnv {
  const env = vaultMcpEnv(mcp.env, base);
  const E = config.env.toUpperCase();
  Object.assign(env, {
    VAULT_MCP_AWS_CREDENTIALS: 'ambient',
    // Don't pull proxy settings from a login shell: the internal Vault must be reached directly.
    INHERIT_NETWORK_PROXY_FROM_SHELL: 'false',
    [`K8S_CONTEXT_${E}`]: kubeContext,
  });
  const set = (key: string, value?: string) => value && (env[key] = value);
  set(`VAULT_ADDR_${E}`, config.addr);
  set(`VAULT_HEADER_${E}`, config.header);
  set(`VAULT_ROLE_${E}`, config.role);
  set(`AWS_REGION_${E}`, config.region);
  // Other envs' Vault web UIs on this machine; vault-mcp asks them for key fingerprints only.
  set('VAULT_MCP_PEERS', Object.entries(config.peers ?? {}).map(([name, port]) => `${name}=http://127.0.0.1:${port}`).join(','));
  if (config.addr) {
    // A proxy inherited from elsewhere (e.g. Claude's environment) can't reach the internal Vault.
    const host = new URL(config.addr).hostname;
    const list = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.includes(host)) list.push(host);
    env.NO_PROXY = env.no_proxy = list.join(',');
  }
  return env;
}

/** vault-mcp's /api/health → short label; "unauthenticated" is pending while a sign-in may still be running. */
export function vaultHealth(body: { vault?: string; message?: string }, sinceLoginMs: number): ToolHealth {
  if (body.vault === 'authenticated') return { state: 'ok', text: 'Vault signed in' };
  if (body.vault === 'error') return { state: 'failed', text: 'Vault error', detail: body.message };
  if (sinceLoginMs < SIGN_IN_GRACE_MS) return { state: 'pending', text: 'Signing in to Vault' };
  return { state: 'failed', text: 'Vault sign-in failed', detail: body.message };
}

export class VaultTool implements Tool {
  readonly kind = 'vault' as const;
  state: ToolState = { status: 'stopped' };
  private child?: ChildProcess;
  private log: string[] = [];
  private healthTimer?: NodeJS.Timeout;
  private loginAt = 0;
  /** Bumped by each start() and stop(), so a start that was superseded while waiting gives up. */
  private generation = 0;

  constructor(private ctx: ToolContext) {}

  private update(patch: Partial<ToolState>) {
    Object.assign(this.state, patch);
    this.ctx.onChange();
  }

  private fail(message: string) {
    clearTimeout(this.healthTimer);
    const child = this.child;
    this.child = undefined;
    if (child) killTree(child);
    this.state = { status: 'error', message, logTail: this.log.slice(-40) };
    this.ctx.onChange();
  }

  async start(): Promise<void> {
    const restarting = !!this.child;
    this.stop();
    const generation = this.generation;
    const vault = this.ctx.vault;
    if (!vault) return this.fail('Vault is not configured for this environment.');
    const { mcp, config } = vault;
    this.log = [];
    this.state = { status: 'starting', step: mcp.firstRunHint ?? 'Starting Vault…' };
    this.ctx.onChange();

    try {
      // The env's kubeconfig and AWS config files, which the credential env points at (kubectl in the UI uses them).
      this.ctx.kubeconfig();
    } catch (e) {
      return this.fail(`Could not write kubeconfig: ${(e as Error).message}`);
    }
    // On a restart the Vault just stopped can hold the port while it exits; give it a few seconds.
    for (let i = 0; restarting && i < 50 && !(await portFree(config.port)); i++) await new Promise((r) => setTimeout(r, 200));
    // vault-mcp left running after the app ended (its uvx gone) still holds the port: kill it.
    // Any other listener is left alone, and vault-mcp reports the port as in use.
    if (!(await portFree(config.port))) await reclaimPort('vault', config.port);
    if (this.generation !== generation) return;
    const command = mcp.command;
    const args = [...command.slice(1), '--env', config.env, '--port', String(config.port), '--host', '127.0.0.1'];
    const child = spawn(command[0], args, {
      ...treeSpawnOptions,
      cwd: mcp.cwd,
      env: vaultProcessEnv(this.ctx.credentialEnv(), mcp, config, this.ctx.env.context),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.loginAt = Date.now();

    const url = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), mcp.startTimeoutMs);
      const onLine = (d: Buffer) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.log.push(line);
          const m = READY_LINE.exec(line);
          if (m) {
            clearTimeout(timer);
            resolve(m[1].endsWith('/') ? m[1] : `${m[1]}/`);
          }
        }
        if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
      };
      child.stdout!.on('data', onLine);
      child.stderr!.on('data', onLine);
      child.on('error', (e) => {
        this.log.push(`Could not start vault-mcp: ${e.message}`);
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(undefined);
        if (this.child === child && this.state.status === 'ready') this.fail(`Vault web UI exited unexpectedly (code ${code})`);
      });
    });
    if (this.child !== child) return;
    if (!url) {
      const portBusy = this.log.find((l) => /already in use/i.test(l));
      return this.fail(portBusy ?? (child.exitCode !== null ? `Vault web UI exited (code ${child.exitCode})` : 'Timed out waiting for the Vault web UI to start'));
    }
    this.update({ status: 'ready', step: undefined, url });
    await this.checkHealth();
  }

  stop(): void {
    this.generation++;
    clearTimeout(this.healthTimer);
    const child = this.child;
    this.child = undefined;
    if (child) killTree(child);
    if (this.state.status !== 'stopped') this.state = { status: 'stopped' };
  }

  /** New AWS credentials: have vault-mcp sign in to Vault again with them. */
  async onCredentialsRenewed(): Promise<void> {
    if (this.state.status !== 'ready' || !this.state.url || !this.ctx.vault) return;
    this.loginAt = Date.now();
    try {
      await fetch(`${this.state.url}api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ environment: this.ctx.vault.config.env }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      /* the health check reports the outcome */
    }
    await this.checkHealth();
  }

  private async checkHealth(): Promise<void> {
    clearTimeout(this.healthTimer);
    const url = this.state.url;
    if (!url || this.state.status !== 'ready') return;
    let health: ToolHealth;
    try {
      const res = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(5000) });
      health = vaultHealth((await res.json()) as { vault?: string; message?: string }, Date.now() - this.loginAt);
    } catch (e) {
      // vault-mcp prints its ready line just before its server accepts connections.
      health =
        Date.now() - this.loginAt < SIGN_IN_GRACE_MS
          ? { state: 'pending', text: 'Starting Vault' }
          : { state: 'failed', text: 'Vault UI not responding', detail: (e as Error).message };
    }
    if (this.state.url !== url) return;
    if (JSON.stringify(health) !== JSON.stringify(this.state.health)) this.update({ health });
    this.healthTimer = setTimeout(() => void this.checkHealth(), health.state === 'ok' ? 15_000 : 5_000);
  }
}
