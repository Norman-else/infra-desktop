import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrateUserData } from '../src/main/migrate';

describe('migrateUserData', () => {
  let oldDir: string;
  let newDir: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'migrate-'));
    oldDir = join(root, 'Radar Desktop');
    newDir = join(root, 'Infra Desktop');
  });

  const seedOld = () => {
    mkdirSync(join(oldDir, 'kube'), { recursive: true });
    mkdirSync(join(oldDir, 'aws'), { recursive: true });
    writeFileSync(join(oldDir, 'settings.json'), '{"duration":"8h"}');
    writeFileSync(join(oldDir, 'kube', 'dev.yaml'), 'kind: Config');
    writeFileSync(join(oldDir, 'aws', 'credentials'), '');
  };

  it('copies settings, kube and aws into an empty new dir', () => {
    seedOld();
    expect(migrateUserData(oldDir, newDir)).toBe('migrated');
    expect(readFileSync(join(newDir, 'settings.json'), 'utf8')).toBe('{"duration":"8h"}');
    expect(readFileSync(join(newDir, 'kube', 'dev.yaml'), 'utf8')).toBe('kind: Config');
    expect(existsSync(join(newDir, 'aws', 'credentials'))).toBe(true);
  });

  it('does not overwrite an existing new settings.json', () => {
    seedOld();
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, 'settings.json'), '{"duration":"1h"}');
    expect(migrateUserData(oldDir, newDir)).toBe('skipped');
    expect(readFileSync(join(newDir, 'settings.json'), 'utf8')).toBe('{"duration":"1h"}');
  });

  it('skips when there is nothing to migrate', () => {
    expect(migrateUserData(oldDir, newDir)).toBe('skipped');
  });

  it('leaves the old dir untouched', () => {
    seedOld();
    migrateUserData(oldDir, newDir);
    expect(readFileSync(join(oldDir, 'settings.json'), 'utf8')).toBe('{"duration":"8h"}');
  });
});
