// app.js のログイン経路を、最小の DOM スタブで確かめる（画面描画は対象外）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DEFAULTS, toYaml, fromYaml } from '../lib.js';

// ?login を付けて読んだ app.js だけ、config.js をログイン有効の値に差し替える。
const loginConfig = new URL('./fixtures/config-login.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './config.js' && context.parentURL?.includes('app.js?login')) return { url: loginConfig, shortCircuit: true };
    return next(specifier, context);
  },
});

const installations = JSON.parse(readFileSync(new URL('./fixtures/installations.json', import.meta.url), 'utf8'));
const statsFixture = JSON.parse(readFileSync(new URL('./fixtures/stats.json', import.meta.url), 'utf8'));
const saved = {};
const GLOBALS = ['document', 'localStorage', 'sessionStorage', 'location', 'history', 'addEventListener', 'Option', 'confirm', 'fetch'];
let env;
let n = 0;

function storage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

function element() {
  const linkChildren = function (children) {
    children.forEach((child, i) => {
      child.parentElement = this;
      child.nextElementSibling = children[i + 1] ?? null;
    });
  };
  const dataset = {};
  const node = {
    hidden: false, textContent: '', value: '', open: true, disabled: false, handlers: {},
    nextElementSibling: null, previousElementSibling: null, parentElement: null,
    classList: { toggle() {}, contains: () => false },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelectorAll: () => [],
    querySelector(sel) {
      for (const c of this.children ?? []) {
        const found = sel === `.${c.className}` || sel === c.tagName ? c : c.querySelector?.(sel);
        if (found) return found;
      }
      return null;
    },
    closest(sel) {
      let current = this;
      while (current) {
        if (sel === '[data-list]' && Object.hasOwn(current.dataset, 'list')) return current;
        current = current.parentElement;
      }
      return null;
    },
    replaceChildren(...children) { this.children = children; linkChildren.call(this, children); },
    append(...children) { this.children = [...(this.children ?? []), ...children]; linkChildren.call(this, this.children); },
    insertAdjacentElement(position, child) {
      if (position !== 'afterend') return null;
      if (!this.parentElement) {
        child.previousElementSibling = this;
        child.nextElementSibling = this.nextElementSibling ?? null;
        this.nextElementSibling = child;
        return child;
      }
      const index = this.parentElement.children.indexOf(this);
      this.parentElement.children.splice(index + 1, 0, child);
      linkChildren.call(this.parentElement, this.parentElement.children);
      return child;
    },
    remove() {
      if (this.parentElement) {
        const parent = this.parentElement;
        parent.children = parent.children.filter((child) => child !== this);
        linkChildren.call(parent, parent.children);
      } else if (this.previousElementSibling?.nextElementSibling === this) {
        this.previousElementSibling.nextElementSibling = this.nextElementSibling ?? null;
      }
    },
    setAttribute() {}, scrollIntoView() {}, focus() {},
  };
  Object.defineProperty(node, 'dataset', { enumerable: true, get: () => dataset });
  return node;
}

