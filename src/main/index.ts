import { app, BrowserWindow, ipcMain, Menu, Notification, shell, WebContentsView, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { migrateUserData } from './migrate';
import { importLoginShellEnv } from './paths';
import type { ToolKind } from '../shared/types';
import { EnvManager } from './sessions';
import { createUpdater, type Updater } from './updater';

/** Height of the environment bar drawn by the renderer; the tool's page is shown below it. */
const BAR_HEIGHT = 44;

let win: BrowserWindow | undefined;
let manager: EnvManager;
/** One view per environment and tool, keyed by viewKey(). */
const views = new Map<string, WebContentsView>();
const viewKey = (env: string, tool: ToolKind) => `${env}:${tool}`;
const activeKey = () => (manager.active ? viewKey(manager.active, manager.activeTool) : undefined);
const activeView = () => {
  const key = activeKey();
  return key ? views.get(key) : undefined;
};
let overlayOpen = false;
let updater: Updater | undefined;

const isLocalUrl = (url: string) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url);

function createView(env: string, tool: ToolKind, url: string): WebContentsView {
  const view = new WebContentsView({
    // radar keeps its pre-0.3 partition name, so existing cookies survive.
    webPreferences: { partition: `persist:${tool}-${env}`, sandbox: true, contextIsolation: true },
  });
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isLocalUrl(target)) return { action: 'allow' };
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, target) => {
    if (!isLocalUrl(target)) {
      e.preventDefault();
      void shell.openExternal(target);
    }
  });
  void wc.loadURL(url);
  views.set(viewKey(env, tool), view);
  return view;
}

/** Drop a tool's view, or every view of the env when no tool is given. */
function destroyView(env: string, tool?: ToolKind) {
  for (const [key, view] of views) {
    if (tool ? key !== viewKey(env, tool) : !key.startsWith(`${env}:`)) continue;
    win?.contentView.removeChildView(view);
    view.webContents.close();
    views.delete(key);
  }
}

/** Show only the active env's active tool, unless an HTML overlay (menu / dialog) needs the space. */
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const active = activeKey();
  for (const [key, view] of views) {
    const show = key === active && !overlayOpen;
    const attached = win.contentView.children.includes(view);
    if (show) {
      view.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) });
      if (!attached) win.contentView.addChildView(view);
    } else if (attached) win.contentView.removeChildView(view);
  }
}

function updateTitle() {
  if (!win || win.isDestroyed()) return;
  const env = manager.getState().envs.find((e) => e.name === manager.active);
  win.setTitle(env ? `${env.label} · ${env.clusterName} — Infra Desktop` : 'Infra Desktop');
}

/** Desktop notification for an env whose credentials need MFA; clicking it opens the MFA prompt there. */
function notifyRenewal(name: string, expired: boolean) {
  const env = manager.getState().envs.find((e) => e.name === name);
  if (!env || !Notification.isSupported()) return;
  const left = env.credsExpiresAt ? Math.max(0, Math.round((env.credsExpiresAt - Date.now()) / 60_000)) : 0;
  const n = new Notification({
    title: expired ? `${env.label}: AWS credentials expired` : `${env.label}: AWS credentials expire in ${left} min`,
    body: 'Click to enter an MFA code and renew without restarting Radar or Vault.',
  });
  n.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    void manager.switchTo(name).then(() => manager.session(name).renew());
  });
  n.show();
}

