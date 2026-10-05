import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, validate, toYaml, fromYaml, categoryOptions, splitCategory, joinCategory } from '../lib.js';

const fresh = () => structuredClone(DEFAULTS);
const paths = (settings) => validate(settings).map((e) => e.path);
const withChange = (mutate) => {
  const s = fresh();
  mutate(s);
  return s;
};

test('DEFAULTS は検証を通る', () => {
  assert.deepEqual(validate(fresh()), []);
});

test('任意項目（budgets 全体・mf）が無くても通る', () => {
  assert.deepEqual(validate(withChange((s) => { delete s.budgets; delete s.mf; })), []);
  assert.deepEqual(validate(withChange((s) => { delete s.budgets.yearly; s.budgets.weekly = null; })), []);
});

test('必須欠落はパス付きの日本語メッセージ', () => {
  const errors = validate(withChange((s) => {
    delete s.savings.yearlyTarget;
    delete s.period;
    delete s.timezone;
    delete s.warnings.stale.ignoreAccounts;
    delete s.discord.mentionOnWarning;
  }));
  assert.deepEqual(errors.map((e) => e.path).sort(), [
    'discord.mentionOnWarning', 'period', 'savings.yearlyTarget', 'timezone', 'warnings.stale.ignoreAccounts',
  ]);
  for (const e of errors) assert.equal(e.message, '必須です');
});

test('範囲外', () => {
  for (const day of [0, 29]) assert.deepEqual(paths(withChange((s) => { s.period.monthStartDay = day; })), ['period.monthStartDay']);
  for (const day of [1, 28]) assert.deepEqual(paths(withChange((s) => { s.period.monthStartDay = day; })), []);
  for (const m of [101, -1]) assert.deepEqual(paths(withChange((s) => { s.warnings.pace.marginPercent = m; })), ['warnings.pace.marginPercent']);
  for (const m of [0, 100, 12.5]) assert.deepEqual(paths(withChange((s) => { s.warnings.pace.marginPercent = m; })), []);
  assert.deepEqual(paths(withChange((s) => { s.warnings.stale.maxAgeHours = 23; })), ['warnings.stale.maxAgeHours']);
  assert.deepEqual(paths(withChange((s) => { s.warnings.stale.maxAgeHours = 24; })), []);
  for (const key of ['yearly', 'monthly', 'weekly']) {
    assert.deepEqual(paths(withChange((s) => { s.budgets[key] = 0; })), [`budgets.${key}`]);
  }
  assert.deepEqual(paths(withChange((s) => { s.savings.yearlyTarget = -5; })), ['savings.yearlyTarget']);
  assert.match(validate(withChange((s) => { s.period.monthStartDay = 29; }))[0].message, /1〜28/);
});

test('monthlyByCategory のキーは支出カテゴリに含まれる', () => {
  const errors = validate(withChange((s) => { s.budgets.monthlyByCategory.旅行 = 1000; }));
  assert.deepEqual(errors.map((e) => e.path), ['budgets.monthlyByCategory.旅行']);
  assert.match(errors[0].message, /支出カテゴリにありません/);
  assert.deepEqual(paths(withChange((s) => { s.budgets.monthlyByCategory.食費 = 0; })), ['budgets.monthlyByCategory.食費']);
});

test('型違い', () => {
  assert.deepEqual(paths(withChange((s) => { s.period.monthStartDay = true; })), ['period.monthStartDay']);
  assert.deepEqual(paths(withChange((s) => { s.period.monthStartDay = 1.5; })), ['period.monthStartDay']);
  assert.deepEqual(paths(withChange((s) => { s.savings.yearlyTarget = '100'; })), ['savings.yearlyTarget']);
  assert.deepEqual(paths(withChange((s) => { s.warnings.pace.marginPercent = true; })), ['warnings.pace.marginPercent']);
  assert.deepEqual(paths(withChange((s) => { s.warnings.overBudget.enabled = 1; })), ['warnings.overBudget.enabled']);
  assert.deepEqual(paths(withChange((s) => { s.categories.expense = ['食費', '日用品', '']; })), ['categories.expense']);
  assert.deepEqual(paths(withChange((s) => { s.categories.income = '収入'; })), ['categories.income']);
  assert.deepEqual(paths(withChange((s) => { s.warnings.pace = []; })), ['warnings.pace']);
  assert.deepEqual(paths(withChange((s) => { s.discord.mentionOnWarning = 1; })), ['discord.mentionOnWarning']);
  assert.deepEqual(paths(withChange((s) => { s.mf.bulkUpdate.timeoutSeconds = 0; })), ['mf.bulkUpdate.timeoutSeconds']);
  assert.deepEqual(paths(null), ['']);
});

