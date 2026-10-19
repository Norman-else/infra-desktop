/** Credential state of an environment; tools have their own ToolState. */
export type EnvStatus = 'idle' | 'checking' | 'ready' | 'error';

/** Input the env is waiting for from the user (first connect, or renewing credentials of a running env) */
export type EnvPrompt = 'mfa' | 'passphrase';

export type ToolKind = 'radar' | 'vault';

/** Short, user-facing health of a running tool; `detail` is the full reason (tooltip). */
export interface ToolHealth {
  state: 'ok' | 'pending' | 'failed';
  text: string;
  detail?: string;
}

export interface ToolState {
  status: 'stopped' | 'starting' | 'ready' | 'error';
  step?: string;
  message?: string;
  logTail?: string[];
  health?: ToolHealth;
  url?: string;
}

export interface ToolAvailability {
  available: boolean;
  reason?: string;
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
  /** Per-tool state, including whether this build can run the tool */
  tools: Record<ToolKind, ToolState & ToolAvailability>;
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
  /** Tool shown in the window (global: switching environment keeps it) */
  activeTool: ToolKind;
}

export interface RadarDesktopApi {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): void;
  /** Commands from the app menu / shortcuts, e.g. 'switcher' */
  onCommand(cb: (cmd: string) => void): void;
  switchTo(env: string): Promise<void>;
  /** Show Radar or Vault (ignored when unavailable) */
  setTool(tool: ToolKind): Promise<void>;
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
