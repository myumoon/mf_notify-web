import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, validate, toYaml, fromYaml, categoryOptions, missingMinors, minorsOf, splitCategory, joinCategory } from '../lib.js';
import * as lib from '../lib.js';

const fresh = () => structuredClone(DEFAULTS);
const paths = (settings) => validate(settings).map((e) => e.path);
const withChange = (mutate) => {
  const s = fresh();
  mutate(s);
  return s;
};

test('moveItem は配列を変更せず要素を前後へ移動する', () => {
  const items = ['食費', '日用品', '趣味'];
  assert.deepEqual(lib.moveItem(items, 0, 2), ['日用品', '趣味', '食費']);
  assert.deepEqual(lib.moveItem(items, 2, 0), ['趣味', '食費', '日用品']);
  assert.deepEqual(items, ['食費', '日用品', '趣味']);
});

test('formatYen: 3 桁区切り・負数・非数', () => {
  assert.equal(typeof lib.formatYen, 'function');
  for (const [value, expected] of [
    [0, '0 円'],
    [1000, '1,000 円'],
    [1234567, '1,234,567 円'],
    [-1000, '-1,000 円'],
    [NaN, '—'],
    [undefined, '—'],
    [null, '—'],
    [Infinity, '—'],
  ]) assert.equal(lib.formatYen(value), expected);
});

test('DEFAULTS は検証を通る', () => {
  assert.deepEqual(validate(fresh()), []);
});

test('任意項目（budgets 全体・mf）が無くても通る', () => {
  assert.deepEqual(validate(withChange((s) => { delete s.destinations[0].budgets; delete s.mf; })), []);
  assert.deepEqual(validate(withChange((s) => { delete s.destinations[0].budgets.yearly; s.destinations[0].budgets.weekly = null; })), []);
});

test('必須欠落はパス付きの日本語メッセージ', () => {
  const errors = validate(withChange((s) => {
    delete s.period;
    delete s.timezone;
    delete s.warnings.stale.ignoreAccounts;
    delete s.destinations[0].name;
  }));
  assert.deepEqual(errors.map((e) => e.path).sort(), [
    'destinations.0.name', 'period', 'timezone', 'warnings.stale.ignoreAccounts',
  ]);
  for (const e of errors) assert.equal(e.message, '必須です');
});

test('貯金の年間目標と空の savings は任意', () => {
  assert.deepEqual(validate(withChange((s) => { delete s.destinations[0].savings.yearlyTarget; })), []);
  assert.deepEqual(validate(withChange((s) => { delete s.destinations[0].savings; })), []);
});

test('範囲外', () => {
  for (const day of [0, 29]) assert.deepEqual(paths(withChange((s) => { s.period.monthStartDay = day; })), ['period.monthStartDay']);
  for (const day of [1, 28]) assert.deepEqual(paths(withChange((s) => { s.period.monthStartDay = day; })), []);
  for (const m of [101, -1]) assert.deepEqual(paths(withChange((s) => { s.warnings.pace.marginPercent = m; })), ['warnings.pace.marginPercent']);
  for (const m of [0, 100, 12.5]) assert.deepEqual(paths(withChange((s) => { s.warnings.pace.marginPercent = m; })), []);
  assert.deepEqual(paths(withChange((s) => { s.warnings.stale.maxAgeHours = 23; })), ['warnings.stale.maxAgeHours']);
  assert.deepEqual(paths(withChange((s) => { s.warnings.stale.maxAgeHours = 24; })), []);
  for (const key of ['yearly', 'monthly', 'weekly']) {
    assert.deepEqual(paths(withChange((s) => { s.destinations[0].budgets[key] = 0; })), [`destinations.0.budgets.${key}`]);
  }
  assert.deepEqual(paths(withChange((s) => { s.destinations[0].savings.yearlyTarget = -5; })), ['destinations.0.savings.yearlyTarget']);
  assert.match(validate(withChange((s) => { s.period.monthStartDay = 29; }))[0].message, /1〜28/);
});

