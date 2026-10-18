import type { AppState, EnvState, RadarDesktopApi } from '../shared/types';

declare global {
  interface Window { radarDesktop: RadarDesktopApi }
}

const api = window.radarDesktop;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bar = $('bar');
const body = $('body');
const overlay = $('overlay');
const backdrop = $<HTMLImageElement>('backdrop');
const overlayContent = $('overlay-content');

let state: AppState = { envs: [], active: null, problems: [], settingsPath: '', update: { status: 'disabled', current: '' } };
let menuOpen = false;
/** The ⚙ menu: settings, config reload, version and updates */
let appMenuOpen = false;
let menuFocus = 0;
let overlayShown = false;
let renderedOverlayKey = '';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const activeEnv = (): EnvState | undefined => state.envs.find((e) => e.name === state.active);
const isMac = navigator.platform.toLowerCase().includes('mac');
// Ctrl+K is radar's own search, so the switcher uses Ctrl+Shift+E.
const shortcut = isMac ? '⇧⌘E' : 'Ctrl+Shift+E';

function remaining(ms?: number): string | undefined {
  if (!ms) return undefined;
  const min = Math.round((ms - Date.now()) / 60_000);
  if (min <= 0) return 'expired';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

const ERROR_TYPES: Record<string, string> = {
  'auth-rejected': 'authentication rejected',
  unreachable: 'cluster unreachable',
  timeout: 'timed out',
  forbidden: 'forbidden',
};

function clusterText(e: EnvState): { text: string; cls: string } {
  const c = e.cluster;
  if (!c) return { text: 'Checking cluster…', cls: '' };
  if (c.state === 'connected') return { text: '● Cluster connected', cls: 'ok' };
  if (c.state === 'connecting') return { text: 'Connecting to cluster…', cls: '' };
  return { text: `⚠ Cluster connection failed${c.errorType ? `: ${ERROR_TYPES[c.errorType] ?? c.errorType}` : ''}`, cls: 'bad' };
}

/** Short status for the menu and cards; `title` holds the full text for a tooltip. */
function statusText(e: EnvState): { text: string; cls: string; title?: string } {
  if (e.prompt === 'mfa') return { text: 'Waiting for MFA', cls: 'bad' };
  if (e.prompt === 'passphrase') return { text: 'Waiting for password', cls: 'bad' };
  switch (e.status) {
    case 'ready': {
      const r = remaining(e.credsExpiresAt);
      const c = clusterText(e);
      if (c.cls === 'bad') {
        const t = e.cluster?.errorType;
        return { text: `⚠ ${t === 'auth-rejected' ? 'Auth rejected' : t ? (ERROR_TYPES[t] ?? t) : 'Cluster error'}`, cls: 'bad', title: c.text };
      }
      return { text: e.renewNeedsMfa ? `Renewal needed · ${r} left` : `Running${r ? ` · ${r} left` : ''}`, cls: e.renewNeedsMfa ? 'bad' : 'ok' };
    }
    case 'checking':
    case 'connecting':
      return { text: 'Connecting…', cls: '' };
    case 'error':
      return { text: 'Error', cls: 'bad' };
    default:
      return { text: 'Not connected', cls: '' };
  }
}

// ---------------------------------------------------------------- bar

function updateHtml(): string {
  const u = state.update;
  if (u.status === 'ready') return `<button class="update-btn" data-act="install-update">⬆ v${esc(u.version ?? '')} ready · Restart to update</button>`;
  if (u.status === 'downloading') return `<span class="meta">⬇ Downloading update ${u.progress ?? 0}%</span>`;
  return '';
}

function gearHtml(): string {
  const dot = state.update.status === 'ready' || state.problems.length ? '<span class="dot"></span>' : '';
  return `<button class="gear-btn ${appMenuOpen ? 'open' : ''}" data-act="app-menu" title="Settings and updates">⚙${dot}</button>`;
}

function renderBar() {
  const e = activeEnv();
  bar.style.setProperty('--env', e ? e.color : '#50525a');
  if (!e) {
    bar.innerHTML = `<span class="env-name">Not connected</span><span class="cluster">Choose an environment</span><span class="spacer"></span>${updateHtml()}
      <button class="switch-btn" data-act="menu">Switch environment ▾<span class="kbd">${shortcut}</span></button>${gearHtml()}`;
    return;
  }
  const r = remaining(e.credsExpiresAt);
  let meta = '';
  if (e.status === 'ready') {
    // Cluster reachability first: valid AWS credentials don't mean radar can talk to the cluster.
    const c = clusterText(e);
    meta = `<span class="health ${c.cls}" title="${esc(e.cluster?.error ?? '')}">${esc(c.text)}</span>`;
    if (r === 'expired') meta += `<button class="warn-btn" data-act="renew">⚠ AWS credentials expired · Enter MFA</button>`;
    else if (e.renewNeedsMfa) meta += `<button class="warn-btn" data-act="renew">⚠ AWS credentials expire in ${r} · Enter MFA to renew</button>`;
    else if (r) meta += `<span class="meta">AWS credentials: ${r} left</span>`;
    if (e.message) meta += `<span class="meta" title="${esc(e.message)}">⚠ Renewal failed</span>`;
  } else {
    meta = `<span class="meta">${esc(statusText(e).text)}</span>`;
  }
  bar.innerHTML = `<span class="env-name"><span class="pulse"></span>${esc(e.label)}</span>
    <span class="cluster">${esc(e.clusterName)}</span><span class="spacer"></span>${meta}${updateHtml()}
    <button class="switch-btn" data-act="menu">Switch environment ${menuOpen ? '▴' : '▾'}<span class="kbd">${shortcut}</span></button>${gearHtml()}`;
}

bar.addEventListener('click', (ev) => {
  const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'menu') toggleMenu();
  if (act === 'app-menu') toggleAppMenu();
  if (act === 'renew' && state.active) void api.renew(state.active);
  if (act === 'install-update') void api.installUpdate();
});