function elementWithDataset(values) {
  const node = element();
  Object.assign(node.dataset, values);
  return node;
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
    document: { getElementById: (id) => elements.get(id) ?? elements.set(id, element()).get(id), createElement: (tagName) => Object.assign(element(), { tagName }) },
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
const YEN_PATHS = ['budgets.yearly', 'budgets.monthly', 'budgets.weekly', 'savings.yearlyTarget'];

// 数値欄・エラー欄・行リストを持つフォームを用意し、PAT 接続済みで settings.yml（と categories.json）を読ませる。
async function loadForm(settings, categories, stats = null) {
  setup('');
  const form = element();
  const inputs = NUMBER_PATHS.map((path) => {
    const dataset = OPTIONAL.includes(path) ? { path, optional: '' } : { path };
    if (YEN_PATHS.includes(path)) dataset.yen = '';
    const input = Object.assign(elementWithDataset(dataset), { type: 'number' });
    if (YEN_PATHS.includes(path)) input.nextElementSibling = Object.assign(element(), { tagName: 'output', className: 'yen' });
    return input;
  });
  const slots = [...NUMBER_PATHS, 'budgets.monthlyByCategory'].map((errorFor) => elementWithDataset({ errorFor }));
  const lists = Object.fromEntries(['expense', 'income', 'accounts'].map((list) => [list, elementWithDataset({ list })]));
  const adds = Object.keys(lists).map((add) => elementWithDataset({ add }));
  form.querySelectorAll = (sel) => (sel === '[data-path]' ? inputs : sel === '[data-error-for]' ? slots : sel === '[data-add]' ? adds : []);
  form.querySelector = (sel) => lists[sel.match(/data-list="(\w+)"/)?.[1]]
    ?? inputs.find((input) => sel === `[data-path="${input.dataset.path}"]`) ?? null;
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
    if (method === 'GET' && categories && String(url).includes('/contents/categories.json')) {
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify({ categories })).toString('base64'), sha: 'c1' }), { status: 200 });
    }
    if (method === 'GET' && stats !== null && String(url).includes('/contents/stats.json')) {
      const text = typeof stats === 'string' ? stats : JSON.stringify(stats);
      return new Response(JSON.stringify({ content: Buffer.from(text).toString('base64'), sha: 'st1' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  await loadApp(false);
  return {
    form,
    lists,
    add: (kind) => adds.find((b) => b.dataset.add === kind),
    input: (path) => inputs.find((i) => i.dataset.path === path),
    slot: (path) => slots.find((s) => s.dataset.errorFor === path),
  };
}

test('円入力の隣に表示し、値・空・badInputと行追加・一括追加で更新する', async () => {
  assert.throws(() => Object.assign(element(), { dataset: { yen: '' } }), TypeError);
  const settings = structuredClone(DEFAULTS);
  settings.budgets.monthlyByCategory = {};
  const f = await loadForm(settings, { 食費: ['外食', '食料品'] });
  const expected = {
    'budgets.yearly': '3,000,000 円',
    'budgets.monthly': '250,000 円',
    'budgets.weekly': '60,000 円',
    'savings.yearlyTarget': '2,000,000 円',
  };
  for (const path of YEN_PATHS) {
    const input = f.input(path);
    assert.equal(input.type, 'number', path);
    assert.ok('yen' in input.dataset, path);
    assert.equal(input.nextElementSibling.tagName, 'output', path);
    assert.equal(input.nextElementSibling.className, 'yen', path);
    assert.equal(input.nextElementSibling.textContent, expected[path], path);
  }
  for (const path of NUMBER_PATHS.filter((p) => !YEN_PATHS.includes(p))) {
    assert.ok(!('yen' in f.input(path).dataset), path);
  }

  const type = (input, value, badInput = false) => {
    Object.assign(input, { value, validity: { badInput } });
    f.form.handlers.input({ target: input });
  };
  const monthly = f.input('budgets.monthly');
  type(monthly, '1234567');
  assert.equal(monthly.nextElementSibling.textContent, '1,234,567 円');
  type(monthly, '');
  assert.equal(monthly.nextElementSibling.textContent, '—');
  type(monthly, '', true);
  assert.equal(monthly.nextElementSibling.textContent, '数値ではありません');

  const existing = f.lists.expense.children[0].querySelector('.budget');
  assert.ok('yen' in existing.dataset);
  assert.equal(existing.nextElementSibling.tagName, 'output');
  assert.equal(existing.nextElementSibling.className, 'yen');
  assert.equal(existing.nextElementSibling.textContent, '—');
  existing.closest = () => f.lists.expense;
  type(existing, '1000');
  assert.equal(existing.nextElementSibling.textContent, '1,000 円');

  f.add('expense').handlers.click();
  const added = f.lists.expense.children.at(-1).querySelector('.budget');
  assert.ok('yen' in added.dataset);
  assert.equal(added.nextElementSibling.className, 'yen');
  assert.equal(added.nextElementSibling.textContent, '—');

  env.el('bulk-major').value = '食費';
  env.el('bulk-add-button').handlers.click();
  const bulkAdded = f.lists.expense.children.filter((row) => row.querySelector('.budget')?.value === '');
  assert.ok(bulkAdded.length >= 2);
  for (const row of bulkAdded) {
    const budget = row.querySelector('.budget');
    assert.ok('yen' in budget.dataset);
    assert.equal(budget.nextElementSibling.className, 'yen');
    assert.equal(budget.nextElementSibling.textContent, '—');
  }
});

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

test('別の repo の読込に失敗したら、前の repo の内容と sha で保存できない', async () => {
  await loadForm(structuredClone(DEFAULTS));
  assert.equal(env.el('save').disabled, false);
  globalThis.fetch = async (url, init) => {
    env.events.push(['fetch', init?.method ?? 'GET', String(url)]);
    return new Response('{}', { status: 500 });
  };
  env.el('repo-select').value = 'o/b';
  env.el('repo-select').handlers.change();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.el('settings-form').hidden, true);
  assert.equal(env.el('savebar').hidden, true);
  assert.equal(env.el('save').disabled, true);
  assert.match(env.el('connect-message').textContent, /500/);
  await env.el('save').handlers.click();
  assert.ok(!env.events.some(([, method]) => method === 'PUT'), '保存しない');
});

test('アプリのインストールからの戻り（state 無し）は失敗と表示せず、code も交換しない', async () => {
  setup('?code=install-code&installation_id=1&setup_action=install');
  await loadApp(true);
  assert.deepEqual(env.events, [['replaceState', '/mf_notify-web/']]);
  assert.equal(env.local.getItem('mfnotify.token'), null);
  assert.match(env.el('connect-message').textContent, /インストールしました/);
});

// ---- カテゴリ行（categories.json の候補で select にする）

const CATEGORIES = { 食費: ['食料品', '外食', 'カフェ'], 日用品: ['消耗品'], 収入: ['給与'] };
const sorted = (list) => [...list].sort();
const textOf = (select) => select.children.find((o) => o.value === select.value)?.text;
const previewYaml = () => {
  env.el('preview').handlers.click();
  return env.el('yaml-text').textContent;
};
const savedCategories = (kind) => fromYaml(previewYaml()).categories[kind];
// ブラウザと同じく、行の要素の input → フォームの input（syncRows）の順に発火させる
function fire(f, kind, target, value) {
  target.value = value;
  target.handlers.input?.();
  target.closest = () => f.lists[kind];
  f.form.handlers.input({ target });
}
const pick = (row, name) => row.querySelector(`.${name}-select`);

test('候補ありで行が select になり、候補に無い既存値は自由入力で表示し、再保存で値を失わない', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.categories = { expense: ['食費', '食費/外食', '食費/謎の中項目', '謎の大項目/x', '謎の大項目'], income: ['収入/給与'] };
  settings.budgets.monthlyByCategory = { '食費/外食': 10000, '謎の大項目/x': 5000 };
  const f = await loadForm(settings, CATEGORIES);
  const rows = f.lists.expense.children;
  const majors = sorted(Object.keys(CATEGORIES));
  assert.deepEqual(pick(rows[0], 'major').children.map((o) => o.text), ['大項目を選択', ...majors, 'その他（自由入力）']);
  assert.deepEqual(pick(rows[0], 'minor').children.map((o) => o.text),
    ['中項目を選択', ...sorted(CATEGORIES.食費), '（大項目全体）', 'その他（自由入力）']);
  const shown = (row) => [textOf(pick(row, 'major')), textOf(pick(row, 'minor')),
    row.querySelector('.major').hidden ? null : row.querySelector('.major').value,
    row.querySelector('.minor').hidden ? null : row.querySelector('.minor').value];
  assert.deepEqual(rows.map(shown), [
    ['食費', '（大項目全体）', null, null],
    ['食費', '外食', null, null],
    ['食費', 'その他（自由入力）', null, '謎の中項目'],
    ['その他（自由入力）', 'その他（自由入力）', '謎の大項目', 'x'],
    ['その他（自由入力）', '（大項目全体）', '謎の大項目', null],
  ]);
  // 収入も同じ行 UI
  assert.deepEqual(shown(f.lists.income.children[0]), ['収入', '給与', null, null]);
  assert.equal(env.el('save').disabled, false);
  // 何か触って書き戻しても、保存される YAML は読み込んだ値と同じ
  fire(f, 'expense', rows[1].querySelector('.budget'), '10000');
  fire(f, 'income', pick(f.lists.income.children[0], 'minor'), '給与');
  assert.equal(previewYaml(), toYaml(settings));
});

test('候補が無ければ従来の text 入力のまま動き、一括追加は出さない', async () => {
  const f = await loadForm(structuredClone(DEFAULTS));
  const row = f.lists.expense.children.find((r) => r.querySelector('.major').value === '食費');
  assert.equal(pick(row, 'major'), null);
  assert.equal(pick(row, 'minor'), null);
  assert.equal(row.querySelector('.minor').placeholder, '（大項目全体）');
  assert.equal(env.el('bulk-add').hidden, true);
  fire(f, 'expense', row.querySelector('.minor'), '外食');
  assert.deepEqual(savedCategories('expense'), ['食費/外食', '日用品', '趣味・娯楽']);
});

test('一括追加: 大項目の中項目のうち行に無いものだけを追加し、settings.categories.expense に反映する', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.categories.expense = ['食費', '食費/外食'];
  settings.budgets.monthlyByCategory = {};
  const f = await loadForm(settings, CATEGORIES);
  assert.equal(env.el('bulk-add').hidden, false);
  assert.deepEqual(env.el('bulk-major').children.map((o) => o.text), sorted(Object.keys(CATEGORIES)));
  env.el('bulk-major').value = '食費';
  env.el('bulk-add-button').handlers.click();
  const added = sorted(CATEGORIES.食費).filter((m) => m !== '外食').map((m) => `食費/${m}`);
  assert.deepEqual(savedCategories('expense'), ['食費', '食費/外食', ...added]);
  assert.deepEqual(f.lists.expense.children.slice(2).map((r) => textOf(pick(r, 'minor'))), added.map((v) => v.split('/')[1]));
  assert.equal(env.el('save').disabled, false);
  // もう一度押しても重複しない
  env.el('bulk-add-button').handlers.click();
  assert.equal(f.lists.expense.children.length, 2 + added.length);
  assert.match(env.el('toast').textContent, /追加する中項目はありません/);
});

