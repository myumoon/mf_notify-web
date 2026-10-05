// app.js のログイン経路を、最小の DOM スタブで確かめる（画面描画は対象外）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DEFAULTS, toYaml } from '../lib.js';

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
    querySelector(sel) { return (this.children ?? []).find((c) => sel === `.${c.className}`) ?? null; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children = [...(this.children ?? []), ...children]; },
    setAttribute() {}, scrollIntoView() {},
  };
}

function setup(search) {
  const elements = new Map();
  const events = [];
  env = {
    events,
    elements,
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

// index.html の type=number 欄すべて（data-path を持つもの）
const NUMBER_PATHS = ['period.monthStartDay', 'budgets.yearly', 'budgets.monthly', 'budgets.weekly', 'savings.yearlyTarget',
  'warnings.pace.marginPercent', 'warnings.stale.maxAgeHours', 'mf.bulkUpdate.timeoutSeconds'];
const OPTIONAL = ['budgets.yearly', 'budgets.monthly', 'budgets.weekly'];

// 数値欄・エラー欄・行リストを持つフォームを用意し、PAT 接続済みで settings.yml を読ませる。
async function loadForm(settings) {
  setup('');
  const form = element();
  const inputs = NUMBER_PATHS.map((path) => Object.assign(element(), { type: 'number', dataset: OPTIONAL.includes(path) ? { path, optional: '' } : { path } }));
  const slots = [...NUMBER_PATHS, 'budgets.monthlyByCategory'].map((errorFor) => Object.assign(element(), { dataset: { errorFor } }));
  const lists = Object.fromEntries(['expense', 'income', 'accounts'].map((list) => [list, Object.assign(element(), { dataset: { list } })]));
  form.querySelectorAll = (sel) => (sel === '[data-path]' ? inputs : sel === '[data-error-for]' ? slots : []);
  form.querySelector = (sel) => lists[sel.match(/data-list="(\w+)"/)?.[1]] ?? null;
  env.elements.set('settings-form', form);
  env.local.setItem('mfnotify.token', 'pat-token');
  env.local.setItem('mfnotify.repo', 'o/r');
  env.local.setItem('mfnotify.authMode', 'pat');
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    env.events.push(['fetch', method, String(url)]);
    if (method === 'GET' && String(url).includes('/contents/settings.yml')) {
      return new Response(JSON.stringify({ content: Buffer.from(toYaml(settings)).toString('base64'), sha: 's1' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  await loadApp(false);
  return {
    form,
    lists,
    input: (path) => inputs.find((i) => i.dataset.path === path),
    slot: (path) => slots.find((s) => s.dataset.errorFor === path),
  };
}

test('数値として読めない数値欄（badInput）は未入力扱いせず、欄の下にエラーを出して保存を止め、キーを消さない', async () => {
  const settings = structuredClone(DEFAULTS);
  Object.assign(settings.budgets, { yearly: 3000000, monthly: 250000, weekly: 60000 });
  const f = await loadForm(settings);
  assert.equal(env.el('save').disabled, false);
  // ブラウザは「3,000,000」のような入力で value を '' にし、validity.badInput を立てる
  const type = (input, value, badInput) => {
    Object.assign(input, { value, validity: { badInput } });
    f.form.handlers.input({ target: input });
  };
  const yaml = () => {
    env.el('preview').handlers.click();
    return env.el('yaml-text').textContent;
  };

  for (const path of NUMBER_PATHS) {
    const input = f.input(path);
    const original = String(input.value);
    type(input, '', true);
    assert.equal(env.el('save').disabled, true, path);
    assert.match(f.slot(path).textContent, /^(整数で入力してください|数値で入力してください)$/, path);
    assert.match(yaml(), new RegExp(`${path.split('.').pop()}: \\.nan`), path);
    type(input, original, false);
    assert.equal(f.slot(path).textContent, '', path);
    assert.equal(env.el('save').disabled, false, path);
  }

  // 支出行の月予算も同じ。エラーは budgets.monthlyByCategory の欄に出る
  const row = f.lists.expense.children.find((r) => r.querySelector('.major').value === '食費');
  const budget = row.querySelector('.budget');
  budget.closest = () => f.lists.expense;
  type(budget, '', true);
  assert.equal(env.el('save').disabled, true);
  assert.equal(f.slot('budgets.monthlyByCategory').textContent, '食費: 整数で入力してください');
  assert.match(yaml(), /食費: \.nan/);
  await env.el('save').handlers.click();
  assert.ok(!env.events.some(([, method]) => method === 'PUT'), '保存しない');
  // 本当に空にしたときだけキーを消す
  type(budget, '', false);
  assert.equal(env.el('save').disabled, false);
  assert.doesNotMatch(yaml(), /食費: /);
});