// ---------------------------------------------------------------- body (shown when no radar view is on top)

function problemsHtml() {
  if (!state.problems.length) return '';
  return `<div class="problems"><b>Setup problems</b><ul>${state.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    <div class="actions"><button class="btn" data-act="settings">Open settings file</button><button class="btn" data-act="reload">Reload config</button></div></div>`;
}

function renderBody() {
  const e = activeEnv();
  if (!e || e.status === 'idle') {
    body.innerHTML = `<div class="center">${problemsHtml()}<h1>Choose an environment</h1>
      <p class="sub">Connecting gets credentials from aws-vault (asking for MFA when needed), then opens radar here.</p>
      <div class="env-cards">${state.envs
        .map(
          (x) => `<button class="env-card" style="--c:${x.color}" data-env="${esc(x.name)}"><div class="l">${esc(x.label)}</div>
          <div class="c">${esc(x.clusterName)}<br>profile ${esc(x.profile)}</div><div class="s">${esc(statusText(x).text)}</div></button>`,
        )
        .join('')}</div></div>`;
    return;
  }
  if (e.status === 'error') {
    body.innerHTML = `<div class="center error" style="--c:${e.color}"><h1>Could not connect to ${esc(e.label)}</h1>
      <pre>${esc(e.message ?? '')}</pre>${e.logTail?.length ? `<p class="sub">radar output:</p><pre>${esc(e.logTail.join('\n'))}</pre>` : ''}
      <div class="actions"><button class="btn primary" data-act="retry">Retry</button><button class="btn" data-act="menu">Switch environment</button>
      <button class="btn" data-act="settings">Open settings file</button></div></div>`;
    return;
  }
  if (e.status === 'checking' || e.status === 'connecting') {
    body.innerHTML = `<div class="progress" style="--c:${e.color}"><div class="spinner"></div>
      <div class="step">${esc(e.step ?? 'Connecting…')}</div><div class="hint">${esc(e.label)} · ${esc(e.clusterName)}</div>
      <div class="actions" style="justify-content:center"><button class="btn" data-act="cancel">Cancel</button></div></div>`;
    return;
  }
  body.innerHTML = ''; // ready: radar view covers this area
}

body.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-act],[data-env]');
  if (!t) return;
  if (t.dataset.env) return void api.switchTo(t.dataset.env);
  const act = t.dataset.act;
  if (act === 'settings') void api.openSettings();
  if (act === 'reload') void api.reloadConfig();
  if (act === 'menu') toggleMenu(true);
  if (act === 'retry' && state.active) void api.retry(state.active);
  if (act === 'cancel' && state.active) void api.cancel(state.active);
});

// ---------------------------------------------------------------- overlay: menu & prompts

function toggleMenu(force?: boolean) {
  menuOpen = force ?? !menuOpen;
  if (menuOpen) appMenuOpen = false;
  menuFocus = Math.max(0, state.envs.findIndex((e) => e.name === state.active));
  render();
}

function toggleAppMenu(force?: boolean) {
  appMenuOpen = force ?? !appMenuOpen;
  if (appMenuOpen) menuOpen = false;
  render();
}

function closeMenus() {
  menuOpen = false;
  appMenuOpen = false;
  render();
}

