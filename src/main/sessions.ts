import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState, EnvInfo, EnvState, ToolAvailability, ToolKind, ToolState, UpdateState } from '../shared/types';
import { CredentialServer, cleanAwsEnv, clearSessions, detectBackend, fetchCredentials, profileHasSession, type FetchResult } from './credentials';
import { discoverEnvs, mergeKubeConfigs, parseAwsConfig, singleContextKubeConfig, type KubeConfig } from './discovery';
import { awsConfigPath, effectivePath, kubeconfigPaths, resolveBinary, which } from './paths';
import { loadSettings, saveEnvVault, type Settings } from './settings';
import { RadarTool } from './tools/radar';
import type { Tool, ToolContext } from './tools/tool';
import { VaultTool } from './tools/vault';
import { readClaudeVaultEnv, resolveVaultConfig, type VaultEnvConfig } from './vault-config';
import { detectVaultMcp, type VaultMcp } from './vault-mcp';

type Purpose = 'connect' | 'renew';
export type ToolFactories = Partial<Record<ToolKind, (ctx: ToolContext) => Tool>>;

export const TOOL_KINDS: ToolKind[] = ['radar', 'vault'];
/** Shown for a tool this build can't run yet. */
export const TOOL_UNAVAILABLE = 'Vault support is coming in a later version.';

/** Start renewing this long before credentials expire, so there's time to answer an MFA prompt. */
const RENEW_BEFORE_MS = 15 * 60_000;
const MFA_ERROR = /MFA|one time pass code|MultiFactor|AccessDenied/i;

/** One environment: its AWS credentials (shared) and the tools running on them. */
class EnvSession {
  state: Omit<EnvState, 'tools'>;
  private tools = new Map<ToolKind, Tool>();
  /** Last status pushed per tool, to notice a tool leaving `ready`. */
  private lastToolStatus = new Map<ToolKind, ToolState['status']>();
  private purpose: Purpose = 'connect';
  private renewTimer?: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  private cred?: { uri: string; token: string };
  /** The aws-vault call in progress; only one at a time, since an MFA code is single-use. */
  private inflight?: { promise: Promise<void>; code?: string };
  /** Bumped on disconnect so results of calls started before it are dropped. */
  private generation = 0;

  constructor(info: EnvInfo, private m: EnvManager) {
    this.state = { ...info, status: 'idle' };
  }

  snapshot(): EnvState {
    const tools = {} as EnvState['tools'];
    for (const kind of TOOL_KINDS) tools[kind] = { ...(this.tools.get(kind)?.state ?? { status: 'stopped' }), ...this.m.availability(kind, this.state.name) };
    return { ...this.state, tools };
  }

  urlOf(kind: ToolKind): string | undefined {
    const t = this.tools.get(kind);
    return t?.state.status === 'ready' ? t.state.url : undefined;
  }

  private update(patch: Partial<EnvState>) {
    Object.assign(this.state, patch);
    this.m.emitState();
  }

  async connect(): Promise<void> {
    if (this.state.status !== 'idle' && this.state.status !== 'error') return;
    this.purpose = 'connect';
    this.update({ status: 'checking', step: 'Checking aws-vault session…', message: undefined, prompt: undefined, promptError: undefined });
    await this.fetch();
  }

  /** User asked to renew credentials of a running env (silent renewal needed MFA). */
  renew(): void {
    this.purpose = 'renew';
    this.update({ prompt: 'mfa', promptError: undefined });
  }

  async submitMfa(code: string): Promise<void> {
    // Same code submitted again (auto-submit + Enter): don't burn it on a second, failing STS call.
    if (this.inflight?.code === code) return this.inflight.promise;
    await this.inflight?.promise;
    this.update({ prompt: undefined, promptError: undefined, step: 'Verifying MFA…' });
    await this.fetch(code);
  }

  async afterPassphrase(): Promise<void> {
    this.update({ prompt: undefined, promptError: undefined, step: 'Unlocking aws-vault…' });
    await this.fetch();
  }

  cancel(): void {
    if (this.state.status === 'ready') this.update({ prompt: undefined, promptError: undefined });
    else this.disconnect();
  }

  // ------------------------------------------------------------------ tools

