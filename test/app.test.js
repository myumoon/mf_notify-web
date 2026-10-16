// app.js のログイン経路を、最小の DOM スタブで確かめる（画面描画は対象外）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DEFAULTS, toYaml, fromYaml, reserveMonthlyProposal } from '../lib.js';

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
test('大項目の通知トリガー説明はサマリーに含まれることを案内する', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('オフにした大項目は支出が変わっても通知しません（週次・月次サマリーには含まれます）'));
});
test('支出カテゴリ表に積立列と月予算の対象説明を表示する', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('積立: ボーナス払い・年会費・帰省など特定の月に集中する支出を、毎月の積立枠で均して管理します（通常の月予算から外れます）'));
  assert.ok(html.includes('role="columnheader">積立</span>'));
  assert.ok(html.includes('合計は積立以外の支出カテゴリの月予算の合計です'));
});
test('支出カテゴリ表に並べ替え列と操作説明を表示する', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<div class="expense-row expense-header"');
  const header = html.slice(start, html.indexOf('</div>', start));
  assert.equal((header.match(/<span/g) ?? []).length, 7);
  assert.ok(html.includes('⋮⋮ をドラッグ（またはフォーカスして ↑↓）で並べ替え。ダッシュボードはこの順に表示（グループは最初に出てきた位置の順）'));
});
test('optional null values are omitted from exported settings', async () => {
  const settings = single();
  const major = Object.keys(settings.majors)[0];
  settings.destinations[0].categories = [major];
  settings.majors = { [major]: { label: null, notify: null } };
  settings.advisor = { provider: 'claude', model: null, timeoutSeconds: null };

  await loadForm(settings);
  const exported = fromYaml(previewYaml());
  assert.equal(Object.hasOwn(exported, 'majors'), false);
  assert.deepEqual(exported.advisor, { provider: 'claude' });
});
const GLOBALS = ['document', 'localStorage', 'sessionStorage', 'location', 'history', 'addEventListener', 'Option', 'confirm', 'fetch', 'crypto'];
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
      child.previousElementSibling = children[i - 1] ?? null;
    });
  };
  const releasePointerCaptures = (root, notify = true) => {
    if (root.capturedPointerId !== undefined) root.releasePointerCapture(root.capturedPointerId, notify);
    for (const child of root.children ?? []) releasePointerCaptures(child, notify);
  };
  const detach = (child, removed = false) => {
    if (!child.parentElement) return;
    const parent = child.parentElement;
    parent.children = parent.children.filter((item) => item !== child);
    child.parentElement = null;
    child.nextElementSibling = null;
    child.previousElementSibling = null;
    linkChildren.call(parent, parent.children);
    if (removed) releasePointerCaptures(child, false);
  };
  const dataset = {};
  const classes = new Set();
  const node = {
    hidden: false, textContent: '', value: '', open: true, disabled: false, handlers: {},
    nextElementSibling: null, previousElementSibling: null, parentElement: null,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, force) {
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
      contains: (name) => classes.has(name),
    },
    addEventListener(type, fn) { this.handlers[type] = fn; },
    querySelectorAll(sel) {
      const found = [];
      const visit = (parent) => {
        for (const child of parent.children ?? []) {
          if (sel === child.tagName || sel === `.${child.className}`) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    },
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
    replaceChildren(...children) {
      for (const child of [...(this.children ?? [])]) detach(child, true);
      this.children = [];
      for (const child of children) {
        detach(child);
        this.children.push(child);
      }
      linkChildren.call(this, this.children);
    },
    append(...children) {
      this.children ??= [];
      for (const child of children) {
        detach(child);
        this.children.push(child);
      }
      linkChildren.call(this, this.children);
    },
    insertBefore(child, reference) {
      if (child === reference) return child;
      detach(child);
      this.children ??= [];
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      linkChildren.call(this, this.children);
      return child;
    },
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
        detach(this);
      } else if (this.previousElementSibling?.nextElementSibling === this) {
        this.previousElementSibling.nextElementSibling = this.nextElementSibling ?? null;
      }
    },
    setAttribute(name, value) { this.attributes ??= {}; this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes?.[name] ?? null; },
    setPointerCapture(pointerId) { this.capturedPointerId = pointerId; },
    releasePointerCapture(pointerId, notify = true) {
      if (this.capturedPointerId !== pointerId) return;
      delete this.capturedPointerId;
      if (notify) this.handlers.lostpointercapture?.({ pointerId });
    },
    getBoundingClientRect() {
      const top = (this.parentElement?.children?.indexOf(this) ?? 0) * 40;
      return { top, bottom: top + 32, height: 32 };
    },
    scrollIntoView() {}, focus() { this.focused = true; },
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
  let uuid = 0;
  env = {
    events,
    elements,
    el: (id) => elements.get(id),
    local: storage(),
    session: storage(),
    location: { search, pathname: '/mf_notify-web/', origin: 'https://pages.example', hash: '', assign(url) { this.assigned = url; } },
  };
  const values = {
    document: {
      getElementById: (id) => elements.get(id) ?? elements.set(id, element()).get(id),
      createElement: (tagName) => Object.assign(element(), { tagName }),
      createElementNS: (namespaceURI, tagName) => Object.assign(element(), { namespaceURI, tagName }),
    },
    localStorage: env.local,
    sessionStorage: env.session,
    location: env.location,
    history: { replaceState: (_s, _t, url) => events.push(['replaceState', url]) },
    addEventListener() {},
    Option: class { constructor(text, value) { this.text = text; this.value = value ?? text; } },
    confirm: () => true,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
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

// index.html の type=number 欄すべて（data-path を持つもの）。円表示（data-yen）の data-path 欄は無い。
const NUMBER_PATHS = ['period.monthStartDay', 'destinations.*.notifyThresholdYen', 'warnings.pace.marginPercent', 'warnings.stale.maxAgeHours', 'mf.bulkUpdate.timeoutSeconds', 'advisor.timeoutSeconds'];
const OPTIONAL = ['destinations.*.notifyThresholdYen', 'advisor.timeoutSeconds'];
// 通知先タブの文字欄（index.html と同じ data-path）
const TEXT_PATHS = ['destinations.*.name', 'destinations.*.webhookRef', 'destinations.*.mentionOnWarning', 'advisor.provider', 'advisor.model'];
// 通知先 1 件だけの既定値（DEFAULTS の先頭の通知先）
const single = () => {
  const settings = structuredClone(DEFAULTS);
  settings.destinations.length = 1;
  return settings;
};
const setCategories = (settings, { expense }) => {
  settings.destinations[0].categories = expense;
};

// 数値欄・エラー欄・行リストを持つフォームを用意し、PAT 接続済みで settings.yml（と categories.json）を読ませる。
async function loadForm(settings, categories, stats = null) {
  setup('');
  const form = element();
  const inputs = NUMBER_PATHS.map((path) => {
    const dataset = OPTIONAL.includes(path) ? { path, optional: '' } : { path };
    return Object.assign(elementWithDataset(dataset), { type: 'number' });
  });
  inputs.push(...TEXT_PATHS.map((path) => Object.assign(elementWithDataset({ path }), { type: 'text' })));
  const slots = [...NUMBER_PATHS, ...TEXT_PATHS, 'destinations', 'destinations.*', 'destinations.*.id', 'destinations.*.categories', 'destinations.*.budgets.monthlyByCategory']
    .map((errorFor) => elementWithDataset({ errorFor }));
  const allocationChart = Object.assign(element(), { tagName: 'svg', attributes: {} });
  const allocationLegend = Object.assign(element(), { tagName: 'ul' });
  const allocationEmpty = Object.assign(element(), { tagName: 'p' });
  env.elements.set('allocation-chart', allocationChart);
  env.elements.set('allocation-legend', allocationLegend);
  env.elements.set('allocation-empty', allocationEmpty);
  const majorLabels = element();
  env.elements.set('major-labels', majorLabels);
  const lists = Object.fromEntries(['expense', 'accounts'].map((list) => [list, elementWithDataset({ list })]));
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
    allocationChart,
    allocationLegend,
    allocationEmpty,
    majorLabels,
  };
}

