import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));
const { findAppBundle, installTarget, isNewer } = await import('../src/main/updater');

describe('isNewer', () => {
  it('compares semver parts numerically', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('v1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });
});

describe('macOS update bundle', () => {
  const dirWith = (...names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    for (const n of names) mkdirSync(join(dir, n));
    return dir;
  };

  it('finds the single .app in an extracted update', () => {
    const dir = dirWith('Infra Desktop.app', '__MACOSX');
    expect(findAppBundle(dir)).toBe(join(dir, 'Infra Desktop.app'));
  });

  it('rejects a zip without exactly one .app', () => {
    expect(() => findAppBundle(dirWith())).toThrow(/found 0/);
    expect(() => findAppBundle(dirWith('A.app', 'B.app'))).toThrow(/found 2/);
  });

  it("targets the current bundle's folder with the new name", () => {
    expect(installTarget('/Users/u/Applications/Radar Desktop.app', 'Infra Desktop')).toBe(join('/Users/u/Applications', 'Infra Desktop.app'));
  });
});