  private toolContext(kind: ToolKind): ToolContext {
    return {
      env: this.state,
      credentialEnv: () => this.credentialEnv(),
      kubeconfig: () => this.m.writeEnvFiles(this.state),
      settings: this.m.settings,
      binaries: { radar: this.m.binaries.radar ? [this.m.binaries.radar] : undefined },
      vault: kind === 'vault' && this.m.vaultMcp?.ok ? { mcp: this.m.vaultMcp, config: this.m.vaultConfig(this.state) } : undefined,
      onChange: () => this.toolChanged(kind),
      emit: (event) => this.m.emit(event, this.state.name, kind),
    };
  }

  /** Env for tool processes: AWS credentials only via our credential endpoint, isolated from ~/.aws. */
  private credentialEnv(): NodeJS.ProcessEnv {
    const env = cleanAwsEnv(effectivePath());
    const aws = join(this.m.dataDir, 'aws');
    Object.assign(env, {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: this.cred!.uri,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: this.cred!.token,
      // Isolate from ~/.aws so a [default] key or AWS_PROFILE can't take precedence over our credentials.
      AWS_CONFIG_FILE: join(aws, `${this.state.name}.config`),
      AWS_SHARED_CREDENTIALS_FILE: join(aws, 'credentials'),
      KUBECONFIG: join(this.m.dataDir, 'kube', `${this.state.name}.yaml`),
      INFRA_DESKTOP_ENV: this.state.name,
    });
    if (this.state.region) Object.assign(env, { AWS_REGION: this.state.region, AWS_DEFAULT_REGION: this.state.region });
    return env;
  }

  private toolChanged(kind: ToolKind) {
    const status = this.tools.get(kind)?.state.status ?? 'stopped';
    const before = this.lastToolStatus.get(kind);
    this.lastToolStatus.set(kind, status);
    if (before === 'ready' && status !== 'ready') this.m.emit('stopped', this.state.name, kind);
    this.m.emitState();
  }

  /** Start a tool for this env if credentials are ready and it isn't running yet. */
  async ensureTool(kind: ToolKind): Promise<void> {
    const availability = this.m.availability(kind, this.state.name);
    if (this.state.status !== 'ready' || !availability.available || availability.setup) return;
    let tool = this.tools.get(kind);
    if (!tool) {
      tool = this.m.toolFactories[kind]!(this.toolContext(kind));
      this.tools.set(kind, tool);
    }
    if (tool.state.status === 'ready' || tool.state.status === 'starting') return;
    await tool.start();
    this.toolChanged(kind);
    if (isReady(tool)) this.m.emit('ready', this.state.name, kind);
  }

  /** Restart a tool that failed, reusing the env's credentials. */
  async retryTool(kind: ToolKind): Promise<void> {
    this.tools.get(kind)?.stop();
    await this.ensureTool(kind);
  }

  private stopTools() {
    for (const t of this.tools.values()) t.stop();
    this.tools.clear();
    this.lastToolStatus.clear();
  }

  // ------------------------------------------------------------ credentials