test('timezone・provider・refs', () => {
  assert.deepEqual(paths(withChange((s) => { s.timezone = 'UTC'; })), ['timezone']);
  assert.deepEqual(paths(withChange((s) => { s.period.weekStartsOn = 'friday'; })), ['period.weekStartsOn']);
  assert.deepEqual(paths(withChange((s) => { s.secrets.provider = 'vault'; })), ['secrets.provider']);
  assert.deepEqual(paths(withChange((s) => { s.secrets.provider = 'env'; })), []);
  assert.deepEqual(paths(withChange((s) => { s.secrets.refs.mfEmail = ''; delete s.secrets.refs.mfTotpSecret; })),
    ['secrets.refs.mfEmail', 'secrets.refs.mfTotpSecret']);
});

test('メッセージは全て日本語', () => {
  const errors = validate({ timezone: 1, period: 1, categories: 1, budgets: 1, savings: 1, warnings: 1, mf: 1, discord: 1, secrets: 1 });
  assert.ok(errors.length >= 8);
  for (const e of errors) assert.match(e.message, /[぀-ヿ一-鿿]/);
});

test('toYaml → fromYaml の往復で等価', () => {
  const s = withChange((x) => { x.discord.mentionOnWarning = '<@123>'; x.categories.expense.push('食費/外食'); });
  assert.deepEqual(fromYaml(toYaml(s)), s);
});

test('キー順は DEFAULTS 順、未知キーは保持して後ろへ', () => {
  const s = fresh();
  const shuffled = { secrets: { refs: { mfTotpSecret: 'op://a/b/c', webhookUrl: 'op://a/b/d', mfEmail: 'op://e', mfPassword: 'op://f' }, provider: 'env' }, extra: { keep: 1 } };
  for (const key of Object.keys(s).reverse()) if (!(key in shuffled)) shuffled[key] = s[key];
  shuffled.budgets = { monthlyByCategory: { 日用品: 1, 食費: 2 }, weekly: 3 };
  const back = fromYaml(toYaml(shuffled));
  assert.deepEqual(Object.keys(back), [...Object.keys(DEFAULTS), 'extra']);
  assert.deepEqual(Object.keys(back.secrets), ['provider', 'refs']);
  assert.deepEqual(Object.keys(back.secrets.refs), ['webhookUrl', 'mfEmail', 'mfPassword', 'mfTotpSecret']);
  assert.deepEqual(Object.keys(back.budgets), ['weekly', 'monthlyByCategory']);
  assert.deepEqual(Object.keys(back.budgets.monthlyByCategory), ['日用品', '食費']);
  assert.deepEqual(back.extra, { keep: 1 });
});

test('日本語はエスケープしない', () => {
  const text = toYaml(fresh());
  assert.ok(text.includes('趣味・娯楽'));
  assert.ok(!text.includes('\\u'));
  assert.ok(text.startsWith('timezone: Asia/Tokyo\n'));
});

test('fromYaml は YAML 1.2（JSON 相当）で読み、日付を変換しない', () => {
  assert.deepEqual(fromYaml('a: 2026-10-06\nb: 1\nc: true\n'), { a: '2026-10-06', b: 1, c: true });
  assert.deepEqual(fromYaml(''), {});
});

test('categoryOptions: ソート・重複除去・空', () => {
  const opts = categoryOptions({ updatedAt: 'x', categories: { 食費: ['外食', '食料品', '外食', ''], 収入: [], 交通費: ['電車'] } });
  assert.deepEqual(opts.majors, ['交通費', '収入', '食費'].sort());
  assert.deepEqual(opts.minors.食費, ['外食', '食料品'].sort());
  assert.deepEqual(opts.minors.収入, []);
  for (const empty of [null, undefined, {}, { categories: {} }, { categories: [] }]) {
    assert.deepEqual(categoryOptions(empty), { majors: [], minors: {} });
  }
});

test('splitCategory / joinCategory', () => {
  assert.deepEqual(splitCategory('食費/外食'), { major: '食費', minor: '外食' });
  assert.deepEqual(splitCategory('食費'), { major: '食費', minor: '' });
  assert.equal(joinCategory('食費', '外食'), '食費/外食');
  assert.equal(joinCategory('食費', ''), '食費');
});
