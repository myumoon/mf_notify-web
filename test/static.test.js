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
  const allowed = new Set(['api.github.com', 'github.com']);
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