  private fetch(mfaToken?: string): Promise<void> {
    if (this.inflight) return this.inflight.promise;
    const promise = this.doFetch(mfaToken).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = undefined;
    });
    this.inflight = { promise, code: mfaToken };
    return promise;
  }

  private async doFetch(mfaToken?: string): Promise<void> {
    const gen = this.generation;
    const b = this.m.binaries;
    if (!b.awsVault) return this.fail('aws-vault not found. Install it or set awsVaultPath in settings.');
    const backend = await this.m.awsVaultBackend();
    // aws-vault's MFA prompt can't be captured on Windows, so without a cached session ask for the code up front.
    const profiles = [this.state.profile, this.state.sourceProfile].filter((p): p is string => !!p);
    if (!mfaToken && !(await profileHasSession(b.awsVault, backend, profiles, effectivePath()))) {
      if (gen === this.generation) await this.handle({ kind: 'need-mfa' }, false);
      return;
    }
    if (mfaToken && this.purpose === 'renew') await clearSessions(b.awsVault, backend, profiles, effectivePath());
    const r = await fetchCredentials({
      awsVault: b.awsVault,
      profile: this.state.profile,
      mfaToken,
      passphrase: this.m.passphrase,
      duration: this.m.settings.duration,
      backend,
      path: effectivePath(),
    });
    if (gen === this.generation) await this.handle(r, !!mfaToken);
  }

  private async handle(r: FetchResult, triedMfa: boolean): Promise<void> {
    // The user may have disconnected while aws-vault was running.
    if (this.state.status === 'idle') return;
    switch (r.kind) {
      case 'ok': {
        const expires = Date.parse(r.creds.Expiration);
        // Silent renewal got the same cached credentials back: they can't be extended without MFA.
        const extended = !this.state.credsExpiresAt || expires > this.state.credsExpiresAt + 60_000;
        if (this.purpose === 'renew' && !extended) {
          if (triedMfa) return this.update({ prompt: 'mfa', promptError: 'aws-vault returned the same credentials. Try again with the next MFA code.' });
          return this.needRenewal();
        }
        this.cred ??= this.m.credServer.register(this.state.name);
        this.m.credServer.set(this.state.name, r.creds);
        const firstCredentials = this.state.status !== 'ready';
        this.update({ status: 'ready', step: undefined, credsExpiresAt: expires, renewNeedsMfa: false, message: undefined });
        this.scheduleRenew(expires);
        if (firstCredentials) await this.ensureTool(this.m.activeTool);
        else await Promise.all([...this.tools.values()].filter((t) => t.state.status === 'ready').map((t) => t.onCredentialsRenewed()));
        return;
      }
      case 'need-mfa':
        if (this.purpose === 'renew' && !triedMfa) return this.needRenewal();
        return this.update({ prompt: 'mfa', step: 'Waiting for MFA code' });
      case 'need-passphrase':
        this.m.passphrase = undefined;
        return this.update({ prompt: 'passphrase', step: 'Waiting for aws-vault password' });
      case 'error':
        if (triedMfa && MFA_ERROR.test(r.message)) return this.update({ prompt: 'mfa', promptError: r.message });
        if (this.state.status === 'ready') {
          // Keep the tools running on the old credentials and try again shortly.
          this.update({ message: `Credential renewal failed: ${r.message}` });
          this.renewTimer = setTimeout(() => this.silentRenew(), 60_000);
          return;
        }
        return this.fail(r.message);
    }
  }

  private scheduleRenew(expires: number) {
    clearTimeout(this.renewTimer);
    clearTimeout(this.expiryTimer);
    const delay = Math.max(expires - RENEW_BEFORE_MS - Date.now(), 60_000);
    this.renewTimer = setTimeout(() => this.silentRenew(), delay);
    this.expiryTimer = setTimeout(() => {
      if (this.state.status !== 'ready') return;
      this.m.emit('expired', this.state.name);
      this.m.emitState();
    }, Math.max(expires - Date.now(), 0));
  }

  /** Silent renewal isn't possible; ask the user (once) to enter MFA before the credentials expire. */
  private needRenewal() {
    const first = !this.state.renewNeedsMfa;
    this.update({ renewNeedsMfa: true });
    if (first) this.m.emit('renew-needed', this.state.name);
  }

  private async silentRenew() {
    if (this.state.status !== 'ready' || this.state.prompt) return;
    this.purpose = 'renew';
    await this.fetch();
  }

  /** Credentials could not be obtained: nothing can run without them. */
  private fail(message: string) {
    clearTimeout(this.renewTimer);
    clearTimeout(this.expiryTimer);
    this.stopTools();
    this.update({ status: 'error', message, step: undefined, prompt: undefined });
    this.m.emit('stopped', this.state.name);
  }

  disconnect(): void {
    clearTimeout(this.expiryTimer);
    clearTimeout(this.renewTimer);
    this.generation++;
    this.inflight = undefined;
    this.stopTools();
    if (this.cred) this.m.credServer.unregister(this.state.name);
    this.cred = undefined;
    this.state = { ...pickInfo(this.state), status: 'idle' };
    this.m.emit('stopped', this.state.name);
    this.m.emitState();
  }
}

/** A function, so TS doesn't keep a status narrowed from before an await. */
const isReady = (t: Tool) => t.state.status === 'ready';

function pickInfo(s: EnvInfo): EnvInfo {
  const { name, label, color, profile, sourceProfile, roleArn, region, context, clusterName, port, vaultPort } = s;
  return { name, label, color, profile, sourceProfile, roleArn, region, context, clusterName, port, vaultPort };
}

export class EnvManager extends EventEmitter {
  settings: Settings = {};
  binaries: { awsVault?: string; radar?: string; aws?: string } = {};
  passphrase?: string;
  readonly credServer = new CredentialServer();
  readonly toolFactories: ToolFactories;
  private sessions = new Map<string, EnvSession>();
  private problems: string[] = [];
  private kube: KubeConfig = {};
  private backend?: Promise<string | undefined>;
  active: string | null = null;
  activeTool: ToolKind = 'radar';
  update: UpdateState = { status: 'disabled', current: '' };