test('中項目を選ばない行は大項目単独にせず空扱いし、行の下にエラーを出して保存を止める', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.categories.expense = ['日用品'];
  settings.budgets.monthlyByCategory = {};
  const f = await loadForm(settings, CATEGORIES);
  f.add('expense').handlers.click();
  const row = f.lists.expense.children[1];
  assert.equal(textOf(pick(row, 'minor')), '中項目を選択');
  fire(f, 'expense', pick(row, 'major'), '食費');
  assert.equal(textOf(pick(row, 'minor')), '中項目を選択', '既定は未選択（大項目全体ではない）');
  assert.equal(row.querySelector('.row-error').textContent, '中項目を選んでください');
  assert.deepEqual(savedCategories('expense'), ['日用品', '']);
  assert.equal(env.el('save').disabled, true);
  await env.el('save').handlers.click();
  assert.ok(!env.events.some(([, method]) => method === 'PUT'), '保存しない');

  fire(f, 'expense', pick(row, 'minor'), '\0whole');
  assert.deepEqual(savedCategories('expense'), ['日用品', '食費'], '（大項目全体）を明示したときだけ大項目単独');
  assert.equal(row.querySelector('.row-error').textContent, '');
  assert.equal(env.el('save').disabled, false);

  fire(f, 'expense', pick(row, 'minor'), '外食');
  assert.deepEqual(savedCategories('expense'), ['日用品', '食費/外食']);
  // 大項目を変えると、新しい候補に無い中項目は未選択へ戻る
  fire(f, 'expense', pick(row, 'major'), '日用品');
  assert.equal(textOf(pick(row, 'minor')), '中項目を選択');
  assert.equal(env.el('save').disabled, true);
  // 自由入力: 空のうちは未選択と同じ、入力すればその値
  fire(f, 'expense', pick(row, 'minor'), '\0free');
  assert.equal(row.querySelector('.minor').hidden, false);
  assert.equal(row.querySelector('.row-error').textContent, '中項目を選んでください');
  fire(f, 'expense', row.querySelector('.minor'), ' 自作 ');
  assert.deepEqual(savedCategories('expense'), ['日用品', '日用品/自作']);
  assert.equal(env.el('save').disabled, false);
});

