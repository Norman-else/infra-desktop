import { describe, expect, it, vi } from 'vitest';
import { discoverVault, vaultFromCluster } from '../src/main/vault-discovery';

const cr = (roles: { name: string; bound_iam_principal_arn: string | string[] }[]) => ({
  items: [
    {
      metadata: { name: 'vault', namespace: 'vault' },
      spec: {
        externalConfig: {
          auth: [
            { type: 'kubernetes', roles: [{ name: 'svc', bound_service_account_names: 'svc' }] },
            { type: 'aws', config: { iam_server_id_header_value: 'vault.dev.example' }, roles },
          ],
        },
      },
    },
  ],
});
const ingresses = {
  items: [
    { metadata: { namespace: 'default' }, spec: { rules: [{ host: 'vault-ui.dev.example', http: { paths: [{ backend: { service: { name: 'vault' } } }] } }] } },
    { metadata: { namespace: 'vault' }, spec: { rules: [{ host: 'vault.internal.dev.example', http: { paths: [{ backend: { service: { name: 'vault' } } }] } }] } },
  ],
};
const ops = 'arn:aws:iam::222222222222:role/ops';

describe('vaultFromCluster', () => {
  it('reads address, header and the role bound to the profile role', () => {
    const vaults = cr([
      { name: 'readers', bound_iam_principal_arn: 'arn:aws:iam::222222222222:role/readonly' },
      { name: 'vault_admin', bound_iam_principal_arn: [ops] },
    ]);
    expect(vaultFromCluster(vaults, ingresses, ops)).toEqual({ addr: 'https://vault.internal.dev.example', header: 'vault.dev.example', role: 'vault_admin' });
  });

  it('matches wildcard principals', () => {
    expect(vaultFromCluster(cr([{ name: 'a', bound_iam_principal_arn: 'arn:aws:iam::1:role/x' }, { name: 'b', bound_iam_principal_arn: 'arn:aws:iam::222222222222:role/*' }]), ingresses, ops).role).toBe('b');
  });

  it('uses the only AWS role when none is bound to the profile role', () => {
    expect(vaultFromCluster(cr([{ name: 'vault_admin', bound_iam_principal_arn: 'arn:aws:iam::9:role/other' }]), ingresses, ops).role).toBe('vault_admin');
  });

  it('leaves the role out when it is ambiguous', () => {
    const vaults = cr([
      { name: 'a', bound_iam_principal_arn: 'arn:aws:iam::9:role/a' },
      { name: 'b', bound_iam_principal_arn: 'arn:aws:iam::9:role/b' },
    ]);
    expect(vaultFromCluster(vaults, ingresses, ops).role).toBeUndefined();
  });

  it('nothing without a Vault resource', () => {
    expect(vaultFromCluster({ items: [] }, ingresses, ops)).toEqual({});
  });
});

describe('discoverVault', () => {
  it('falls back to the vault namespace when listing all namespaces is forbidden', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('--all-namespaces')) throw new Error('Forbidden');
      if (args[1].startsWith('vaults')) return JSON.stringify(cr([{ name: 'vault_admin', bound_iam_principal_arn: ops }]));
      return JSON.stringify({ items: [ingresses.items[1]] });
    });
    expect(await discoverVault('kubectl', {}, ops, run)).toEqual({ addr: 'https://vault.internal.dev.example', header: 'vault.dev.example', role: 'vault_admin' });
    expect(run.mock.calls.at(-1)![0]).toEqual(['get', 'ingresses.networking.k8s.io', '-n', 'vault', '-o', 'json']);
  });

  it('nothing when the cluster has no bank-vaults Vault', async () => {
    expect(await discoverVault('kubectl', {}, ops, async () => { throw new Error('the server doesn\'t have a resource type'); })).toEqual({});
  });
});
