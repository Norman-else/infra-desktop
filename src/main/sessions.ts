import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState, ClusterHealth, EnvInfo, EnvState, UpdateState } from '../shared/types';
import { CredentialServer, cleanAwsEnv, clearSessions, detectBackend, fetchCredentials, profileHasSession, type FetchResult } from './credentials';
import { discoverEnvs, mergeKubeConfigs, parseAwsConfig, singleContextKubeConfig, type KubeConfig } from './discovery';
import { awsConfigPath, effectivePath, kubeconfigPaths, resolveBinary, which } from './paths';
import { RadarProcess } from './radar';
import { loadSettings, type Settings } from './settings';

type Purpose = 'connect' | 'renew';

/** Start renewing this long before credentials expire, so there's time to answer an MFA prompt. */
const RENEW_BEFORE_MS = 15 * 60_000;
const MFA_ERROR = /MFA|one time pass code|MultiFactor|AccessDenied/i;

class EnvSession {
  state: EnvState;
  radar?: RadarProcess;
  private purpose: Purpose = 'connect';
  private renewTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  private cred?: { uri: string; token: string };
  /** The aws-vault call in progress; only one at a time, since an MFA code is single-use. */
  private inflight?: { promise: Promise<void>; code?: string };
  /** Bumped on disconnect so results of calls started before it are dropped. */
  private generation = 0;

  constructor(info: EnvInfo, private m: EnvManager) {
    this.state = { ...info, status: 'idle' };
  }

  get url(): string | undefined {
    return this.state.status === 'ready' ? this.radar?.url : undefined;
  }

  private update(patch: Partial<EnvState>) {
    Object.assign(this.state, patch);
    this.m.emitState();
  }

