import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { EnvOverride } from './discovery';

export interface Settings {
  /** Absolute path to aws-vault; auto-detected from PATH when empty */
  awsVaultPath?: string;
  /** Absolute path to kubectl-radar / radar; auto-detected when empty */
  radarPath?: string;
  /** Kubeconfig file(s), same syntax as $KUBECONFIG; defaults to $KUBECONFIG or ~/.kube/config */
  kubeconfig?: string;
  /** Passed to aws-vault as --duration, e.g. "1h" */
  duration?: string;
  /** Extra arguments appended to every radar invocation */
  radarArgs?: string[];
  /** Per-profile overrides, keyed by AWS profile name */
  envs?: Record<string, EnvOverride>;
}

const TEMPLATE: Settings = {
  awsVaultPath: '',
  radarPath: '',
  kubeconfig: '',
  duration: '',
  radarArgs: [],
  envs: {
    'example-profile': { context: 'my-kube-context', label: 'EXAMPLE', color: '#3d6fd6', hidden: false },
  },
};

export function loadSettings(file: string): Settings {
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(TEMPLATE, null, 2));
    return {};
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Settings;
  // Treat empty strings from the template as "not set".
  for (const k of ['awsVaultPath', 'radarPath', 'kubeconfig', 'duration'] as const) if (!raw[k]) delete raw[k];
  return raw;
}