test('円入力の隣に表示し、値・空・badInputと行追加・一括追加で更新する', async () => {
  assert.throws(() => Object.assign(element(), { dataset: { yen: '' } }), TypeError);
  const settings = single();
  settings.destinations[0].budgets.monthlyByCategory = {};
  const f = await loadForm(settings, { 食費: ['外食', '食料品'] });
  for (const path of NUMBER_PATHS) assert.ok(!('yen' in f.input(path).dataset), path);

  const type = (input, value, badInput = false) => {
    Object.assign(input, { value, validity: { badInput } });
    f.form.handlers.input({ target: input });
  };
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
  const settings = single();
  settings.advisor = { provider: 'claude' };
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
  assert.equal(f.slot('destinations.*.budgets.monthlyByCategory').textContent, '食費: 整数で入力してください');
  assert.match(yaml(), /食費: \.nan/);
  await env.el('save').handlers.click();
  assert.ok(!env.events.some(([, method]) => method === 'PUT'), '保存しない');
  // 本当に空にしたときだけキーを消す
  type(budget, '', false);
  assert.equal(env.el('save').disabled, false);
  assert.doesNotMatch(yaml(), /食費: /);
});

test('別の repo の読込に失敗したら、前の repo の内容と sha で保存できない', async () => {
  await loadForm(single());
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
const savedCategories = () => fromYaml(previewYaml()).destinations[0].categories;
// ブラウザと同じく、行の要素の input → フォームの input（syncRows）の順に発火させる
function fire(f, kind, target, value) {
  target.value = value;
  target.handlers.input?.();
  target.closest = () => f.lists[kind];
  f.form.handlers.input({ target });
}
const pick = (row, name) => row.querySelector(`.${name}-select`);

function expenseSettingsForMove() {
  const settings = single();
  settings.destinations[0].categories = ['食費', '日用品', '趣味'];
  settings.destinations[0].budgets.monthlyByCategory = { 食費: 1000, 趣味: 3000 };
  settings.destinations[0].reserves = [{ category: '日用品', monthly: 2000 }];
  return settings;
}

test('キーボードで支出行を移動し、YAML の順と予算・積立の対応を保つ', async () => {
  const f = await loadForm(expenseSettingsForMove());
  const handle = f.lists.expense.children[0].querySelector('.expense-drag-handle');
  handle.handlers.keydown({ key: 'ArrowDown', preventDefault() {} });

  assert.deepEqual(f.lists.expense.children.map((row) => row.querySelector('.major').value), ['日用品', '食費', '趣味']);
  assert.equal(handle.focused, true);
  assert.deepEqual(f.lists.expense.children.map((row) => row.querySelector('.budget').value), [2000, 1000, 3000]);
  assert.deepEqual(f.lists.expense.children.map((row) => row.querySelector('.reserve').checked), [true, false, false]);
  const saved = fromYaml(previewYaml()).destinations[0];
  assert.deepEqual(saved.categories, ['日用品', '食費', '趣味']);
  assert.deepEqual(saved.budgets.monthlyByCategory, { 食費: 1000, 趣味: 3000 });
  assert.deepEqual(saved.reserves, [{ category: '日用品', monthly: 2000 }]);

  f.lists.expense.children[1].querySelector('.expense-drag-handle').handlers.keydown({ key: 'ArrowUp', preventDefault() {} });
  assert.deepEqual(f.lists.expense.children.map((row) => row.querySelector('.major').value), ['食費', '日用品', '趣味']);
  assert.deepEqual(savedCategories('expense'), ['食費', '日用品', '趣味']);
});

test('Pointer Events で支出行を並べ替え、口座行にはハンドルを付けない', async () => {
  const settings = expenseSettingsForMove();
  settings.destinations[0].categories.push('交通費');
  settings.warnings.stale.ignoreAccounts = ['銀行'];
  const f = await loadForm(settings);
  const row = f.lists.expense.children[0];
  const handle = row.querySelector('.expense-drag-handle');
  assert.equal(handle.ariaLabel, '並べ替え');
  handle.handlers.pointerdown({ button: 0, pointerId: 7, pointerType: 'touch' });
  assert.equal(handle.capturedPointerId, 7);
  const moveWhileCaptured = (clientY) => {
    if (handle.capturedPointerId === 7) handle.handlers.pointermove({ pointerId: 7, clientY });
  };
  moveWhileCaptured(70);
  moveWhileCaptured(112);
  moveWhileCaptured(200);
  assert.deepEqual(f.lists.expense.children.map((item) => item.querySelector('.major').value), ['日用品', '趣味', '交通費', '食費']);
  assert.equal(handle.capturedPointerId, 7);
  assert.equal(row.classList.contains('dragging'), true);
  const pointerupTarget = f.lists.expense.children[2].querySelector('.expense-drag-handle');
  (handle.capturedPointerId === 7 ? handle : pointerupTarget).handlers.pointerup({ pointerId: 7, clientX: 200, clientY: 200 });
  assert.equal(row.classList.contains('dragging'), false);
  const saved = fromYaml(previewYaml()).destinations[0];
  assert.deepEqual(saved.categories, ['日用品', '趣味', '交通費', '食費']);
  assert.deepEqual(saved.budgets.monthlyByCategory, { 食費: 1000, 趣味: 3000 });
  assert.deepEqual(saved.reserves, [{ category: '日用品', monthly: 2000 }]);
  assert.equal(f.lists.accounts.children[0].querySelector('.expense-drag-handle'), null);
});

test('pointercancel は行順を戻し、lostpointercapture は並べ替えを確定する', async () => {
  const f = await loadForm(expenseSettingsForMove());
  const [row] = f.lists.expense.children;
  const handle = row.querySelector('.expense-drag-handle');
  handle.handlers.pointerdown({ button: 0, pointerId: 8, pointerType: 'mouse' });
  handle.handlers.pointermove({ pointerId: 8, clientY: 100 });
  handle.handlers.pointercancel({ pointerId: 8 });
  assert.deepEqual(f.lists.expense.children.map((item) => item.querySelector('.major').value), ['食費', '日用品', '趣味']);
  assert.equal(row.classList.contains('dragging'), false);

  handle.handlers.pointerdown({ button: 0, pointerId: 9, pointerType: 'touch' });
  handle.handlers.pointermove({ pointerId: 9, clientY: 120 });
  handle.releasePointerCapture(9);
  assert.deepEqual(f.lists.expense.children.map((item) => item.querySelector('.major').value), ['日用品', '趣味', '食費']);
  assert.deepEqual(savedCategories('expense'), ['日用品', '趣味', '食費']);
  assert.equal(row.classList.contains('dragging'), false);

  handle.handlers.pointerdown({ button: 0, pointerId: 10, pointerType: 'mouse' });
  handle.handlers.pointercancel({ pointerId: 10 });
  assert.equal(row.classList.contains('dragging'), false);
});

test('タブ再描画の直後に支出行のポインタ並べ替えが再開する', async () => {
  const f = await loadForm(expenseSettingsForMove());
  const clickTab = (index) => env.el('tablist').children[index].handlers.click();
  clickTab(1);

  const staleHandle = f.lists.expense.children[0].querySelector('.expense-drag-handle');
  staleHandle.handlers.pointerdown({ button: 0, pointerId: 20, pointerType: 'touch' });
  assert.equal(staleHandle.capturedPointerId, 20);
  clickTab(0);
  assert.equal(staleHandle.capturedPointerId, undefined);
  clickTab(1);

  const nextHandle = f.lists.expense.children[0].querySelector('.expense-drag-handle');
  nextHandle.handlers.pointerdown({ button: 0, pointerId: 21, pointerType: 'touch' });
  nextHandle.handlers.pointermove({ pointerId: 21, clientY: 120 });
  nextHandle.handlers.pointerup({ pointerId: 21 });

  assert.deepEqual(f.lists.expense.children.map((row) => row.querySelector('.major').value), ['日用品', '趣味', '食費']);
  assert.deepEqual(savedCategories('expense'), ['日用品', '趣味', '食費']);
});

test('候補ありで行が select になり、候補に無い既存値は自由入力で表示し、再保存で値を失わない', async () => {
  const settings = single();
  delete settings.majors['趣味・娯楽']; // 使っていない大項目の設定は保存時に落ちるので、読み込み値から外しておく
  setCategories(settings, { expense:['食費', '食費/外食', '食費/謎の中項目', '謎の大項目/x', '謎の大項目'] });
  settings.destinations[0].budgets.monthlyByCategory = { '食費/外食': 10000, '謎の大項目/x': 5000 };
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
  assert.equal(env.el('save').disabled, false);
  // 何か触って書き戻しても、保存される YAML は読み込んだ値と同じ
  fire(f, 'expense', rows[1].querySelector('.budget'), '10000');
  assert.equal(previewYaml(), toYaml(settings));
});

test('候補が無ければ従来の text 入力のまま動き、一括追加は出さない', async () => {
  const f = await loadForm(single());
  const row = f.lists.expense.children.find((r) => r.querySelector('.major').value === '食費');
  assert.equal(pick(row, 'major'), null);
  assert.equal(pick(row, 'minor'), null);
  assert.equal(row.querySelector('.minor').placeholder, '（大項目全体）');
  assert.equal(env.el('bulk-add').hidden, true);
  fire(f, 'expense', row.querySelector('.minor'), '外食');
  assert.deepEqual(savedCategories('expense'), ['食費/外食', '日用品', '趣味・娯楽']);
});

test('支出行は提案の有無にかかわらず提案スロットと同じ子要素数を持つ', async () => {
  const settings = single();
  setCategories(settings, { expense:['食費', '架空'] });
  const f = await loadForm(settings, CATEGORIES, statsFixture);
  const [suggested, empty] = f.lists.expense.children;
  assert.equal(suggested.querySelector('.suggest-slot').children[0].className, 'suggest');
  assert.equal(empty.querySelector('.suggest-slot').children.length, 0);
  assert.equal(suggested.children.length, empty.children.length);
  assert.deepEqual(suggested.children.map((child) => child.className), ['expense-drag-cell', 'pick', 'pick', 'budget-cell', 'reserve-cell', 'suggest-slot', 'remove-cell', 'row-error']);
  assert.deepEqual(suggested.children.slice(0, 7).map((cell) => cell.getAttribute('role')), Array(7).fill('cell'));
  assert.equal(suggested.querySelector('.row-error').getAttribute('role'), null);
});

test('支出行のセル role が入力欄と削除ボタンの role を上書きしない', async () => {
  const settings = single();
  setCategories(settings, { expense:['食費/外食', '架空'] });
  const assertCellRoles = (row) => {
    assert.equal(row.getAttribute('role'), 'row');
    assert.deepEqual(row.children.slice(0, 7).map((cell) => cell.getAttribute('role')), Array(7).fill('cell'));
    for (const selector of ['.expense-drag-handle', '.major', '.minor', '.major-select', '.minor-select', '.remove']) {
      const control = row.querySelector(selector);
      if (control) assert.equal(control.getAttribute('role'), null, selector);
    }
    assert.equal(row.querySelector('.row-error').getAttribute('role'), null);
  };

  const f = await loadForm(settings, CATEGORIES, statsFixture);
  const [suggested, empty] = f.lists.expense.children;
  assert.equal(suggested.querySelector('.suggest-slot').children.length, 1);
  assert.equal(empty.querySelector('.suggest-slot').children.length, 0);
  assertCellRoles(suggested);
  assertCellRoles(empty);

  f.add('expense').handlers.click();
  assertCellRoles(f.lists.expense.children.at(-1));

  const beforeBulkAdd = f.lists.expense.children.length;
  env.el('bulk-major').value = '食費';
  env.el('bulk-add-button').handlers.click();
  for (const row of f.lists.expense.children.slice(beforeBulkAdd)) assertCellRoles(row);

  const withoutOptions = await loadForm(settings);
  for (const row of withoutOptions.lists.expense.children) assertCellRoles(row);
  withoutOptions.add('expense').handlers.click();
  assertCellRoles(withoutOptions.lists.expense.children.at(-1));
});

test('大項目の通知表示名を保存し、空名とカテゴリに無い大項目を YAML から除く', async () => {
  const settings = single();
  setCategories(settings, { expense:['食費/外食', '日用品', '食費/食品'] });
  settings.majors = { 食費: { label: '家計' }, 交通費: { label: '移動費' } };
  const f = await loadForm(settings);
  const rows = f.majorLabels.children;
  assert.deepEqual(rows.map((row) => row.querySelector('.major-name').textContent), ['食費', '日用品']);
  const label = rows[0].querySelector('.major-label');
  assert.equal(label.placeholder, '食費');

  label.value = '変動費';
  f.form.handlers.input({ target: label });
  assert.deepEqual(fromYaml(previewYaml()).majors, { 食費: { label: '変動費' } });

  label.value = '';
  f.form.handlers.input({ target: label });
  assert.equal(Object.hasOwn(fromYaml(previewYaml()), 'majors'), false);
});

test('通知トリガーは既定オンで、オフだけ false を保存し、既定オンならキーを消す', async () => {
  const settings = single();
  settings.destinations[0].categories = ['食費'];
  settings.majors = { 食費: { label: '変動費' } };
  const f = await loadForm(settings);
  const notify = f.majorLabels.children[0].querySelector('.major-notify');
  const label = f.majorLabels.children[0].querySelector('.major-label');
  assert.equal(notify.checked, true);

  notify.checked = false;
  f.form.handlers.input({ target: notify });
  assert.deepEqual(fromYaml(previewYaml()).majors, { 食費: { label: '変動費', notify: false } });

  notify.checked = true;
  f.form.handlers.input({ target: notify });
  assert.deepEqual(fromYaml(previewYaml()).majors, { 食費: { label: '変動費' } });

  label.value = '';
  f.form.handlers.input({ target: label });
  assert.equal(Object.hasOwn(fromYaml(previewYaml()), 'majors'), false);
});

test('advisor は既定オフで、使う設定と任意欄を保存し、オフで削除する', async () => {
  const settings = single();
  settings.advisor = null;
  const f = await loadForm(settings);
  const enabled = env.el('advisor-enabled');
  assert.equal(enabled.checked, false);
  assert.equal(Object.hasOwn(fromYaml(previewYaml()), 'advisor'), false);

  enabled.checked = true;
  f.form.handlers.input({ target: enabled });
  assert.equal(f.input('advisor.provider').value, 'claude');
  assert.deepEqual(fromYaml(previewYaml()).advisor, { provider: 'claude' });

  f.input('advisor.provider').value = 'codex';
  f.form.handlers.input({ target: f.input('advisor.provider') });
  f.input('advisor.model').value = 'gpt-5.1/codex';
  f.form.handlers.input({ target: f.input('advisor.model') });
  f.input('advisor.timeoutSeconds').value = '120';
  f.form.handlers.input({ target: f.input('advisor.timeoutSeconds') });
  assert.deepEqual(fromYaml(previewYaml()).advisor, { provider: 'codex', model: 'gpt-5.1/codex', timeoutSeconds: 120 });

  enabled.checked = false;
  f.form.handlers.input({ target: enabled });
  assert.equal(Object.hasOwn(fromYaml(previewYaml()), 'advisor'), false);
});

test('大項目 select の一時変更で通知表示名を失わない', async () => {
  const settings = single();
  setCategories(settings, { expense:['食費'] });
  settings.majors = { 食費: { label: '変動費' } };
  const f = await loadForm(settings, CATEGORIES);
  const row = f.lists.expense.children[0];
  const major = pick(row, 'major');

  fire(f, 'expense', major, '日用品');
  fire(f, 'expense', major, '食費');

  assert.equal(f.majorLabels.children[0].querySelector('.major-label').value, '変動費');
  assert.deepEqual(fromYaml(previewYaml()).majors, { 食費: { label: '変動費' } });
});

test('大項目の自由入力を編集中も通知表示名を保持する', async () => {
  const settings = single();
  setCategories(settings, { expense:['食費'] });
  settings.majors = { 食費: { label: '変動費' } };
  const f = await loadForm(settings);
  const major = f.lists.expense.children[0].querySelector('.major');

  fire(f, 'expense', major, '食');
  fire(f, 'expense', major, '食費');

  assert.equal(f.majorLabels.children[0].querySelector('.major-label').value, '変動費');
  assert.deepEqual(fromYaml(previewYaml()).majors, { 食費: { label: '変動費' } });
});

test('支出から大項目がなくなると通知表示名の設定も削除する', async () => {
  const settings = single();
  setCategories(settings, { expense:['食費', '日用品'] });
  settings.majors = { 食費: { label: '変動費', notify: false }, 日用品: { label: '生活費' } };
  const f = await loadForm(settings);
  f.lists.expense.children[0].querySelector('.remove').handlers.click();
  assert.deepEqual(f.majorLabels.children.map((row) => row.querySelector('.major-name').textContent), ['日用品']);
  assert.deepEqual(fromYaml(previewYaml()).majors, { 日用品: { label: '生活費' } });
});

test('一括追加: 大項目の中項目のうち行に無いものだけを追加し、settings.categories.expense に反映する', async () => {
  const settings = single();
  settings.destinations[0].categories =['食費', '食費/外食'];
  settings.destinations[0].budgets.monthlyByCategory = {};
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
  const settings = single();
  settings.destinations[0].categories =['日用品'];
  settings.destinations[0].budgets.monthlyByCategory = {};
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

test('stats のカテゴリ提案を押すと月予算へ反映し、年・月・週の提案は出さない', async () => {
  assert.equal(Object.keys(statsFixture.months).length, 7);
  const settings = single();
  setCategories(settings, { expense:['食費'] });
  settings.destinations[0].budgets.monthlyByCategory = {};
  const f = await loadForm(settings, CATEGORIES, statsFixture);
  assert.match(env.el('budget-suggestions').children.map((child) => child.textContent).join(' '), /直近 6 か月の中央値/);
  assert.equal(env.el('budget-total-monthly').textContent, '未設定');

  const rowBudget = f.lists.expense.children[0].querySelector('.budget');
  const rowSuggestion = f.lists.expense.children[0].querySelector('.suggest-slot').children[0];
  assert.equal(rowSuggestion.textContent, '提案 34,000');
  rowSuggestion.handlers.click();
  assert.equal(rowBudget.value, '34000');
  assert.deepEqual(fromYaml(previewYaml()).destinations[0].budgets, { monthlyByCategory: { 食費: 34000 } });
  assert.equal(env.el('budget-total-monthly').textContent, '34,000 円');
  assert.equal(env.el('save').disabled, false);
});

test('stats が無いか壊れていても編集でき、案内だけ表示する', async () => {
  for (const stats of [null, '{broken', '{}']) {
    const f = await loadForm(single(), undefined, stats);
    const suggestions = env.el('budget-suggestions');
    assert.equal(suggestions.children.length, 1);
    assert.equal(suggestions.children[0].textContent, 'PC で 1 回実行すると提案が出ます');
    assert.equal(suggestions.children.some((child) => child.className === 'apply-suggestions'), false);
    for (const row of f.lists.expense.children) assert.equal(row.querySelector('.suggest-slot').children.length, 0);

    fire(f, 'expense', f.lists.expense.children[0].querySelector('.budget'), '123000');
    assert.equal(fromYaml(previewYaml()).destinations[0].budgets.monthlyByCategory.食費, 123000);
  }
});

test('有効な stats が 0 か月なら提案を出さず案内だけ表示する', async () => {
  const emptyStats = { updatedAt: '2026-10-06T00:00:00.000Z', monthStartDay: 1, months: {} };
  const f = await loadForm(single(), CATEGORIES, emptyStats);
  const controls = env.el('budget-suggestions');
  assert.equal(controls.children.length, 1);
  assert.equal(controls.children[0].textContent, 'PC で 1 回実行すると提案が出ます');
  assert.equal(controls.children.some((child) => child.className === 'apply-suggestions'), false);
  assert.equal(controls.children.some((child) => child.className === 'suggestion-note'), false);
  for (const row of f.lists.expense.children) {
    assert.notEqual(row.querySelector('.budget').nextElementSibling.nextElementSibling?.className, 'suggest');
  }
});

test('すべて提案値にするでカテゴリの月予算を埋め、予算合計も更新する', async () => {
  await loadForm(single(), CATEGORIES, statsFixture);
  const button = env.el('budget-suggestions').children.find((child) => child.className === 'apply-suggestions');
  assert.equal(button.textContent, 'すべて提案値にする');
  button.handlers.click();

  assert.deepEqual(fromYaml(previewYaml()).destinations[0].budgets, {
    monthlyByCategory: { 食費: 34000, 日用品: 6000, 趣味・娯楽: 4000 },
  });
  // 44000×12 = 528000、528000/52 = 10153.8… → 10153
  assert.deepEqual(['monthly', 'yearly', 'weekly'].map((key) => env.el(`budget-total-${key}`).textContent),
    ['44,000 円', '528,000 円', '10,153 円']);
});

test('カテゴリ rule を変えると提案を再計算し、null の入力にはボタンを出さない', async () => {
  const settings = single();
  setCategories(settings, { expense:['食費'] });
  settings.destinations[0].budgets.monthlyByCategory = {};
  const f = await loadForm(settings, CATEGORIES, statsFixture);
  const row = f.lists.expense.children[0];
  const major = pick(row, 'major');
  assert.equal(row.querySelector('.suggest-slot').children[0].textContent, '提案 34,000');

  fire(f, 'expense', major, '日用品');
  assert.equal(row.querySelector('.suggest-slot').children[0].textContent, '提案 6,000');
  assert.deepEqual(savedCategories('expense'), ['日用品']);
});

const allocationSettings = () => {
  const settings = single();
  setCategories(settings, { expense:['Food', 'Daily', 'Trip'] });
  settings.destinations[0].budgets.monthlyByCategory = { Food: 30000, Daily: 10000 };
  settings.destinations[0].reserves = [{ category: 'Trip', monthly: 50000 }];
  return settings;
};
const totalsShown = () => ['monthly', 'yearly', 'weekly'].map((key) => env.el(`budget-total-${key}`).textContent);

test('予算合計: 積立以外のカテゴリ予算の合計を月・年・週（切り捨て）で表示する', async () => {
  await loadForm(allocationSettings(), null, statsFixture);
  // 40000×12 = 480000、480000/52 = 9230.7… → 9230
  assert.deepEqual(totalsShown(), ['40,000 円', '480,000 円', '9,230 円']);
});

test('予算合計: カテゴリ予算の編集・積立チェックで即時に更新し、0 件なら未設定', async () => {
  const f = await loadForm(allocationSettings(), null, statsFixture);
  const rows = f.lists.expense.children;
  fire(f, 'expense', rows[0].querySelector('.budget'), '50000');
  assert.deepEqual(totalsShown(), ['60,000 円', '720,000 円', '13,846 円']);
  assert.equal(f.allocationLegend.children[0].children[3].textContent, '83%');

  // Daily を積立にすると合計から外れる
  const reserve = rows[1].querySelector('.reserve');
  reserve.checked = true;
  reserve.closest = () => f.lists.expense;
  f.form.handlers.input({ target: reserve });
  assert.deepEqual(totalsShown(), ['50,000 円', '600,000 円', '11,538 円']);

  // 積立以外のカテゴリ予算が 0 件
  fire(f, 'expense', rows[0].querySelector('.budget'), '');
  assert.deepEqual(totalsShown(), ['未設定', '未設定', '未設定']);
  assert.equal(f.allocationChart.hidden, true);
});

test('allocation: 合計はカテゴリ予算の合計で、その他の支出・超過を出さない', async () => {
  const f = await loadForm(allocationSettings(), null, statsFixture);

  assert.equal(env.elements.has('allocation-income'), false);
  assert.equal(env.session.getItem('mfnotify.allocationIncome'), null);
  assert.equal(f.allocationChart.hidden, false);
  assert.equal(f.allocationChart.getAttribute('aria-label'), '月予算の内訳');
  assert.equal(f.allocationChart.getAttribute('viewBox'), '0 0 1000 28');
  const rects = f.allocationChart.children.filter((node) => node.tagName === 'rect');
  assert.deepEqual(rects.map((rect) => [rect.getAttribute('x'), rect.getAttribute('width')]), [['0', '750'], ['750', '250']]);
  assert.equal(f.allocationChart.querySelectorAll('pattern').length, 0);
  assert.equal(f.allocationChart.children.some((node) => node.tagName === 'line'), false);
  assert.deepEqual(f.allocationLegend.children.map((row) => [
    row.children[1].textContent, row.children[2].textContent, row.children[3].textContent,
  ]), [['Food', '30,000 円', '75%'], ['Daily', '10,000 円', '25%']]);
});

test('カテゴリ予算が無ければ内訳は案内だけ表示する', async () => {
  const settings = allocationSettings();
  delete settings.destinations[0].budgets;
  const f = await loadForm(settings, null, statsFixture);

  assert.equal(f.allocationChart.hidden, true);
  assert.equal(f.allocationChart.getAttribute('display'), 'none');
  assert.equal(f.allocationEmpty.textContent, '支出カテゴリに月予算を入力すると表示されます');
  assert.equal(f.allocationChart.children.length, 0);
  assert.equal(f.allocationLegend.children.length, 0);
  assert.deepEqual(totalsShown(), ['未設定', '未設定', '未設定']);
});

test('non-string expense entries do not shift allocation colors', async () => {
  const settings = single();
  setCategories(settings, { expense:['Food', 123, 'Daily'] });
  settings.destinations[0].budgets.monthlyByCategory = { Food: 60000, Daily: 20000 };
  const f = await loadForm(settings, null, statsFixture);
  const segmentRects = f.allocationChart.children.filter((node) => node.tagName === 'rect');

  assert.deepEqual(segmentRects.map((rect) => rect.getAttribute('fill')), ['#3b82c4', '#f39c12']);
});

test('廃止キー（収入カテゴリ・貯金・年/月/週予算）は読込時に外し、保存する YAML に残さない', async () => {
  const settings = single();
  settings.categories = { income: ['収入'] };
  Object.assign(settings.destinations[0].budgets, { yearly: 3000000, monthly: 250000, weekly: 60000 });
  settings.destinations[0].savings = { yearlyTarget: 2000000 };
  await loadForm(settings, null);
  assert.equal(env.el('save').disabled, false);
  const saved = fromYaml(previewYaml());
  assert.equal(Object.hasOwn(saved, 'categories'), false);
  assert.deepEqual(saved.destinations[0].budgets, { monthlyByCategory: { 食費: 60000, 日用品: 15000 } });
  assert.equal(Object.hasOwn(saved.destinations[0], 'savings'), false);
  // 表示はカテゴリ予算から導出（廃止キーの monthly は使わない）
  assert.deepEqual(totalsShown(), ['75,000 円', '900,000 円', '17,307 円']);
});

test('カテゴリ予算を全部消すと空の budgets を残さない', async () => {
  const settings = single();
  setCategories(settings, { expense:['食費'] });
  settings.destinations[0].budgets.monthlyByCategory = { 食費: 1000 };
  const f = await loadForm(settings, null);
  fire(f, 'expense', f.lists.expense.children[0].querySelector('.budget'), '');
  assert.equal(Object.hasOwn(fromYaml(previewYaml()).destinations[0], 'budgets'), false);
});

test('prototype-like rule keys do not use inherited proposals or erase existing budgets', async () => {
  const settings = single();
  const rules = ['constructor', 'toString', '__proto__'];
  const budgets = Object.fromEntries(rules.map((rule, index) => [rule, (index + 5) * 1000]));
  setCategories(settings, { expense:rules });
  settings.destinations[0].budgets.monthlyByCategory = budgets;
  const f = await loadForm(settings, undefined, statsFixture);
  const rows = f.lists.expense.children;

  assert.deepEqual(rows.map((row) => row.querySelector('.budget').value), [5000, 6000, 7000]);
  assert.ok(rows.every((row) => row.querySelector('.suggest-slot').children.length === 0));
  env.el('budget-suggestions').children.find((child) => child.className === 'apply-suggestions').handlers.click();
  fire(f, 'expense', rows[0].querySelector('.budget'), '5000');
  assert.deepEqual(fromYaml(previewYaml()).destinations[0].budgets.monthlyByCategory, budgets);
});

// ---- 通知先タブ

const tabs = () => env.el('tablist').children;
const tabTexts = () => tabs().map((tab) => tab.textContent);
const selectedTab = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true').textContent;
const clickTab = (label) => tabs().find((tab) => tab.textContent.startsWith(label)).handlers.click();
const typeInto = (f, path, value) => {
  const input = f.input(path);
  input.value = value;
  f.form.handlers.input({ target: input });
};

test('タブ: 共通と通知先ごとのタブを role/aria 付きで出し、矢印キー・Home・End で移動する', async () => {
  await loadForm(structuredClone(DEFAULTS));
  assert.deepEqual(tabTexts(), ['共通', '家計', 'おこづかい']);
  assert.deepEqual(tabs().map((tab) => [tab.getAttribute('role'), tab.getAttribute('aria-selected'), tab.tabIndex]),
    [['tab', 'true', 0], ['tab', 'false', -1], ['tab', 'false', -1]]);
  assert.deepEqual(tabs().map((tab) => tab.getAttribute('aria-controls')), ['panel-common', 'panel-destination', 'panel-destination']);
  assert.equal(env.el('panel-common').hidden, false);
  assert.equal(env.el('panel-destination').hidden, true);

  let prevented = 0;
  let focused = '';
  for (const id of ['tab-common', 'tab-0', 'tab-1']) document.getElementById(id).focus = () => { focused = id; };
  const key = (k) => env.el('tablist').handlers.keydown({ key: k, preventDefault: () => { prevented++; } });
  key('ArrowRight');
  assert.equal(selectedTab(), '家計');
  assert.equal(focused, 'tab-0', '描き直した選択中のタブへフォーカスを戻す');
  clickTab('おこづかい');
  assert.equal(focused, 'tab-1', 'クリック・Enter で選んでもフォーカスを失わない');
  clickTab('家計');
  assert.equal(env.el('panel-common').hidden, true);
  assert.equal(env.el('panel-destination').hidden, false);
  assert.equal(env.el('panel-destination').getAttribute('aria-labelledby'), 'tab-0');
  key('End');
  assert.equal(selectedTab(), 'おこづかい');
  key('ArrowRight');
  assert.equal(selectedTab(), '共通', '末尾から先頭へ回る');
  key('ArrowLeft');
  assert.equal(selectedTab(), 'おこづかい');
  key('Home');
  assert.equal(selectedTab(), '共通');
  key('a');
  assert.equal(prevented, 5, '移動キー以外は既定動作を止めない');
});

test('通知先タブの欄・カテゴリ行・予算は選んだ通知先の destinations[i] に読み書きする', async () => {
  const f = await loadForm(structuredClone(DEFAULTS));
  clickTab('おこづかい');
  assert.equal(f.input('destinations.*.name').value, 'おこづかい');
  assert.deepEqual(totalsShown(), ['30,000 円', '360,000 円', '6,923 円']);
  assert.equal(f.input('destinations.*.notifyThresholdYen').value, '');
  assert.deepEqual(f.lists.expense.children.map((row) => row.querySelector('.major').value), ['衣服・美容', '教養・教育']);

  typeInto(f, 'destinations.*.name', '自分用');
  typeInto(f, 'destinations.*.mentionOnWarning', '<@1>');
  typeInto(f, 'destinations.*.notifyThresholdYen', '2500');
  assert.equal(fromYaml(previewYaml()).destinations[1].notifyThresholdYen, 2500);
  typeInto(f, 'destinations.*.notifyThresholdYen', '');
  assert.equal(Object.hasOwn(fromYaml(previewYaml()).destinations[1], 'notifyThresholdYen'), false);
  fire(f, 'expense', f.lists.expense.children[0].querySelector('.budget'), '12000');
  assert.deepEqual(tabTexts(), ['共通', '家計', '自分用']);
  assert.deepEqual(totalsShown(), ['22,000 円', '264,000 円', '5,076 円']);

  const saved = fromYaml(previewYaml());
  assert.deepEqual(saved.destinations[1], {
    id: 'personal', name: '自分用', webhookRef: DEFAULTS.destinations[1].webhookRef, mentionOnWarning: '<@1>',
    categories: ['衣服・美容', '教養・教育'], budgets: { monthlyByCategory: { 衣服・美容: 12000, 教養・教育: 10000 } },
  });
  assert.deepEqual(saved.destinations[0], DEFAULTS.destinations[0], 'ほかの通知先は変えない');

  clickTab('家計');
  assert.deepEqual(totalsShown(), ['75,000 円', '900,000 円', '17,307 円']);
  assert.equal(f.input('destinations.*.notifyThresholdYen').value, 10000);
  assert.deepEqual(f.lists.expense.children.map((row) => row.querySelector('.major').value), ['食費', '日用品', '趣味・娯楽']);
});

test('通知先の追加: ランダム ID は衝突を避けて一意になり、既存 ID を保存時に保つ', async () => {
  const settings = structuredClone(DEFAULTS);
  const collision = '00000000000040008000000000000001';
  settings.destinations[0].id = collision;
  settings.destinations[1].id = 'dest-3';
  const existingIds = settings.destinations.map((dest) => dest.id);
  const f = await loadForm(settings);
  assert.equal(f.input('destinations.*.id'), undefined);
  assert.ok(f.slot('destinations.*.id'));
  env.el('add-destination').handlers.click();
  assert.deepEqual(tabTexts(), ['共通', '家計', 'おこづかい', '通知先4（エラー 1）']);
  assert.equal(selectedTab(), '通知先4（エラー 1）');
  const firstId = fromYaml(previewYaml()).destinations[2].id;
  assert.match(firstId, /^[0-9a-f]{32}$/);
  assert.equal(firstId, '00000000000040008000000000000002');
  assert.ok(!existingIds.includes(firstId));
  assert.equal(f.slot('destinations.*.webhookRef').textContent, '必須です');
  assert.equal(env.el('save').disabled, true);
  assert.equal(f.lists.expense.children.length, 0);

  typeInto(f, 'destinations.*.webhookRef', 'op://Private/new/credential');
  assert.equal(env.el('save').disabled, false);
  const saved = fromYaml(previewYaml());
  assert.deepEqual(saved.destinations.slice(0, 2).map((dest) => dest.id), existingIds);
  assert.deepEqual(saved.destinations[2],
    { id: firstId, name: '通知先4', webhookRef: 'op://Private/new/credential', mentionOnWarning: '', categories: [] });

  env.el('add-destination').handlers.click();
  const secondId = fromYaml(previewYaml()).destinations[3].id;
  assert.match(secondId, /^[0-9a-f]{32}$/);
  assert.notEqual(secondId, firstId);
  assert.ok(!existingIds.includes(secondId));
});

test('通知先の削除: 確認して消し、最後の 1 件は消せない', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.destinations[0].id = 'dest-1';
  settings.destinations[1].id = 'dest-2';
  const f = await loadForm(settings);
  clickTab('おこづかい');
  assert.equal(env.el('remove-destination').disabled, false);
  let asked = '';
  globalThis.confirm = (message) => { asked = message; return false; };
  env.el('remove-destination').handlers.click();
  assert.match(asked, /通知先「おこづかい」を削除しますか/);
  assert.equal(fromYaml(previewYaml()).destinations.length, 2, 'キャンセルなら消さない');

  globalThis.confirm = () => true;
  env.el('remove-destination').handlers.click();
  assert.deepEqual(tabTexts(), ['共通', '家計']);
  assert.equal(selectedTab(), '家計');
  assert.equal(f.input('destinations.*.name').value, '家計');
  assert.deepEqual(fromYaml(previewYaml()).destinations.map((d) => d.id), ['dest-1']);
  assert.equal(env.el('remove-destination').disabled, true);
  env.el('remove-destination').handlers.click();
  assert.deepEqual(fromYaml(previewYaml()).destinations.map((d) => d.id), ['dest-1'], '最後の 1 件は残す');

  env.el('add-destination').handlers.click();
  const readdedId = fromYaml(previewYaml()).destinations[1].id;
  assert.match(readdedId, /^[0-9a-f]{32}$/);
  assert.notEqual(readdedId, 'dest-2', '削除した ID を再利用しない');
});

test('旧形式は 1 件の通知先に変換して表示し、保存する YAML に旧キーを残さない', async () => {
  const legacy = {
    timezone: 'Asia/Tokyo',
    period: { monthStartDay: 1, weekStartsOn: 'monday' },
    categories: { expense: ['食費', '日用品'], income: ['収入'] },
    budgets: { monthly: 100000, monthlyByCategory: { 食費: 30000 } },
    savings: { yearlyTarget: 50000 },
    warnings: structuredClone(DEFAULTS.warnings),
    mf: structuredClone(DEFAULTS.mf),
    discord: { mentionOnWarning: '<@9>' },
    secrets: { provider: 'onepassword', refs: { webhookUrl: 'op://a/b/c', ...DEFAULTS.secrets.refs } },
  };
  const f = await loadForm(legacy);
  assert.match(env.el('toast').textContent, /旧形式の設定を通知先「家計」1 件に変換/);
  assert.deepEqual(tabTexts(), ['共通', '家計']);
  assert.equal(env.el('save').disabled, false);
  clickTab('家計');
  assert.equal(f.input('destinations.*.webhookRef').value, 'op://a/b/c');
  assert.deepEqual(totalsShown(), ['30,000 円', '360,000 円', '6,923 円']);

  const text = previewYaml();
  for (const key of ['discord', 'webhookUrl', '\nbudgets:', 'savings', 'expense', '\ncategories:', 'income', 'monthly:']) {
    assert.ok(!text.includes(key), key);
  }
  assert.deepEqual(fromYaml(text).destinations, [{
    id: 'default', name: '家計', webhookRef: 'op://a/b/c', mentionOnWarning: '<@9>', categories: ['食費', '日用品'],
    budgets: { monthlyByCategory: { 食費: 30000 } },
  }]);
});

test('予算提案は表示中の通知先のカテゴリで計算する', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.destinations[0].categories = ['食費'];
  settings.destinations[0].budgets.monthlyByCategory = {};
  settings.destinations[1].categories = ['日用品'];
  const f = await loadForm(settings, CATEGORIES, statsFixture);
  clickTab('家計');
  assert.equal(f.lists.expense.children[0].querySelector('.suggest-slot').children[0].textContent, '提案 34,000');
  clickTab('おこづかい');
  assert.equal(f.lists.expense.children[0].querySelector('.suggest-slot').children[0].textContent, '提案 6,000');
  env.el('budget-suggestions').children.find((child) => child.className === 'apply-suggestions').handlers.click();
  const saved = fromYaml(previewYaml());
  assert.deepEqual(saved.destinations[1].budgets, { monthlyByCategory: { 日用品: 6000 } });
  assert.deepEqual(saved.destinations[0].budgets, { monthlyByCategory: {} }, 'ほかの通知先の予算は変えない');
});

test('積立チェックで月額の保存先を切り替え、カテゴリ変更と行削除に追従する', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.destinations[0].categories = ['食費', '日用品'];
  settings.destinations[0].budgets.monthlyByCategory = { 食費: 2000, 日用品: 5000 };
  settings.destinations[1].budgets = { monthlyByCategory: { 衣服・美容: 3000 } };
  const otherBudgets = structuredClone(settings.destinations[1].budgets);
  const f = await loadForm(settings);
  const row = f.lists.expense.children[0];
  const reserve = row.querySelector('.reserve');
  assert.ok(reserve, '各支出カテゴリに積立チェックがある');
  const toggle = (checked) => {
    reserve.checked = checked;
    reserve.closest = () => f.lists.expense;
    f.form.handlers.input({ target: reserve });
  };

  toggle(true);
  assert.equal(row.querySelector('.budget').placeholder, '積立月額（空なら自動）');
  let savedSettings = fromYaml(previewYaml());
  assert.deepEqual(savedSettings.destinations[0].budgets.monthlyByCategory, { 日用品: 5000 });
  assert.deepEqual(savedSettings.destinations[0].reserves, [{ category: '食費', monthly: 2000 }]);

  toggle(false);
  savedSettings = fromYaml(previewYaml());
  assert.equal(Object.hasOwn(savedSettings.destinations[0], 'reserves'), false);
  assert.deepEqual(savedSettings.destinations[0].budgets.monthlyByCategory, { 食費: 2000, 日用品: 5000 });

  toggle(true);
  fire(f, 'expense', row.querySelector('.major'), '季節費');
  assert.deepEqual(fromYaml(previewYaml()).destinations[0].reserves, [{ category: '季節費', monthly: 2000 }]);
  row.querySelector('.remove').handlers.click();
  savedSettings = fromYaml(previewYaml());
  assert.equal(Object.hasOwn(savedSettings.destinations[0], 'reserves'), false);
  assert.deepEqual(savedSettings.destinations[1].budgets, otherBudgets);
});

test('積立行の自動提案は過去月平均を切り上げ、積立月額へ保存する', async () => {
  const settings = single();
  settings.destinations[0].categories = ['食費'];
  settings.destinations[0].budgets.monthlyByCategory = {};
  settings.destinations[0].reserves = [{ category: '食費' }];
  const proposal = reserveMonthlyProposal(statsFixture, '食費');
  assert.ok(proposal > 0);
  const f = await loadForm(settings, CATEGORIES, statsFixture);
  assert.ok(env.events.some(([, , url]) => url.includes('/contents/stats.json')), JSON.stringify(env.events));
  const row = f.lists.expense.children[0];
  assert.equal(row.querySelector('.reserve')?.checked, true);
  assert.equal(row.querySelector('.major').value, '食費');
  const slot = row.querySelector('.suggest-slot');
  assert.equal(slot.children.length, 1);
  const button = slot.children[0];
  assert.equal(button.textContent, `自動 ${proposal.toLocaleString('ja-JP')}`);
  button.handlers.click();
  const savedSettings = fromYaml(previewYaml());
  assert.deepEqual(savedSettings.destinations[0].reserves, [{ category: '食費', monthly: proposal }]);
  assert.equal(Object.hasOwn(savedSettings.destinations[0], 'budgets'), false, 'カテゴリ予算が無ければ budgets ごと書かない');
});

test('一括適用は積立の空欄を固定額にすることを注記する', async () => {
  const settings = single();
  settings.destinations[0].categories = ['食費'];
  settings.destinations[0].budgets.monthlyByCategory = {};
  settings.destinations[0].reserves = [{ category: '食費' }];
  const proposal = reserveMonthlyProposal(statsFixture, '食費');
  const f = await loadForm(settings, CATEGORIES, statsFixture);
  const note = env.el('budget-suggestions').children.find((child) => child.className === 'suggestion-note').textContent;
  assert.match(note, /通常.*中央値/);
  assert.match(note, /積立.*平均/);
  assert.match(note, /空欄.*固定/);

  env.el('budget-suggestions').children.find((child) => child.className === 'apply-suggestions').handlers.click();
  assert.deepEqual(fromYaml(previewYaml()).destinations[0].reserves, [{ category: '食費', monthly: proposal }]);
});

test('大項目の表示名表は全通知先のカテゴリの大項目を対象にし、使われている大項目の表示名だけ保存する', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.majors = { 食費: { label: '変動費' }, 衣服・美容: { label: '身だしなみ' }, 交通費: { label: '移動' } };
  const f = await loadForm(settings);
  const names = () => f.majorLabels.children.map((row) => row.querySelector('.major-name').textContent);
  assert.deepEqual(names(), ['食費', '日用品', '趣味・娯楽', '衣服・美容', '教養・教育']);
  clickTab('おこづかい');
  assert.deepEqual(names(), ['食費', '日用品', '趣味・娯楽', '衣服・美容', '教養・教育'], 'タブを変えても同じ');
  assert.deepEqual(fromYaml(previewYaml()).majors, { 食費: { label: '変動費' }, 衣服・美容: { label: '身だしなみ' } });
});