  /** vault-mcp checkout and whether it supports standalone mode; undefined while being detected */
  vaultMcp?: VaultMcp;
  private vaultDetection: Promise<void> = Promise.resolve();
  private claudeVaultEnv: Record<string, string> = {};

  constructor(
    readonly dataDir: string,
    toolFactories: ToolFactories = { radar: (ctx) => new RadarTool(ctx), vault: (ctx) => new VaultTool(ctx) },
    private options: { detectVault?: (settings: Settings) => Promise<VaultMcp>; claudeJsonPath?: string } = {},
  ) {
    super();
    this.toolFactories = toolFactories;
    for (const d of ['kube', 'aws']) mkdirSync(join(dataDir, d), { recursive: true });
    writeFileSync(join(dataDir, 'aws', 'credentials'), '');
  }

  get settingsPath(): string {
    return join(this.dataDir, 'settings.json');
  }

  /** Whether a tool can run (for one env when given: Vault also needs that env's Vault address). */
  availability(kind: ToolKind, env?: string): ToolAvailability {
    if (!this.toolFactories[kind]) return { available: false, reason: TOOL_UNAVAILABLE };
    if (kind !== 'vault') return { available: true };
    if (!this.vaultMcp) return { available: false, reason: 'Checking vault-mcp…' };
    if (!this.vaultMcp.ok) return { available: false, reason: this.vaultMcp.reason };
    const session = env ? this.sessions.get(env) : undefined;
    // No address yet: the Vault page shows a setup form instead of being disabled.
    if (session && !this.vaultConfig(session.state).addr) return { available: true, setup: 'vault' };
    return { available: true };
  }

  /** The env's Vault settings: settings override, else the vault MCP server's values. */
  vaultConfig(env: EnvInfo): VaultEnvConfig {
    return resolveVaultConfig(env, this.settings.envs?.[env.profile]?.vault, this.claudeVaultEnv);
  }

