// 画面の組み立て・イベント・状態。表示文字列は textContent / Option で入れる（innerHTML を使わない）。
// トークン・code・設定の中身を console や URL に出さない。
import { CLIENT_ID, TOKEN_ENDPOINT, APP_SLUG } from './config.js';
import { DEFAULTS, validate, toYaml, fromYaml, formatYen, categoryOptions, minorsOf, missingMinors, splitCategory, joinCategory, suggestBudgets, monthlySeriesForRules, allocation } from './lib.js';
import { getFile, putFile, listInstallationRepos, exchangeCode, GitHubError, ConflictError } from './github.js';

const KEYS = { token: 'mfnotify.token', repo: 'mfnotify.repo', authMode: 'mfnotify.authMode' };
const STATE_KEY = 'mfnotify.oauthState';
const ALLOCATION_INCOME_KEY = 'mfnotify.allocationIncome';
const ALLOCATION_COLORS = ['#3b82c4', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#e84393', '#16a085'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const SETTINGS_PATH = 'settings.yml';
const CATEGORIES_PATH = 'categories.json';
const STATS_PATH = 'stats.json';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const LIST_PATHS = { expense: 'categories.expense', income: 'categories.income', accounts: 'warnings.stale.ignoreAccounts' };

const $ = (id) => document.getElementById(id);
const form = $('settings-form');
const slots = new Map([...form.querySelectorAll('[data-error-for]')].map((s) => [s.dataset.errorFor, s]));

let settings = null; // 読み込んだ設定（画面に無いキーもそのまま保持して保存する）
let sha = null;
let loadedRepo = ''; // settings と sha がどの repo のものか
let loadSeq = 0; // 読込の世代。古い読込・保存の結果を捨てるため
let options = categoryOptions(null);
let stats = null;
let allocationIncome = null;
let errors = [];
let busy = false;
let dirty = false;

const stored = (key) => localStorage.getItem(KEYS[key]) ?? '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) {
    if (!isObject(o[k])) o[k] = {};
    o = o[k];
  }
  if (value === undefined) delete o[last];
  else o[last] = value;
}

function describe(err) {
  if (err instanceof ConflictError) return '他で更新されています。再読込してください';
  if (err instanceof GitHubError) {
    if (err.status === 401) return 'トークンが無効です。切断して接続し直してください';
    if (err.status === 403 || err.status === 404) return `リポジトリにアクセスできません（${err.status}）。トークンの権限と owner/repo を確認してください`;
    return `GitHub との通信に失敗しました（${err.status}）`;
  }
  if (err?.name === 'TimeoutError') return 'タイムアウトしました。もう一度お試しください';
  return '通信に失敗しました。もう一度お試しください';
}

const connectMessage = (text) => { $('connect-message').textContent = text; };

let toastTimer;
function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  clearTimeout(toastTimer);
  if (!isError) toastTimer = setTimeout(() => { t.textContent = ''; }, 4000);
}

// ---- 接続

function renderConnection() {
  const connected = Boolean(stored('token'));
  const app = stored('authMode') === 'app';
  $('login').hidden = !CLIENT_ID || connected;
  $('install-link').hidden = !CLIENT_ID || !APP_SLUG || (connected && !app);
  $('install-link').href = `https://github.com/apps/${encodeURIComponent(APP_SLUG)}/installations/new`;
  $('pat-form').hidden = connected;
  $('repo-select-field').hidden = !(connected && app);
  $('disconnect').hidden = !connected;
  $('connect-status').textContent = !connected ? '（未接続）' : stored('repo') ? `（${stored('repo')}）` : '（リポジトリ未選択）';
}

function startLogin() {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  const query = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: location.origin + location.pathname, state });
  location.assign(`https://github.com/login/oauth/authorize?${query}`);
}

