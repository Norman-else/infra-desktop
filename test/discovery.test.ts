import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { discoverEnvs, mergeKubeConfigs, parseAwsConfig, singleContextKubeConfig } from '../src/main/discovery';

const awsConfig = `
[default]
region = us-west-2
[profile root]
mfa_serial = arn:aws:iam::111111111111:mfa/someone
[profile dev]
source_profile = root
role_arn = arn:aws:iam::222222222222:role/ops
mfa_serial = arn:aws:iam::111111111111:mfa/someone
[profile sat]
source_profile = root
role_arn = arn:aws:iam::333333333333:role/ops
[profile prod]
source_profile = root
role_arn = arn:aws:iam::444444444444:role/ops
[profile orphan]
role_arn = arn:aws:iam::999999999999:role/ops
`;

const eks = (acct: string, name: string) => `arn:aws:eks:us-west-2:${acct}:cluster/${name}`;
const kubeYaml = YAML.stringify({
  'current-context': 'acme-prod',
  contexts: [
    { name: 'acme-dev', context: { cluster: eks('222222222222', 'acme-dev-us-west-2'), user: eks('222222222222', 'acme-dev-us-west-2') } },
    { name: 'acme-sat', context: { cluster: eks('333333333333', 'acme-sat-us-west-2'), user: eks('333333333333', 'acme-sat-us-west-2') } },
    { name: 'acme-prod', context: { cluster: eks('444444444444', 'acme-prod-us-west-2'), user: eks('444444444444', 'acme-prod-us-west-2') } },
  ],
  clusters: ['222222222222', '333333333333', '444444444444'].map((a, i) => ({
    name: eks(a, ['acme-dev-us-west-2', 'acme-sat-us-west-2', 'acme-prod-us-west-2'][i]),
    cluster: { server: `https://${a}.eks.amazonaws.com` },
  })),
  users: ['222222222222', '333333333333', '444444444444'].map((a, i) => ({
    name: eks(a, ['acme-dev-us-west-2', 'acme-sat-us-west-2', 'acme-prod-us-west-2'][i]),
    user: { exec: { command: 'aws', args: ['eks', 'get-token'] } },
  })),
});

describe('discoverEnvs', () => {
  const profiles = parseAwsConfig(awsConfig);
  const kube = mergeKubeConfigs([kubeYaml]);

  it('maps role profiles to contexts by AWS account and orders by risk', () => {
    const envs = discoverEnvs(profiles, kube);
    expect(envs.map((e) => [e.name, e.context, e.clusterName])).toEqual([
      ['dev', 'acme-dev', 'acme-dev-us-west-2'],
      ['sat', 'acme-sat', 'acme-sat-us-west-2'],
      ['prod', 'acme-prod', 'acme-prod-us-west-2'],
    ]);
    expect(envs[2].color).toBe('#c62828');
    expect(envs[0].region).toBe('us-west-2');
  });

  it('applies overrides', () => {
    const envs = discoverEnvs(profiles, kube, { sat: { hidden: true }, dev: { label: 'Development', color: '#000' } });
    expect(envs.map((e) => e.name)).toEqual(['dev', 'prod']);
    expect(envs[0].label).toBe('Development');
  });

  it('writes a kubeconfig with only the chosen context', () => {
    const out = YAML.parse(singleContextKubeConfig(kube, 'acme-sat'));
    expect(out['current-context']).toBe('acme-sat');
    expect(out.contexts).toHaveLength(1);
    expect(out.clusters).toHaveLength(1);
    expect(out.users[0].user.exec.command).toBe('aws');
  });
});

describe('ports', () => {
  it('assigns 9281, 9282, … in list order and keeps configured ports', () => {
    const envs = discoverEnvs(parseAwsConfig(awsConfig), mergeKubeConfigs([kubeYaml]), { sat: { port: 9282 }, prod: { port: 9500 } });
    expect(envs.map((e) => [e.name, e.port])).toEqual([
      ['dev', 9281],
      ['sat', 9282],
      ['prod', 9500],
    ]);
    const clash = discoverEnvs(parseAwsConfig(awsConfig), mergeKubeConfigs([kubeYaml]), { dev: { port: 9282 } });
    expect(clash.map((e) => e.port)).toEqual([9282, 9281, 9283]);
  });
});

describe('vault ports', () => {
  it('vault ports default to radar port + 10', () => {
    const envs = discoverEnvs(parseAwsConfig(awsConfig), mergeKubeConfigs([kubeYaml]), { prod: { vault: { port: 9600 } } });
    expect(envs.map((e) => [e.name, e.vaultPort])).toEqual([
      ['dev', 9291],
      ['sat', 9292],
      ['prod', 9600],
    ]);
  });
});