test('monthlyByCategory のキーは支出カテゴリに含まれる', () => {
  const errors = validate(withChange((s) => { s.destinations[0].budgets.monthlyByCategory.旅行 = 1000; }));
  assert.deepEqual(errors.map((e) => e.path), ['destinations.0.budgets.monthlyByCategory.旅行']);
  assert.match(errors[0].message, /支出カテゴリにありません/);
  assert.deepEqual(paths(withChange((s) => { s.destinations[0].budgets.monthlyByCategory.食費 = 0; })), ['destinations.0.budgets.monthlyByCategory.食費']);
});

test('majors は任意の object で、各 label は任意の文字列', () => {
  assert.deepEqual(paths(withChange((s) => { s.majors = { 食費: { label: '変動費' }, 日用品: {} }; })), []);
  assert.deepEqual(paths(withChange((s) => { s.majors = { 食費: { label: '' } }; })), []);
  assert.deepEqual(paths(withChange((s) => { s.majors = []; })), ['majors']);
  assert.deepEqual(paths(withChange((s) => { s.majors = null; })), []);
  assert.deepEqual(paths(withChange((s) => { s.majors = { 食費: [] }; })), ['majors.食費']);
  assert.deepEqual(paths(withChange((s) => { s.majors = { 食費: null }; })), ['majors.食費']);
  assert.deepEqual(paths(withChange((s) => { s.majors = { 食費: { label: 1 } }; })), ['majors.食費.label']);
  assert.deepEqual(paths(withChange((s) => { s.majors = { [Object.keys(s.majors)[0]]: { label: null } }; })), []);
});

test('majors.notify は省略可能な boolean', () => {
  assert.deepEqual(paths(withChange((s) => { s.majors = { 食費: {}, 日用品: { notify: false } }; })), []);
  assert.deepEqual(paths(withChange((s) => { s.majors = { 食費: { notify: true } }; })), []);
  for (const notify of ['false', 0]) {
    assert.deepEqual(paths(withChange((s) => { s.majors = { 食費: { notify } }; })), ['majors.食費.notify']);
  }
  assert.deepEqual(paths(withChange((s) => { s.majors = { [Object.keys(s.majors)[0]]: { notify: null } }; })), []);
});

test('advisor の provider・model・timeoutSeconds を検証する', () => {
  assert.deepEqual(paths(fresh()), []);
  assert.deepEqual(paths(withChange((s) => { s.advisor = null; })), []);
  assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'claude' }; })), []);
  assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'codex', model: 'gpt-5.1/codex[fast]', timeoutSeconds: 600 }; })), []);
  assert.deepEqual(paths(withChange((s) => { s.advisor = {}; })), ['advisor.provider']);
  assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'other' }; })), ['advisor.provider']);
  for (const model of ['contains space', 'a'.repeat(65)]) {
    assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'claude', model }; })), ['advisor.model']);
  }
  assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'claude', model: null }; })), []);
  assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'claude', model: '' }; })), []);
  for (const timeoutSeconds of [29, 601, 30.5]) {
    assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'claude', timeoutSeconds }; })), ['advisor.timeoutSeconds']);
  }
  assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'claude', timeoutSeconds: null }; })), []);
  for (const timeoutSeconds of [30, 600]) {
    assert.deepEqual(paths(withChange((s) => { s.advisor = { provider: 'claude', timeoutSeconds }; })), []);
  }
});

test('型違い', () => {
  assert.deepEqual(paths(withChange((s) => { s.period.monthStartDay = true; })), ['period.monthStartDay']);
  assert.deepEqual(paths(withChange((s) => { s.period.monthStartDay = 1.5; })), ['period.monthStartDay']);
  assert.deepEqual(paths(withChange((s) => { s.destinations[0].savings.yearlyTarget = '100'; })), ['destinations.0.savings.yearlyTarget']);
  assert.deepEqual(paths(withChange((s) => { s.warnings.pace.marginPercent = true; })), ['warnings.pace.marginPercent']);
  assert.deepEqual(paths(withChange((s) => { s.warnings.overBudget.enabled = 1; })), ['warnings.overBudget.enabled']);
  assert.deepEqual(paths(withChange((s) => { s.destinations[0].categories = ['食費', '日用品', '']; })), ['destinations.0.categories']);
  assert.deepEqual(paths(withChange((s) => { s.categories.income = '収入'; })), ['categories.income']);
  assert.deepEqual(paths(withChange((s) => { s.warnings.pace = []; })), ['warnings.pace']);
  assert.deepEqual(paths(withChange((s) => { s.destinations[0].mentionOnWarning = 1; })), ['destinations.0.mentionOnWarning']);
  assert.deepEqual(paths(withChange((s) => { s.mf.bulkUpdate.timeoutSeconds = 0; })), ['mf.bulkUpdate.timeoutSeconds']);
  assert.deepEqual(paths(null), ['']);
});

