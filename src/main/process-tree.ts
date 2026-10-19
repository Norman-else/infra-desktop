import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** POSIX: start the child in its own process group so killTree can signal everything it spawned. */
export const treeSpawnOptions: SpawnOptions = process.platform === 'win32' ? {} : { detached: true };

/**
 * Kill a child and everything it started. Launchers like uvx run the real server as a grandchild,
 * which outlives a plain child.kill() and keeps its port. Synchronous so it finishes before the app quits.
 */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* group already gone */
    }
  }
  if (child.exitCode === null) child.kill();
}
