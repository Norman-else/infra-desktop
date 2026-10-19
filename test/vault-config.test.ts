import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvInfo } from '../src/shared/types';
import { readClaudeVaultEnv, resolveVaultConfig } from '../src/main/vault-config';

const dev: EnvInfo = { name: 'dev', label: 'DEV', color: '#1f8f4e', profile: 'dev', context: 'acme-dev', clusterName: 'acme-dev', port: 9281, vaultPort: 9291 };

const claudeJson = (servers: object, projects: object = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), 'claude-json-')), '.claude.json');
  writeFileSync(file, JSON.stringify({ mcpServers: servers, projects }));
  return file;
};

const vaultServer = {
  vault: {
    command: 'python',
    env: {
      VAULT_ADDR_DEV: 'https://vault.dev.example',
      VAULT_HEADER_DEV: 'vault.dev.example',
      VAULT_ROLE_DEV: 'vault_admin',
      AWS_REGION_DEV: 'us-west-2',
      VAULT_ADDR_SAT: 'https://vault.sat.example',
      SLACK_BOT_TOKEN: 'xoxb-secret',
    },
  },
};

describe('readClaudeVaultEnv', () => {
  it('ignores other keys', () => {
    const env = readClaudeVaultEnv(claudeJson(vaultServer));
    expect(env.VAULT_ADDR_DEV).toBe('https://vault.dev.example');
    expect(Object.keys(env)).not.toContain('SLACK_BOT_TOKEN');
  });

  it('reads servers from projects too', () => {
    const env = readClaudeVaultEnv(claudeJson({}, { 'K:/x': { mcpServers: vaultServer } }));
    expect(env.VAULT_ROLE_DEV).toBe('vault_admin');
  });

  it('returns nothing when the file is missing', () => {
    expect(readClaudeVaultEnv(join(tmpdir(), 'no-such-claude.json'))).toEqual({});
  });
});

describe('resolveVaultConfig', () => {
  const claude = readClaudeVaultEnv(claudeJson(vaultServer));

  it("uses the MCP server's values for the profile", () => {
    expect(resolveVaultConfig(dev, undefined, claude)).toEqual({
      env: 'dev',
      addr: 'https://vault.dev.example',
      header: 'vault.dev.example',
      role: 'vault_admin',
      region: 'us-west-2',
      port: 9291,
    });
  });

  it('settings override MCP values', () => {
    const c = resolveVaultConfig(dev, { addr: 'https://other', port: 9500 }, claude);
    expect(c.addr).toBe('https://other');
    expect(c.role).toBe('vault_admin');
    expect(c.port).toBe(9500);
  });

  it('maps a profile to another vault env', () => {
    const c = resolveVaultConfig(dev, { env: 'sat' }, claude);
    expect(c.env).toBe('sat');
    expect(c.addr).toBe('https://vault.sat.example');
  });
});