test('destinations: notifyThresholdYen は任意の 0 以上の整数', () => {
  const missing = fresh();
  delete missing.destinations[0].notifyThresholdYen;
  assert.deepEqual(validate(missing), []);
  for (const value of [0, 10000]) {
    assert.deepEqual(paths(withChange((s) => { s.destinations[0].notifyThresholdYen = value; })), []);
  }
  for (const [value, message] of [
    [-1, '0 以上の整数で入力してください'],
    [1.5, '整数で入力してください'],
    ['10000', '整数で入力してください'],
    [true, '整数で入力してください'],
  ]) {
    const errors = validate(withChange((s) => { s.destinations[0].notifyThresholdYen = value; }));
    assert.deepEqual(errors.map(({ path }) => path), ['destinations.0.notifyThresholdYen']);
    assert.equal(errors[0].message, message);
  }
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
  const errors = validate({ timezone: 1, period: 1, categories: 1, warnings: 1, mf: 1, secrets: 1, destinations: [1, { id: 'X' }] });
  assert.ok(errors.length >= 8);
  for (const e of errors) assert.match(e.message, /[぀-ヿ一-鿿]/);
});

test('toYaml → fromYaml の往復で等価', () => {
  const s = withChange((x) => { x.destinations[0].mentionOnWarning = '<@123>'; x.destinations[0].categories.push('食費/外食'); });
  assert.deepEqual(fromYaml(toYaml(s)), s);
});

test('キー順は DEFAULTS 順、未知キーは保持して後ろへ', () => {
  const s = fresh();
  const shuffled = { secrets: { refs: { mfTotpSecret: 'op://a/b/c', mfEmail: 'op://e', mfPassword: 'op://f' }, provider: 'env' }, extra: { keep: 1 } };
  for (const key of Object.keys(s).reverse()) if (!(key in shuffled)) shuffled[key] = s[key];
  shuffled.destinations = [
    { extra: 1, budgets: { monthlyByCategory: { 日用品: 1, 食費: 2 }, weekly: 3 }, categories: ['食費'], notifyThresholdYen: 0, mentionOnWarning: '<@1>', webhookRef: 'w', name: 'n', id: 'a' },
    { savings: { yearlyTarget: 1 }, id: 'b' },
  ];
  const back = fromYaml(toYaml(shuffled));
  assert.deepEqual(Object.keys(back), [...Object.keys(DEFAULTS), 'extra']);
  assert.deepEqual(Object.keys(back.secrets), ['provider', 'refs']);
  assert.deepEqual(Object.keys(back.secrets.refs), ['mfEmail', 'mfPassword', 'mfTotpSecret']);
  assert.deepEqual(back.destinations.map((d) => Object.keys(d)), [['id', 'name', 'webhookRef', 'mentionOnWarning', 'notifyThresholdYen', 'categories', 'budgets', 'extra'], ['id', 'savings']]);
  assert.deepEqual(Object.keys(back.destinations[0].budgets), ['weekly', 'monthlyByCategory']);
  assert.deepEqual(Object.keys(back.destinations[0].budgets.monthlyByCategory), ['日用品', '食費']);
  assert.deepEqual(back.extra, { keep: 1 });
});

test('DEFAULTS は本体 settings.example.yml と同じ形（destinations の各キー順・旧キー無し）', () => {
  const text = toYaml(fresh());
  assert.deepEqual(Object.keys(DEFAULTS), ['timezone', 'period', 'categories', 'majors', 'destinations', 'warnings', 'mf', 'secrets']);
  assert.equal(Object.hasOwn(DEFAULTS, 'advisor'), false);
  assert.deepEqual(Object.keys(DEFAULTS.destinations[0]), ['id', 'name', 'webhookRef', 'mentionOnWarning', 'notifyThresholdYen', 'categories', 'budgets', 'savings']);
  assert.deepEqual(DEFAULTS.destinations.map((d) => d.id), ['family', 'personal']);
  assert.deepEqual(DEFAULTS.categories, { income: ['収入'] });
  for (const legacy of ['discord:', 'webhookUrl', '\nbudgets:', '\nsavings:', 'expense']) assert.ok(!text.includes(legacy), legacy);
});

