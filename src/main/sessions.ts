import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState, ClusterHealth, EnvInfo, EnvState, UpdateState } from '../shared/types';
import { CredentialServer, cleanAwsEnv, fetchCredentials, type FetchResult } from './credentials';
import { discoverEnvs, mergeKubeConfigs, parseAwsConfig, singleContextKubeConfig, type KubeConfig } from './discovery';
import { awsConfigPath, effectivePath, kubeconfigPaths, resolveBinary, which } from './paths';
import { RadarProcess } from './radar';
import { loadSettings, type Settings } from './settings';

type Purpose = 'connect' | 'renew';

const RENEW_BEFORE_MS = 5 * 60_000;
const MFA_ERROR = /MFA|one time pass code|MultiFactor|AccessDenied/i;

class EnvSession {
  state: EnvState;
  radar?: RadarProcess;
  private purpose: Purpose = 'connect';
  private renewTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private cred?: { uri: string; token: string };

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
    this.update({ status: 'checking', step: '检查 aws-vault 会话…', message: undefined, logTail: undefined, prompt: undefined, promptError: undefined });
    await this.fetch();
  }

  /** User asked to renew credentials of a running env (silent renewal needed MFA). */
  renew(): void {
    this.purpose = 'renew';
    this.update({ prompt: 'mfa', promptError: undefined });
  }

  async submitMfa(code: string): Promise<void> {
    this.update({ prompt: undefined, promptError: undefined, step: '验证 MFA…' });
    await this.fetch(code);
  }

  async afterPassphrase(): Promise<void> {
    this.update({ prompt: undefined, promptError: undefined, step: '解锁 aws-vault…' });
    await this.fetch();
  }

  cancel(): void {
    if (this.state.status === 'ready') this.update({ prompt: undefined, promptError: undefined });
    else this.disconnect();
  }

  private async fetch(mfaToken?: string): Promise<void> {
    const b = this.m.binaries;
    if (!b.awsVault) return this.fail('找不到 aws-vault，请安装或在设置里配置 awsVaultPath');
    const r = await fetchCredentials({
      awsVault: b.awsVault,
      profile: this.state.profile,
      mfaToken,
      passphrase: this.m.passphrase,
      duration: this.m.settings.duration,
      path: effectivePath(),
    });
    await this.handle(r, !!mfaToken);
  }

  private async handle(r: FetchResult, triedMfa: boolean): Promise<void> {
    // The user may have disconnected while aws-vault was running.
    if (this.state.status === 'idle') return;
    switch (r.kind) {
      case 'ok': {
        const expires = Date.parse(r.creds.Expiration);
        this.cred ??= this.m.credServer.register(this.state.name);
        this.m.credServer.set(this.state.name, r.creds);
        this.update({ credsExpiresAt: expires, renewNeedsMfa: false, message: undefined });
        this.scheduleRenew(expires);
        if (this.purpose === 'connect' && !this.radar) await this.startRadar();
        else void this.checkHealth();
        return;
      }
      case 'need-mfa':
        return this.update(this.purpose === 'renew' && !triedMfa ? { renewNeedsMfa: true } : { prompt: 'mfa', step: '等待 MFA 验证码' });
      case 'need-passphrase':
        this.m.passphrase = undefined;
        return this.update({ prompt: 'passphrase', step: '等待 aws-vault 密码' });
      case 'error':
        if (triedMfa && MFA_ERROR.test(r.message)) return this.update({ prompt: 'mfa', promptError: r.message });
        if (this.state.status === 'ready') {
          // Keep radar running on the old credentials and try again shortly.
          this.update({ message: `凭证续期失败：${r.message}` });
          this.renewTimer = setTimeout(() => this.silentRenew(), 60_000);
          return;
        }
        return this.fail(r.message);
    }
  }

  private scheduleRenew(expires: number) {
    clearTimeout(this.renewTimer);
    const delay = Math.max(expires - RENEW_BEFORE_MS - Date.now(), 60_000);
    this.renewTimer = setTimeout(() => this.silentRenew(), delay);
  }

  private async silentRenew() {
    if (this.state.status !== 'ready' || this.state.prompt) return;
    this.purpose = 'renew';
    await this.fetch();
  }

  private async startRadar(): Promise<void> {
    const b = this.m.binaries;
    if (!b.radar) return this.fail('找不到 radar（kubectl-radar），请安装或在设置里配置 radarPath');
    this.update({ status: 'connecting', step: '启动 radar…' });

    let kubeconfig: string;
    try {
      kubeconfig = this.m.writeEnvFiles(this.state);
    } catch (e) {
      return this.fail(`生成 kubeconfig 失败：${(e as Error).message}`);
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
      onExit: (code, log) => {
        if (this.radar !== radar) return;
        this.radar = undefined;
        this.fail(`radar 意外退出（code ${code}）`, log.slice(-40));
      },
    });
    this.radar = radar;
    try {
      await radar.start();
      this.update({ step: '等待 radar 就绪…' });
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
      health = { state: 'unknown', error: `无法读取 radar 连接状态：${(e as Error).message}` };
    }
    if (this.radar !== radar) return;
    if (JSON.stringify(health) !== JSON.stringify(this.state.cluster)) this.update({ cluster: health });
    this.healthTimer = setTimeout(() => void this.checkHealth(), health.state === 'connected' ? 15_000 : 5_000);
  }

  private fail(message: string, logTail?: string[]) {
    clearTimeout(this.renewTimer);
    clearTimeout(this.healthTimer);
    this.radar?.stop();
    this.radar = undefined;
    this.update({ status: 'error', message, logTail, step: undefined, prompt: undefined, cluster: undefined });
    this.m.emit('stopped', this.state.name);
  }

  disconnect(): void {
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
  const { name, label, color, profile, roleArn, region, context, clusterName } = s;
  return { name, label, color, profile, roleArn, region, context, clusterName };
}

