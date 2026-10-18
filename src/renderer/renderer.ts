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
  if (min <= 0) return '已过期';
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

const ERROR_TYPES: Record<string, string> = {
  'auth-rejected': '认证被拒绝',
  unreachable: '集群不可达',
  timeout: '连接超时',
  forbidden: '没有权限',
};

function clusterText(e: EnvState): { text: string; cls: string } {
  const c = e.cluster;
  if (!c) return { text: '集群状态检查中…', cls: '' };
  if (c.state === 'connected') return { text: '● 集群已连接', cls: 'ok' };
  if (c.state === 'connecting') return { text: '集群连接中…', cls: '' };
  return { text: `⚠ 集群连接失败${c.errorType ? `：${ERROR_TYPES[c.errorType] ?? c.errorType}` : ''}`, cls: 'bad' };
}

function statusText(e: EnvState): { text: string; cls: string } {
  if (e.prompt === 'mfa') return { text: '等待 MFA', cls: 'bad' };
  if (e.prompt === 'passphrase') return { text: '等待密码', cls: 'bad' };
  switch (e.status) {
    case 'ready': {
      const r = remaining(e.credsExpiresAt);
      const c = clusterText(e);
      if (c.cls === 'bad') return c;
      return { text: e.renewNeedsMfa ? `需续期 · 剩 ${r}` : `运行中${r ? ` · 剩 ${r}` : ''}`, cls: e.renewNeedsMfa ? 'bad' : 'ok' };
    }
    case 'checking':
    case 'connecting':
      return { text: '连接中…', cls: '' };
    case 'error':
      return { text: '出错', cls: 'bad' };
    default:
      return { text: '未连接', cls: '' };
  }
}

// ---------------------------------------------------------------- bar

function updateHtml(): string {
  const u = state.update;
  if (u.status === 'ready') return `<button class="update-btn" data-act="install-update">⬆ 新版本 v${esc(u.version ?? '')} · 重启更新</button>`;
  if (u.status === 'downloading') return `<span class="meta">⬇ 下载更新 ${u.progress ?? 0}%</span>`;
  return '';
}

function renderBar() {
  const e = activeEnv();
  bar.style.setProperty('--env', e ? e.color : '#50525a');
  if (!e) {
    bar.innerHTML = `<span class="env-name">未连接</span><span class="cluster">选择一个环境</span><span class="spacer"></span>${updateHtml()}
      <button class="switch-btn" data-act="menu">切换环境 ▾<span class="kbd">${shortcut}</span></button>`;
    return;
  }
  const r = remaining(e.credsExpiresAt);
  let meta = '';
  if (e.status === 'ready') {
    // Cluster reachability first: valid AWS credentials don't mean radar can talk to the cluster.
    const c = clusterText(e);
    meta = `<span class="health ${c.cls}" title="${esc(e.cluster?.error ?? '')}">${esc(c.text)}</span>`;
    if (r === '已过期') meta += `<button class="warn-btn" data-act="renew">⚠ AWS 凭证已过期 · 输入 MFA</button>`;
    else if (e.renewNeedsMfa) meta += `<button class="warn-btn" data-act="renew">⚠ AWS 凭证 ${r}后过期 · 输入 MFA 续期</button>`;
    else if (r) meta += `<span class="meta">AWS 凭证剩余 ${r}</span>`;
    if (e.message) meta += `<span class="meta" title="${esc(e.message)}">⚠ 续期失败</span>`;
  } else {
    meta = `<span class="meta">${esc(statusText(e).text)}</span>`;
  }
  bar.innerHTML = `<span class="env-name"><span class="pulse"></span>${esc(e.label)}</span>
    <span class="cluster">${esc(e.clusterName)}</span><span class="spacer"></span>${meta}${updateHtml()}
    <button class="switch-btn" data-act="menu">切换环境 ${menuOpen ? '▴' : '▾'}<span class="kbd">${shortcut}</span></button>`;
}

bar.addEventListener('click', (ev) => {
  const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'menu') toggleMenu();
  if (act === 'renew' && state.active) void api.renew(state.active);
  if (act === 'install-update') void api.installUpdate();
});

// ---------------------------------------------------------------- body (shown when no radar view is on top)

function problemsHtml() {
  if (!state.problems.length) return '';
  return `<div class="problems"><b>环境配置有问题</b><ul>${state.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    <div class="actions"><button class="btn" data-act="settings">打开设置文件</button><button class="btn" data-act="reload">重新加载配置</button></div></div>`;
}