// GitHub から ?code=&state= で戻ってきたとき。code/state はすぐ URL から消す。
async function finishLogin(params) {
  const code = params.get('code');
  const state = params.get('state');
  history.replaceState(null, '', location.pathname + location.hash);
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  // 「アプリをインストール」からの戻りは state が無い。失敗扱いせず、code も交換しない（CSRF 対策）。
  if (!state && (params.has('setup_action') || params.has('installation_id'))) {
    if (!stored('token')) connectMessage('アプリをインストールしました。「GitHub でログイン」から接続してください');
    return;
  }
  if (!CLIENT_ID || !code || !expected || state !== expected) {
    connectMessage('ログインに失敗しました。もう一度お試しください');
    return;
  }
  try {
    const { token } = await exchangeCode(TOKEN_ENDPOINT, code);
    localStorage.setItem(KEYS.token, token);
    localStorage.setItem(KEYS.authMode, 'app');
    localStorage.removeItem(KEYS.repo);
  } catch {
    connectMessage('ログインに失敗しました。もう一度お試しください');
  }
}

async function loadRepoChoices() {
  try {
    const repos = await listInstallationRepos(stored('token'));
    $('repo-select').replaceChildren(new Option('選択してください', ''), ...repos.map((r) => new Option(r.fullName, r.fullName)));
    $('repo-select').value = repos.some((r) => r.fullName === stored('repo')) ? stored('repo') : '';
    if (!repos.length) connectMessage('アプリを入れたリポジトリがありません。「アプリをインストール」から追加してください');
  } catch (err) {
    connectMessage(describe(err));
  }
}

function connectWithPat(event) {
  event.preventDefault();
  const token = $('pat').value.trim();
  const repo = $('pat-repo').value.trim();
  if (!token || !REPO_PATTERN.test(repo)) {
    connectMessage('トークンと owner/repo 形式のリポジトリを入力してください');
    return;
  }
  localStorage.setItem(KEYS.token, token);
  localStorage.setItem(KEYS.repo, repo);
  localStorage.setItem(KEYS.authMode, 'pat');
  $('pat').value = '';
  renderConnection();
  load();
}

function disconnect() {
  if (dirty && !confirm('保存していない変更は失われます。切断しますか？')) return;
  for (const key of Object.values(KEYS)) localStorage.removeItem(key);
  clearSettings();
  $('repo-select').replaceChildren();
  $('connect').open = true;
  connectMessage('');
  renderConnection();
}

// ---- 読込・保存

function setBusy(value) {
  busy = value;
  for (const id of ['reload', 'preview']) $(id).disabled = busy;
  $('save').disabled = busy || !settings || errors.length > 0;
}

// 表示中の設定を捨てる。進行中の読込の結果も捨てる（loadSeq を進める）。
function clearSettings(resetAllocationIncome = true) {
  loadSeq++;
  settings = null;
  stats = null;
  if (resetAllocationIncome) {
    allocationIncome = null;
    sessionStorage.removeItem(ALLOCATION_INCOME_KEY);
  }
  sha = null;
  loadedRepo = '';
  dirty = false;
  form.hidden = true;
  $('savebar').hidden = true;
}

async function load() {
  const token = stored('token');
  const repo = stored('repo');
  if (!token || !repo) return;
  // 別の repo の内容と sha で保存できないよう、切り替えたら先に消す
  if (repo !== loadedRepo) clearSettings(loadedRepo !== '');
  const seq = ++loadSeq;
  setBusy(true);
  connectMessage('');
  try {
    const file = await getFile(token, repo, SETTINGS_PATH);
    if (seq !== loadSeq) return;
    let loaded = structuredClone(DEFAULTS);
    if (file) {
      try {
        loaded = fromYaml(file.text);
      } catch {
        loaded = null;
      }
      if (!isObject(loaded)) {
        connectMessage('settings.yml を読めません（YAML の形式が不正です）。GitHub 上で直してください');
        return;
      }
    }
    const [loadedOptions, loadedStats] = await Promise.all([
      loadCategories(token, repo),
      loadStats(token, repo),
    ]);
    if (seq !== loadSeq) return; // 後から始まった読込・切断を優先する
    settings = loaded;
    stats = loadedStats;
    sha = file?.sha ?? null;
    loadedRepo = repo;
    options = loadedOptions;
    dirty = false;
    renderForm();
    $('connect').open = false;
    // 接続欄は閉じるので、案内は保存バーに出す
    if (!file) toast('settings.yml がまだ無いので既定値を表示しています。保存すると作成します');
  } catch (err) {
    if (seq === loadSeq) connectMessage(describe(err));
  } finally {
    if (seq === loadSeq) setBusy(false);
  }
}

