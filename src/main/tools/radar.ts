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
   * After new credentials, make radar retry right away if it lost the cluster (e.g. they had expired):
   * radar's own background re-check can take a long time, and its page waits for that.
   */
  async onCredentialsRenewed(): Promise<void> {
    const radar = this.radar;
    if (!radar || this.state.status !== 'ready') return;
    const wasDown = this.state.health?.state === 'failed';
    if (wasDown) {
      this.update({ health: { state: 'pending', text: 'Connecting to cluster' } });
      try {
        await fetch(`${radar.url}api/connection/retry`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
      } catch {
        /* the health check below reports the outcome */
      }
    }
    await this.checkHealth();
    // Its page may still show the error screen; reload it once the cluster is back.
    if (wasDown && this.state.health?.state === 'ok') this.ctx.emit('reload-view');
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
