import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Carry settings over from the app's previous data dir (Radar Desktop → Infra Desktop).
 * Only runs when the new dir has no settings yet; the old dir is left as it is.
 */
export function migrateUserData(oldDir: string, newDir: string): 'migrated' | 'skipped' {
  const oldSettings = join(oldDir, 'settings.json');
  const newSettings = join(newDir, 'settings.json');
  if (!existsSync(oldSettings) || existsSync(newSettings)) return 'skipped';

  mkdirSync(newDir, { recursive: true });
  for (const sub of ['kube', 'aws']) {
    const from = join(oldDir, sub);
    if (existsSync(from)) cpSync(from, join(newDir, sub), { recursive: true });
  }
  // Settings last, so an interrupted copy is retried on the next start.
  copyFileSync(oldSettings, newSettings);
  return 'migrated';
}
