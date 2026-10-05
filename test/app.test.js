// app.js のログイン経路を、最小の DOM スタブで確かめる（画面描画は対象外）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// ?login を付けて読んだ app.js だけ、config.js をログイン有効の値に差し替える。
const loginConfig = new URL('./fixtures/config-login.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './config.js' && context.parentURL?.includes('app.js?login')) return { url: loginConfig, shortCircuit: true };
    return next(specifier, context);
  },
});

const installations = JSON.parse(readFileSync(new URL('./fixtures/installations.json', import.meta.url), 'utf8'));
const saved = {};
const GLOBALS = ['document', 'localStorage', 'sessionStorage', 'location', 'history', 'addEventListener', 'Option', 'confirm', 'fetch'];
let env;
let n = 0;

function storage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

function element() {
  return {
    dataset: {}, hidden: false, textContent: '', value: '', open: true, disabled: false, handlers: {},
    classList: { toggle() {}, contains: () => false },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelectorAll: () => [],
    querySelector: () => null,
    replaceChildren(...children) { this.children = children; },
    append() {}, setAttribute() {}, scrollIntoView() {},
  };
}

function setup(search) {
  const elements = new Map();
  const events = [];
  env = {
    events,
    el: (id) => elements.get(id),
    local: storage(),
    session: storage(),
    location: { search, pathname: '/mf_notify-web/', origin: 'https://pages.example', hash: '', assign(url) { this.assigned = url; } },
  };
  const values = {
    document: { getElementById: (id) => elements.get(id) ?? elements.set(id, element()).get(id), createElement: () => element() },
    localStorage: env.local,
    sessionStorage: env.session,
    location: env.location,
    history: { replaceState: (_s, _t, url) => events.push(['replaceState', url]) },
    addEventListener() {},
    Option: class { constructor(text, value) { this.text = text; this.value = value ?? text; } },
    confirm: () => true,
    fetch: async (url, init) => {
      events.push(['fetch', String(url), init?.body]);
      const u = new URL(url);
      const body = u.pathname === '/token' ? { token: 'gho_from_worker' }
        : u.pathname === '/user/installations' ? installations : { repositories: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  };
  for (const key of GLOBALS) Object.defineProperty(globalThis, key, { value: values[key], configurable: true, writable: true });
}

async function loadApp(login) {
  await import(`../app.js?${login ? 'login' : 'plain'}=${++n}`);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const logs = [];
beforeEach((t) => {
  for (const key of GLOBALS) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  logs.length = 0;
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, m, (...args) => logs.push(args));
});
afterEach(() => {
  for (const key of GLOBALS) {
    if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
    else delete globalThis[key];
  }
  assert.deepEqual(logs, [], 'console に何も出さない');
});

test('CLIENT_ID が空ならログインボタンを出さず、戻りの code も交換しないが URL からは消す', async () => {
  setup('?code=secret-code&state=s1');
  env.session.setItem('mfnotify.oauthState', 's1');
  await loadApp(false);
  assert.equal(env.el('login').hidden, true);
  assert.deepEqual(env.events, [['replaceState', '/mf_notify-web/']]);
  assert.equal(env.local.getItem('mfnotify.token'), null);
  assert.ok(!env.el('connect-message').textContent.includes('secret-code'));
});

test('ログイン: state を sessionStorage に置き、authorize へ client_id・redirect_uri・state を渡す', async () => {
  setup('');
  await loadApp(true);
  assert.equal(env.el('login').hidden, false);
  env.el('login').handlers.click();
  const url = new URL(env.location.assigned);
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'Iv1.testclient');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://pages.example/mf_notify-web/');
  assert.ok(url.searchParams.get('state'));
  assert.equal(url.searchParams.get('state'), env.session.getItem('mfnotify.oauthState'));
});

test('戻り: state が一致すれば URL を先に消し、code を TOKEN_ENDPOINT に POST してトークンを localStorage へ', async () => {
  setup('?code=secret-code&state=s1');
  env.session.setItem('mfnotify.oauthState', 's1');
  await loadApp(true);
  assert.deepEqual(env.events.slice(0, 2), [
    ['replaceState', '/mf_notify-web/'],
    ['fetch', 'https://worker.example/token', JSON.stringify({ code: 'secret-code' })],
  ]);
  assert.equal(env.local.getItem('mfnotify.token'), 'gho_from_worker');
  assert.equal(env.local.getItem('mfnotify.authMode'), 'app');
  assert.equal(env.session.getItem('mfnotify.oauthState'), null);
  // 続けてインストール先のリポジトリ一覧を取る
  assert.ok(env.events.some(([kind, url]) => kind === 'fetch' && url.startsWith('https://api.github.com/user/installations?per_page=100')));
  assert.equal(env.el('login').hidden, true);
  assert.equal(env.el('repo-select-field').hidden, false);
});

test('戻り: state 不一致なら交換しない', async () => {
  setup('?code=secret-code&state=forged');
  env.session.setItem('mfnotify.oauthState', 's1');
  await loadApp(true);
  assert.deepEqual(env.events, [['replaceState', '/mf_notify-web/']]);
  assert.equal(env.local.getItem('mfnotify.token'), null);
  assert.match(env.el('connect-message').textContent, /ログインに失敗/);
  assert.ok(!env.el('connect-message').textContent.includes('secret-code'));
});