  /** Save an env's Vault settings from the setup form, reload, and start Vault if it is being shown. */
  async saveVaultConfig(env: string, vault: { addr: string; header?: string; role?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.get(env);
    if (!session) return { ok: false, error: `Unknown environment ${env}` };
    const addr = vault.addr.trim();
    if (!/^https?:\/\//.test(addr)) return { ok: false, error: 'Address must start with https:// or http://' };
    try {
      new URL(addr);
    } catch {
      return { ok: false, error: 'Address is not a valid URL' };
    }
    const value: { addr: string; header?: string; role?: string } = { addr };
    if (vault.header?.trim()) value.header = vault.header.trim();
    if (vault.role?.trim()) value.role = vault.role.trim();
    try {
      saveEnvVault(this.settingsPath, session.state.profile, value);
    } catch (e) {
      return { ok: false, error: `Could not save settings: ${(e as Error).message}` };
    }
    this.reload();
    await this.vaultReady();
    if (this.active === env && this.activeTool === 'vault') await this.session(env).ensureTool('vault');
    return { ok: true };
  }

  /** Resolves when the vault-mcp detection started by the last reload has finished. */
  vaultReady(): Promise<void> {
    return this.vaultDetection;
  }

  async init(): Promise<void> {
    await this.credServer.start();
    this.reload();
  }

  /** (Re)read settings, ~/.aws/config and kubeconfig. Running sessions are kept. */
  reload(): void {
    this.problems = [];
    this.backend = undefined;
    try {
      this.settings = loadSettings(this.settingsPath);
    } catch (e) {
      this.problems.push(`Could not parse settings file: ${(e as Error).message}`);
      this.settings = {};
    }
    const s = this.settings;
    this.binaries = {
      awsVault: resolveBinary(s.awsVaultPath, ['aws-vault']),
      radar: resolveBinary(s.radarPath, ['kubectl-radar', 'radar']),
      aws: which(['aws']),
    };
    if (!this.binaries.awsVault) this.problems.push(s.awsVaultPath ? `awsVaultPath does not exist: ${s.awsVaultPath}` : 'aws-vault not found');
    if (!this.binaries.radar) this.problems.push(s.radarPath ? `radarPath does not exist: ${s.radarPath}` : 'radar (kubectl-radar) not found');
    if (!this.binaries.aws) this.problems.push('AWS CLI not found (EKS kubeconfigs use it to get tokens)');

    let envs: EnvInfo[] = [];
    try {
      const awsCfg = awsConfigPath();
      const profiles = existsSync(awsCfg) ? parseAwsConfig(readFileSync(awsCfg, 'utf8')) : [];
      if (!profiles.length) this.problems.push(`No AWS profiles found in ${awsCfg}`);
      const kubeFiles = kubeconfigPaths(s.kubeconfig).filter((f) => existsSync(f));
      if (!kubeFiles.length) this.problems.push('No kubeconfig found');
      this.kube = mergeKubeConfigs(kubeFiles.map((f) => readFileSync(f, 'utf8')));
      envs = discoverEnvs(profiles, this.kube, s.envs);
      if (profiles.length && kubeFiles.length && !envs.length)
        this.problems.push('No environments matched: each needs an AWS profile with role_arn and an EKS context for the same account in kubeconfig (or set the context in settings).');
    } catch (e) {
      this.problems.push(`Could not read config: ${(e as Error).message}`);
    }

    const next = new Map<string, EnvSession>();
    for (const info of envs) {
      const existing = this.sessions.get(info.name);
      if (existing) {
        Object.assign(existing.state, info);
        next.set(info.name, existing);
      } else next.set(info.name, new EnvSession(info, this));
    }
    for (const [name, sess] of this.sessions) if (!next.has(name)) sess.disconnect();
    this.sessions = next;
    if (this.active && !next.has(this.active)) this.active = null;

    this.claudeVaultEnv = readClaudeVaultEnv(this.options.claudeJsonPath);
    if (this.toolFactories.vault) {
      this.vaultMcp = undefined;
      const detect = this.options.detectVault ?? detectVaultMcp;
      const settings = this.settings;
      this.vaultDetection = detect(settings).then((r) => {
        if (this.settings !== settings) return; // a newer reload is detecting
        this.vaultMcp = r;
        this.emitState();
      });
    }
    this.emitState();
  }

  /** aws-vault backend to use: from settings, else whichever backend actually holds keys (detected once per reload). */
  awsVaultBackend(): Promise<string | undefined> {
    if (this.settings.awsVaultBackend) return Promise.resolve(this.settings.awsVaultBackend);
    if (!this.binaries.awsVault) return Promise.resolve(undefined);
    this.backend ??= detectBackend(this.binaries.awsVault, effectivePath());
    return this.backend;
  }

  /** Writes the single-context kubeconfig and isolated AWS config for an env; returns the kubeconfig path. */
  writeEnvFiles(env: EnvInfo): string {
    const kubeFile = join(this.dataDir, 'kube', `${env.name}.yaml`);
    writeFileSync(kubeFile, singleContextKubeConfig(this.kube, env.context), { mode: 0o600 });
    writeFileSync(join(this.dataDir, 'aws', `${env.name}.config`), env.region ? `[default]\nregion = ${env.region}\n` : '');
    return kubeFile;
  }

  session(name: string): EnvSession {
    const s = this.sessions.get(name);
    if (!s) throw new Error(`unknown env ${name}`);
    return s;
  }

  async switchTo(name: string): Promise<void> {
    const s = this.session(name);
    this.active = name;
    this.emitState();
    this.emit('activate', name);
    await s.connect();
    await s.ensureTool(this.activeTool);
  }

  /** Show another tool; ignored when this build can't run it. */
  async setTool(kind: ToolKind): Promise<void> {
    if (!this.availability(kind, this.active ?? undefined).available) return;
    this.activeTool = kind;
    this.emitState();
    this.emit('activate', this.active);
    if (this.active) await this.session(this.active).ensureTool(kind);
  }

  async submitPassphrase(name: string, passphrase: string): Promise<void> {
    this.passphrase = passphrase;
    await this.session(name).afterPassphrase();
  }

  urlOf(name: string, kind: ToolKind): string | undefined {
    return this.sessions.get(name)?.urlOf(kind);
  }

  getState(): AppState {
    return {
      envs: [...this.sessions.values()].map((s) => s.snapshot()),
      active: this.active,
      problems: this.problems,
      settingsPath: this.settingsPath,
      update: this.update,
      activeTool: this.activeTool,
    };
  }

  emitState(): void {
    this.emit('state', this.getState());
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.disconnect();
    this.credServer.stop();
  }
}