test('stats の円額提案を押すと data-path の既存更新経路で設定へ反映する', async () => {
  assert.equal(Object.keys(statsFixture.months).length, 7);
  const settings = structuredClone(DEFAULTS);
  settings.categories = { expense: ['食費'], income: ['収入'] };
  settings.budgets.monthlyByCategory = {};
  const f = await loadForm(settings, CATEGORIES, statsFixture);
  const monthly = f.input('budgets.monthly');
  const button = monthly.nextElementSibling.nextElementSibling;
  assert.equal(button.className, 'suggest');
  assert.equal(button.textContent, '提案 34,000');
  assert.match(env.el('budget-suggestions').children.map((child) => child.textContent).join(' '), /直近 6 か月の中央値/);

  button.handlers.click();
  assert.equal(monthly.value, '34000');
  assert.equal(fromYaml(previewYaml()).budgets.monthly, 34000);
  const rowBudget = f.lists.expense.children[0].querySelector('.budget');
  const rowSuggestion = rowBudget.nextElementSibling.nextElementSibling;
  assert.equal(rowSuggestion.textContent, '提案 34,000');
  rowSuggestion.handlers.click();
  assert.equal(rowBudget.value, '34000');
  assert.deepEqual(fromYaml(previewYaml()).budgets.monthlyByCategory, { 食費: 34000 });
  assert.equal(env.el('save').disabled, false);
});

