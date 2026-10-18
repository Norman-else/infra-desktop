import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

export interface RadarOptions {
  radarPath: string;
  kubeconfig: string;
  env: NodeJS.ProcessEnv;
  extraArgs: string[];
  onExit: (code: number | null, log: string[]) => void;
}

export class RadarProcess {
  readonly log: string[] = [];
  port = 0;
  private child?: ChildProcess;
  private stopped = false;

  constructor(private o: RadarOptions) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  async start(): Promise<void> {
    this.port = await freePort();
    const args = ['-no-browser', '-listen-address', '127.0.0.1', '-port', String(this.port), '-kubeconfig', this.o.kubeconfig, ...this.o.extraArgs];
    this.child = spawn(this.o.radarPath, args, { env: this.o.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const push = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) this.log.push(line);
      if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    };
    this.child.stdout!.on('data', push);
    this.child.stderr!.on('data', push);
    this.child.on('error', (e) => this.log.push(`无法启动 radar: ${e.message}`));
    this.child.on('exit', (code) => {
      if (!this.stopped) this.o.onExit(code, this.log);
    });
  }

  /** Resolves once radar's HTTP server answers. */
  async waitReady(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopped || !this.child || this.child.exitCode !== null) throw new Error('radar 进程已退出');
      try {
        const res = await fetch(this.url, { signal: AbortSignal.timeout(2000) });
        if (res.status < 500) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('等待 radar 启动超时');
  }

  stop(): void {
    this.stopped = true;
    if (this.child && this.child.exitCode === null) this.child.kill();
  }
}
