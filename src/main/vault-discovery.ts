import { execFile } from 'node:child_process';

/** Vault settings found in the cluster; any field may be missing. */
export interface DiscoveredVault {
  addr?: string;
  header?: string;
  role?: string;
}

interface K8sList<T> {
  items?: T[];
}
interface VaultCR {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    externalConfig?: {
      auth?: {
        type?: string;
        path?: string;
        config?: { iam_server_id_header_value?: string };
        roles?: { name?: string; bound_iam_principal_arn?: string | string[] }[];
      }[];
    };
  };
}
interface Ingress {
  metadata?: { namespace?: string };
  spec?: {
    tls?: { hosts?: string[] }[];
    rules?: { host?: string; http?: { paths?: { backend?: { service?: { name?: string } } }[] } }[];
  };
}

/** `*` in a bound principal ARN matches anything, as in Vault's AWS auth. */
const arnMatches = (pattern: string, arn: string) =>
  new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(arn);

/**
 * Vault address, IAM server ID header and AWS auth role from a bank-vaults `Vault` resource and the
 * Ingress in front of its Service. The role is the one bound to `roleArn` (or the only AWS role).
 */
export function vaultFromCluster(vaults: K8sList<VaultCR>, ingresses: K8sList<Ingress>, roleArn?: string): DiscoveredVault {
  const cr = vaults.items?.[0];
  if (!cr) return {};
  const found: DiscoveredVault = {};
  const aws = cr.spec?.externalConfig?.auth?.find((a) => a.type === 'aws');
  if (aws?.config?.iam_server_id_header_value) found.header = aws.config.iam_server_id_header_value;
  const roles = (aws?.roles ?? []).filter((r) => r.name);
  const bound = roleArn
    ? roles.find((r) => [r.bound_iam_principal_arn ?? []].flat().some((p) => arnMatches(p, roleArn)))
    : undefined;
  const role = bound ?? (roles.length === 1 ? roles[0] : undefined);
  if (role) found.role = role.name;

  // bank-vaults names the Vault Service after the resource.
  const service = cr.metadata?.name;
  for (const ing of ingresses.items ?? []) {
    if (ing.metadata?.namespace && cr.metadata?.namespace && ing.metadata.namespace !== cr.metadata.namespace) continue;
    const rule = ing.spec?.rules?.find((r) => r.host && r.http?.paths?.some((p) => p.backend?.service?.name === service));
    if (rule?.host) {
      // TLS is usually terminated at the load balancer, so https even without an Ingress tls section.
      found.addr = `https://${rule.host}`;
      break;
    }
  }
  return found;
}

type Kubectl = (args: string[]) => Promise<string>;

/** Look Vault up in the env's cluster with kubectl (its kubeconfig and credentials are in `env`). */
export async function discoverVault(kubectl: string, env: NodeJS.ProcessEnv, roleArn?: string, run?: Kubectl): Promise<DiscoveredVault> {
  const k: Kubectl =
    run ??
    ((args) =>
      new Promise((resolve, reject) =>
        execFile(kubectl, args, { env, timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
      ));
  const json = async <T>(args: string[]): Promise<T | undefined> => {
    try {
      return JSON.parse(await k([...args, '-o', 'json'])) as T;
    } catch {
      return undefined;
    }
  };
  // Listing across namespaces may be forbidden; bank-vaults installs into "vault" by convention.
  const vaults =
    (await json<K8sList<VaultCR>>(['get', 'vaults.vault.banzaicloud.com', '--all-namespaces'])) ??
    (await json<K8sList<VaultCR>>(['get', 'vaults.vault.banzaicloud.com', '-n', 'vault']));
  const ns = vaults?.items?.[0]?.metadata?.namespace;
  if (!vaults || !ns) return {};
  const ingresses = (await json<K8sList<Ingress>>(['get', 'ingresses.networking.k8s.io', '-n', ns])) ?? {};
  return vaultFromCluster(vaults, ingresses, roleArn);
}