test('stats が無いか壊れていても編集でき、案内だけ表示する', async () => {
  for (const stats of [null, '{broken', '{}']) {
    const f = await loadForm(structuredClone(DEFAULTS), undefined, stats);
    const suggestions = env.el('budget-suggestions');
    assert.equal(suggestions.children.length, 1);
    assert.equal(suggestions.children[0].textContent, 'PC で 1 回実行すると提案が出ます');
    assert.equal(f.input('budgets.monthly').nextElementSibling.nextElementSibling, null);
    assert.equal(suggestions.children.some((child) => child.className === 'apply-suggestions'), false);

    f.input('budgets.monthly').value = '123000';
    f.form.handlers.input({ target: f.input('budgets.monthly') });
    assert.equal(fromYaml(previewYaml()).budgets.monthly, 123000);
  }
});

test('有効な stats が 0 か月なら提案を出さず案内だけ表示する', async () => {
  const emptyStats = { updatedAt: '2026-10-06T00:00:00.000Z', monthStartDay: 1, months: {} };
  const f = await loadForm(structuredClone(DEFAULTS), CATEGORIES, emptyStats);
  const controls = env.el('budget-suggestions');
  assert.equal(controls.children.length, 1);
  assert.equal(controls.children[0].textContent, 'PC で 1 回実行すると提案が出ます');
  assert.equal(controls.children.some((child) => child.className === 'apply-suggestions'), false);
  assert.equal(controls.children.some((child) => child.className === 'suggestion-note'), false);
  for (const input of f.form.querySelectorAll('[data-path]')) {
    if (YEN_PATHS.includes(input.dataset.path)) assert.equal(input.nextElementSibling.nextElementSibling, null);
  }
  for (const row of f.lists.expense.children) {
    assert.equal(row.querySelector('.budget').nextElementSibling.nextElementSibling, null);
  }
});

test('すべて提案値にするで円欄とカテゴリの月予算を埋める', async () => {
  const f = await loadForm(structuredClone(DEFAULTS), CATEGORIES, statsFixture);
  const button = env.el('budget-suggestions').children.find((child) => child.className === 'apply-suggestions');
  assert.equal(button.textContent, 'すべて提案値にする');
  button.handlers.click();

  assert.equal(f.input('budgets.monthly').value, '43000');
  assert.equal(f.input('budgets.weekly').value, '10000');
  assert.equal(f.input('budgets.yearly').value, '516000');
  assert.equal(f.input('savings.yearlyTarget').value, '3440000');
  assert.deepEqual(fromYaml(previewYaml()).budgets.monthlyByCategory, {
    食費: 34000,
    日用品: 6000,
    趣味・娯楽: 4000,
  });
});

test('カテゴリ rule を変えると提案を再計算し、null の入力にはボタンを出さない', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.categories = { expense: ['食費'], income: [] };
  settings.budgets.monthlyByCategory = {};
  const f = await loadForm(settings, CATEGORIES, statsFixture);
  const row = f.lists.expense.children[0];
  const major = pick(row, 'major');
  assert.equal(row.querySelector('.budget').nextElementSibling.nextElementSibling.textContent, '提案 34,000');
  assert.equal(f.input('savings.yearlyTarget').nextElementSibling.nextElementSibling, null);

  fire(f, 'expense', major, '日用品');
  assert.equal(row.querySelector('.budget').nextElementSibling.nextElementSibling.textContent, '提案 6,000');
  assert.deepEqual(savedCategories('expense'), ['日用品']);
});

test('prototype-like rule keys do not use inherited proposals or erase existing budgets', async () => {
  const settings = structuredClone(DEFAULTS);
  const rules = ['constructor', 'toString', '__proto__'];
  const budgets = Object.fromEntries(rules.map((rule, index) => [rule, (index + 5) * 1000]));
  settings.categories = { expense: rules, income: [] };
  settings.budgets.monthlyByCategory = budgets;
  const f = await loadForm(settings, undefined, statsFixture);
  const rows = f.lists.expense.children;

  assert.deepEqual(rows.map((row) => row.querySelector('.budget').value), [5000, 6000, 7000]);
  assert.ok(rows.every((row) => row.querySelector('.budget').nextElementSibling.nextElementSibling === null));
  env.el('budget-suggestions').children.find((child) => child.className === 'apply-suggestions').handlers.click();
  fire(f, 'expense', rows[0].querySelector('.budget'), '5000');
  assert.deepEqual(fromYaml(previewYaml()).budgets.monthlyByCategory, budgets);
});
