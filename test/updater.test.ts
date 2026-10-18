import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));
const { isNewer } = await import('../src/main/updater');

describe('isNewer', () => {
  it('compares semver parts numerically', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('v1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });
});
