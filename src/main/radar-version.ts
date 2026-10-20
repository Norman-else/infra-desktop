import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO = 'skyhook-io/radar';

const run = (cmd: string, args: string[], timeout: number) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => (err ? reject(new Error(`${stderr || err.message}`.trim())) : resolve(stdout))),
  );

/** "radar 1.17.0" → "1.17.0" */
export function parseRadarVersion(out: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1];
}

export async function radarCurrentVersion(bin: string): Promise<string | undefined> {
  return parseRadarVersion(await run(bin, ['-version'], 10_000));
}

export async function radarLatestVersion(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  const tag = ((await res.json()) as { tag_name?: string }).tag_name;
  if (!tag) throw new Error('No radar release found');
  return tag.replace(/^v/, '');
}

/**
 * The Homebrew formula a binary was installed from (e.g. skyhook-io/tap/radar), with the brew that manages it;
 * undefined when it isn't in a Cellar. The tap matters: plain `brew upgrade radar` would mean the radar cask.
 */
export function brewFormula(bin: string): { brew: string; formula: string } | undefined {
  let real: string;
  try {
    real = realpathSync(bin);
  } catch {
    return undefined;
  }
  const m = /^(.*)\/Cellar\/([^/]+)\/([^/]+)\//.exec(real);
  if (!m) return undefined;
  const [, prefix, name, version] = m;
  const brew = join(prefix, 'bin', 'brew');
  if (!existsSync(brew)) return undefined;
  let tap: string | undefined;
  try {
    tap = (JSON.parse(readFileSync(join(prefix, 'Cellar', name, version, 'INSTALL_RECEIPT.json'), 'utf8')) as { source?: { tap?: string } }).source?.tap;
  } catch {
    /* no receipt: the bare name */
  }
  return { brew, formula: tap && tap !== 'homebrew/core' ? `${tap}/${name}` : name };
}

export async function brewUpgrade(b: { brew: string; formula: string }): Promise<void> {
  // brew refuses to run without its own dir on PATH in some setups.
  const env = { ...process.env, PATH: `${dirname(b.brew)}:${process.env.PATH ?? ''}`, HOMEBREW_NO_INSTALL_CLEANUP: '1' };
  await new Promise<void>((resolve, reject) =>
    execFile(b.brew, ['upgrade', b.formula], { env, timeout: 10 * 60_000 }, (err, _out, stderr) => (err ? reject(new Error(`${stderr || err.message}`.trim())) : resolve())),
  );
}