function renderBody() {
  const e = activeEnv();
  if (!e || e.status === 'idle') {
    body.innerHTML = `<div class="center">${problemsHtml()}<h1>选择环境</h1>
      <p class="sub">连接时会用 aws-vault 获取凭证（需要时输入 MFA），然后在这里打开 radar。</p>
      <div class="env-cards">${state.envs
        .map(
          (x) => `<button class="env-card" style="--c:${x.color}" data-env="${esc(x.name)}"><div class="l">${esc(x.label)}</div>
          <div class="c">${esc(x.clusterName)}<br>profile ${esc(x.profile)}</div><div class="s">${esc(statusText(x).text)}</div></button>`,
        )
        .join('')}</div></div>`;
    return;
  }
  if (e.status === 'error') {
    body.innerHTML = `<div class="center error" style="--c:${e.color}"><h1>连接 ${esc(e.label)} 失败</h1>
      <pre>${esc(e.message ?? '')}</pre>${e.logTail?.length ? `<p class="sub">radar 输出：</p><pre>${esc(e.logTail.join('\n'))}</pre>` : ''}
      <div class="actions"><button class="btn primary" data-act="retry">重试</button><button class="btn" data-act="menu">切换环境</button>
      <button class="btn" data-act="settings">打开设置文件</button></div></div>`;
    return;
  }
  if (e.status === 'checking' || e.status === 'connecting') {
    body.innerHTML = `<div class="progress" style="--c:${e.color}"><div class="spinner"></div>
      <div class="step">${esc(e.step ?? '连接中…')}</div><div class="hint">${esc(e.label)} · ${esc(e.clusterName)}</div>
      <div class="actions" style="justify-content:center"><button class="btn" data-act="cancel">取消</button></div></div>`;
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
  menuFocus = Math.max(0, state.envs.findIndex((e) => e.name === state.active));
  render();
}

function menuHtml() {
  return `<div class="menu">${state.envs
    .map((e, i) => {
      const st = statusText(e);
      const cur = e.name === state.active;
      return `<div class="row ${cur ? 'current' : ''} ${i === menuFocus ? 'focus' : ''}" style="--c:${e.color}" data-env="${esc(e.name)}">
        <span class="num">${i < 9 ? i + 1 : ''}</span><span class="sw"></span>
        <span class="names"><b>${esc(e.label)}${cur ? ' · 当前' : ''}</b><small>${esc(e.clusterName)}</small></span>
        <span class="st ${st.cls}">${esc(st.text)}</span>
        ${e.status !== 'idle' ? `<button class="disc" data-disc="${esc(e.name)}" title="停止这个环境的 radar">断开</button>` : ''}</div>`;
    })
    .join('')}${state.problems.length ? `<div class="row" data-act="settings"><span class="st bad">⚠ ${esc(state.problems[0])}</span></div>` : ''}
    <div class="foot"><button class="link" data-act="settings">打开设置文件</button><button class="link" data-act="reload">重新加载配置</button>
    <span class="spacer"></span>${versionHtml()}</div></div>`;
}

function versionHtml(): string {
  const u = state.update;
  const label: Record<string, string> = {
    disabled: '开发版',
    checking: '检查更新中…',
    latest: '已是最新',
    downloading: `下载 v${u.version ?? ''} ${u.progress ?? 0}%`,
    ready: `v${u.version ?? ''} 待安装`,
    error: '检查更新失败',
  };
  const st = label[u.status] ?? '';
  return `<span class="ver" title="${esc(u.error ?? '')}">v${esc(u.current)}${st ? ` · ${esc(st)}` : ''}</span>
    ${u.status === 'disabled' ? '' : `<button class="link" data-act="check-update">检查更新</button>`}`;
}

function promptHtml(e: EnvState) {
  const info = `<dl><dt>profile</dt><dd>${esc(e.profile)}</dd>${e.roleArn ? `<dt>role</dt><dd>${esc(e.roleArn)}</dd>` : ''}
    <dt>集群</dt><dd>${esc(e.clusterName)}</dd></dl>`;
  const renewing = e.status === 'ready';
  const title = renewing ? `续期 ${esc(e.label)} 凭证` : `切换到 ${esc(e.label)}`;
  const err = e.promptError ? `<div class="err">${esc(e.promptError)}</div>` : '';
  if (e.prompt === 'passphrase') {
    return `<div class="modal-wrap"><form class="modal" style="--c:${e.color}" data-form="passphrase"><div class="head">${title}</div><div class="content">${info}
      <label>aws-vault 密码（file backend）</label><input type="password" name="v" autofocus autocomplete="off" />${err}
      <div class="note">只保存在本次运行的内存里。</div>
      <div class="actions"><button class="btn primary" type="submit">解锁</button><button class="btn" type="button" data-act="cancel">取消</button></div></div></form></div>`;
  }
  return `<div class="modal-wrap"><form class="modal" style="--c:${e.color}" data-form="mfa"><div class="head">${title}</div><div class="content">${info}
    <label>MFA 验证码</label><input name="v" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" autofocus />${err}
    <div class="actions"><button class="btn primary" type="submit">连接</button><button class="btn" type="button" data-act="cancel">取消</button></div></div></form></div>`;
}

/** The env whose prompt should be shown (only the active one; others show "等待 MFA" in the menu). */
const promptEnv = () => {
  const e = activeEnv();
  return e?.prompt ? e : undefined;
};

async function renderOverlay() {
  const pe = promptEnv();
  const want = !!pe || menuOpen;
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
  const key = pe ? `prompt:${pe.name}:${pe.prompt}:${pe.promptError ?? ''}` : `menu:${menuFocus}:${JSON.stringify(state.envs.map(statusText))}:${state.active}:${JSON.stringify(state.update)}`;
  if (key === renderedOverlayKey) return;
  renderedOverlayKey = key;
  overlayContent.innerHTML = pe ? promptHtml(pe) : menuHtml();
  overlayContent.querySelector<HTMLInputElement>('input')?.focus();
}

overlayContent.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  if (t === overlayContent) return toggleMenu(false);
  const disc = t.closest<HTMLElement>('[data-disc]')?.dataset.disc;
  if (disc) return void api.disconnect(disc);
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'cancel') return void (state.active && api.cancel(state.active));
  if (act === 'settings') return void api.openSettings();
  if (act === 'reload') return void api.reloadConfig();
  if (act === 'check-update') return void api.checkUpdate();
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
  if (!e || !value) return;
  if (form.dataset.form === 'mfa') {
    if (!/^\d{6}$/.test(value)) return;
    void api.submitMfa(e.name, value);
  } else void api.submitPassphrase(e.name, value);
});

function pick(env: string) {
  menuOpen = false;
  render();
  void api.switchTo(env);
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (promptEnv() && state.active) return void api.cancel(state.active);
    if (menuOpen) return toggleMenu(false);
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
