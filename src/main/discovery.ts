import { parse as parseIni } from 'ini';
import YAML from 'yaml';
import type { EnvInfo } from '../shared/types';

export interface EnvOverride {
  context?: string;
  color?: string;
  label?: string;
  hidden?: boolean;
}

export interface AwsProfile {
  name: string;
  roleArn?: string;
  region?: string;
  mfaSerial?: string;
  sourceProfile?: string;
}

interface NamedEntry<T> { name: string; [k: string]: unknown; context?: T; cluster?: T; user?: T }
export interface KubeConfig {
  'current-context'?: string;
  contexts?: NamedEntry<{ cluster: string; user: string; namespace?: string }>[];
  clusters?: NamedEntry<{ server: string }>[];
  users?: NamedEntry<unknown>[];
  [k: string]: unknown;
}

export function parseAwsConfig(text: string): AwsProfile[] {
  const data = parseIni(text) as Record<string, Record<string, string>>;
  const defaultRegion = data['default']?.region;
  return Object.entries(data).map(([section, v]) => ({
    name: section === 'default' ? 'default' : section.replace(/^profile\s+/, ''),
    roleArn: v.role_arn,
    region: v.region ?? defaultRegion,
    mfaSerial: v.mfa_serial,
    sourceProfile: v.source_profile,
  }));
}

/** Merge kubeconfig files the way kubectl does: first occurrence of a name wins. */
export function mergeKubeConfigs(texts: string[]): KubeConfig {
  const out: KubeConfig = { contexts: [], clusters: [], users: [] };
  for (const text of texts) {
    const doc = (YAML.parse(text) ?? {}) as KubeConfig;
    out['current-context'] ??= doc['current-context'];
    for (const key of ['contexts', 'clusters', 'users'] as const) {
      for (const entry of doc[key] ?? []) {
        if (!out[key]!.some((e) => e.name === entry.name)) out[key]!.push(entry as never);
      }
    }
  }
  return out;
}

const accountOf = (arn?: string) => arn?.split(':')[4];

function contextClusterRef(kube: KubeConfig, ctxName: string): string {
  const ctx = kube.contexts?.find((c) => c.name === ctxName);
  const clusterName = ctx?.context?.cluster ?? '';
  const server = kube.clusters?.find((c) => c.name === clusterName)?.cluster?.server ?? '';
  return `${clusterName} ${server}`;
}

/** Find the kube context for a profile: same AWS account as the role, preferring a name match. */
export function matchContext(profile: AwsProfile, kube: KubeConfig): string | undefined {
  const contexts = (kube.contexts ?? []).map((c) => c.name);
  const account = accountOf(profile.roleArn);
  const byAccount = account ? contexts.filter((c) => c.includes(account) || contextClusterRef(kube, c).includes(account)) : [];
  const nameHit = (list: string[]) =>
    list.find((c) => c === profile.name) ??
    list.find((c) => new RegExp(`(^|[-_./:])${escapeRe(profile.name)}($|[-_./:])`).test(c));
  if (byAccount.length === 1) return byAccount[0];
  if (byAccount.length > 1) return nameHit(byAccount) ?? byAccount[0];
  return nameHit(contexts);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function defaultColor(name: string): string {
  const n = name.toLowerCase();
  if (/prod|prd|live/.test(n)) return '#c62828';
  if (/sat|stag|stg|uat|qa|test|pre/.test(n)) return '#c98a10';
  if (/dev|sandbox|local/.test(n)) return '#1f8f4e';
  return '#3d6fd6';
}

function riskRank(color: string): number {
  return ['#1f8f4e', '#3d6fd6', '#c98a10', '#c62828'].indexOf(color);
}

/** Readable cluster name from an EKS ARN like arn:aws:eks:us-west-2:123:cluster/foo */
export function clusterDisplayName(kube: KubeConfig, ctxName: string): string {
  const ctx = kube.contexts?.find((c) => c.name === ctxName);
  const cluster = ctx?.context?.cluster ?? ctxName;
  return cluster.includes(':cluster/') ? cluster.split(':cluster/')[1] : cluster;
}

export function discoverEnvs(profiles: AwsProfile[], kube: KubeConfig, overrides: Record<string, EnvOverride> = {}): EnvInfo[] {
  const envs: EnvInfo[] = [];
  for (const p of profiles) {
    const o = overrides[p.name] ?? {};
    if (o.hidden) continue;
    // Only profiles that assume a role or were explicitly configured are environments.
    if (!p.roleArn && !o.context) continue;
    const context = o.context ?? matchContext(p, kube);
    if (!context || !kube.contexts?.some((c) => c.name === context)) continue;
    const color = o.color ?? defaultColor(p.name);
    envs.push({
      name: p.name,
      profile: p.name,
      sourceProfile: p.sourceProfile,
      label: o.label ?? p.name.toUpperCase(),
      color,
      roleArn: p.roleArn,
      region: p.region,
      context,
      clusterName: clusterDisplayName(kube, context),
    });
  }
  return envs.sort((a, b) => riskRank(a.color) - riskRank(b.color) || a.name.localeCompare(b.name));
}

/** A kubeconfig containing only the env's context, so radar can't switch to a cluster these credentials don't cover. */
export function singleContextKubeConfig(kube: KubeConfig, ctxName: string): string {
  const ctx = kube.contexts!.find((c) => c.name === ctxName)!;
  const cluster = kube.clusters?.find((c) => c.name === ctx.context?.cluster);
  const user = kube.users?.find((u) => u.name === ctx.context?.user);
  const doc = {
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': ctxName,
    contexts: [ctx],
    clusters: cluster ? [cluster] : [],
    users: user ? [user] : [],
  };
  return YAML.stringify(doc);
}
