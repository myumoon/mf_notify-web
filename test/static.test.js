// 配信物の静的検査: README の必須記述・外部参照なし・innerHTML 不使用・npm 依存なし。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('test/ の *.test.js はすべて index.js から読まれる（node --test test/ は index.js だけを実行する）', () => {
  const index = read('test/index.js');
  for (const name of readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.test.js'))) {
    assert.ok(index.includes(`import './${name}';`), name);
  }
});

test('SVG namespace uses the explicit standard URI', () => {
  assert.ok(read('app.js').includes("const SVG_NS = 'http://www.w3.org/2000/svg';"));
});

test('allocation has no monthly income input or session state', () => {
  const html = read('index.html');
  const app = read('app.js');
  for (const oldSurface of [
    'allocation-income', 'ALLOCATION_INCOME_KEY', 'allocationIncome', 'medianIncome',
    'updateAllocationIncome', 'mfnotify.allocationIncome', '収入と予算の割り振り', '月収',
  ]) assert.ok(!`${html}\n${app}`.includes(oldSurface), oldSurface);
  assert.match(html, /<h2>月予算の内訳<\/h2>/);
});

test('収入カテゴリ・貯金・年/月/週予算の入力欄は無く、予算合計は読み取り専用で表示する', () => {
  const html = read('index.html');
  for (const removed of [
    '収入カテゴリ', 'data-list="income"', 'data-add="income"', 'categories.income', '<h2>貯金</h2>', 'savings',
    'budgets.yearly', 'budgets.monthly"', 'budgets.weekly', 'allocation-overflow',
  ]) assert.ok(!html.includes(removed), removed);
  assert.ok(!read('app.js').includes('その他の支出'));
  const section = html.match(/<h2>予算合計[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, '予算合計 section exists');
  for (const key of ['monthly', 'yearly', 'weekly']) assert.match(section, new RegExp(`<output id="budget-total-${key}"`));
  assert.doesNotMatch(section, /<input/);
});

test('notification threshold is an optional integer field after warning mention with a semantics note', () => {
  const html = read('index.html');
  assert.match(html, /data-path="destinations\.\*\.mentionOnWarning"[\s\S]*?<\/label>\s*<label class="field">通知する支出の増加額（円、空なら 10000）/);
  const field = html.match(/<label class="field">通知する支出の増加額（円、空なら 10000）[\s\S]*?<\/label>/)?.[0];
  assert.ok(field, 'threshold label exists');
  assert.match(field, /<input\b(?=[^>]*\btype="number")(?=[^>]*\bdata-path="destinations\.\*\.notifyThresholdYen")(?=[^>]*\bdata-optional)(?=[^>]*\bmin="0")(?=[^>]*\bstep="1")(?=[^>]*\binputmode="numeric")[^>]*>/);
  assert.match(field, /data-error-for="destinations\.\*\.notifyThresholdYen"/);
  assert.match(html, /<p class="note">通知対象の支出が前回通知から設定額以上増えたときに通知します。notify:false の大項目と積立は数えません。<\/p>/);
});

test('destination ID cannot be edited in the form and retains its validation error slot', () => {
  const html = read('index.html');
  assert.equal(html.includes('ID（半角英小文字・数字・ハイフン、32 文字まで）'), false, 'ID label is removed');
  assert.equal(html.includes('data-path="destinations.*.id"'), false, 'ID input is removed');
  assert.match(html, /<span class="error" data-error-for="destinations\.\*\.id"><\/span>/, 'ID validation errors remain visible');
});

test('settings form columns stay shrinkable at desktop widths', () => {
  const desktop = read('style.css').match(/@media\s*\(min-width:\s*900px\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(desktop, '900px media query exists');
  // セクションはタブパネル（.panel）の中で 2 列に並ぶ
  const settingsForm = desktop.match(/#settings-form \.panel\s*\{([^}]*)\}/)?.[1];
  assert.ok(settingsForm, '#settings-form .panel rule exists in the 900px media query');
  assert.match(settingsForm, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)\s*;/);
});

test('支出カテゴリ section spans the settings panel on desktop', () => {
  const section = read('index.html').match(/<section class="expense-settings">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(section?.includes('data-list="expense"'), 'expense section is identified');
  const desktop = read('style.css').match(/@media\s*\(min-width:\s*900px\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(desktop, '900px media query exists');
  assert.match(desktop, /#settings-form\s+\.expense-settings\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/);
});

test('支出カテゴリ表は fine pointer で通常行を compact にし、touch target の既定サイズを保つ', () => {
  const css = read('style.css');
  const fine = css.match(/@media\s*\(pointer:\s*fine\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(fine, 'fine pointer media query exists');
  const rules = [...fine.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.ok(rules.length, 'fine pointer rules exist');
  for (const [, selector] of rules) assert.ok(selector.includes('.expense-table .expense-row'), selector);

  const controls = rules.find(([, selector, declarations]) =>
    /(?:input|select)/.test(selector) && /min-height:\s*\d+px/.test(declarations));
  assert.ok(controls, 'expense row controls have a fine pointer height override');
  assert.ok(Number(controls[2].match(/min-height:\s*(\d+)px/)[1]) <= 40, 'control height is at most 40px');
  assert.match(fine, /\.expense-table\s+\.expense-row:not\(\.expense-header\)\s*\{[^}]*padding-bottom:\s*0/);
  assert.match(fine, /\.expense-table\s+\.expense-row\s+\.budget-cell\s*\{[^}]*display:\s*flex/);
  assert.match(fine, /\.expense-table\s+\.expense-row\s+\.expense-drag-cell\s*\{[^}]*align-self:\s*stretch/);
  assert.match(fine, /\.expense-table\s+\.expense-row\s+\.expense-drag-handle\s*\{[^}]*flex:\s*1/);

  const defaultControls = css.match(/input\[type="text"\], input\[type="password"\], input\[type="number"\], select\s*\{([^}]*)\}/)?.[1];
  assert.ok(defaultControls, 'shared control rule exists');
  assert.match(defaultControls, /min-height:\s*44px/);
});

test('MF 一括更新の設定は現在の用途と上限を説明する', () => {
  const section = read('index.html').match(/<section>\s*<h2>マネーフォワード<\/h2>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(section, 'マネーフォワード section exists');
  assert.match(section, /<label class="check"><input type="checkbox" data-path="mf\.bulkUpdate\.enabled">\s*（予約）取得前に一括更新する ※現在は未使用。一括更新は refresh コマンドとタスクで実行します<\/label>/);
  assert.match(section, /<label class="field">一括更新の完了待ち（秒）[\s\S]*?<input type="number" data-path="mf\.bulkUpdate\.timeoutSeconds"[^>]*\bmax="1200"[^>]*>/);
  assert.match(section, /<p class="note">refresh コマンドで使用。1200 を超える値は 1200 として扱われます。<\/p>/);
});

const SHIPPED_JS = ['app.js', 'lib.js', 'github.js', 'config.js', 'worker/worker.js'];
const SHIPPED = [...SHIPPED_JS, 'index.html', 'style.css'];
// 行コメント（空白の後の //）とブロックコメントを除く。文字列中の https:// は残る。
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');

test('README: 使い方・PAT・GitHub App・Worker・config.js の手順がある', () => {
  const readme = read('README.md');
  for (const text of [
    '## 画面の使い方',
    '## fine-grained PAT の作り方',
    'Only select repositories',
    'Contents: Read and write',
    'Metadata: Read-only',
    'Callback URL',
    'Expire user authorization tokens',
    'npx wrangler deploy',
    'npx wrangler secret put GITHUB_CLIENT_SECRET',
    'ALLOWED_ORIGIN',
    'CLIENT_ID',
    'TOKEN_ENDPOINT',
    'APP_SLUG',
  ]) assert.ok(readme.includes(text), text);
});

test('外部リソースを参照しない（通信先は GitHub だけ）', () => {
  const allowed = new Set(['api.github.com', 'github.com', 'www.w3.org']);
  for (const path of SHIPPED) {
    const src = stripComments(read(path));
    for (const [url] of src.matchAll(/https?:\/\/[^\s'"`)<>]+/g)) {
      assert.ok(allowed.has(new URL(url).host), `${path}: ${url}`);
    }
    assert.doesNotMatch(src, /@import|url\(\s*['"]?(https?:)?\/\//, path);
  }
  const html = read('index.html');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.doesNotMatch(ref, /^(https?:)?\/\//, ref);
});

test('HTML を文字列で差し込む API を使わない', () => {
  for (const path of SHIPPED_JS) {
    assert.doesNotMatch(stripComments(read(path)), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, path);
  }
});

test('npm 依存・ビルド工程が無い（import は相対パスか node: だけ）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.devDependencies, undefined);
  assert.deepEqual(Object.keys(pkg.scripts), ['test']);
  for (const path of SHIPPED_JS) {
    for (const [, spec] of read(path).matchAll(/^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)) {
      assert.match(spec, /^\.{1,2}\//, `${path}: ${spec}`);
    }
  }
});

// Firefox は「・」(U+30FB) などを識別子に使えず、引用符なしのキーがあるとモジュール全体が読み込まれない
test('配信する JS は非 ASCII のオブジェクトキーを引用符で囲む', () => {
  for (const file of ['app.js', 'lib.js', 'github.js', 'config.js']) {
    const unquoted = read(file).match(/[{,]\s*[^\s'"`{}:,()]*[^\x00-\x7F][^\s'"`{}:,()]*\s*:/g);
    assert.equal(unquoted, null, `${file}: ${unquoted}`);
  }
});
