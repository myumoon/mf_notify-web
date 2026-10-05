// 純粋関数: 既定値・検証・YAML 変換・カテゴリ整形。DOM に触らない。
// js-yaml の UMD はモジュールとして読むと globalThis.jsyaml を作る（ブラウザ・Node 共通）。
import './vendor/js-yaml.min.js';

const yaml = globalThis.jsyaml;

export const SECRET_NAMES = ['webhookUrl', 'mfEmail', 'mfPassword', 'mfTotpSecret'];

// 本体 settings.example.yml と同じ内容・キー順。
export const DEFAULTS = Object.freeze({
  timezone: 'Asia/Tokyo',
  period: { monthStartDay: 1, weekStartsOn: 'monday' },
  categories: { expense: ['食費', '日用品', '趣味・娯楽'], income: ['収入'] },
  budgets: {
    yearly: 3000000,
    monthly: 250000,
    weekly: 60000,
    monthlyByCategory: { 食費: 60000, 日用品: 15000 },
  },
  savings: { yearlyTarget: 2000000 },
  warnings: {
    overBudget: { enabled: true },
    pace: { enabled: true, marginPercent: 10 },
    stale: { enabled: true, maxAgeHours: 48, ignoreAccounts: [] },
  },
  mf: { bulkUpdate: { enabled: false, timeoutSeconds: 300 } },
  discord: { mentionOnWarning: '' },
  secrets: {
    provider: 'onepassword',
    refs: {
      webhookUrl: 'op://Private/mf-notify Discord/credential',
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

  const categories = section(settings, 'categories', 'categories');
  const expense = categories ? strList(categories, 'expense', 'categories.expense') : [];
  if (categories) strList(categories, 'income', 'categories.income');

  const budgets = section(settings, 'budgets', 'budgets', true);
  if (budgets) {
    for (const key of ['yearly', 'monthly', 'weekly']) positiveInt(budgets, key, `budgets.${key}`, true);
    const byCategory = section(budgets, 'monthlyByCategory', 'budgets.monthlyByCategory', true);
    for (const name of Object.keys(byCategory ?? {})) {
      const path = `budgets.monthlyByCategory.${name}`;
      if (!expense.includes(name)) fail(path, `「${name}」は支出カテゴリにありません`);
      else positiveInt(byCategory, name, path);
    }
  }

  const savings = section(settings, 'savings', 'savings');
  if (savings) positiveInt(savings, 'yearlyTarget', 'savings.yearlyTarget');

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

  const discord = section(settings, 'discord', 'discord');
  if (discord) str(discord, 'mentionOnWarning', 'discord.mentionOnWarning');

  const secrets = section(settings, 'secrets', 'secrets');
  if (secrets) {
    choice(secrets, 'provider', 'secrets.provider', ['onepassword', 'env']);
    const refs = section(secrets, 'refs', 'secrets.refs');
    if (refs) for (const name of SECRET_NAMES) str(refs, name, `secrets.refs.${name}`, true);
  }
  return errors;
}

// DEFAULTS のキー順に並べ替える。DEFAULTS に無いキーは元の順で後ろへ。
// monthlyByCategory は利用者のカテゴリ名がキーなので並べ替えない。
function ordered(value, template) {
  if (!isObject(value)) return value;
  const tpl = isObject(template) ? template : {};
  const keys = [...Object.keys(tpl).filter((k) => k in value), ...Object.keys(value).filter((k) => !(k in tpl))];
  return Object.fromEntries(keys.map((k) => [k, ordered(value[k], k === 'monthlyByCategory' ? {} : tpl[k])]));
}

export function toYaml(settings) {
  return yaml.dump(ordered(settings, DEFAULTS), { lineWidth: -1, noRefs: true });
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