  async connect(): Promise<void> {
    if (this.state.status !== 'idle' && this.state.status !== 'error') return;
    this.purpose = 'connect';
    this.update({ status: 'checking', step: 'Checking aws-vault session…', message: undefined, logTail: undefined, prompt: undefined, promptError: undefined });
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
        this.update({ credsExpiresAt: expires, renewNeedsMfa: false, message: undefined });
        this.scheduleRenew(expires);
        if (this.purpose === 'connect' && !this.radar) await this.startRadar();
        else void this.reconnectRadar();
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
          // Keep radar running on the old credentials and try again shortly.
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

  private async startRadar(): Promise<void> {
    const b = this.m.binaries;
    if (!b.radar) return this.fail('radar (kubectl-radar) not found. Install it or set radarPath in settings.');
    this.update({ status: 'connecting', step: 'Starting radar…' });

    let kubeconfig: string;
    try {
      kubeconfig = this.m.writeEnvFiles(this.state);
    } catch (e) {
      return this.fail(`Could not write kubeconfig: ${(e as Error).message}`);
    }

    const env = cleanAwsEnv(effectivePath());
    const aws = join(this.m.dataDir, 'aws');
    Object.assign(env, {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: this.cred!.uri,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: this.cred!.token,
      // Isolate from ~/.aws so a [default] key or AWS_PROFILE can't take precedence over our credentials.
      AWS_CONFIG_FILE: join(aws, `${this.state.name}.config`),
      AWS_SHARED_CREDENTIALS_FILE: join(aws, 'credentials'),
      AWS_REGION: this.state.region ?? '',
      AWS_DEFAULT_REGION: this.state.region ?? '',
      KUBECONFIG: kubeconfig,
      RADAR_DESKTOP_ENV: this.state.name,
    });
    if (!this.state.region) {
      delete env.AWS_REGION;
      delete env.AWS_DEFAULT_REGION;
    }

    const radar = new RadarProcess({
      radarPath: b.radar,
      kubeconfig,
      env,
      extraArgs: this.m.settings.radarArgs ?? [],
      port: this.state.port,
      onExit: (code, log) => {
        if (this.radar !== radar) return;
        this.radar = undefined;
        this.fail(`radar exited unexpectedly (code ${code})`, log.slice(-40));
      },
    });
    this.radar = radar;
    try {
      await radar.start();
      this.update({ step: 'Waiting for radar…' });
      await radar.waitReady();
    } catch (e) {
      if (this.radar !== radar) return;
      radar.stop();
      this.radar = undefined;
      return this.fail((e as Error).message, radar.log.slice(-40));
    }
    if (this.radar !== radar) return;
    this.update({ status: 'ready', step: undefined });
    this.m.emit('ready', this.state.name);
    await this.checkHealth();
  }

/**
   * After new credentials, make radar retry right away if it lost the cluster (e.g. they had expired):
   * radar's own background re-check can take a long time, and its page waits for that.
   */
  private async reconnectRadar(): Promise<void> {
    const radar = this.radar;
    const wasDown = !!this.state.cluster && this.state.cluster.state !== 'connected';
    if (radar && wasDown) {
      this.update({ cluster: { state: 'connecting' } });
      try {
        await fetch(`${radar.url}api/connection/retry`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
      } catch {
        /* the health check below reports the outcome */
      }
    }
    await this.checkHealth();
    // Its page may still show the error screen; reload it once the cluster is back.
    if (wasDown && this.state.cluster?.state === 'connected') this.m.emit('reload-view', this.state.name);
  }

  /** Ask radar whether it can actually reach the cluster; credentials being valid doesn't mean it can. */
  private async checkHealth(): Promise<void> {
    clearTimeout(this.healthTimer);
    const radar = this.radar;
    if (!radar || this.state.status !== 'ready') return;
    let health: ClusterHealth;
    try {
      const res = await fetch(`${radar.url}api/connection?contexts=0`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { state?: string; error?: string; errorType?: string };
      health = { state: body.state ?? 'unknown', error: body.error || undefined, errorType: body.errorType || undefined };
    } catch (e) {
      health = { state: 'unknown', error: `Could not read radar connection status: ${(e as Error).message}` };
    }
    if (this.radar !== radar) return;
    if (JSON.stringify(health) !== JSON.stringify(this.state.cluster)) this.update({ cluster: health });
    this.healthTimer = setTimeout(() => void this.checkHealth(), health.state === 'connected' ? 15_000 : 5_000);
  }

  private fail(message: string, logTail?: string[]) {
    clearTimeout(this.renewTimer);
    clearTimeout(this.expiryTimer);
    clearTimeout(this.healthTimer);
    this.radar?.stop();
    this.radar = undefined;
    this.update({ status: 'error', message, logTail, step: undefined, prompt: undefined, cluster: undefined });
    this.m.emit('stopped', this.state.name);
  }

  disconnect(): void {
    clearTimeout(this.expiryTimer);
    this.generation++;
    this.inflight = undefined;
    clearTimeout(this.renewTimer);
    clearTimeout(this.healthTimer);
    this.radar?.stop();
    this.radar = undefined;
    if (this.cred) this.m.credServer.unregister(this.state.name);
    this.cred = undefined;
    this.state = { ...pickInfo(this.state), status: 'idle' };
    this.m.emit('stopped', this.state.name);
    this.m.emitState();
  }
}

function pickInfo(s: EnvState): EnvInfo {
  const { name, label, color, profile, sourceProfile, roleArn, region, context, clusterName, port } = s;
  return { name, label, color, profile, sourceProfile, roleArn, region, context, clusterName, port };
}

export class EnvManager extends EventEmitter {
  settings: Settings = {};
  binaries: { awsVault?: string; radar?: string; aws?: string } = {};
  passphrase?: string;
  readonly credServer = new CredentialServer();
  private sessions = new Map<string, EnvSession>();
  private problems: string[] = [];
  private kube: KubeConfig = {};
  private backend?: Promise<string | undefined>;
  active: string | null = null;
  update: UpdateState = { status: 'disabled', current: '' };

  constructor(readonly dataDir: string) {
    super();
    for (const d of ['kube', 'aws']) mkdirSync(join(dataDir, d), { recursive: true });
    writeFileSync(join(dataDir, 'aws', 'credentials'), '');
  }

  get settingsPath(): string {
    return join(this.dataDir, 'settings.json');
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
  writeEnvFiles(env: EnvState): string {
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
  }

  async submitPassphrase(name: string, passphrase: string): Promise<void> {
    this.passphrase = passphrase;
    await this.session(name).afterPassphrase();
  }

  urlOf(name: string): string | undefined {
    return this.sessions.get(name)?.url;
  }

  getState(): AppState {
    return {
      envs: [...this.sessions.values()].map((s) => ({ ...s.state })),
      active: this.active,
      problems: this.problems,
      settingsPath: this.settingsPath,
      update: this.update,
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
