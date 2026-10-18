export type EnvStatus = 'idle' | 'checking' | 'connecting' | 'ready' | 'error';

/** Input the env is waiting for from the user (first connect, or renewing credentials of a running env) */
export type EnvPrompt = 'mfa' | 'passphrase';

export interface ClusterHealth {
  /** radar's state, e.g. connected / connecting / disconnected; 'unknown' when radar didn't answer */
  state: string;
  error?: string;
  errorType?: string;
}

export interface EnvInfo {
  /** aws-vault / AWS profile name, also the env id */
  name: string;
  label: string;
  color: string;
  profile: string;
  /** Profile holding the long-lived keys (aws-vault caches the MFA session there when chaining) */
  sourceProfile?: string;
  roleArn?: string;
  region?: string;
  context: string;
  clusterName: string;
  /** Fixed local port for radar (UI and MCP at /mcp) */
  port: number;
}

export interface EnvState extends EnvInfo {
  status: EnvStatus;
  prompt?: EnvPrompt;
  /** Error from the last MFA / passphrase attempt, shown inside the prompt */
  promptError?: string;
  /** Human readable current step while checking/connecting */
  step?: string;
  /** Error text for status=error, or a non-fatal renewal warning */
  message?: string;
  /** Epoch ms when the current AWS credentials expire */
  credsExpiresAt?: number;
  /** Credentials could not be renewed silently; user must enter MFA before they expire */
  renewNeedsMfa?: boolean;
  /** Cluster connection as reported by radar's /api/connection (only while status=ready) */
  cluster?: ClusterHealth;
  /** Last lines of radar output, for error display */
  logTail?: string[];
}

export interface UpdateState {
  /** disabled = not a packaged build */
  status: 'disabled' | 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error';
  current: string;
  version?: string;
  progress?: number;
  error?: string;
}

export interface AppState {
  envs: EnvState[];
  active: string | null;
  /** Setup problems, e.g. missing aws-vault / radar binaries */
  problems: string[];
  settingsPath: string;
  update: UpdateState;
}

export interface RadarDesktopApi {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): void;
  /** Commands from the app menu / shortcuts, e.g. 'switcher' */
  onCommand(cb: (cmd: string) => void): void;
  switchTo(env: string): Promise<void>;
  submitMfa(env: string, code: string): Promise<void>;
  submitPassphrase(env: string, passphrase: string): Promise<void>;
  /** Start an MFA renewal for an already-running env */
  renew(env: string): Promise<void>;
  cancel(env: string): Promise<void>;
  disconnect(env: string): Promise<void>;
  retry(env: string): Promise<void>;
  /** Hide the radar view so HTML overlays are visible; returns a screenshot to use as backdrop */
  openOverlay(): Promise<string | null>;
  closeOverlay(): Promise<void>;
  openSettings(): Promise<void>;
  checkUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  reloadConfig(): Promise<void>;
}