test('advisor は YAML で mf の後・secrets の前に並ぶ', () => {
  const settings = fresh();
  settings.advisor = { provider: 'claude' };
  assert.deepEqual(Object.keys(fromYaml(toYaml(settings))), [
    'timezone', 'period', 'categories', 'majors', 'destinations', 'warnings', 'mf', 'advisor', 'secrets',
  ]);
});

test('destinations: 1 件以上の一覧で、各要素はオブジェクト', () => {
  assert.deepEqual(paths(withChange((s) => { delete s.destinations; })), ['destinations']);
  assert.deepEqual(paths(withChange((s) => { s.destinations = []; })), ['destinations']);
  assert.deepEqual(paths(withChange((s) => { s.destinations = { a: 1 }; })), ['destinations']);
  assert.deepEqual(paths(withChange((s) => { s.destinations[1] = 'x'; })), ['destinations.1']);
  assert.deepEqual(paths(withChange((s) => { s.destinations.length = 1; })), []);
});

test('destinations: id は ^[a-z0-9-]{1,32}$ で一意、name・webhookRef は必須の空でない文字列、mention は任意の文字列', () => {
  for (const id of ['Family', '家計', '', 'a_b', 'a'.repeat(33), 'a\n', 1]) {
    assert.deepEqual(paths(withChange((s) => { s.destinations[0].id = id; })), ['destinations.0.id'], String(id));
  }
  for (const id of ['a', 'dest-1', 'a'.repeat(32)]) assert.deepEqual(paths(withChange((s) => { s.destinations[0].id = id; })), [], id);
  assert.deepEqual(paths(withChange((s) => { delete s.destinations[0].id; })), ['destinations.0.id']);
  assert.deepEqual(paths(withChange((s) => { s.destinations[1].id = 'family'; })), ['destinations.1.id']);
  for (const key of ['name', 'webhookRef']) {
    for (const v of ['', undefined, null, 1]) {
      assert.deepEqual(paths(withChange((s) => { s.destinations[1][key] = v; })), [`destinations.1.${key}`], `${key}=${v}`);
    }
  }
  assert.deepEqual(paths(withChange((s) => { delete s.destinations[0].mentionOnWarning; })), []);
  assert.deepEqual(paths(withChange((s) => { s.destinations[0].mentionOnWarning = '<@1>'; })), []);
  assert.deepEqual(paths(withChange((s) => { s.destinations[1].categories = '食費'; })), ['destinations.1.categories']);
  assert.deepEqual(paths(withChange((s) => { delete s.destinations[1].categories; })), ['destinations.1.categories']);
  assert.deepEqual(paths(withChange((s) => { s.destinations[1].categories = []; s.destinations[1].budgets = {}; })), []);
});

test('destinations: カテゴリは通知先をまたいで重ならず、同じ通知先でも同一は不可（本体 _overlaps と同じ）', () => {
  const clash = (a, b) => paths(withChange((s) => {
    s.destinations[0].categories = a;
    s.destinations[0].budgets.monthlyByCategory = {};
    s.destinations[1].categories = b;
  }));
  assert.deepEqual(clash(['食費'], ['食費']), ['destinations.1.categories']);
  assert.deepEqual(clash(['食費'], ['食費/外食']), ['destinations.1.categories']);
  assert.deepEqual(clash(['食費/外食'], ['食費']), ['destinations.1.categories']);
  assert.deepEqual(clash(['食費/外食'], ['食費/外食']), ['destinations.1.categories']);
  assert.deepEqual(clash(['食費', '食費'], []), ['destinations.0.categories']);
  assert.deepEqual(clash(['食費', '食費/外食'], []), [], '同じ通知先の大項目と中項目は可');
  assert.deepEqual(clash(['食費/外食'], ['食費/カフェ', '食費外']), []);
  const [error] = validate(withChange((s) => { s.destinations[1].categories = ['日用品']; }));
  assert.match(error.message, /「日用品」は「家計」のカテゴリと重なっています/);
  assert.ok(lib.overlaps('食費', '食費/外食') && lib.overlaps('食費/外食', '食費') && !lib.overlaps('食費/外食', '食費/カフェ'));
});

