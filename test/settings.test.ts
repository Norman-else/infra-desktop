import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveEnvVault } from '../src/main/settings';

describe('saveEnvVault', () => {
  it('saving keeps other settings', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'settings-')), 'settings.json');
    writeFileSync(file, JSON.stringify({ duration: '8h', envs: { dev: { port: 9381, vault: { port: 9391 } }, prod: { label: 'PROD' } } }));
    saveEnvVault(file, 'dev', { addr: 'https://vault.dev.example', header: 'vault.dev.example', role: 'vault_admin' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      duration: '8h',
      envs: {
        dev: { port: 9381, vault: { port: 9391, addr: 'https://vault.dev.example', header: 'vault.dev.example', role: 'vault_admin' } },
        prod: { label: 'PROD' },
      },
    });
  });

  it('creates the env entry when missing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'settings-')), 'settings.json');
    writeFileSync(file, '{}');
    saveEnvVault(file, 'sat', { addr: 'https://vault.sat.example' });
    expect(JSON.parse(readFileSync(file, 'utf8')).envs.sat.vault).toEqual({ addr: 'https://vault.sat.example' });
  });
});
