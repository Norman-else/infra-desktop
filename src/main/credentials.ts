import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AwsCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: string;
}

export type FetchResult =
  | { kind: 'ok'; creds: AwsCredentials }
  | { kind: 'need-mfa' }
  | { kind: 'need-passphrase' }
  | { kind: 'error'; message: string };

export interface FetchOptions {
  awsVault: string;
  profile: string;
  mfaToken?: string;
  passphrase?: string;
  duration?: string;
  path: string;
  timeoutMs?: number;
}

const MFA_PROMPT = /enter (mfa|token)|mfa code|mfa token/i;
const PASSPHRASE_PROMPT = /passphrase/i;

/** Env for aws-vault: never inherit credentials from a parent aws-vault shell, and force a prompt we can detect. */
export function cleanAwsEnv(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
  for (const k of Object.keys(env)) {
    if (/^AWS_(VAULT($|_PROMPT)|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|PROFILE|DEFAULT_PROFILE|CREDENTIAL_EXPIRATION|CONTAINER_)/.test(k)) delete env[k];
  }
  delete env.Path; // Windows: avoid PATH/Path duplicates
  env.AWS_VAULT_PROMPT = 'terminal';
  return env;
}

/**
 * Runs `aws-vault export --format=json`. aws-vault reuses its cached MFA session when it can;
 * when it needs input it prints a prompt to stderr, which we detect and turn into need-mfa / need-passphrase.
 */
export function fetchCredentials(o: FetchOptions): Promise<FetchResult> {
  const args = ['export', '--format=json'];
  if (o.mfaToken) args.push(`--mfa-token=${o.mfaToken}`);
  if (o.duration) args.push(`--duration=${o.duration}`);
  args.push(o.profile);
  const env = cleanAwsEnv(o.path);
  if (o.passphrase) env.AWS_VAULT_FILE_PASSPHRASE = o.passphrase;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(o.awsVault, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (r: FetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ kind: 'error', message: `aws-vault 超时无响应\n${stderr}`.trim() }), o.timeoutMs ?? 60_000);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!o.passphrase && PASSPHRASE_PROMPT.test(stderr)) finish({ kind: 'need-passphrase' });
      else if (!o.mfaToken && MFA_PROMPT.test(stderr)) finish({ kind: 'need-mfa' });
    });
    child.on('error', (e) => finish({ kind: 'error', message: `无法运行 aws-vault: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0) {
        try {
          const creds = JSON.parse(stdout) as AwsCredentials;
          if (!creds.AccessKeyId) throw new Error('missing AccessKeyId');
          return finish({ kind: 'ok', creds });
        } catch (e) {
          return finish({ kind: 'error', message: `无法解析 aws-vault 输出: ${(e as Error).message}` });
        }
      }
      // Prompt text may arrive together with the failure (e.g. stdin closed), check once more.
      if (!o.passphrase && PASSPHRASE_PROMPT.test(stderr)) return finish({ kind: 'need-passphrase' });
      if (!o.mfaToken && MFA_PROMPT.test(stderr)) return finish({ kind: 'need-mfa' });
      finish({ kind: 'error', message: explainAwsVaultError(stderr.trim() || `aws-vault exited with code ${code}`) });
    });
  });
}

function explainAwsVaultError(msg: string): string {
  const missing = /profile (\S+): credentials missing/.exec(msg);
  if (missing) return `${msg}\n\n本机 aws-vault 里没有 ${missing[1]} 的 access key，请先在终端运行：aws-vault add ${missing[1]}`;
  if (/MultiFactorAuthentication failed|invalid MFA one time pass code/i.test(msg)) return `MFA 验证码错误或已使用过，请等下一个验证码。\n\n${msg}`;
  return msg;
}

/**
 * ECS-compatible credential endpoint. Radar (and the `aws eks get-token` it runs) reads credentials from here
 * via AWS_CONTAINER_CREDENTIALS_FULL_URI, so we can renew them without restarting radar.
 */
export class CredentialServer {
  private server?: Server;
  private port = 0;
  private entries = new Map<string, { token: string; creds?: AwsCredentials }>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '').replace(/^\/creds\//, ''));
      const entry = this.entries.get(name);
      const auth = Buffer.from(String(req.headers.authorization ?? ''));
      const ok = entry && auth.length === entry.token.length && timingSafeEqual(auth, Buffer.from(entry.token));
      if (!ok) {
        res.writeHead(403).end();
        return;
      }
      if (!entry.creds) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'credentials not available' }));
        return;
      }
      const c = entry.creds;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ AccessKeyId: c.AccessKeyId, SecretAccessKey: c.SecretAccessKey, Token: c.SessionToken, Expiration: c.Expiration }),
      );
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  register(name: string): { uri: string; token: string } {
    const token = randomBytes(24).toString('hex');
    this.entries.set(name, { token });
    return { uri: `http://127.0.0.1:${this.port}/creds/${encodeURIComponent(name)}`, token };
  }

  set(name: string, creds: AwsCredentials): void {
    const e = this.entries.get(name);
    if (e) e.creds = creds;
  }

  unregister(name: string): void {
    this.entries.delete(name);
  }

  stop(): void {
    this.server?.close();
  }
}