// categories.json は選択肢用。読めなくても編集はできるので空で続ける。
async function loadCategories(token, repo) {
  try {
    const file = await getFile(token, repo, CATEGORIES_PATH);
    return categoryOptions(file ? JSON.parse(file.text) : null);
  } catch {
    return categoryOptions(null);
  }
}

// stats.json は提案専用。無い・壊れているときも設定編集は続ける。
async function loadStats(token, repo) {
  try {
    const file = await getFile(token, repo, STATS_PATH);
    if (!file) return null;
    const stats = JSON.parse(file.text);
    const validMonths = isObject(stats?.months) && Object.entries(stats.months).every(([month, period]) =>
      /^\d{4}-\d{2}$/.test(month) && isObject(period)
      && /^\d{4}-\d{2}-\d{2}$/.test(period.from) && /^\d{4}-\d{2}-\d{2}$/.test(period.to)
      && isObject(period.totals) && Object.values(period.totals).every(Number.isInteger));
    return isObject(stats) && typeof stats.updatedAt === 'string'
      && Number.isInteger(stats.monthStartDay) && stats.monthStartDay >= 1 && stats.monthStartDay <= 31
      && validMonths ? stats : null;
  } catch {
    return null;
  }
}

async function save() {
  refresh();
  if (busy || !settings || errors.length) return;
  setBusy(true);
  try {
    const seq = loadSeq;
    // 保存先は読み込んだ repo（sha と内容はその repo のもの）
    const saved = await putFile(stored('token'), loadedRepo, SETTINGS_PATH, toYaml(settings), sha, 'Update settings');
    // 保存中に切り替え・再読込されたら、新しく読んだ側の sha を上書きしない
    if (seq === loadSeq) {
      sha = saved.sha;
      dirty = false;
    }
    toast('保存しました');
  } catch (err) {
    toast(describe(err), true);
  } finally {
    setBusy(false);
  }
}

function reload() {
  if (dirty && !confirm('保存していない変更は失われます。再読込しますか？')) return;
  toast('');
  load();
}

function showYaml() {
  $('yaml-text').textContent = toYaml(settings);
  $('yaml-preview').hidden = false;
  $('yaml-preview').open = true;
  $('yaml-preview').scrollIntoView({ block: 'nearest' });
}

// ---- フォーム

// type=number は数値として読めない入力（「3,000,000」など）でも value が '' になる。
// 未入力と区別して NaN にし、validate で弾く（任意項目が黙って消えないように）。
function readNumber(input, empty) {
  if (input.validity?.badInput) return NaN;
  return input.value === '' ? empty : Number(input.value);
}

function updateYen(input) {
  if (!Object.hasOwn(input.dataset, 'yen')) return;
  const output = input.nextElementSibling;
  if (!output) return;
  output.textContent = input.validity?.badInput ? '数値ではありません'
    : formatYen(input.value === '' ? undefined : Number(input.value));
}

