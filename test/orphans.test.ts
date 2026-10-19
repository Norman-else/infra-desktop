import { describe, expect, it, vi } from 'vitest';
import { findOrphanRoot, isToolProcess, reclaimPort, type ProcInfo, type ReclaimDeps } from '../src/main/orphans';

const CACHE = 'C:\\Users\\me\\AppData\\Local\\uv\\cache\\archive-v0\\abc\\Scripts';
const vaultExe = (port: number, ppid = 100): ProcInfo => ({
  pid: 200,
  ppid,
  name: 'vault-mcp-web-ui.exe',
  commandLine: `"${CACHE}\\vault-mcp-web-ui.exe" --env dev --port ${port} --host 127.0.0.1`,
  executablePath: `${CACHE}\\vault-mcp-web-ui.exe`,
  created: 20,
});
// vault-mcp-web-ui.exe -> python.exe -> python.exe (the listener), as uv's trampoline runs it.
const pythons: ProcInfo[] = [
  { pid: 201, ppid: 200, name: 'python.exe', commandLine: `"${CACHE}\\python.exe" "${CACHE}\\vault-mcp-web-ui.exe" --env dev --port 9291`, executablePath: `${CACHE}\\python.exe`, created: 21 },
  { pid: 202, ppid: 201, name: 'python.exe', commandLine: 'C:\\Python312\\python.exe', executablePath: 'C:\\Python312\\python.exe', created: 22 },
];
const uvx: ProcInfo = { pid: 100, ppid: 1, name: 'uvx.exe', commandLine: 'uvx --from https://github.com/x/archive/v1.zip vault-mcp-web-ui --env dev --port 9291', created: 10 };
const radar = (port: number, ppid = 50): ProcInfo => ({ pid: 300, ppid, name: 'kubectl-radar.exe', commandLine: `kubectl-radar.exe -no-browser -port ${port} -kubeconfig k.yaml`, created: 30 });

describe('isToolProcess', () => {
  it('matches vault-mcp-web-ui from the uv cache on the same port only', () => {
    expect(isToolProcess('vault', 9291, vaultExe(9291))).toBe(true);
    expect(isToolProcess('vault', 9291, vaultExe(9292))).toBe(false);
    expect(isToolProcess('vault', 9291, { ...vaultExe(9291), executablePath: 'C:\\tools\\vault-mcp-web-ui.exe', commandLine: 'vault-mcp-web-ui.exe --port 9291' })).toBe(false);
    expect(isToolProcess('vault', 9291, uvx)).toBe(false);
  });
  it('matches the macOS script entry point run by python', () => {
    const p: ProcInfo = { pid: 1, ppid: 0, name: '/Users/me/.cache/uv/archive-v0/x/bin/python', commandLine: '/Users/me/.cache/uv/archive-v0/x/bin/python /Users/me/.cache/uv/archive-v0/x/bin/vault-mcp-web-ui --env dev --port 9291' };
    expect(isToolProcess('vault', 9291, p)).toBe(true);
  });
  it('matches radar / kubectl-radar on the same port only', () => {
    expect(isToolProcess('radar', 9281, radar(9281))).toBe(true);
    expect(isToolProcess('radar', 9281, { ...radar(9281), name: 'radar' })).toBe(true);
    expect(isToolProcess('radar', 9281, radar(92810))).toBe(false);
    expect(isToolProcess('radar', 9281, { ...radar(9281), name: 'node.exe' })).toBe(false);
    expect(isToolProcess('vault', 9281, radar(9281))).toBe(false);
  });
});

describe('findOrphanRoot', () => {
  it('finds vault-mcp-web-ui above the listening python once uvx is gone', () => {
    expect(findOrphanRoot('vault', 9291, 202, [vaultExe(9291), ...pythons])).toBe(200);
  });
  it('leaves it alone while uvx and the app are still running', () => {
    const app: ProcInfo = { pid: 1, ppid: 0, name: 'Infra Desktop.exe', commandLine: 'Infra Desktop.exe', created: 1 };
    expect(findOrphanRoot('vault', 9291, 202, [app, uvx, vaultExe(9291), ...pythons])).toBeUndefined();
  });
  it('includes a surviving uv launcher whose own parent is gone', () => {
    const uv: ProcInfo = { pid: 150, ppid: 100, name: 'uv.exe', commandLine: '"uv.exe" tool uvx --from https://x/v1.zip vault-mcp-web-ui --env dev --port 9291 --host 127.0.0.1', created: 15 };
    expect(findOrphanRoot('vault', 9291, 202, [uv, vaultExe(9291, 150), ...pythons])).toBe(150);
    expect(findOrphanRoot('vault', 9291, 202, [{ ...uv, commandLine: uv.commandLine.replace('9291', '9292') }, vaultExe(9291, 150), ...pythons])).toBeUndefined();
  });
  it('treats a parent PID reused by a newer process as dead', () => {
    expect(findOrphanRoot('vault', 9291, 202, [{ ...uvx, created: 99 }, vaultExe(9291), ...pythons])).toBe(200);
  });
  it('ignores a listener that is not ours', () => {
    const other: ProcInfo = { pid: 400, ppid: 0, name: 'nginx.exe', commandLine: 'nginx --port 9291' };
    expect(findOrphanRoot('vault', 9291, 400, [other])).toBeUndefined();
    expect(findOrphanRoot('vault', 9291, 999, [])).toBeUndefined();
  });
  it('ignores our process serving a different port', () => {
    expect(findOrphanRoot('vault', 9291, 202, [vaultExe(9292), ...pythons])).toBeUndefined();
  });
  it('finds a radar whose app is gone, not one with a live parent (e.g. a terminal)', () => {
    expect(findOrphanRoot('radar', 9281, 300, [radar(9281)])).toBe(300);
    const shell: ProcInfo = { pid: 50, ppid: 0, name: 'pwsh.exe', commandLine: 'pwsh', created: 1 };
    expect(findOrphanRoot('radar', 9281, 300, [shell, radar(9281)])).toBeUndefined();
  });
});

describe('reclaimPort', () => {
  const deps = (procs: ProcInfo[], listener: number | undefined): ReclaimDeps & { killed: number[] } => {
    const killed: number[] = [];
    return {
      killed,
      listenerPid: async () => listener,
      listProcesses: async () => procs,
      killTree: (pid) => killed.push(pid),
      portFree: vi.fn(async () => killed.length > 0),
    };
  };
  it('kills our orphan tree by PID and reports the port free', async () => {
    const d = deps([vaultExe(9291), ...pythons], 202);
    expect(await reclaimPort('vault', 9291, d)).toBe(true);
    expect(d.killed).toEqual([200]);
  });
  it('kills nothing when someone else listens', async () => {
    const shell: ProcInfo = { pid: 1, ppid: 0, name: 'pwsh.exe', commandLine: 'pwsh', created: 1 };
    const d = deps([shell, uvx, vaultExe(9291), ...pythons], 202);
    expect(await reclaimPort('vault', 9291, d)).toBe(false);
    expect(d.killed).toEqual([]);
  });
  it('kills nothing when process info is unavailable', async () => {
    const d = { ...deps([], 202), listProcesses: async () => Promise.reject(new Error('no powershell')) };
    expect(await reclaimPort('vault', 9291, d)).toBe(false);
    expect(d.killed).toEqual([]);
  });
});
