import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';

/** Whether 127.0.0.1:port can be bound right now. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

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
  /** Fixed port; a random free one when 0 */
  port: number;
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
    if (this.o.port && !(await portFree(this.o.port)))
      throw new Error(`Port ${this.o.port} is already in use (is radar already running in a terminal?). Stop it or set a different "port" for this environment in settings.`);
    this.port = this.o.port || (await freePort());
    const args = ['-no-browser', '-listen-address', '127.0.0.1', '-port', String(this.port), '-kubeconfig', this.o.kubeconfig, ...this.o.extraArgs];
    this.child = spawn(this.o.radarPath, args, { env: this.o.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const push = (d: Buffer) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) this.log.push(line);
      if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    };
    this.child.stdout!.on('data', push);
    this.child.stderr!.on('data', push);
    this.child.on('error', (e) => this.log.push(`Could not start radar: ${e.message}`));
    this.child.on('exit', (code) => {
      if (!this.stopped) this.o.onExit(code, this.log);
    });
  }

  /** Resolves once radar's HTTP server answers. */
  async waitReady(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopped || !this.child || this.child.exitCode !== null) throw new Error('radar exited');
      try {
        const res = await fetch(this.url, { signal: AbortSignal.timeout(2000) });
        if (res.status < 500) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('Timed out waiting for radar to start');
  }

  stop(): void {
    this.stopped = true;
    if (this.child && this.child.exitCode === null) this.child.kill();
  }
}