function medianIncome(stats, rules) {
  if (!stats || !Array.isArray(rules)) return 0;
  const values = monthlySeriesForRules(stats, rules).sort((a, b) => a - b);
  if (!values.length) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function renderAllocation(preserveIncomeInput = false) {
  if (!settings) return;
  const incomeInput = $('allocation-income');
  const chart = $('allocation-chart');
  const legend = $('allocation-legend');
  const empty = $('allocation-empty');
  if (!incomeInput || !chart || !legend || !empty) return;

  if (allocationIncome === null) {
    const storedIncome = sessionStorage.getItem(ALLOCATION_INCOME_KEY);
    const value = storedIncome === null ? NaN : Number(storedIncome);
    allocationIncome = Number.isFinite(value) && value >= 0
      ? value
      : medianIncome(stats, settings.categories?.income);
  }
  if (!preserveIncomeInput) incomeInput.value = String(allocationIncome);
  updateYen(incomeInput);
  const result = allocation(settings, allocationIncome);
  chart.replaceChildren();
  legend.replaceChildren();
  if (allocationIncome <= 0) {
    chart.hidden = true;
    chart.setAttribute('display', 'none');
    empty.textContent = '月収を入力すると表示されます';
    return;
  }

  chart.hidden = false;
  chart.setAttribute('display', 'inline');
  chart.setAttribute('viewBox', '0 0 1000 28');
  chart.setAttribute('width', '100%');
  chart.setAttribute('height', '28');
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', '収入と予算の割り振り');
  empty.textContent = '';

  const svg = (tag, attributes = {}) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  };
  if (result.overflow > 0) {
    const pattern = svg('pattern', { id: 'allocation-overflow', patternUnits: 'userSpaceOnUse', width: 8, height: 8, patternTransform: 'rotate(45)' });
    pattern.append(svg('rect', { width: 8, height: 8, fill: '#e74c3c' }), svg('path', { d: 'M0 0 V8', stroke: '#fff', 'stroke-width': 3 }));
    const defs = svg('defs');
    defs.append(pattern);
    chart.append(defs);
  }

  const expenseCount = Array.isArray(settings.categories?.expense)
    ? settings.categories.expense.filter((rule) => typeof rule === 'string').length
    : 0;
  const scale = Math.max(result.income, result.segments.reduce((sum, segment) => sum + segment.amount, 0));
  let x = 0;
  result.segments.forEach((segment, index) => {
    const color = index < expenseCount ? ALLOCATION_COLORS[index % ALLOCATION_COLORS.length]
      : segment.key === 'other' ? '#9ca3af'
        : segment.key === 'savings' ? '#2ecc71' : '#e5e7eb';
    const width = Math.min(1000 - x, segment.amount / scale * 1000);
    chart.append(svg('rect', { x, y: 0, width, height: 28, fill: color }));
    x += width;

    const swatch = el('span', { className: 'allocation-swatch' });
    swatch.setAttribute('aria-hidden', 'true');
    swatch.setAttribute('style', `display:inline-block;width:0.8rem;height:0.8rem;background-color:${color}`);
    legend.append(el('li', {}, swatch,
      el('span', { textContent: segment.label }),
      el('span', { textContent: formatYen(segment.amount) }),
      el('span', { textContent: `${Math.round(segment.share * 100)}%` }),
    ));
  });
  if (result.overflow > 0) {
    const incomeX = result.income / scale * 1000;
    chart.append(svg('rect', { x: incomeX, y: 0, width: 1000 - incomeX, height: 28, fill: 'url(#allocation-overflow)' }));
    chart.append(svg('line', { x1: incomeX, y1: 0, x2: incomeX, y2: 28, stroke: '#111827', 'stroke-width': 2 }));
  }
}

function updateAllocationIncome(input) {
  updateYen(input);
  if (input.validity?.badInput) return;
  if (input.value === '') {
    allocationIncome = null;
    sessionStorage.removeItem(ALLOCATION_INCOME_KEY);
    renderAllocation();
    return;
  }
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) return;
  allocationIncome = value;
  sessionStorage.setItem(ALLOCATION_INCOME_KEY, String(value));
  renderAllocation(true);
}

function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number') return readNumber(input, 'optional' in input.dataset ? undefined : null);
  return input.value;
}

function renderForm() {
  for (const input of form.querySelectorAll('[data-path]')) {
    const v = getPath(settings, input.dataset.path);
    if (input.type === 'checkbox') input.checked = v === true;
    else input.value = v ?? '';
    updateYen(input);
  }
  $('major-options').replaceChildren(...options.majors.map((m) => new Option(m)));
  $('bulk-major').replaceChildren(...options.majors.map((m) => new Option(m)));
  $('bulk-add').hidden = !options.majors.length;
  for (const kind of Object.keys(LIST_PATHS)) renderRows(kind);
  $('yaml-preview').hidden = true;
  form.hidden = false;
  $('savebar').hidden = false;
  refresh();
  updateSuggestions();
}