test('destinations: monthlyByCategory のキーはその通知先のカテゴリだけ（他の通知先のカテゴリは不可）', () => {
  assert.deepEqual(paths(withChange((s) => { s.destinations[1].budgets.monthlyByCategory = { 食費: 1000 }; })),
    ['destinations.1.budgets.monthlyByCategory.食費']);
  assert.deepEqual(paths(withChange((s) => { s.destinations[1].budgets.monthlyByCategory = { 衣服・美容: 1000 }; })), []);
  assert.deepEqual(paths(withChange((s) => { s.destinations[1].budgets = 1; s.destinations[1].savings = []; })),
    ['destinations.1.budgets', 'destinations.1.savings']);
});

test('migrateSettings: 旧形式は id=default・name=家計 の 1 件へ移し、旧キーを除く', () => {
  const legacy = {
    timezone: 'Asia/Tokyo',
    period: { monthStartDay: 1, weekStartsOn: 'monday' },
    categories: { expense: ['食費', '日用品'], income: ['収入'] },
    budgets: { monthly: 100000, monthlyByCategory: { 食費: 30000 } },
    savings: { yearlyTarget: 10000 },
    warnings: structuredClone(DEFAULTS.warnings),
    discord: { mentionOnWarning: '<@1>' },
    secrets: { provider: 'env', refs: { webhookUrl: 'WEBHOOK', mfEmail: 'E', mfPassword: 'P', mfTotpSecret: 'T' } },
  };
  const { settings, migrated } = lib.migrateSettings(legacy);
  assert.equal(migrated, true);
  assert.deepEqual(settings.destinations, [{
    id: 'default', name: '家計', webhookRef: 'WEBHOOK', mentionOnWarning: '<@1>',
    categories: ['食費', '日用品'], budgets: { monthly: 100000, monthlyByCategory: { 食費: 30000 } }, savings: { yearlyTarget: 10000 },
  }]);
  assert.deepEqual(validate(settings), []);
  const text = toYaml(settings);
  for (const key of ['discord', 'webhookUrl', '\nbudgets:', '\nsavings:', 'expense']) assert.ok(!text.includes(key), key);
  assert.equal(legacy.budgets.monthly, 100000, '元のオブジェクトは変えない');

  // 任意項目が無い旧形式も、無いキーは作らない
  const bare = lib.migrateSettings({ categories: { expense: ['食費'], income: [] }, secrets: { refs: { webhookUrl: 'op://x' } } });
  assert.deepEqual(bare.settings.destinations, [{ id: 'default', name: '家計', webhookRef: 'op://x', categories: ['食費'] }]);

  // 新形式はそのまま（混ざった旧キーだけ除く）
  const current = lib.migrateSettings({ ...fresh(), budgets: { monthly: 1 }, discord: {} });
  assert.equal(current.migrated, false);
  assert.deepEqual(current.settings, fresh());
});

