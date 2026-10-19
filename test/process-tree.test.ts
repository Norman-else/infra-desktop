import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { killTree, treeSpawnOptions } from '../src/main/process-tree';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('killTree', () => {
  it('kills the grandchild a launcher started, not just the launcher', async () => {
    // Like uvx: a launcher that starts the real server as its own child and waits. On Windows, node
    // would put that child in a job that dies with the launcher; detached keeps it out, as with uvx.
    const launcher = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform === 'win32' });
      console.log(c.pid); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', launcher], { ...treeSpawnOptions, stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((resolve) => child.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    expect(alive(grandchild)).toBe(true);

    killTree(child);

    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
  });
});
