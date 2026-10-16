// 純粋関数: 既定値・検証・YAML 変換・カテゴリ整形。DOM に触らない。
// js-yaml の UMD はモジュールとして読むと globalThis.jsyaml を作る（ブラウザ・Node 共通）。
import './vendor/js-yaml.min.js';

const yaml = globalThis.jsyaml;

// 全通知先で共通の秘密情報。Webhook は通知先ごとの webhookRef。
export const SECRET_NAMES = ['mfEmail', 'mfPassword', 'mfTotpSecret'];
const DESTINATION_ID = /^[a-z0-9-]{1,32}$/;

export function formatYen(value) {
  return Number.isFinite(value) ? `${value.toLocaleString('ja-JP')} 円` : '—';
}

function recentMonths(stats) {
  const months = stats?.months;
  return months && typeof months === 'object' && !Array.isArray(months)
    ? Object.keys(months).sort().reverse().slice(0, 6)
    : [];
}

function totalForRules(stats, month, rules) {
  const totals = stats?.months?.[month]?.totals;
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return 0;
  return Object.entries(totals).reduce((sum, [key, value]) => {
    const matches = rules.some((rule) => key === rule || key.startsWith(`${rule}/`));
    return matches && Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

export function monthlySeriesForRules(stats, rules) {
  const validRules = Array.isArray(rules) ? rules.filter((rule) => typeof rule === 'string' && rule) : [];
  return recentMonths(stats).map((month) => totalForRules(stats, month, validRules));
}

export function monthlySeries(stats, rule) {
  const rules = typeof rule === 'string' && rule ? [rule] : [];
  return monthlySeriesForRules(stats, rules);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const ceilTo = (value, unit) => Math.ceil(value / unit) * unit;

// 予算提案は通知先 1 件ぶん（その通知先の categories）で計算する。
export function suggestBudgets(stats, destination) {
  const months = recentMonths(stats);
  const expenseRules = Array.isArray(destination?.categories)
    ? destination.categories.filter((rule) => typeof rule === 'string' && rule)
    : [];
  if (!months.length) return { months: 0, monthlyByCategory: {} };

  const monthlyByCategory = Object.fromEntries(expenseRules.flatMap((rule) => {
    const amount = median(monthlySeries(stats, rule).map((value) => Math.max(0, -value)));
    const proposal = ceilTo(amount, 1000);
    return proposal > 0 ? [[rule, proposal]] : [];
  }));
  return { months: months.length, monthlyByCategory };
}

export function reserveMonthlyProposal(stats, category) {
  const months = stats?.months && typeof stats.months === 'object' && !Array.isArray(stats.months)
    ? Object.keys(stats.months).sort().slice(-12)
    : [];
  const firstMonthWithData = months.findIndex((month) => {
    const totals = stats.months[month]?.totals;
    return totals && typeof totals === 'object' && !Array.isArray(totals) && Object.keys(totals).length > 0;
  });
  if (firstMonthWithData < 0) return null;
  const rules = typeof category === 'string' && category ? [category] : [];
  const monthsInRange = months.slice(firstMonthWithData);
  const total = monthsInRange.reduce((sum, month) => sum + totalForRules(stats, month, rules), 0);
  const average = Math.max(0, -total) / monthsInRange.length;
  const proposal = ceilTo(average, 1000);
  return proposal > 0 ? proposal : null;
}

const budgetAmount = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
const reservedCategories = (destination) => new Set((Array.isArray(destination?.reserves) ? destination.reserves : [])
  .map((reserve) => reserve?.category).filter((category) => typeof category === 'string'));
const ownCategoryBudgets = (destination) => {
  const budgets = destination?.budgets?.monthlyByCategory;
  return isObject(budgets) ? budgets : {};
};

// 期間予算の合計。本体（mf_notify）と同じ式: 月 M = 積立以外の monthlyByCategory の合計、年 = M×12、週 = floor(M×12/52)。
// 該当カテゴリが 0 件なら予算なし（null）。
export function budgetTotals(destination) {
  const byCategory = ownCategoryBudgets(destination);
  const reserved = reservedCategories(destination);
  const keys = Object.keys(byCategory).filter((key) => !reserved.has(key));
  if (!keys.length) return null;
  const monthly = keys.reduce((sum, key) => sum + budgetAmount(byCategory[key]), 0);
  return { monthly, yearly: monthly * 12, weekly: Math.floor(monthly * 12 / 52) };
}

// 通知先 1 件の月予算の内訳。合計は budgetTotals の月 M。
export function allocation(destination) {
  const total = budgetTotals(destination)?.monthly ?? 0;
  const expenseRules = Array.isArray(destination?.categories)
    ? destination.categories.filter((rule) => typeof rule === 'string')
    : [];
  const categoryBudgets = ownCategoryBudgets(destination);
  const reserved = reservedCategories(destination);
  const segments = expenseRules.filter((rule) => !reserved.has(rule)).map((rule) => {
    const amount = Object.hasOwn(categoryBudgets, rule) ? budgetAmount(categoryBudgets[rule]) : 0;
    return { key: rule, label: rule, amount, share: total > 0 ? amount / total : 0 };
  });
  return { total, segments };
}

// 本体 settings.example.yml と同じ内容・キー順。destinations の各要素のキー順は先頭要素に従う。
export const DEFAULTS = Object.freeze({
  timezone: 'Asia/Tokyo',
  period: { monthStartDay: 1, weekStartsOn: 'monday' },
  majors: { 食費: { label: '変動費' }, 趣味・娯楽: { notify: false } },
  destinations: [
    {
      id: 'family',
      name: '家計',
      webhookRef: 'op://Private/mf-notify Discord/credential',
      mentionOnWarning: '',
      notifyThresholdYen: 10000,
      categories: ['食費', '日用品', '趣味・娯楽'],
      budgets: {
        monthlyByCategory: { 食費: 60000, 日用品: 15000 },
      },
    },
    {
      id: 'personal',
      name: 'おこづかい',
      webhookRef: 'op://Private/mf-notify Discord personal/credential',
      categories: ['衣服・美容', '教養・教育'],
      budgets: {
        monthlyByCategory: { 衣服・美容: 20000, 教養・教育: 10000 },
      },
    },
  ],
  warnings: {
    overBudget: { enabled: true },
    pace: { enabled: true, marginPercent: 10 },
    stale: { enabled: true, maxAgeHours: 48, ignoreAccounts: [] },
  },
  mf: { bulkUpdate: { enabled: false, timeoutSeconds: 300 } },
  secrets: {
    provider: 'onepassword',
    refs: {
      mfEmail: 'op://Private/MoneyForward ME/username',
      mfPassword: 'op://Private/MoneyForward ME/password',
      mfTotpSecret: 'op://Private/MoneyForward ME/TOTP_xxxx',
    },
  },
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);

// mf_notify/config.py の parse_config と同じ規則。Python は最初の誤りで止まるが、画面用に全件集める。
export function validate(settings) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });

  // section: 必須なら欠落も誤り。誤りなら null を返し、その下は見ない。
  const section = (obj, key, path, optional = false) => {
    const v = obj?.[key];
    if (v == null) {
      if (optional) return {};
      fail(path, '必須です');
      return null;
    }
    if (!isObject(v)) {
      fail(path, '項目のまとまり（オブジェクト）にしてください');
      return null;
    }
    return v;
  };
  // value: 必須チェック。null なら以降の検査を飛ばす。
  const value = (obj, key, path, optional = false) => {
    const v = obj?.[key];
    if (v == null) {
      if (!optional) fail(path, '必須です');
      return null;
    }
    return v;
  };
  const int = (obj, key, path, optional = false) => {
    const v = value(obj, key, path, optional);
    if (v === null) return null;
    if (!isInt(v)) {
      fail(path, '整数で入力してください');
      return null;
    }
    return v;
  };
  const positiveInt = (obj, key, path, optional = false) => {
    const v = int(obj, key, path, optional);
    if (v !== null && v <= 0) fail(path, '正の整数で入力してください');
  };
  const bool = (obj, key, path) => {
    const v = value(obj, key, path);
    if (v !== null && typeof v !== 'boolean') fail(path, 'オン / オフ（true / false）で指定してください');
  };
  const str = (obj, key, path, nonEmpty = false) => {
    const v = value(obj, key, path);
    if (v === null) return;
    if (typeof v !== 'string') fail(path, '文字列で入力してください');
    else if (nonEmpty && v === '') fail(path, '必須です');
  };
  const choice = (obj, key, path, choices) => {
    const v = value(obj, key, path);
    if (v !== null && !choices.includes(v)) fail(path, `${choices.join(' / ')} のいずれかにしてください`);
  };
  const strList = (obj, key, path) => {
    const v = value(obj, key, path);
    if (v === null) return [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s !== '')) {
      fail(path, '空でない文字列の一覧にしてください');
      return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
    }
    return v;
  };

  if (!isObject(settings)) {
    fail('', '設定がオブジェクトではありません');
    return errors;
  }

  choice(settings, 'timezone', 'timezone', ['Asia/Tokyo']);

  const period = section(settings, 'period', 'period');
  if (period) {
    const day = int(period, 'monthStartDay', 'period.monthStartDay');
    if (day !== null && (day < 1 || day > 28)) fail('period.monthStartDay', '1〜28 の範囲で入力してください');
    choice(period, 'weekStartsOn', 'period.weekStartsOn', ['monday', 'sunday']);
  }

  // 支出カテゴリ・予算は通知先ごと（destinations）。廃止キー（categories・savings・budgets.yearly/monthly/weekly）は検証しない。
  if (Object.hasOwn(settings, 'majors')) {
    const majors = section(settings, 'majors', 'majors', true);
    for (const name of Object.keys(majors ?? {})) {
      const path = `majors.${name}`;
      const major = section(majors, name, path);
      if (major && Object.hasOwn(major, 'label') && major.label != null && typeof major.label !== 'string') {
        fail(`${path}.label`, '文字列で入力してください');
      }
      if (major && Object.hasOwn(major, 'notify') && major.notify != null && typeof major.notify !== 'boolean') {
        fail(`${path}.notify`, 'オン / オフ（true / false）で指定してください');
      }
    }
  }

  // 本体の _destinations と同じ規則。旧形式（destinations 無し）は画面が読込時に変換するので、ここでは必須。
  const destinations = value(settings, 'destinations', 'destinations');
  if (destinations !== null && !Array.isArray(destinations)) fail('destinations', '通知先の一覧にしてください');
  else if (destinations !== null && !destinations.length) fail('destinations', '通知先を 1 件以上登録してください');
  else if (destinations !== null) {
    const ids = [];
    const owners = []; // [ルール, 通知先の添字]
    destinations.forEach((dest, index) => {
      const at = `destinations.${index}`;
      if (!isObject(dest)) {
        fail(at, '項目のまとまり（オブジェクト）にしてください');
        return;
      }
      const id = value(dest, 'id', `${at}.id`);
      if (id !== null && typeof id !== 'string') fail(`${at}.id`, '文字列で入力してください');
      else if (id !== null && !DESTINATION_ID.test(id)) fail(`${at}.id`, '半角英小文字・数字・ハイフンの 32 文字以内にしてください');
      else if (id !== null && ids.includes(id)) fail(`${at}.id`, `「${id}」はほかの通知先と同じです`);
      else if (id !== null) ids.push(id);
      str(dest, 'name', `${at}.name`, true);
      str(dest, 'webhookRef', `${at}.webhookRef`, true);
      if (dest.mentionOnWarning != null && typeof dest.mentionOnWarning !== 'string') fail(`${at}.mentionOnWarning`, '文字列で入力してください');
      const notifyThresholdYen = int(dest, 'notifyThresholdYen', `${at}.notifyThresholdYen`, true);
      if (notifyThresholdYen !== null && notifyThresholdYen < 0) fail(`${at}.notifyThresholdYen`, '0 以上の整数で入力してください');
      const expense = strList(dest, 'categories', `${at}.categories`);
      for (const rule of expense) {
        // 1 つの明細を複数の通知先で数えないよう、通知先をまたぐ大項目・中項目の重なりも禁止する
        const clash = owners.find(([other, owner]) => rule === other || owner !== index && overlaps(rule, other));
        if (clash) {
          fail(`${at}.categories`, clash[1] === index ? `「${rule}」が重複しています`
            : `「${rule}」は「${destinationLabel(destinations[clash[1]], clash[1])}」のカテゴリと重なっています`);
        }
        owners.push([rule, index]);
      }
      const budgets = section(dest, 'budgets', `${at}.budgets`, true);
      if (budgets) {
        const byCategory = section(budgets, 'monthlyByCategory', `${at}.budgets.monthlyByCategory`, true);
        for (const name of Object.keys(byCategory ?? {})) {
          const path = `${at}.budgets.monthlyByCategory.${name}`;
          if (!expense.includes(name)) fail(path, `「${name}」はこの通知先の支出カテゴリにありません`);
          else positiveInt(byCategory, name, path);
        }
      }
      const reserves = value(dest, 'reserves', `${at}.reserves`, true);
      if (reserves !== null) {
        if (!Array.isArray(reserves)) fail(`${at}.reserves`, '配列にしてください');
        else {
          const seenReserves = new Set();
          reserves.forEach((reserve, reserveIndex) => {
            const reserveAt = `${at}.reserves.${reserveIndex}`;
            if (!isObject(reserve)) {
              fail(reserveAt, '項目のまとまり（オブジェクト）にしてください');
              return;
            }
            const category = reserve.category;
            const categoryPath = `${reserveAt}.category`;
            if (typeof category !== 'string') fail(categoryPath, '文字列で入力してください');
            else if (!expense.includes(category)) fail(categoryPath, `「${category}」はこの通知先の支出カテゴリにありません`);
            else if (seenReserves.has(category)) fail(categoryPath, `「${category}」が重複しています`);
            else seenReserves.add(category);
            positiveInt(reserve, 'monthly', `${reserveAt}.monthly`, true);
          });
        }
      }
    });
  }

  const warnings = section(settings, 'warnings', 'warnings');
  if (warnings) {
    const over = section(warnings, 'overBudget', 'warnings.overBudget');
    if (over) bool(over, 'enabled', 'warnings.overBudget.enabled');
    const pace = section(warnings, 'pace', 'warnings.pace');
    if (pace) {
      bool(pace, 'enabled', 'warnings.pace.enabled');
      const margin = value(pace, 'marginPercent', 'warnings.pace.marginPercent');
      if (margin !== null) {
        if (typeof margin !== 'number' || !Number.isFinite(margin)) fail('warnings.pace.marginPercent', '数値で入力してください');
        else if (margin < 0 || margin > 100) fail('warnings.pace.marginPercent', '0〜100 の範囲で入力してください');
      }
    }
    const stale = section(warnings, 'stale', 'warnings.stale');
    if (stale) {
      bool(stale, 'enabled', 'warnings.stale.enabled');
      const hours = int(stale, 'maxAgeHours', 'warnings.stale.maxAgeHours');
      if (hours !== null && hours < 24) fail('warnings.stale.maxAgeHours', '24 以上で入力してください');
      strList(stale, 'ignoreAccounts', 'warnings.stale.ignoreAccounts');
    }
  }

  // mf は parse_config では読まないが、画面で編集するので形だけ確かめる（無ければ何もしない）。
  const mf = section(settings, 'mf', 'mf', true);
  const bulk = mf && section(mf, 'bulkUpdate', 'mf.bulkUpdate', true);
  if (bulk && Object.keys(bulk).length) {
    bool(bulk, 'enabled', 'mf.bulkUpdate.enabled');
    positiveInt(bulk, 'timeoutSeconds', 'mf.bulkUpdate.timeoutSeconds');
  }

  if (Object.hasOwn(settings, 'advisor') && settings.advisor != null) {
    const advisor = section(settings, 'advisor', 'advisor');
    if (advisor) {
      choice(advisor, 'provider', 'advisor.provider', ['claude', 'codex']);
      if (Object.hasOwn(advisor, 'model') && advisor.model != null
        && (typeof advisor.model !== 'string' || !/^[A-Za-z0-9._:/\[\]-]{0,64}$/.test(advisor.model))) {
        fail('advisor.model', '使用できる文字で 64 文字以内にしてください');
      }
      if (Object.hasOwn(advisor, 'timeoutSeconds')) {
        const seconds = int(advisor, 'timeoutSeconds', 'advisor.timeoutSeconds', true);
        if (seconds !== null && (seconds < 30 || seconds > 600)) {
          fail('advisor.timeoutSeconds', '30〜600 の整数で入力してください');
        }
      }
    }
  }

  const secrets = section(settings, 'secrets', 'secrets');
  if (secrets) {
    choice(secrets, 'provider', 'secrets.provider', ['onepassword', 'env']);
    const refs = section(secrets, 'refs', 'secrets.refs');
    if (refs) for (const name of SECRET_NAMES) str(refs, name, `secrets.refs.${name}`, true);
  }
  return errors;
}

// 同じ明細に当たりうるルールか（同一、または一方が他方の大項目）。本体の _overlaps と同じ。
export function overlaps(a, b) {
  return a === b || a === splitCategory(b).major || splitCategory(a).major === b;
}

// タブ・メッセージ用の通知先の呼び名。
export function destinationLabel(destination, index) {
  if (typeof destination?.name === 'string' && destination.name) return destination.name;
  if (typeof destination?.id === 'string' && destination.id) return destination.id;
  return `通知先${index + 1}`;
}

const LEGACY_KEYS = ['budgets', 'savings', 'discord', 'categories'];
const REMOVED_BUDGET_KEYS = ['yearly', 'monthly', 'weekly'];

// 旧形式（destinations 無し）は本体と同じく id=default・name=家計 の通知先 1 件へ移す。
// 保存する YAML に旧キー・廃止キー（トップレベルの budgets / savings / discord / categories・secrets.refs.webhookUrl、
// 各通知先の savings・budgets.yearly/monthly/weekly）を残さない。旧形式から移した値も同じ規則で除く。
export function migrateSettings(source) {
  const settings = structuredClone(source);
  const migrated = settings.destinations == null;
  if (migrated) {
    const destination = {
      id: 'default',
      name: '家計',
      webhookRef: settings.secrets?.refs?.webhookUrl,
      mentionOnWarning: settings.discord?.mentionOnWarning,
      categories: settings.categories?.expense,
      budgets: settings.budgets,
    };
    settings.destinations = [Object.fromEntries(Object.entries(destination).filter(([, v]) => v !== undefined))];
  }
  for (const key of LEGACY_KEYS) delete settings[key];
  if (isObject(settings.secrets?.refs)) delete settings.secrets.refs.webhookUrl;
  for (const dest of Array.isArray(settings.destinations) ? settings.destinations : []) {
    if (!isObject(dest)) continue;
    delete dest.savings;
    if (!isObject(dest.budgets)) continue;
    for (const key of REMOVED_BUDGET_KEYS) delete dest.budgets[key];
    if (!Object.keys(dest.budgets).length) delete dest.budgets;
  }
  return { settings, migrated };
}

// DEFAULTS のキー順に並べ替える。DEFAULTS に無いキーは元の順で後ろへ。配列の要素はテンプレートの先頭要素の順。
// monthlyByCategory と majors は利用者の名前がキーなので配下を並べ替えない。
function ordered(value, template, destination = false) {
  if (Array.isArray(value)) return value.map((item) => ordered(item, Array.isArray(template) ? template[0] : undefined, destination));
  if (!isObject(value)) return value;
  const tpl = isObject(template) ? template : {};
  const keep = (key) => !(destination && key === 'reserves'
    && (value.reserves == null || Array.isArray(value.reserves) && value.reserves.length === 0));
  const keys = [
    ...Object.keys(tpl).filter((k) => Object.hasOwn(value, k) && keep(k)),
    ...Object.keys(value).filter((k) => !Object.hasOwn(tpl, k) && keep(k)),
  ];
  return Object.fromEntries(keys.map((k) => [k, ordered(value[k], k === 'monthlyByCategory' || k === 'majors' ? {} : Object.hasOwn(tpl, k) ? tpl[k] : undefined, k === 'destinations')]));
}

export function toYaml(settings) {
  const { secrets, ...beforeSecrets } = DEFAULTS;
  const destination = { ...beforeSecrets.destinations[0], reserves: [{ category: '', monthly: 1 }] };
  return yaml.dump(ordered(settings, { ...beforeSecrets, destinations: [destination], advisor: {}, secrets }), { lineWidth: -1, noRefs: true });
}

export function fromYaml(text) {
  return yaml.load(text, { schema: yaml.JSON_SCHEMA }) ?? {};
}

const uniqueSorted = (values) =>
  [...new Set((Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && v !== ''))].sort();

export function categoryOptions(categoriesJson) {
  const source = isObject(categoriesJson?.categories) ? categoriesJson.categories : {};
  const majors = uniqueSorted(Object.keys(source));
  return { majors, minors: Object.fromEntries(majors.map((m) => [m, uniqueSorted(source[m])])) };
}

// 大項目の中項目候補。自由入力の大項目（「constructor」など）で Object の継承プロパティを拾わない。
export function minorsOf(options, major) {
  return Object.hasOwn(options.minors, major) ? options.minors[major] : [];
}

// 一括追加の対象: その大項目の中項目のうち `大項目/中項目` の行がまだ無いもの（候補順）。
export function missingMinors(options, major, existingValues) {
  const have = new Set(existingValues);
  return minorsOf(options, major).filter((minor) => !have.has(joinCategory(major, minor)));
}

export function splitCategory(value) {
  const i = value.indexOf('/');
  return i < 0 ? { major: value, minor: '' } : { major: value.slice(0, i), minor: value.slice(i + 1) };
}

export function joinCategory(major, minor) {
  return minor ? `${major}/${minor}` : major;
}

export function moveItem(items, from, to) {
  const moved = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
    || from >= moved.length || to >= moved.length) return moved;
  moved.splice(to, 0, moved.splice(from, 1)[0]);
  return moved;
}