function setSuggestion(input, value) {
  const output = input?.nextElementSibling;
  if (!output) return;
  if (output.nextElementSibling?.className === 'suggest') output.nextElementSibling.remove();
  if (value == null) return;
  const button = el('button', {
    type: 'button',
    className: 'suggest',
    textContent: `提案 ${value.toLocaleString('ja-JP')}`,
  });
  button.addEventListener('click', () => {
    input.value = String(value);
    commitInput(input);
  });
  output.insertAdjacentElement('afterend', button);
}

function updateSuggestions() {
  const controls = $('budget-suggestions');
  controls.replaceChildren();
  const proposals = stats ? suggestBudgets(stats, settings) : null;
  const byPath = {
    'budgets.yearly': proposals?.yearly,
    'budgets.monthly': proposals?.monthly,
    'budgets.weekly': proposals?.weekly,
    'savings.yearlyTarget': proposals?.savingsYearlyTarget,
  };
  for (const input of form.querySelectorAll('[data-path]')) {
    if (Object.hasOwn(byPath, input.dataset.path)) setSuggestion(input, byPath[input.dataset.path]);
  }
  for (const row of listOf('expense').children) {
    const input = row.querySelector('.budget');
    const rule = readCategory(row);
    const categories = proposals?.monthlyByCategory;
    setSuggestion(input, categories && Object.hasOwn(categories, rule) ? categories[rule] : null);
  }
  if (!proposals || proposals.months === 0) {
    controls.append(el('span', { textContent: 'PC で 1 回実行すると提案が出ます' }));
    return;
  }
  const applyAll = el('button', { type: 'button', className: 'apply-suggestions', textContent: 'すべて提案値にする' });
  applyAll.addEventListener('click', () => applyAllSuggestions(proposals));
  controls.append(applyAll, el('span', { className: 'suggestion-note', textContent: `直近 ${proposals.months} か月の中央値` }));
}

function applyAllSuggestions(proposals) {
  const byPath = {
    'budgets.yearly': proposals.yearly,
    'budgets.monthly': proposals.monthly,
    'budgets.weekly': proposals.weekly,
    'savings.yearlyTarget': proposals.savingsYearlyTarget,
  };
  for (const input of form.querySelectorAll('[data-path]')) {
    if (!Object.hasOwn(byPath, input.dataset.path)) continue;
    const value = byPath[input.dataset.path];
    if (value != null) {
      input.value = String(value);
      commitInput(input);
    }
  }
  for (const row of listOf('expense').children) {
    const input = row.querySelector('.budget');
    const rule = readCategory(row);
    if (!Object.hasOwn(proposals.monthlyByCategory, rule)) continue;
    const value = proposals.monthlyByCategory[rule];
    if (input && value != null) {
      input.value = String(value);
      commitInput(input);
    }
  }
}

const listOf = (kind) => form.querySelector(`[data-list="${kind}"]`);

function renderRows(kind) {
  const values = getPath(settings, LIST_PATHS[kind]);
  const budgets = getPath(settings, 'budgets.monthlyByCategory');
  listOf(kind).replaceChildren(
    ...(Array.isArray(values) ? values : []).map((v) => makeRow(kind, String(v), isObject(budgets) && Object.hasOwn(budgets, v) ? budgets[v] : undefined)),
  );
}

// 中項目 select の特別な値。カテゴリ名に NUL は入らないので候補と衝突しない。
const WHOLE = '\0whole'; // （大項目全体）
const FREE = '\0free'; // その他（自由入力）
const FREE_LABEL = 'その他（自由入力）';

