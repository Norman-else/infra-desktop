import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EnvOverride } from './discovery';

export interface Settings {
  /** Absolute path to aws-vault; auto-detected from PATH when empty */
  awsVaultPath?: string;
  /** Absolute path to kubectl-radar / radar; auto-detected when empty */
  radarPath?: string;
  /** Kubeconfig file(s), same syntax as $KUBECONFIG; defaults to $KUBECONFIG or ~/.kube/config */
  kubeconfig?: string;
  /** aws-vault backend (wincred / keychain / file); auto-detected from where keys are stored when empty */
  awsVaultBackend?: string;
  /** Passed to aws-vault as --duration, e.g. "1h" */
  duration?: string;
  /** Extra arguments appended to every radar invocation */
  radarArgs?: string[];
  /** vault-mcp checkout used for the Vault tab; defaults to K:/MCP/vault-mcp on Windows when present */
  vaultMcpPath?: string;
  /** Python for vault-mcp; defaults to the checkout's .venv */
  vaultPython?: string;
  /** Per-profile overrides, keyed by AWS profile name */
  envs?: Record<string, EnvOverride>;
}

const TEMPLATE: Settings = {
  awsVaultPath: '',
  awsVaultBackend: '',
  radarPath: '',
  kubeconfig: '',
  duration: '',
  radarArgs: [],
  vaultMcpPath: '',
  vaultPython: '',
  envs: {
    'example-profile': { context: 'my-kube-context', label: 'EXAMPLE', color: '#3d6fd6', hidden: false, port: 9290 },
  },
};

export function loadSettings(file: string): Settings {
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(TEMPLATE, null, 2));
    return {};
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Settings;
  // Treat empty strings from the template as "not set".
  for (const k of ['awsVaultPath', 'awsVaultBackend', 'radarPath', 'kubeconfig', 'duration', 'vaultMcpPath', 'vaultPython'] as const) if (!raw[k]) delete raw[k];
  return raw;
}