test('ほかの通知先と重なるカテゴリ: 行に割り当て済みと出して保存を止め、一括追加では足さない', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.destinations[0].categories = ['食費/外食'];
  settings.destinations[0].budgets.monthlyByCategory = {};
  settings.destinations[1].categories = ['日用品'];
  const f = await loadForm(settings, CATEGORIES);
  clickTab('おこづかい');
  env.el('bulk-major').value = '食費';
  env.el('bulk-add-button').handlers.click();
  assert.deepEqual(fromYaml(previewYaml()).destinations[1].categories, ['日用品', '食費/カフェ', '食費/食料品'], '外食は家計に割り当て済み');
  env.el('bulk-add-button').handlers.click();
  assert.match(env.el('toast').textContent, /追加する中項目はありません/);

  f.add('expense').handlers.click();
  const row = f.lists.expense.children.at(-1);
  fire(f, 'expense', pick(row, 'major'), '食費');
  fire(f, 'expense', pick(row, 'minor'), '\0whole');
  assert.equal(row.querySelector('.row-error').textContent, '家計 に割り当て済み');
  assert.equal(env.el('save').disabled, true);
  assert.match(f.slot('destinations.*.categories').textContent, /「食費」は「家計」のカテゴリと重なっています/);
  assert.match(tabTexts()[2], /^おこづかい（エラー \d+）$/);

  fire(f, 'expense', pick(row, 'minor'), '外食');
  assert.equal(row.querySelector('.row-error').textContent, '家計 に割り当て済み');
  fire(f, 'expense', pick(row, 'major'), '日用品');
  fire(f, 'expense', pick(row, 'minor'), '\0whole');
  assert.equal(row.querySelector('.row-error').textContent, 'この通知先で重複しています');
  row.querySelector('.remove').handlers.click();
  assert.equal(env.el('save').disabled, false);
});

test('表示中でない通知先の誤りは欄に出さず、タブに件数を出す', async () => {
  const settings = structuredClone(DEFAULTS);
  settings.destinations[1].webhookRef = '';
  const f = await loadForm(settings);
  clickTab('家計');
  assert.equal(f.slot('destinations.*.webhookRef').textContent, '');
  assert.deepEqual(tabTexts(), ['共通', '家計', 'おこづかい（エラー 1）']);
  assert.equal(env.el('other-errors').children.length, 0);
  assert.equal(env.el('save').disabled, true);
  clickTab('おこづかい');
  assert.equal(f.slot('destinations.*.webhookRef').textContent, '必須です');
});
