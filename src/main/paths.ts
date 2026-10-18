import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const isWin = process.platform === 'win32';
const home = homedir();

function extraDirs(): string[] {
  if (isWin) {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [
      join(home, 'scoop', 'shims'),
      join(home, '.krew', 'bin'),
      'C:\\Program Files\\aws-vault',
      'C:\\Program Files\\Amazon\\AWSCLIV2',
      join(local, 'Microsoft', 'WinGet', 'Links'),
    ];
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.krew', 'bin'), join(home, 'go', 'bin'), '/usr/bin', '/bin'];
}

/** Variables a terminal user typically sets in their shell rc that matter to aws-vault / kubectl. */
const IMPORTED_VARS = /^(PATH|KUBECONFIG|AWS_VAULT_[A-Z_]+|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|AWS_REGION|AWS_DEFAULT_REGION)$/;

/**
 * macOS GUI apps don't see variables from ~/.zshrc etc. Read them from a login shell once at startup
 * and merge them into process.env (PATH is merged, other variables only fill gaps).
 */
export async function importLoginShellEnv(): Promise<void> {
  if (isWin) return;
  const shell = process.env.SHELL || '/bin/zsh';
  const out = await new Promise<string>((resolve) => {
    execFile(shell, ['-ilc', 'echo __ENV_START__; env; echo __ENV_END__'], { timeout: 8000 }, (_e, stdout) => resolve(stdout ?? ''));
  });
  const body = out.split('__ENV_START__')[1]?.split('__ENV_END__')[0] ?? '';
  for (const line of body.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1);
    if (!IMPORTED_VARS.test(key)) continue;
    if (key === 'PATH') process.env.PATH = `${value}${delimiter}${process.env.PATH ?? ''}`;
    else process.env[key] ??= value;
  }
}

/** PATH used both to find binaries and for child processes (radar runs `aws eks get-token`). */
export function effectivePath(): string {
  const parts = [...(process.env.PATH ?? process.env.Path ?? '').split(delimiter), ...extraDirs()];
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** Like `which`, but only returns directly executable files (on Windows: .exe). */
export function which(names: string[]): string | undefined {
  const dirs = effectivePath().split(delimiter);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, isWin ? `${name}.exe` : name);
      if (isFile(candidate)) return unshim(candidate);
    }
  }
  return undefined;
}

/** Scoop shims spawn the real exe as a child; killing the shim may leave it running, so use the target directly. */
function unshim(exe: string): string {
  const shim = exe.replace(/\.exe$/i, '.shim');
  if (!isWin || !existsSync(shim)) return exe;
  const target = /^path\s*=\s*"?([^"\r\n]+)"?/m.exec(readFileSync(shim, 'utf8'))?.[1];
  return target && isFile(target) ? target : exe;
}

export function resolveBinary(configured: string | undefined, names: string[]): string | undefined {
  if (configured) return isFile(configured) ? configured : undefined;
  return which(names);
}

export function kubeconfigPaths(configured?: string): string[] {
  const raw = configured ?? process.env.KUBECONFIG;
  const list = raw ? raw.split(delimiter).filter(Boolean) : [join(home, '.kube', 'config')];
  return list.map((p) => p.replace(/^~(?=[/\\])/, home));
}

export function awsConfigPath(): string {
  return process.env.AWS_CONFIG_FILE ?? join(home, '.aws', 'config');
}