// 行 = 大項目 + 中項目（+ 月予算）、口座は名前だけ。
// categories.json の候補があれば select、無ければ text（major-options の datalist 付き）。
// 候補に無い値は「その他（自由入力）」の text に出して保持する。
function makeRow(kind, value, budget) {
  const remove = el('button', { type: 'button', className: 'remove', textContent: '削除', ariaLabel: 'この行を削除' });
  remove.addEventListener('click', () => {
    remove.parentElement.remove();
    syncRows(kind);
  });
  if (kind === 'accounts') {
    return el('div', { className: 'row' }, el('input', { type: 'text', className: 'value', value, ariaLabel: '口座名' }), remove);
  }
  const { major, minor } = splitCategory(value);
  const majorInput = el('input', { type: 'text', className: 'major', value: major, placeholder: '大項目', ariaLabel: '大項目' });
  const minorInput = el('input', { type: 'text', className: 'minor', value: minor, placeholder: '（大項目全体）', ariaLabel: '中項目' });
  const parts = [majorInput, minorInput];
  if (options.majors.length) {
    minorInput.placeholder = '中項目';
    const majorSelect = el('select', { className: 'major-select', ariaLabel: '大項目' },
      new Option('大項目を選択', ''), ...options.majors.map((m) => new Option(m)), new Option(FREE_LABEL, FREE));
    majorSelect.value = !major || options.majors.includes(major) ? major : FREE;
    const minorSelect = el('select', { className: 'minor-select', ariaLabel: '中項目' });
    // 大項目を変えたら中項目の候補を作り直す。新しい候補に無い中項目は未選択へ戻す。
    const fillMinors = (selected) => {
      const minors = minorsOf(options, majorSelect.value);
      minorSelect.replaceChildren(new Option('中項目を選択', ''), ...minors.map((m) => new Option(m)),
        new Option('（大項目全体）', WHOLE), new Option(FREE_LABEL, FREE));
      minorSelect.value = [WHOLE, FREE, ...minors].includes(selected) ? selected : '';
    };
    const show = () => {
      majorInput.hidden = majorSelect.value !== FREE;
      minorInput.hidden = minorSelect.value !== FREE;
    };
    // 新しい行は未選択、大項目だけの既存値は「（大項目全体）」
    fillMinors(!value ? '' : !minor ? WHOLE : minorsOf(options, majorSelect.value).includes(minor) ? minor : FREE);
    show();
    majorSelect.addEventListener('input', () => {
      fillMinors(minorSelect.value);
      show();
    });
    minorSelect.addEventListener('input', show);
    parts.splice(0, 2, el('div', { className: 'pick' }, majorSelect, majorInput), el('div', { className: 'pick' }, minorSelect, minorInput));
  } else {
    majorInput.setAttribute('list', 'major-options');
  }
  if (kind === 'expense') {
    const budgetInput = el('input', {
      type: 'number', className: 'budget', value: budget ?? '', min: 1, step: 1, inputMode: 'numeric', placeholder: '月予算（任意）', ariaLabel: '月予算',
    });
    budgetInput.dataset.yen = '';
    parts.push(
      budgetInput,
      el('output', { className: 'yen' }),
    );
  }
  const row = el('div', { className: 'row' }, ...parts, remove, el('span', { className: 'row-error' }));
  if (kind === 'expense') updateYen(row.querySelector('.budget'));
  return row;
}

// 行のカテゴリ値。select があればそれを、自由入力・候補なしなら text を読む。
// 大項目が空なら ''、select で中項目を選んでいない（自由入力が空も含む）なら null。
function readCategory(row) {
  const pick = (name) => {
    const select = row.querySelector(`.${name}-select`);
    return select && select.value !== FREE ? select.value : row.querySelector(`.${name}`).value.trim();
  };
  const major = pick('major');
  const minor = pick('minor');
  if (!major) return '';
  if (minor === '' && row.querySelector('.minor-select')) return null;
  return joinCategory(major, minor === WHOLE ? '' : minor);
}

function syncRows(kind) {
  const rows = [...listOf(kind).children];
  if (kind === 'accounts') {
    setPath(settings, LIST_PATHS.accounts, rows.map((r) => r.querySelector('.value').value.trim()));
  } else {
    // 中項目未選択の行は大項目単独にせず空にする（refresh が行の下にエラーを出して保存を止める）
    const values = rows.map((r) => readCategory(r) ?? '');
    setPath(settings, LIST_PATHS[kind], values);
    if (kind === 'expense') {
      const byCategory = Object.fromEntries(rows.flatMap((r, i) => {
        const b = readNumber(r.querySelector('.budget'), undefined);
        return b === undefined ? [] : [[values[i], b]];
      }));
      if (Object.keys(byCategory).length) setPath(settings, 'budgets.monthlyByCategory', byCategory);
      else if (isObject(settings.budgets)) delete settings.budgets.monthlyByCategory;
    }
  }
  changed();
}

