import { execFile, spawnSync } from 'node:child_process';
import { portFree } from './radar';

/** One running process, as much as the OS tells us. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Image name, e.g. vault-mcp-web-ui.exe */
  name: string;
  commandLine: string;
  executablePath?: string;
  /** Start time (any monotonic unit); used to spot a parent PID that was reused. */
  created?: number;
}

export type OrphanKind = 'radar' | 'vault';

export interface ReclaimDeps {
  /** PID listening on 127.0.0.1:port, if any */
  listenerPid(port: number): Promise<number | undefined>;
  listProcesses(): Promise<ProcInfo[]>;
  /** Kill pid and everything below it (by PID only) */
  killTree(pid: number, procs: ProcInfo[]): void;
  portFree(port: number): Promise<boolean>;
}

const UV_CACHE = /[\\/](uv[\\/]cache|\.cache[\\/]uv)[\\/]/i;
/** The vault-mcp-web-ui entry point as a path (not uvx's bare `vault-mcp-web-ui` argument). */
const VAULT_ENTRY = /(^|[\\/])vault-mcp-web-ui(\.exe)?"?(\s|$)/i;
const baseName = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
const hasPort = (cmd: string, flag: RegExp, port: number) => new RegExp(`(^|\\s)${flag.source}[\\s=]"?${port}"?(\\s|$)`).test(cmd);

/** Whether proc is one of the app's own tool processes serving this port. */
export function isToolProcess(kind: OrphanKind, port: number, p: ProcInfo): boolean {
  if (kind === 'vault')
    return (
      (baseName(p.name) === 'vault-mcp-web-ui' || VAULT_ENTRY.test(p.commandLine)) &&
      UV_CACHE.test(`${p.executablePath ?? ''} ${p.commandLine}`) &&
      hasPort(p.commandLine, /--port/, port)
    );
  return ['kubectl-radar', 'radar'].includes(baseName(p.name)) && hasPort(p.commandLine, /--?port/, port);
}

/** uvx.exe / uv.exe running vault-mcp-web-ui for this port. */
const isUvLauncher = (port: number, p: ProcInfo) =>
  ['uv', 'uvx'].includes(baseName(p.name)) && /\svault-mcp-web-ui\s/.test(p.commandLine) && hasPort(p.commandLine, /--port/, port);

/**
 * If the port's listener belongs to a tool process this app started whose launcher (uvx, or the app itself)
 * is gone, the PID whose tree should be killed. Anything else (another app, a radar run in a terminal) → undefined.
 */
export function findOrphanRoot(kind: OrphanKind, port: number, listenerPid: number, procs: ProcInfo[]): number | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  // Its parent, unless that PID now belongs to a process that started later (the real parent is gone).
  const parentOf = (p: ProcInfo) => {
    const parent = byPid.get(p.ppid);
    return parent && !(parent.created !== undefined && p.created !== undefined && parent.created > p.created) ? parent : undefined;
  };
  // The listener and its ancestors (vault: python.exe → python.exe → vault-mcp-web-ui.exe → uv.exe → uvx.exe).
  const chain: ProcInfo[] = [];
  for (let p = byPid.get(listenerPid); p && !chain.includes(p); p = parentOf(p)) chain.push(p);
  // The topmost match: vault's python children carry the same command line as vault-mcp-web-ui.exe.
  let i = chain.length - 1;
  while (i >= 0 && !isToolProcess(kind, port, chain[i])) i--;
  if (i < 0) return undefined;
  // Vault: uvx runs vault-mcp-web-ui through uv.exe; a surviving uv/uvx for this port is part of the tree.
  while (kind === 'vault' && chain[i + 1] && isUvLauncher(port, chain[i + 1])) i++;
  const root = chain[i];
  return parentOf(root) ? undefined : root.pid;
}

/**
 * The fixed port is busy: if one of our own orphaned tool processes holds it (e.g. left over when an update
 * install ended the app), kill that tree by PID and wait for the port. Resolves whether the port is free now.
 */
export async function reclaimPort(kind: OrphanKind, port: number, deps: ReclaimDeps = defaultDeps): Promise<boolean> {
  try {
    const pid = await deps.listenerPid(port);
    if (!pid) return deps.portFree(port);
    const procs = await deps.listProcesses();
    const root = findOrphanRoot(kind, port, pid, procs);
    if (root === undefined) return false;
    deps.killTree(root, procs);
    for (let i = 0; i < 50; i++) {
      if (await deps.portFree(port)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch {
    /* can't tell: leave the port alone */
  }
  return false;
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
  );
const powershell = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

const defaultDeps: ReclaimDeps = {
  async listenerPid(port) {
    const out =
      process.platform === 'win32'
        ? await powershell(`(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`)
        : await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).catch(() => '');
    const pid = Number(out.trim().split(/\s+/)[0]);
    return pid > 0 ? pid : undefined;
  },
  async listProcesses() {
    if (process.platform === 'win32') {
      const json = await powershell(
        `@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,@{n='Created';e={$_.CreationDate.ToFileTimeUtc()}}) | ConvertTo-Json -Compress`,
      );
      const rows = JSON.parse(json) as { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null; ExecutablePath: string | null; Created: number | null }[];
      return rows.map((r) => ({
        pid: r.ProcessId,
        ppid: r.ParentProcessId,
        name: r.Name,
        commandLine: r.CommandLine ?? '',
        executablePath: r.ExecutablePath ?? undefined,
        created: r.Created ?? undefined,
      }));
    }
    // POSIX: an orphan is reparented to init/launchd (pid 1), which never matches as its launcher.
    const out = await run('ps', ['-A', '-o', 'pid=,ppid=,args=']);
    return out
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid) === 1 ? 0 : Number(ppid), name: args.split(' ')[0], commandLine: args, executablePath: args.split(' ')[0] }));
  },
  killTree(pid, procs) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    const tree = [pid];
    for (let i = 0; i < tree.length; i++) for (const p of procs) if (p.ppid === tree[i] && !tree.includes(p.pid)) tree.push(p.pid);
    for (const p of tree.reverse()) {
      try {
        process.kill(p, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  },
  // Called lazily: radar.ts imports this module too.
  portFree: (port) => portFree(port),
};