function sendCommand(cmd: string) {
  win?.webContents.send('command', cmd);
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Environment',
      submenu: [
        { label: 'Switch Environment…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendCommand('switcher') },
        { type: 'separator' },
        { label: 'Open Settings File', click: () => void shell.openPath(manager.settingsPath) },
        { label: 'Reload Config', click: () => manager.reload() },
        { label: 'Check for Updates', click: () => void updater?.check() },
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: 'Quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Radar', accelerator: 'CmdOrCtrl+Shift+R', click: () => void manager.setTool('radar') },
        { label: 'Vault', accelerator: 'CmdOrCtrl+Shift+V', click: () => void manager.setTool('vault') },
        { type: 'separator' },
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => activeView()?.webContents.reload() },
        { label: 'Page Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => activeView()?.webContents.toggleDevTools() },
        { label: 'App Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('state:get', () => manager.getState());
  ipcMain.handle('env:switch', (_e, env: string) => manager.switchTo(env));
  ipcMain.handle('env:retry', (_e, env: string) => manager.switchTo(env));
  ipcMain.handle('env:mfa', (_e, env: string, code: string) => manager.session(env).submitMfa(code));
  ipcMain.handle('env:passphrase', (_e, env: string, pass: string) => manager.submitPassphrase(env, pass));
  ipcMain.handle('env:renew', (_e, env: string) => manager.session(env).renew());
  ipcMain.handle('env:cancel', (_e, env: string) => manager.session(env).cancel());
  ipcMain.handle('env:disconnect', (_e, env: string) => manager.session(env).disconnect());
  ipcMain.handle('tool:set', (_e, tool: ToolKind) => manager.setTool(tool));
  ipcMain.handle('vault:configure', (_e, env: string, vault: { addr: string; header?: string; role?: string }) => manager.saveVaultConfig(env, vault));
  ipcMain.handle('overlay:open', async () => {
    const view = activeView();
    let shot: string | null = null;
    if (view && win?.contentView.children.includes(view)) {
      try {
        shot = `data:image/jpeg;base64,${(await view.webContents.capturePage()).toJPEG(70).toString('base64')}`;
      } catch {
        shot = null;
      }
    }
    overlayOpen = true;
    layout();
    return shot;
  });
  ipcMain.handle('overlay:close', () => {
    overlayOpen = false;
    layout();
  });
  ipcMain.handle('settings:open', () => shell.openPath(manager.settingsPath));
  ipcMain.handle('settings:reload', () => manager.reload());
  ipcMain.handle('update:check', () => updater?.check());
  ipcMain.handle('vault:check-update', () => manager.checkVaultUpdate());
  ipcMain.handle('update:install', () => updater?.install());
}

async function main() {
  // Lets a test/dev run use its own settings and state (RADAR_DESKTOP_DATA_DIR: name before the rename).
  const dataDirOverride = process.env.INFRA_DESKTOP_DATA_DIR ?? process.env.RADAR_DESKTOP_DATA_DIR;
  if (dataDirOverride) app.setPath('userData', dataDirOverride);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Windows shows notifications only for apps with an AppUserModelID (matches electron-builder's appId).
  if (process.platform === 'win32') app.setAppUserModelId('io.radar.desktop');
  await app.whenReady();
  await importLoginShellEnv();
  // The app was called Radar Desktop before 0.2.0; bring its settings along once.
  if (!dataDirOverride) migrateUserData(join(app.getPath('appData'), 'Radar Desktop'), app.getPath('userData'));

  manager = new EnvManager(app.getPath('userData'));
  manager.on('state', (s) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('state', s);
    updateTitle();
  });
  manager.on('ready', (env: string, tool: ToolKind) => {
    const url = manager.urlOf(env, tool);
    if (url && !views.has(viewKey(env, tool))) createView(env, tool, url);
    layout();
  });
  manager.on('stopped', (env: string, tool?: ToolKind) => {
    destroyView(env, tool);
    layout();
  });
  manager.on('activate', () => layout());
  manager.on('reload-view', (env: string, tool: ToolKind) => views.get(viewKey(env, tool))?.webContents.reload());
  manager.on('renew-needed', (name: string) => notifyRenewal(name, false));
  manager.on('expired', (name: string) => notifyRenewal(name, true));

  registerIpc();
  buildMenu();
  await manager.init();
  updater = createUpdater((u) => {
    manager.update = u;
    manager.emitState();
  });
  manager.update = { ...updater.state };

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: 'Infra Desktop',
    backgroundColor: '#1b1c20',
    // Windows/Linux: keep the menu (and its shortcuts) but only show it while Alt is pressed.
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.on('resize', layout);
  win.on('focus', () => updater?.checkIfStale());
  win.on('closed', () => (win = undefined));
  await win.loadFile(join(__dirname, 'renderer', 'index.html'));

  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => manager?.shutdown());

void main();