function changed() {
  dirty = true;
  refresh();
  updateSuggestions();
}

function commitInput(input) {
  updateYen(input);
  if (input.dataset.path) {
    setPath(settings, input.dataset.path, readInput(input));
    changed();
    return;
  }
  const list = input.closest('[data-list]');
  if (list) syncRows(list.dataset.list);
}

// 検証して、誤りを該当項目の下（無ければ親の項目、さらに無ければフォーム先頭）に出す。
function refresh() {
  renderAllocation();
  errors = settings ? validate(settings) : [];
  for (const slot of slots.values()) slot.textContent = '';
  const others = [];
  for (const { path, message } of errors) {
    let p = path;
    while (p && !slots.has(p)) p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '';
    if (!p) {
      others.push(el('li', { textContent: `${path || '設定全体'}: ${message}` }));
      continue;
    }
    const slot = slots.get(p);
    const text = p === path ? message : `${path.slice(p.length + 1)}: ${message}`;
    slot.textContent = slot.textContent ? `${slot.textContent} / ${text}` : text;
  }
  $('other-errors').replaceChildren(...others);
  // 中項目未選択の行は validate では分からないので、行の下に出して保存を止める
  if (settings) {
    for (const kind of ['expense', 'income']) {
      [...listOf(kind).children].forEach((row, i) => {
        const pending = readCategory(row) === null;
        row.querySelector('.row-error').textContent = pending ? '中項目を選んでください' : '';
        if (pending) errors.push({ path: `${LIST_PATHS[kind]}.${i}`, message: '中項目を選んでください' });
      });
    }
  }
  if (errors.length) toast(`入力エラーが ${errors.length} 件あります`, true);
  else if ($('toast').classList.contains('error') && $('toast').textContent.startsWith('入力エラー')) toast('');
  setBusy(busy);
}

// ---- 起動

form.addEventListener('input', (event) => {
  if (event.target === $('allocation-income')) updateAllocationIncome(event.target);
  else commitInput(event.target);
});
form.addEventListener('submit', (event) => event.preventDefault());
for (const button of form.querySelectorAll('[data-add]')) {
  button.addEventListener('click', () => {
    const kind = button.dataset.add;
    const row = makeRow(kind, '', undefined);
    listOf(kind).append(row);
    syncRows(kind);
    (row.querySelector('select') ?? row.querySelector('input')).focus();
  });
}
// 選んだ大項目の中項目のうち、まだ行に無いものを `大項目/中項目` の行としてまとめて足す
$('bulk-add-button').addEventListener('click', () => {
  const major = $('bulk-major').value;
  const added = missingMinors(options, major, [...listOf('expense').children].map(readCategory));
  if (!added.length) {
    toast('追加する中項目はありません');
    return;
  }
  listOf('expense').append(...added.map((minor) => makeRow('expense', joinCategory(major, minor), undefined)));
  syncRows('expense');
});
$('login').addEventListener('click', startLogin);
$('pat-form').addEventListener('submit', connectWithPat);
$('disconnect').addEventListener('click', disconnect);
$('repo-select').addEventListener('change', () => {
  if (dirty && !confirm('保存していない変更は失われます。切り替えますか？')) {
    $('repo-select').value = stored('repo');
    return;
  }
  localStorage.setItem(KEYS.repo, $('repo-select').value);
  renderConnection();
  load();
});
$('reload').addEventListener('click', reload);
$('preview').addEventListener('click', showYaml);
$('save').addEventListener('click', save);
addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

async function start() {
  const params = new URLSearchParams(location.search);
  if (params.has('code') || params.has('error')) await finishLogin(params);
  renderConnection();
  if (stored('token') && stored('authMode') === 'app') await loadRepoChoices();
  await load();
}

start();