test('toYaml は majors の利用者キー順を保つ', () => {
  const settings = fresh();
  settings.majors = { 交通費: { label: '移動費' }, 食費: { label: '変動費' } };
  assert.deepEqual(Object.keys(fromYaml(toYaml(settings)).majors), ['交通費', '食費']);
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

test('missingMinors: 全部無い / 一部ある / 大項目全体の行があっても中項目は対象 / 候補が無い大項目は []', () => {
  const opts = categoryOptions({ categories: { 食費: ['食料品', '外食', 'カフェ'], 収入: [] } });
  assert.deepEqual(missingMinors(opts, '食費', []), opts.minors.食費);
  assert.deepEqual(missingMinors(opts, '食費', ['食費/外食', '日用品/外食']), opts.minors.食費.filter((m) => m !== '外食'));
  assert.deepEqual(missingMinors(opts, '食費', ['食費']), opts.minors.食費);
  assert.deepEqual(missingMinors(opts, '食費', opts.minors.食費.map((m) => `食費/${m}`)), []);
  assert.deepEqual(missingMinors(opts, '収入', []), []);
  assert.deepEqual(missingMinors(opts, '無い大項目', []), []);
  assert.deepEqual(missingMinors(opts, 'constructor', []), []);
  assert.deepEqual(minorsOf(opts, '__proto__'), []);
});

const statsFor = (months) => ({
  months: Object.fromEntries(months.map(([month, totals]) => [month, { totals }])),
});

test('monthlySeries: 大項目は中項目を束ね、中項目は完全一致で直近 6 か月を新しい順に返す', () => {
  const months = Array.from({ length: 7 }, (_, i) => [
    `2026-0${i + 3}`,
    { '食費': -1000, '食費/食料品': -(i + 1) * 1000, '食費/食料品特別': -500, '日用品': -100 },
  ]);
  const stats = statsFor(months);
  assert.deepEqual(lib.monthlySeries(stats, '食費'), [-8500, -7500, -6500, -5500, -4500, -3500]);
  assert.deepEqual(lib.monthlySeries(stats, '食費/食料品'), [-7000, -6000, -5000, -4000, -3000, -2000]);
  assert.deepEqual(lib.monthlySeries(stats, '日用品'), [-100, -100, -100, -100, -100, -100]);
});

test('monthlySeriesForRules: 包含関係にあるルールでも一致キーを一度だけ数える', () => {
  const stats = statsFor([
    ['2026-01', { '収入/給与': 100, '収入/副収入': 25 }],
  ]);

  assert.equal(typeof lib.monthlySeriesForRules, 'function');
  assert.deepEqual(lib.monthlySeriesForRules(stats, ['収入', '収入/給与']), [125]);
});

test('suggestBudgets: 奇数月の中央値と支出の切り上げ、週・年の提案', () => {
  const stats = statsFor([
    ['2026-01', { '食費': -1001, '日用品': -101, '収入/給与': 20000 }],
    ['2026-02', { '食費': -2001, '収入/給与': 30000 }],
    ['2026-03', { '食費': -3001, '日用品': -201, '収入/給与': 40000 }],
  ]);
  assert.deepEqual(lib.suggestBudgets(stats, {
    categories: ['食費', '日用品'],
  }), {
    months: 3,
    monthlyByCategory: { 食費: 3000, 日用品: 1000 },
    monthly: 3000,
    weekly: 1000,
    yearly: 36000,
  });
});

test('suggestBudgets: 偶数月は中央 2 つの平均を丸める', () => {
  const stats = statsFor([
    ['2026-01', { '食費': -1000, '収入': 10000 }],
    ['2026-02', { '食費': -2000, '収入': 12000 }],
  ]);
  const result = lib.suggestBudgets(stats, { categories: ['食費'] });
  assert.equal(result.monthly, 2000);
  assert.equal(result.monthlyByCategory.食費, 2000);
  assert.equal(Object.hasOwn(result, 'savingsYearlyTarget'), false);
});

test('suggestBudgets: 支出が無い月も 0 として数える', () => {
  const stats = statsFor([
    ['2026-01', { '食費': -9000 }],
    ['2026-02', {}],
    ['2026-03', {}],
  ]);
  const result = lib.suggestBudgets(stats, { categories: ['食費'] });
  assert.equal(result.months, 3);
  assert.deepEqual(result.monthlyByCategory, {});
  assert.equal(result.monthly, null);
  assert.equal(result.weekly, null);
  assert.equal(result.yearly, null);

  const noPositiveIncome = statsFor([
    ['2026-01', { '収入/給与': -1000 }],
    ['2026-02', {}],
    ['2026-03', { '食費': -5000 }],
  ]);
  assert.equal(Object.hasOwn(lib.suggestBudgets(noPositiveIncome, {
    categories: ['食費'],
  }), 'savingsYearlyTarget'), false);

  const refund = lib.suggestBudgets(statsFor([['2026-04', { '食費': 1000 }]]), {
    categories: ['食費'],
  });
  assert.equal(refund.monthly, null);
  assert.equal(refund.weekly, null);
  assert.equal(refund.yearly, null);
  assert.deepEqual(refund.monthlyByCategory, {});

});

test('suggestBudgets: income data is not required for expense budget proposals', () => {
  const stats = statsFor([
    ['2026-01', { '食費': -1001 }],
    ['2026-02', { '食費': -2001 }],
  ]);
  const result = lib.suggestBudgets(stats, {
    categories: ['食費'],
  });

  assert.equal(result.monthly, 2000);
  assert.equal(result.weekly, 1000);
  assert.equal(result.yearly, 24000);
  assert.equal(result.monthlyByCategory.食費, 2000);
  assert.equal(Object.hasOwn(result, 'savingsYearlyTarget'), false);
});

test('suggestBudgets: 使える月が無ければ全提案を空にする', () => {
  assert.deepEqual(lib.suggestBudgets({ months: {} }, {
    categories: ['食費'],
  }), {
    months: 0,
    monthlyByCategory: {},
    monthly: null,
    weekly: null,
    yearly: null,
  });
});

test('allocation: monthly budget is the total and category segments include other spending', () => {
  const result = lib.allocation({
    categories: ['Food', 'Daily'],
    budgets: { monthlyByCategory: { Food: 50, Daily: 75 }, monthly: 200 },
  });

  assert.deepEqual(result, {
    total: 200,
    segments: [
      { key: 'Food', label: 'Food', amount: 50, share: 0.25 },
      { key: 'Daily', label: 'Daily', amount: 75, share: 0.375 },
      { key: 'other', label: 'その他の支出', amount: 75, share: 0.375 },
    ],
    overflow: 0,
  });
});

test('allocation: category budgets above monthly total report overflow at the monthly boundary', () => {
  const result = lib.allocation({
    categories: ['Food', 'Daily'],
    budgets: { monthlyByCategory: { Food: 120, Daily: 90 }, monthly: 200 },
  });

  assert.equal(result.total, 200);
  assert.deepEqual(result.segments.map(({ label, amount, share }) => [label, amount, share]), [
    ['Food', 120, 0.6], ['Daily', 90, 0.45],
  ]);
  assert.equal(result.overflow, 10);
});

test('allocation: missing monthly budget has no other segment or overflow', () => {
  const result = lib.allocation({
    categories: ['Food'],
    budgets: { monthlyByCategory: { Food: 100 } },
  });

  assert.deepEqual(result, {
    total: 0,
    segments: [{ key: 'Food', label: 'Food', amount: 100, share: 0 }],
    overflow: 0,
  });
});

test('allocation: nonnumeric and inherited budgets count as zero', () => {
  const monthlyByCategory = Object.assign(Object.create({ Inherited: 90 }), { Own: '50' });
  const result = lib.allocation({
    categories: ['Inherited', 'Own'],
    budgets: { monthlyByCategory, monthly: '100' },
  });

  assert.deepEqual(result, {
    total: 0,
    segments: [
      { key: 'Inherited', label: 'Inherited', amount: 0, share: 0 },
      { key: 'Own', label: 'Own', amount: 0, share: 0 },
    ],
    overflow: 0,
  });
});

test('allocation: zero category values keep a zero share on the monthly scale', () => {
  const result = lib.allocation({
    categories: ['Food'],
    budgets: { monthlyByCategory: { Food: 0 }, monthly: 100 },
  });

  assert.deepEqual(result.segments.map(({ amount, share }) => [amount, share]), [[0, 0], [100, 1]]);
  assert.equal(result.overflow, 0);
});

test('toYaml/fromYaml: prototype-like category keys remain own budget keys', () => {
  const settings = fresh();
  const budgets = Object.fromEntries([['constructor', 5000], ['toString', 6000], ['__proto__', 7000]]);
  settings.destinations[0].categories = Object.keys(budgets);
  settings.destinations[0].budgets.monthlyByCategory = budgets;
  const restored = fromYaml(toYaml(settings)).destinations[0].budgets.monthlyByCategory;
  assert.deepEqual(restored, budgets);
  assert.deepEqual(Object.keys(restored), Object.keys(budgets));
});

test('reserves: optional entries require a matching unique category and positive optional monthly', () => {
  const settings = fresh();
  settings.destinations[0].reserves = [{ category: '食費' }, { category: '日用品', monthly: 20000 }];
  settings.destinations[1].reserves = [{ category: '衣服・美容', monthly: 1000 }];
  assert.deepEqual(paths(settings), []);
  assert.deepEqual(paths(withChange((s) => { s.destinations[0].reserves = null; })), []);

  for (const [reserves, expected] of [
    ['wrong', 'destinations.0.reserves'],
    [[null], 'destinations.0.reserves.0'],
    [[{ monthly: 1000 }], 'destinations.0.reserves.0.category'],
    [[{ category: 1, monthly: 1000 }], 'destinations.0.reserves.0.category'],
    [[{ category: '旅行' }], 'destinations.0.reserves.0.category'],
    [[{ category: '食費' }, { category: '食費' }], 'destinations.0.reserves.1.category'],
    [[{ category: '食費', monthly: 0 }], 'destinations.0.reserves.0.monthly'],
    [[{ category: '食費', monthly: 1.5 }], 'destinations.0.reserves.0.monthly'],
  ]) {
    assert.deepEqual(paths(withChange((s) => { s.destinations[0].reserves = reserves; })), [expected]);
  }
});

test('reserveMonthlyProposal: averages signed totals from the earliest data month through the latest (up to 12)', () => {
  const months = Array.from({ length: 13 }, (_, i) => {
    const month = new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 7);
    return [month, i === 0 ? { 旅行: -120000 } : { '旅行/帰省': -1001, 旅行: -500 }];
  });
  assert.equal(lib.reserveMonthlyProposal(statsFor(months), '旅行'), 2000);
  assert.equal(lib.reserveMonthlyProposal({ months: {} }, '旅行'), null);
  assert.equal(lib.reserveMonthlyProposal(statsFor([['2026-01', { 旅行: 1000 }]]), '旅行'), null);

  const recentMonths = Array.from({ length: 12 }, (_, i) => {
    const month = new Date(Date.UTC(2025, i + 8, 1)).toISOString().slice(0, 7);
    return [month, i < 9 ? {} : i === 9 ? { 食費: -1000 } : { 旅行: -30000 }];
  });
  assert.equal(lib.reserveMonthlyProposal(statsFor(recentMonths), '旅行'), 20000);

  const refunds = Array.from({ length: 12 }, (_, i) => {
    const month = new Date(Date.UTC(2025, i + 8, 1)).toISOString().slice(0, 7);
    const totals = { 食費: -1000 };
    if (i >= 4 && i <= 6) totals.旅行 = -10000;
    if (i === 7) totals.旅行 = 25000;
    return [month, totals];
  });
  assert.equal(lib.reserveMonthlyProposal(statsFor(refunds), '旅行'), 1000);
  assert.equal(lib.reserveMonthlyProposal(statsFor(recentMonths.map(([month]) => [month, {}])), '旅行'), null);
});

test('allocation: reserved categories are excluded from the regular monthly budget chart', () => {
  assert.deepEqual(lib.allocation({
    categories: ['Annual', 'Food'],
    reserves: [{ category: 'Annual', monthly: 5000 }],
    budgets: { monthly: 10000, monthlyByCategory: { Food: 2000 } },
  }), {
    total: 10000,
    segments: [
      { key: 'Food', label: 'Food', amount: 2000, share: 0.2 },
      { key: 'other', label: 'その他の支出', amount: 8000, share: 0.8 },
    ],
    overflow: 0,
  });
});

test('toYaml: destination reserves follow savings and empty reserves are omitted', () => {
  const settings = fresh();
  settings.destinations[0].reserves = [{ category: '食費', monthly: 20000 }];
  const restored = fromYaml(toYaml(settings)).destinations[0];
  assert.deepEqual(Object.keys(restored).slice(-2), ['savings', 'reserves']);
  assert.deepEqual(restored.reserves, [{ category: '食費', monthly: 20000 }]);

  settings.destinations[0].reserves = [];
  assert.equal(Object.hasOwn(fromYaml(toYaml(settings)).destinations[0], 'reserves'), false);
});

test('toYaml preserves user keys named reserves outside the destination reserves field', () => {
  const settings = fresh();
  settings.destinations[0].categories.push('reserves');
  settings.destinations[0].budgets.monthlyByCategory = { reserves: 5000 };
  settings.majors = { reserves: { label: 'R' } };
  assert.deepEqual(validate(settings), []);

  const restored = fromYaml(toYaml(settings));
  assert.equal(restored.destinations[0].budgets.monthlyByCategory.reserves, 5000);
  assert.deepEqual(restored.majors, { reserves: { label: 'R' } });
});