export class EnvManager extends EventEmitter {
  settings: Settings = {};
  binaries: { awsVault?: string; radar?: string; aws?: string } = {};
  passphrase?: string;
  readonly credServer = new CredentialServer();
  private sessions = new Map<string, EnvSession>();
  private problems: string[] = [];
  private kube: KubeConfig = {};
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
    try {
      this.settings = loadSettings(this.settingsPath);
    } catch (e) {
      this.problems.push(`设置文件解析失败：${(e as Error).message}`);
      this.settings = {};
    }
    const s = this.settings;
    this.binaries = {
      awsVault: resolveBinary(s.awsVaultPath, ['aws-vault']),
      radar: resolveBinary(s.radarPath, ['kubectl-radar', 'radar']),
      aws: which(['aws']),
    };
    if (!this.binaries.awsVault) this.problems.push(s.awsVaultPath ? `awsVaultPath 不存在：${s.awsVaultPath}` : '没有找到 aws-vault');
    if (!this.binaries.radar) this.problems.push(s.radarPath ? `radarPath 不存在：${s.radarPath}` : '没有找到 radar（kubectl-radar）');
    if (!this.binaries.aws) this.problems.push('没有找到 aws CLI（EKS 的 kubeconfig 需要用它获取 token）');

    let envs: EnvInfo[] = [];
    try {
      const awsCfg = awsConfigPath();
      const profiles = existsSync(awsCfg) ? parseAwsConfig(readFileSync(awsCfg, 'utf8')) : [];
      if (!profiles.length) this.problems.push(`没有读到 AWS profile：${awsCfg}`);
      const kubeFiles = kubeconfigPaths(s.kubeconfig).filter((f) => existsSync(f));
      if (!kubeFiles.length) this.problems.push('没有找到 kubeconfig');
      this.kube = mergeKubeConfigs(kubeFiles.map((f) => readFileSync(f, 'utf8')));
      envs = discoverEnvs(profiles, this.kube, s.envs);
      if (profiles.length && kubeFiles.length && !envs.length)
        this.problems.push('没有匹配到任何环境：需要带 role_arn 的 AWS profile，且 kubeconfig 里有同账号的 EKS context（也可以在设置里手动指定 context）');
    } catch (e) {
      this.problems.push(`读取配置失败：${(e as Error).message}`);
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
