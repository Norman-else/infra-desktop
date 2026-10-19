import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EnvInfo } from '../shared/types';
import type { EnvOverride } from './discovery';

/** What vault-mcp needs to sign in to one environment's Vault. */
export interface VaultEnvConfig {
  /** vault-mcp environment name (dev / sat / prod) */
  env: string;
  addr?: string;
  header?: string;
  role?: string;
  region?: string;
  port: number;
}

/** Only these keys are ever read from Claude's config — never tokens or other secrets. */
const VAULT_KEYS = /^(VAULT_(ADDR|HEADER|ROLE)|AWS_REGION)_[A-Z]+$/;

/** The vault MCP server's Vault settings from ~/.claude.json (top-level or per-project servers). */
export function readClaudeVaultEnv(file = join(homedir(), '.claude.json')): Record<string, string> {
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
      projects?: Record<string, { mcpServers?: Record<string, { env?: Record<string, string> }> }>;
    };
    const servers = { ...cfg.mcpServers };
    for (const p of Object.values(cfg.projects ?? {})) Object.assign(servers, p.mcpServers);
    const env = servers.vault?.env ?? {};
    return Object.fromEntries(Object.entries(env).filter(([k, v]) => VAULT_KEYS.test(k) && typeof v === 'string'));
  } catch {
    return {};
  }
}

/** Settings override first, then the MCP server's values for the env's vault name. */
export function resolveVaultConfig(env: EnvInfo, override: EnvOverride['vault'], claudeEnv: Record<string, string>): VaultEnvConfig {
  const name = override?.env ?? env.profile;
  const key = (prefix: string) => claudeEnv[`${prefix}_${name.toUpperCase()}`];
  return {
    env: name,
    addr: override?.addr ?? key('VAULT_ADDR'),
    header: override?.header ?? key('VAULT_HEADER'),
    role: override?.role ?? key('VAULT_ROLE'),
    region: key('AWS_REGION') ?? env.region,
    port: override?.port ?? env.vaultPort,
  };
}
