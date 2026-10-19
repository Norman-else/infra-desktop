import { app, BrowserWindow, ipcMain, Menu, Notification, shell, WebContentsView, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { importLoginShellEnv } from './paths';
import { EnvManager } from './sessions';
import { createUpdater, type Updater } from './updater';

/** Height of the environment bar drawn by the renderer; radar is shown below it. */
const BAR_HEIGHT = 44;

let win: BrowserWindow | undefined;
let manager: EnvManager;
const views = new Map<string, WebContentsView>();
let overlayOpen = false;
let updater: Updater | undefined;

const isRadarUrl = (url: string) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url);

function createView(name: string, url: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: { partition: `persist:radar-${name}`, sandbox: true, contextIsolation: true },
  });
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isRadarUrl(target)) return { action: 'allow' };
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, target) => {
    if (!isRadarUrl(target)) {
      e.preventDefault();
      void shell.openExternal(target);
    }
  });
  void wc.loadURL(url);
  views.set(name, view);
  return view;
}

function destroyView(name: string) {
  const view = views.get(name);
  if (!view) return;
  win?.contentView.removeChildView(view);
  view.webContents.close();
  views.delete(name);
}

/** Show only the active env's radar view, unless an HTML overlay (menu / dialog) needs the space. */
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const active = manager.active;
  for (const [name, view] of views) {
    const show = name === active && !overlayOpen;
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
  win.setTitle(env ? `${env.label} · ${env.clusterName} — Radar Desktop` : 'Radar Desktop');
}

/** Desktop notification for an env whose credentials need MFA; clicking it opens the MFA prompt there. */
function notifyRenewal(name: string, expired: boolean) {
  const env = manager.getState().envs.find((e) => e.name === name);
  if (!env || !Notification.isSupported()) return;
  const left = env.credsExpiresAt ? Math.max(0, Math.round((env.credsExpiresAt - Date.now()) / 60_000)) : 0;
  const n = new Notification({
    title: expired ? `${env.label}: AWS credentials expired` : `${env.label}: AWS credentials expire in ${left} min`,
    body: 'Click to enter an MFA code and renew without restarting radar.',
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
  const activeView = () => (manager.active ? views.get(manager.active) : undefined);
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
        { label: 'Reload Radar', accelerator: 'CmdOrCtrl+R', click: () => activeView()?.webContents.reload() },
        { label: 'Radar Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => activeView()?.webContents.toggleDevTools() },
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
  ipcMain.handle('overlay:open', async () => {
    const view = manager.active ? views.get(manager.active) : undefined;
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
  ipcMain.handle('update:install', () => updater?.install());
}

async function main() {
  // Lets a test/dev run use its own settings and state.
  if (process.env.RADAR_DESKTOP_DATA_DIR) app.setPath('userData', process.env.RADAR_DESKTOP_DATA_DIR);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Windows shows notifications only for apps with an AppUserModelID (matches electron-builder's appId).
  if (process.platform === 'win32') app.setAppUserModelId('io.radar.desktop');
  await app.whenReady();
  await importLoginShellEnv();

  manager = new EnvManager(app.getPath('userData'));
  manager.on('state', (s) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('state', s);
    updateTitle();
  });
  manager.on('ready', (name: string) => {
    const url = manager.urlOf(name);
    if (url && !views.has(name)) createView(name, url);
    layout();
  });
  manager.on('stopped', (name: string) => {
    destroyView(name);
    layout();
  });
  manager.on('activate', () => layout());
  manager.on('reload-view', (name: string) => views.get(name)?.webContents.reload());
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
    title: 'Radar Desktop',
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
