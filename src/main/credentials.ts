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
  /** aws-vault keyring backend (wincred / keychain / file …); inherited from the environment when unset */
  backend?: string;
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
  if (o.backend) env.AWS_VAULT_BACKEND = o.backend;

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
    // Without a token, a hang means aws-vault is waiting for input it prompted for on the console
    // (on Windows that prompt bypasses stderr), so ask the user instead of reporting an error.
    const onTimeout = (): FetchResult => {
      if (!o.mfaToken) return o.backend === 'file' && !o.passphrase ? { kind: 'need-passphrase' } : { kind: 'need-mfa' };
      return { kind: 'error', message: `aws-vault did not respond in time\n${stderr}`.trim() };
    };
    const timer = setTimeout(() => finish(onTimeout()), o.timeoutMs ?? (o.mfaToken ? 60_000 : 15_000));

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!o.passphrase && PASSPHRASE_PROMPT.test(stderr)) finish({ kind: 'need-passphrase' });
      else if (!o.mfaToken && MFA_PROMPT.test(stderr)) finish({ kind: 'need-mfa' });
    });
    child.on('error', (e) => finish({ kind: 'error', message: `Could not run aws-vault: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0) {
        try {
          const creds = JSON.parse(stdout) as AwsCredentials;
          if (!creds.AccessKeyId) throw new Error('missing AccessKeyId');
          return finish({ kind: 'ok', creds });
        } catch (e) {
          return finish({ kind: 'error', message: `Could not parse aws-vault output: ${(e as Error).message}` });
        }
      }
      // Prompt text may arrive together with the failure (e.g. stdin closed), check once more.
      if (!o.passphrase && PASSPHRASE_PROMPT.test(stderr)) return finish({ kind: 'need-passphrase' });
      if (!o.mfaToken && MFA_PROMPT.test(stderr)) return finish({ kind: 'need-mfa' });
      finish({ kind: 'error', message: explainAwsVaultError(stderr.trim() || `aws-vault exited with code ${code}`) });
    });
  });
}

/** Rows of `aws-vault list`: profile, stored credentials ('-' if none), cached sessions ('-' if none). */
function parseList(listOutput: string): { profile: string; credentials: string; sessions: string }[] {
  const lines = listOutput.split(/\r?\n/);
  const start = lines.findIndex((l) => /^=+/.test(l.trim()));
  return lines
    .slice(start + 1)
    .map((l) => l.trim().split(/\s{2,}/))
    .filter((cols) => cols.length >= 3)
    .map(([profile, credentials, sessions]) => ({ profile, credentials, sessions }));
}

/** Profiles that have long-lived keys stored, parsed from `aws-vault list` output. */
export function profilesWithKeys(listOutput: string): string[] {
  return parseList(listOutput)
    .filter((r) => r.credentials !== '-')
    .map((r) => r.profile);
}

/** Whether `aws-vault list` shows a cached session for the profile with at least a few minutes left. */
export function hasCachedSession(listOutput: string, profiles: string[]): boolean {
  return parseList(listOutput)
    .filter((r) => profiles.includes(r.profile) && r.sessions !== '-')
    .some((row) => row.sessions.split(/,\s*/).some((s) => {
    const m = /:(?:(\d+)h)?(?:(\d+)m)?/.exec(s);
    return !!m && Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) >= 5;
  }));
}

function awsVaultList(awsVault: string, backend: string | undefined, path: string): Promise<string> {
  const env = cleanAwsEnv(path);
  if (backend) env.AWS_VAULT_BACKEND = backend;
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(awsVault, ['list'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

const listKeys = async (awsVault: string, backend: string, path: string) => profilesWithKeys(await awsVaultList(awsVault, backend, path));

/** Ask aws-vault whether a profile can be exported without MFA right now. */
export async function profileHasSession(awsVault: string, backend: string | undefined, profiles: string[], path: string): Promise<boolean> {
  return hasCachedSession(await awsVaultList(awsVault, backend, path), profiles);
}

/**
 * The backend the user's terminal uses may differ from the system environment (e.g. a PowerShell profile
 * sets AWS_VAULT_BACKEND=wincred while a machine-wide variable says "file"). Pick the first backend that
 * actually holds keys, starting with the inherited one.
 */
export async function detectBackend(awsVault: string, path: string): Promise<string | undefined> {
  const inherited = process.env.AWS_VAULT_BACKEND;
  const platformDefaults = process.platform === 'win32' ? ['wincred', 'file'] : process.platform === 'darwin' ? ['keychain', 'file'] : ['secret-service', 'pass', 'file'];
  const candidates = [...new Set([inherited, ...platformDefaults].filter((b): b is string => !!b))];
  for (const backend of candidates) if ((await listKeys(awsVault, backend, path)).length) return backend;
  return undefined;
}

function explainAwsVaultError(msg: string): string {
  const missing = /profile (\S+): credentials missing/.exec(msg);
  if (missing) return `${msg}\n\naws-vault has no access key for ${missing[1]} on this machine. Add it in a terminal first: aws-vault add ${missing[1]}`;
  if (/MultiFactorAuthentication failed|invalid MFA one time pass code/i.test(msg)) return `The MFA code was wrong or already used. Wait for the next code.\n\n${msg}`;
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
