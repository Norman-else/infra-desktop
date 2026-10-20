import type { ToolHealth, ToolState } from '../../shared/types';
import { RadarProcess } from '../radar';
import type { Tool, ToolContext } from './tool';

const ERROR_LABELS: Record<string, string> = {
  'auth-rejected': 'Auth rejected',
  unreachable: 'Cluster unreachable',
  timeout: 'Timed out',
  forbidden: 'Forbidden',
};

/** radar's /api/connection answer → short health label. */
export function radarHealth(body: { state?: string; error?: string; errorType?: string }): ToolHealth {
  if (body.state === 'connected') return { state: 'ok', text: 'Cluster connected' };
  if (body.state === 'connecting') return { state: 'pending', text: 'Connecting to cluster' };
  const text = (body.errorType && ERROR_LABELS[body.errorType]) ?? body.errorType ?? 'Cluster error';
  return { state: 'failed', text, detail: body.error || undefined };
}

/** How long a renewal waits for radar to reconnect, how often it polls, and how often it re-asks for a retry. */
const RECOVER_TIMEOUT_MS = 60_000;
const POLL_MS = 1000;
const RETRY_EVERY_MS = 5000;

/** A function, so TS doesn't keep the health narrowed from before an await. */
const healthy = (t: RadarTool) => t.state.health?.state === 'ok';

export class RadarTool implements Tool {
  readonly kind = 'radar' as const;
  state: ToolState = { status: 'stopped' };
  private radar?: RadarProcess;
  private healthTimer?: NodeJS.Timeout;

  constructor(private ctx: ToolContext) {}

  private update(patch: Partial<ToolState>) {
    Object.assign(this.state, patch);
    this.ctx.onChange();
  }

  private fail(message: string, logTail?: string[]) {
    clearTimeout(this.healthTimer);
    this.radar?.stop();
    this.radar = undefined;
    this.state = { status: 'error', message, logTail };
    this.ctx.onChange();
  }

  async start(): Promise<void> {
    this.stop();
    const command = this.ctx.binaries.radar;
    if (!command) return this.fail('radar (kubectl-radar) not found. Install it or set radarPath in settings.');
    this.state = { status: 'starting', step: 'Starting radar…' };
    this.ctx.onChange();

    let kubeconfig: string;
    try {
      kubeconfig = this.ctx.kubeconfig();
    } catch (e) {
      return this.fail(`Could not write kubeconfig: ${(e as Error).message}`);
    }
    const radar = new RadarProcess({
      command,
      kubeconfig,
      env: this.ctx.credentialEnv(),
      extraArgs: this.ctx.settings.radarArgs ?? [],
      port: this.ctx.env.port,
      onExit: (code, log) => {
        if (this.radar === radar) this.fail(`radar exited unexpectedly (code ${code})`, log.slice(-40));
      },
    });
    this.radar = radar;
    try {
      await radar.start();
      this.update({ step: 'Waiting for radar…' });
      await radar.waitReady();
    } catch (e) {
      if (this.radar === radar) this.fail((e as Error).message, radar.log.slice(-40));
      return;
    }
    if (this.radar !== radar) return;
    this.update({ status: 'ready', step: undefined, url: radar.url });
    await this.checkHealth();
  }

  stop(): void {
    clearTimeout(this.healthTimer);
    const radar = this.radar;
    this.radar = undefined;
    radar?.stop();
    if (this.state.status !== 'stopped') this.state = { status: 'stopped' };
  }

  /**
   * After new credentials, get radar back onto the cluster if it lost it (e.g. they had expired). Radar's own
   * reconnect loop backs off up to minutes, and its error page stops retrying while credentials are bad.
   */
  async onCredentialsRenewed(): Promise<void> {
    const radar = this.radar;
    if (!radar || this.state.status !== 'ready') return;
    // The cached health can be a poll old; radar may have dropped the cluster since.
    await this.checkHealth();
    if (this.radar !== radar || this.state.health?.state === 'ok') return;
    const deadline = Date.now() + RECOVER_TIMEOUT_MS;
    let lastRetry = -Infinity;
    while (this.radar === radar && Date.now() < deadline) {
      // Down (not already reconnecting): ask for a retry, again every few seconds, since one can be refused
      // while radar's own reconnect is in flight.
      if (this.state.health?.state === 'failed' && Date.now() - lastRetry >= RETRY_EVERY_MS) {
        lastRetry = Date.now();
        this.update({ health: { state: 'pending', text: 'Connecting to cluster' } });
        try {
          await fetch(`${radar.url}api/connection/retry`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
        } catch {
          /* the health check below reports the outcome */
        }
      }
      await this.checkHealth();
      if (healthy(this)) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    // Its page may still show the error screen; reload it once the cluster is back.
    if (this.radar === radar && healthy(this)) this.ctx.emit('reload-view');
  }

  /** Ask radar whether it can actually reach the cluster; credentials being valid doesn't mean it can. */
  private async checkHealth(): Promise<void> {
    clearTimeout(this.healthTimer);
    const radar = this.radar;
    if (!radar || this.state.status !== 'ready') return;
    let health: ToolHealth;
    try {
      const res = await fetch(`${radar.url}api/connection?contexts=0`, { signal: AbortSignal.timeout(5000) });
      health = radarHealth((await res.json()) as { state?: string; error?: string; errorType?: string });
    } catch (e) {
      health = { state: 'failed', text: 'Radar not responding', detail: (e as Error).message };
    }
    if (this.radar !== radar) return;
    if (JSON.stringify(health) !== JSON.stringify(this.state.health)) this.update({ health });
    this.healthTimer = setTimeout(() => void this.checkHealth(), health.state === 'ok' ? 15_000 : 5_000);
  }
}