function menuHtml() {
  return `<div class="menu">${state.envs
    .map((e, i) => {
      const st = statusText(e);
      const cur = e.name === state.active;
      return `<div class="row ${cur ? 'current' : ''} ${i === menuFocus ? 'focus' : ''}" style="--c:${e.color}" data-env="${esc(e.name)}">
        <span class="num">${i < 9 ? i + 1 : ''}</span><span class="sw"></span>
        <span class="names"><b>${esc(e.label)}${cur ? ' · current' : ''}</b><small>${esc(e.clusterName)}</small></span>
        <span class="st ${st.cls}" title="${esc(st.title ?? st.text)}">${esc(st.text)}</span>
        ${e.status !== 'idle' ? `<button class="disc" data-disc="${esc(e.name)}" title="Stop radar for this environment">Disconnect</button>` : ''}</div>`;
    })
    .join('')}</div>`;
}

function appMenuHtml() {
  const u = state.update;
  const canCheck = !['disabled', 'checking', 'downloading'].includes(u.status);
  const problems = state.problems.length
    ? `<div class="item warn" data-act="settings">⚠ ${esc(state.problems[0])}${state.problems.length > 1 ? ` (+${state.problems.length - 1} more)` : ''}</div>`
    : '';
  const install = u.status === 'ready' ? `<div class="item accent" data-act="install-update">⬆ Restart to update to v${esc(u.version ?? '')}</div>` : '';
  const running = state.envs.filter((e) => e.status === 'ready');
  const mcp = running.length
    ? `<div class="label-line">MCP endpoints · click to copy</div>${running
        .map((e) => {
          const url = `http://127.0.0.1:${e.port}/mcp`;
          return `<div class="item mcp" data-copy="${esc(url)}" style="--c:${e.color}"><span class="sw"></span><b>${esc(e.label)}</b><code>${esc(url)}</code></div>`;
        })
        .join('')}<div class="sep"></div>`
    : '';
  return `<div class="menu app-menu">${problems}${mcp}
    <div class="item" data-act="settings">Open settings file</div>
    <div class="item" data-act="reload">Reload config</div>
    <div class="sep"></div>
    ${install}
    <div class="item ${canCheck ? '' : 'disabled'}" ${canCheck ? 'data-act="check-update"' : ''}>Check for updates</div>
    <div class="ver-line" title="${esc(u.error ?? '')}">${versionHtml()}</div></div>`;
}

function versionHtml(): string {
  const u = state.update;
  const label: Record<string, string> = {
    disabled: 'dev build',
    checking: 'checking for updates…',
    latest: 'up to date',
    downloading: `downloading v${u.version ?? ''} ${u.progress ?? 0}%`,
    ready: `v${u.version ?? ''} ready to install`,
    error: 'update check failed',
  };
  const st = label[u.status] ?? '';
  return `Radar Desktop v${esc(u.current)}${st ? ` · ${esc(st)}` : ''}`;
}

function promptHtml(e: EnvState) {
  const info = `<dl><dt>profile</dt><dd>${esc(e.profile)}</dd>${e.roleArn ? `<dt>role</dt><dd>${esc(e.roleArn)}</dd>` : ''}
    <dt>cluster</dt><dd>${esc(e.clusterName)}</dd></dl>`;
  const renewing = e.status === 'ready';
  const title = renewing ? `Renew ${esc(e.label)} credentials` : `Switch to ${esc(e.label)}`;
  const err = e.promptError ? `<div class="err">${esc(e.promptError)}</div>` : '';
  if (e.prompt === 'passphrase') {
    return `<div class="modal-wrap"><form class="modal" style="--c:${e.color}" data-form="passphrase"><div class="head">${title}</div><div class="content">${info}
      <label>aws-vault password (file backend)</label><input type="password" name="v" autofocus autocomplete="off" />${err}
      <div class="note">Kept in memory for this run only.</div>
      <div class="actions"><button class="btn primary" type="submit">Unlock</button><button class="btn" type="button" data-act="cancel">Cancel</button></div></div></form></div>`;
  }
  return `<div class="modal-wrap"><form class="modal" style="--c:${e.color}" data-form="mfa"><div class="head">${title}</div><div class="content">${info}
    <label>MFA code</label><input name="v" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" autofocus />${err}
    <div class="actions"><button class="btn primary" type="submit">Connect</button><button class="btn" type="button" data-act="cancel">Cancel</button></div></div></form></div>`;
}

/** The env whose prompt should be shown (only the active one; others show "Waiting for MFA" in the menu). */
const promptEnv = () => {
  const e = activeEnv();
  return e?.prompt ? e : undefined;
};

async function renderOverlay() {
  const pe = promptEnv();
  const want = !!pe || menuOpen || appMenuOpen;
  if (want && !overlayShown) {
    overlayShown = true;
    const shot = await api.openOverlay();
    if (shot) backdrop.src = shot;
    else backdrop.removeAttribute('src');
    overlay.hidden = false;
  } else if (!want && overlayShown) {
    overlayShown = false;
    overlay.hidden = true;
    backdrop.removeAttribute('src');
    renderedOverlayKey = '';
    await api.closeOverlay();
    return;
  }
  if (!want) return;
  // Re-render only when the content changes, so typing in an input isn't wiped by state pushes.
  const key = pe
    ? `prompt:${pe.name}:${pe.prompt}:${pe.promptError ?? ''}`
    : appMenuOpen
      ? `app:${JSON.stringify(state.update)}:${state.problems.join('|')}:${state.envs.filter((e) => e.status === 'ready').map((e) => e.name + e.port).join()}`
      : `menu:${menuFocus}:${JSON.stringify(state.envs.map(statusText))}:${state.active}`;
  if (key === renderedOverlayKey) return;
  renderedOverlayKey = key;
  overlayContent.innerHTML = pe ? promptHtml(pe) : appMenuOpen ? appMenuHtml() : menuHtml();
  overlayContent.querySelector<HTMLInputElement>('input')?.focus();
}

overlayContent.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  if (t === overlayContent) return closeMenus();
  const copy = t.closest<HTMLElement>('[data-copy]');
  if (copy) {
    void navigator.clipboard.writeText(copy.dataset.copy!).then(() => {
      const code = copy.querySelector('code');
      if (code) code.textContent = 'Copied ✓';
      setTimeout(() => code && (code.textContent = copy.dataset.copy!), 1200);
    });
    return;
  }
  const disc = t.closest<HTMLElement>('[data-disc]')?.dataset.disc;
  if (disc) return void api.disconnect(disc);
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'cancel') return void (state.active && api.cancel(state.active));
  if (act === 'settings') return void (closeMenus(), api.openSettings());
  if (act === 'reload') return void (closeMenus(), api.reloadConfig());
  if (act === 'check-update') return void api.checkUpdate();
  if (act === 'install-update') return void api.installUpdate();
  const env = t.closest<HTMLElement>('[data-env]')?.dataset.env;
  if (env) pick(env);
});

overlayContent.addEventListener('input', (ev) => {
  const input = ev.target as HTMLInputElement;
  const form = input.closest('form');
  if (form?.dataset.form !== 'mfa') return;
  input.value = input.value.replace(/\D/g, '').slice(0, 6);
  if (input.value.length === 6) form.requestSubmit();
});

overlayContent.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  const value = (form.elements.namedItem('v') as HTMLInputElement).value.trim();
  const e = promptEnv();
  // A code is single-use: auto-submit on the 6th digit plus Enter/click must not send it twice.
  if (!e || !value || form.dataset.busy) return;
  if (form.dataset.form === 'mfa' && !/^\d{6}$/.test(value)) return;
  form.dataset.busy = '1';
  const controls = form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button[type=submit]');
  controls.forEach((c) => (c.disabled = true));
  const done = form.dataset.form === 'mfa' ? api.submitMfa(e.name, value) : api.submitPassphrase(e.name, value);
  // If the same prompt is still shown afterwards (e.g. wrong code), let the user try again.
  void done.finally(() => {
    delete form.dataset.busy;
    controls.forEach((c) => (c.disabled = false));
    const input = form.querySelector<HTMLInputElement>('input');
    if (input && form.isConnected) {
      input.value = '';
      input.focus();
    }
  });
});

function pick(env: string) {
  menuOpen = false;
  render();
  void api.switchTo(env);
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (promptEnv() && state.active) return void api.cancel(state.active);
    if (menuOpen || appMenuOpen) return closeMenus();
  }
  if (!menuOpen || promptEnv()) return;
  if (/^[1-9]$/.test(ev.key) && state.envs[Number(ev.key) - 1]) return pick(state.envs[Number(ev.key) - 1].name);
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    const n = state.envs.length;
    menuFocus = (menuFocus + (ev.key === 'ArrowDown' ? 1 : n - 1)) % n;
    render();
  }
  if (ev.key === 'Enter' && state.envs[menuFocus]) pick(state.envs[menuFocus].name);
});

// ---------------------------------------------------------------- wiring

function render() {
  renderBar();
  renderBody();
  void renderOverlay();
}

api.onState((s) => {
  state = s;
  render();
});
api.onCommand((cmd) => {
  if (cmd === 'switcher') toggleMenu();
});
setInterval(renderBar, 30_000);
void api.getState().then((s) => {
  state = s;
  render();
});
