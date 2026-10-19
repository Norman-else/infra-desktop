import type { EnvInfo, ToolKind, ToolState } from '../../shared/types';
import type { Settings } from '../settings';

/** What an environment hands to each of its tools. */
export interface ToolContext {
  env: EnvInfo;
  /** Process env carrying the environment's AWS credentials (via the local credential endpoint). */
  credentialEnv(): NodeJS.ProcessEnv;
  /** Path of the env's single-context kubeconfig (written on demand). */
  kubeconfig(): string;
  settings: Settings;
  /** Commands as argv: executable followed by leading arguments. */
  binaries: { radar?: string[] };
  /** The tool's state changed; push app state. */
  onChange(): void;
  /** Ask the window to reload this tool's page. */
  emit(event: 'reload-view'): void;
}

/** A per-environment app shown in the window (Radar, Vault). */
export interface Tool {
  readonly kind: ToolKind;
  readonly state: ToolState;
  /** Start (or restart after an error); resolves once ready or failed — never rejects. */
  start(): Promise<void>;
  stop(): void;
  /** The environment's AWS credentials were renewed. */
  onCredentialsRenewed(): Promise<void>;
}
