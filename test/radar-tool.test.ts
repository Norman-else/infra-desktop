import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvInfo } from '../src/shared/types';
import type { ToolContext } from '../src/main/tools/tool';
import { RadarTool } from '../src/main/tools/radar';
import { freePort } from '../src/main/radar';

const fixture = join(__dirname, 'fixtures', 'fake-radar.mjs');
const tools: RadarTool[] = [];
afterEach(() => tools.splice(0).forEach((t) => t.stop()));

async function makeTool(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-tool-'));
  const info: EnvInfo = { name: 'dev', label: 'DEV', color: '#1f8f4e', profile: 'dev', context: 'acme-dev', clusterName: 'acme-dev', port: await freePort(), vaultPort: 0 };
  const events: string[] = [];
  const ctx: ToolContext = {
    env: info,
    credentialEnv: () => ({ ...process.env, ...env }),
    kubeconfig: () => join(dir, 'kubeconfig.yaml'),
    settings: {},
    binaries: { radar: [process.execPath, fixture] },
    onChange: () => {},
    emit: (e) => events.push(e),
  };
  const tool = new RadarTool(ctx);
  tools.push(tool);
  return { tool, info, dir, events };
}

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

describe('RadarTool', () => {
  it('starts and reports ok health', async () => {
    const { tool, info } = await makeTool({ FAKE_RADAR_STATE: 'connected' });
    await tool.start();
    expect(tool.state.status).toBe('ready');
    expect(tool.state.url).toBe(`http://127.0.0.1:${info.port}/`);
    await waitFor(() => !!tool.state.health);
    expect(tool.state.health).toEqual({ state: 'ok', text: 'Cluster connected' });
  });

  it('maps auth failures to a short label', async () => {
    const { tool } = await makeTool({ FAKE_RADAR_STATE: 'disconnected', FAKE_RADAR_ERROR_TYPE: 'auth-rejected' });
    await tool.start();
    await waitFor(() => !!tool.state.health);
    expect(tool.state.health).toMatchObject({ state: 'failed', text: 'Auth rejected' });
    expect(tool.state.health?.detail).toMatch(/credentials/);
  });

  it('retries the connection after renewal when it was down', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'retry-')), 'retry.log');
    const { tool } = await makeTool({ FAKE_RADAR_STATE: 'disconnected', FAKE_RADAR_ERROR_TYPE: 'auth-rejected', FAKE_RADAR_RETRY_LOG: log, FAKE_RADAR_RETRY_CONNECTS: '0' });
    await tool.start();
    await waitFor(() => !!tool.state.health);
    await tool.onCredentialsRenewed();
    expect(existsSync(log) && readFileSync(log, 'utf8')).toBe('retry\n');
  });

  it('re-checks health on renewal, so a drop the last poll missed still gets a retry and a reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'renew-'));
    const [log, stateFile] = [join(dir, 'retry.log'), join(dir, 'state')];
    const { tool, events } = await makeTool({ FAKE_RADAR_RETRY_LOG: log, FAKE_RADAR_STATE_FILE: stateFile, FAKE_RADAR_ERROR_TYPE: 'auth-rejected', FAKE_RADAR_RETRY_CONNECTS: '2' });
    await tool.start();
    expect(tool.state.health?.state).toBe('ok');
    writeFileSync(stateFile, 'disconnected'); // radar demoted itself after the last health poll
    await tool.onCredentialsRenewed();
    expect(readFileSync(log, 'utf8')).toBe('retry\n');
    // It reported `connecting` for a while; the page is reloaded only once it is connected.
    expect(tool.state.health?.state).toBe('ok');
    expect(events).toEqual(['reload-view']);
  });

  it('leaves a connected radar alone on renewal', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'renew-')), 'retry.log');
    const { tool, events } = await makeTool({ FAKE_RADAR_STATE: 'connected', FAKE_RADAR_RETRY_LOG: log });
    await tool.start();
    await tool.onCredentialsRenewed();
    expect(existsSync(log)).toBe(false);
    expect(events).toEqual([]);
  });

  it('reports an error when radar exits', async () => {
    const { tool } = await makeTool({ FAKE_RADAR_EXIT: '1' });
    await tool.start();
    expect(tool.state.status).toBe('error');
    expect(tool.state.message).toMatch(/exited/);
  });
});
