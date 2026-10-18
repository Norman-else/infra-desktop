import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, RadarDesktopApi } from '../shared/types';

const api: RadarDesktopApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => ipcRenderer.on('state', (_e, s: AppState) => cb(s)),
  onCommand: (cb) => ipcRenderer.on('command', (_e, cmd: string) => cb(cmd)),
  switchTo: (env) => ipcRenderer.invoke('env:switch', env),
  submitMfa: (env, code) => ipcRenderer.invoke('env:mfa', env, code),
  submitPassphrase: (env, pass) => ipcRenderer.invoke('env:passphrase', env, pass),
  renew: (env) => ipcRenderer.invoke('env:renew', env),
  cancel: (env) => ipcRenderer.invoke('env:cancel', env),
  disconnect: (env) => ipcRenderer.invoke('env:disconnect', env),
  retry: (env) => ipcRenderer.invoke('env:retry', env),
  openOverlay: () => ipcRenderer.invoke('overlay:open'),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  reloadConfig: () => ipcRenderer.invoke('settings:reload'),
};

contextBridge.exposeInMainWorld('radarDesktop', api);
