import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialServer, fetchCredentials } from '../src/main/credentials';
import { effectivePath, which } from '../src/main/paths';

const fake = join(__dirname, 'fake-aws-vault', process.platform === 'win32' ? 'fake-aws-vault.exe' : 'fake-aws-vault');
const session = join(tmpdir(), 'fake-aws-vault-session');

describe.skipIf(!existsSync(fake))('fetchCredentials (fake aws-vault)', () => {
  beforeAll(() => rmSync(session, { force: true }));
  const opts = { awsVault: fake, profile: 'dev', path: effectivePath() };

  it('reports need-mfa when aws-vault prompts', async () => {
    expect((await fetchCredentials(opts)).kind).toBe('need-mfa');
  });

  it('explains a rejected MFA code', async () => {
    const r = await fetchCredentials({ ...opts, mfaToken: '000000' });
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.message).toMatch(/MFA 验证码错误/);
  });

  it('returns credentials with a token, then reuses the cached session', async () => {
    const r = await fetchCredentials({ ...opts, mfaToken: '123456' });
    expect(r.kind === 'ok' && r.creds.AccessKeyId).toBe('ASIAFAKEDEV');
    const again = await fetchCredentials({ ...opts, profile: 'sat' });
    expect(again.kind === 'ok' && again.creds.AccessKeyId).toBe('ASIAFAKESAT');
  });
});

describe('CredentialServer', () => {
  const server = new CredentialServer();
  beforeAll(() => server.start());
  afterAll(() => server.stop());
  const creds = { AccessKeyId: 'AKIDTEST', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3600e3).toISOString() };

  it('serves ECS-format credentials only with the right token', async () => {
    const { uri, token } = server.register('dev');
    expect((await fetch(uri, { headers: { authorization: token } })).status).toBe(503);
    server.set('dev', creds);
    expect((await fetch(uri)).status).toBe(403);
    const body = await (await fetch(uri, { headers: { authorization: token } })).json();
    expect(body).toMatchObject({ AccessKeyId: 'AKIDTEST', Token: 't' });
  });

  // Async: the server lives in this process, so a sync exec would block it.
  it.skipIf(!which(['aws']))('is accepted by the AWS CLI credential chain', async () => {
    const { uri, token } = server.register('cli');
    server.set('cli', creds);
    const { stdout: out } = await promisify(execFile)(which(['aws'])!, ['configure', 'export-credentials', '--format', 'process'], {
      env: {
        PATH: effectivePath(),
        SystemRoot: process.env.SystemRoot,
        AWS_CONTAINER_CREDENTIALS_FULL_URI: uri,
        AWS_CONTAINER_AUTHORIZATION_TOKEN: token,
        AWS_CONFIG_FILE: join(tmpdir(), 'nonexistent-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: join(tmpdir(), 'nonexistent-aws-creds'),
      },
    });
    expect(JSON.parse(out).AccessKeyId).toBe('AKIDTEST');
  });
});
