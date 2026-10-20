import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brewFormula, parseRadarVersion } from '../src/main/radar-version';

describe('radar version', () => {
  it('reads the version from `radar -version`', () => {
    expect(parseRadarVersion('radar 1.17.0\n')).toBe('1.17.0');
    expect(parseRadarVersion('dev')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('finds the tap formula behind a Homebrew symlink', () => {
    const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'brew-'))); // macOS: /var is /private/var
    const keg = join(prefix, 'Cellar', 'radar', '1.17.0');
    mkdirSync(join(keg, 'bin'), { recursive: true });
    mkdirSync(join(prefix, 'bin'));
    writeFileSync(join(keg, 'bin', 'kubectl-radar'), '');
    writeFileSync(join(keg, 'INSTALL_RECEIPT.json'), JSON.stringify({ source: { tap: 'skyhook-io/tap' } }));
    writeFileSync(join(prefix, 'bin', 'brew'), '');
    symlinkSync(join(keg, 'bin', 'kubectl-radar'), join(prefix, 'bin', 'kubectl-radar'));

    expect(brewFormula(join(prefix, 'bin', 'kubectl-radar'))).toEqual({ brew: join(prefix, 'bin', 'brew'), formula: 'skyhook-io/tap/radar' });
    expect(brewFormula(join(prefix, 'bin', 'brew'))).toBeUndefined();
  });
});
