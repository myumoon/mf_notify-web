// 画面の組み立て・イベント・状態。表示文字列は textContent / Option で入れる（innerHTML を使わない）。
// トークン・code・設定の中身を console や URL に出さない。
import { CLIENT_ID, TOKEN_ENDPOINT, APP_SLUG } from './config.js';
import {
  DEFAULTS, validate, toYaml, fromYaml, formatYen, categoryOptions, minorsOf, missingMinors, splitCategory, joinCategory, suggestBudgets, reserveMonthlyProposal, allocation,
  migrateSettings, overlaps, destinationLabel,
} from './lib.js';
import { getFile, putFile, listInstallationRepos, exchangeCode, GitHubError, ConflictError } from './github.js';

const KEYS = { token: 'mfnotify.token', repo: 'mfnotify.repo', authMode: 'mfnotify.authMode' };
const STATE_KEY = 'mfnotify.oauthState';
const ALLOCATION_COLORS = ['#3b82c4', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#e84393', '#16a085'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const SETTINGS_PATH = 'settings.yml';
const CATEGORIES_PATH = 'categories.json';
const STATS_PATH = 'stats.json';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
// 通知先タブの欄は data-path を `destinations.*.` で始め、* を表示中の通知先の添字に置き換えて読み書きする。
const DEST = 'destinations.*.';
const LIST_PATHS = { expense: `${DEST}categories`, income: 'categories.income', accounts: 'warnings.stale.ignoreAccounts' };

const $ = (id) => document.getElementById(id);
const form = $('settings-form');
const slots = new Map([...form.querySelectorAll('[data-error-for]')].map((s) => [s.dataset.errorFor, s]));

let settings = null; // 読み込んだ設定（画面に無いキーもそのまま保持して保存する）
let sha = null;
let loadedRepo = ''; // settings と sha がどの repo のものか
let loadSeq = 0; // 読込の世代。古い読込・保存の結果を捨てるため
let options = categoryOptions(null);
let stats = null;
let errors = [];
let busy = false;
let dirty = false;
let current = 0; // 通知先パネルが表示・編集する destinations の添字
let showCommon = true; // 共通タブを表示中か

const stored = (key) => localStorage.getItem(KEYS[key]) ?? '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const resolve = (path) => path.replace('*', String(current));
const destinations = () => (Array.isArray(settings?.destinations) ? settings.destinations : []);
const currentDest = () => (isObject(destinations()[current]) ? destinations()[current] : {});
const destCategories = (dest) => (isObject(dest) && Array.isArray(dest.categories) ? dest.categories.filter((c) => typeof c === 'string') : []);
// 表示中以外の通知先で、rule と重なるカテゴリを持つものの添字（無ければ -1）
const ownerOf = (rule) => destinations().findIndex((dest, i) => i !== current && destCategories(dest).some((other) => overlaps(rule, other)));

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
    if (!isObject(o[k]) && !Array.isArray(o[k])) o[k] = {};
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
function clearSettings() {
  loadSeq++;
  settings = null;
  stats = null;
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
  if (repo !== loadedRepo) clearSettings();
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
    const { settings: migrated, migrated: wasLegacy } = migrateSettings(loaded);
    settings = migrated;
    stats = loadedStats;
    sha = file?.sha ?? null;
    loadedRepo = repo;
    options = loadedOptions;
    dirty = false;
    current = 0;
    showCommon = true;
    renderForm();
    $('connect').open = false;
    // 接続欄は閉じるので、案内は保存バーに出す
    if (!file) toast('settings.yml がまだ無いので既定値を表示しています。保存すると作成します');
    else if (wasLegacy) toast('旧形式の設定を通知先「家計」1 件に変換して表示しています。保存すると新しい形式で書き込みます');
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
    const saved = await putFile(stored('token'), loadedRepo, SETTINGS_PATH, toYaml(settingsForExport()), sha, 'Update settings');
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
  $('yaml-text').textContent = toYaml(settingsForExport());
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

function renderAllocation() {
  if (!settings) return;
  const chart = $('allocation-chart');
  const legend = $('allocation-legend');
  const empty = $('allocation-empty');
  if (!chart || !legend || !empty) return;

  const result = allocation(currentDest());
  chart.replaceChildren();
  legend.replaceChildren();
  if (result.total <= 0) {
    chart.hidden = true;
    chart.setAttribute('display', 'none');
    empty.textContent = '月予算を入力すると表示されます';
    return;
  }

  chart.hidden = false;
  chart.setAttribute('display', 'inline');
  chart.setAttribute('viewBox', '0 0 1000 28');
  chart.setAttribute('width', '100%');
  chart.setAttribute('height', '28');
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', '月予算の内訳');
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

  const expenseCategories = destCategories(currentDest());
  const scale = Math.max(result.total, result.segments.reduce((sum, segment) => sum + segment.amount, 0));
  let x = 0;
  result.segments.forEach((segment, index) => {
    const categoryIndex = expenseCategories.indexOf(segment.key);
    const color = categoryIndex < 0 ? '#9ca3af' : ALLOCATION_COLORS[categoryIndex % ALLOCATION_COLORS.length];
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
    const monthlyX = result.total / scale * 1000;
    chart.append(svg('rect', { x: monthlyX, y: 0, width: 1000 - monthlyX, height: 28, fill: 'url(#allocation-overflow)' }));
    chart.append(svg('line', { x1: monthlyX, y1: 0, x2: monthlyX, y2: 28, stroke: '#111827', 'stroke-width': 2 }));
  }
}

function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number') return readNumber(input, 'optional' in input.dataset ? undefined : null);
  return input.value;
}

function renderInputs(destinationOnly) {
  for (const input of form.querySelectorAll('[data-path]')) {
    if (destinationOnly && !input.dataset.path.startsWith(DEST)) continue;
    const v = getPath(settings, resolve(input.dataset.path));
    if (input.type === 'checkbox') input.checked = v === true;
    else input.value = v ?? '';
    updateYen(input);
  }
}

function renderAdvisor() {
  const enabled = isObject(settings.advisor);
  $('advisor-enabled').checked = enabled;
  for (const input of form.querySelectorAll('[data-path]')) {
    if (!input.dataset.path.startsWith('advisor.')) continue;
    input.disabled = !enabled;
    input.value = getPath(settings, input.dataset.path) ?? '';
  }
}

function renderForm() {
  renderInputs(false);
  renderAdvisor();
  $('major-options').replaceChildren(...options.majors.map((m) => new Option(m)));
  $('bulk-major').replaceChildren(...options.majors.map((m) => new Option(m)));
  $('bulk-add').hidden = !options.majors.length;
  for (const kind of Object.keys(LIST_PATHS)) renderRows(kind);
  $('yaml-preview').hidden = true;
  form.hidden = false;
  $('savebar').hidden = false;
  renderPanels();
}

// ---- タブ（WAI-ARIA tabs: 選択中のタブだけ tabIndex 0、矢印キー・Home・End で移動）

const tabKeys = () => ['common', ...destinations().map((_, i) => i)];
const tabId = (key) => `tab-${key}`;

function renderTabs(counts) {
  const tabs = tabKeys().map((key) => {
    const selected = key === 'common' ? showCommon : !showCommon && key === current;
    const label = key === 'common' ? '共通' : destinationLabel(destinations()[key], key);
    const count = counts[key] ?? 0;
    const button = el('button', { type: 'button', id: tabId(key), textContent: count ? `${label}（エラー ${count}）` : label, tabIndex: selected ? 0 : -1 });
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(selected));
    button.setAttribute('aria-controls', key === 'common' ? 'panel-common' : 'panel-destination');
    button.addEventListener('click', () => selectTab(key));
    return button;
  });
  $('tablist').replaceChildren(...tabs);
  $('panel-destination').setAttribute('aria-labelledby', tabId(current));
}

// タブのボタンは描き直すので、選んだタブへフォーカスを戻す（Enter・Space・矢印キーで操作を続けられるように）。
function selectTab(key) {
  showCommon = key === 'common';
  if (!showCommon) current = key;
  renderPanels();
  $(tabId(showCommon ? 'common' : current))?.focus();
}

// 表示中のタブに合わせてパネルを切り替え、通知先パネルの欄・行を current の通知先で描き直す。
function renderPanels() {
  if (current >= destinations().length) current = Math.max(0, destinations().length - 1);
  $('panel-common').hidden = !showCommon;
  $('panel-destination').hidden = showCommon || !destinations().length;
  $('remove-destination').disabled = destinations().length <= 1;
  renderInputs(true);
  renderRows('expense');
  renderMajorSettings();
  refresh();
  updateSuggestions();
}

function moveTab(event) {
  const keys = tabKeys();
  const at = keys.indexOf(showCommon ? 'common' : current);
  const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: keys.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  selectTab(keys[(next + keys.length) % keys.length]);
}

function addDestination() {
  if (!Array.isArray(settings.destinations)) settings.destinations = [];
  const ids = new Set(settings.destinations.map((dest) => dest?.id));
  let n = settings.destinations.length + 1;
  while (ids.has(`dest-${n}`)) n++;
  settings.destinations.push({ id: `dest-${n}`, name: `通知先${n}`, webhookRef: '', mentionOnWarning: '', categories: [] });
  dirty = true;
  selectTab(settings.destinations.length - 1);
}

function removeDestination() {
  const list = destinations();
  if (list.length <= 1) return;
  if (!confirm(`通知先「${destinationLabel(list[current], current)}」を削除しますか？`)) return;
  list.splice(current, 1);
  dirty = true;
  selectTab(Math.min(current, list.length - 1));
}

function setSuggestion(input, value, slot = null, label = '提案') {
  const output = input?.nextElementSibling;
  if (slot) slot.replaceChildren();
  else {
    if (!output) return;
    if (output.nextElementSibling?.className === 'suggest') output.nextElementSibling.remove();
  }
  if (value == null) return;
  const button = el('button', {
    type: 'button',
    className: 'suggest',
    textContent: `${label} ${value.toLocaleString('ja-JP')}`,
  });
  button.addEventListener('click', () => {
    input.value = String(value);
    commitInput(input);
  });
  if (slot) slot.append(button);
  else output.insertAdjacentElement('afterend', button);
}

function updateSuggestions() {
  const controls = $('budget-suggestions');
  controls.replaceChildren();
  const proposals = stats ? suggestBudgets(stats, currentDest()) : null;
  const byPath = {
    [`${DEST}budgets.yearly`]: proposals?.yearly,
    [`${DEST}budgets.monthly`]: proposals?.monthly,
    [`${DEST}budgets.weekly`]: proposals?.weekly,
  };
  for (const input of form.querySelectorAll('[data-path]')) {
    if (Object.hasOwn(byPath, input.dataset.path)) setSuggestion(input, byPath[input.dataset.path]);
  }
  for (const row of listOf('expense').children) {
    const input = row.querySelector('.budget');
    const rule = readCategory(row);
    const reserved = row.querySelector('.reserve')?.checked;
    const categories = proposals?.monthlyByCategory;
    const proposal = reserved ? reserveMonthlyProposal(stats, rule) : categories && Object.hasOwn(categories, rule) ? categories[rule] : null;
    setSuggestion(input, proposal, row.querySelector('.suggest-slot'), reserved ? '自動' : '提案');
  }
  if (!proposals || proposals.months === 0) {
    controls.append(el('span', { textContent: 'PC で 1 回実行すると提案が出ます' }));
    return;
  }
  const applyAll = el('button', { type: 'button', className: 'apply-suggestions', textContent: 'すべて提案値にする' });
  applyAll.addEventListener('click', () => applyAllSuggestions(proposals));
  controls.append(applyAll, el('span', { className: 'suggestion-note', textContent: `通常は直近 ${proposals.months} か月の中央値。積立はデータのある最古月から最新月まで（最大 12 か月）の平均。適用すると提案のある積立行の月額も置き換え、空欄は固定額になります。` }));
}

function applyAllSuggestions(proposals) {
  const byPath = {
    [`${DEST}budgets.yearly`]: proposals.yearly,
    [`${DEST}budgets.monthly`]: proposals.monthly,
    [`${DEST}budgets.weekly`]: proposals.weekly,
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
    const reserved = row.querySelector('.reserve')?.checked;
    const value = reserved ? reserveMonthlyProposal(stats, rule)
      : Object.hasOwn(proposals.monthlyByCategory, rule) ? proposals.monthlyByCategory[rule] : null;
    if (value == null) continue;
    if (input && value != null) {
      input.value = String(value);
      commitInput(input);
    }
  }
}

const listOf = (kind) => form.querySelector(`[data-list="${kind}"]`);

function renderRows(kind) {
  const values = getPath(settings, resolve(LIST_PATHS[kind]));
  const budgets = kind === 'expense' ? currentDest().budgets?.monthlyByCategory : undefined;
  const reserves = kind === 'expense' && Array.isArray(currentDest().reserves) ? currentDest().reserves : [];
  listOf(kind).replaceChildren(
    ...(Array.isArray(values) ? values : []).map((v) => {
      const reserve = reserves.find((item) => item?.category === v);
      const budget = reserve ? reserve.monthly : isObject(budgets) && Object.hasOwn(budgets, v) ? budgets[v] : undefined;
      return makeRow(kind, String(v), budget, Boolean(reserve));
    }),
  );
}

// 全通知先の支出カテゴリに出てくる大項目。表示中の通知先は編集中の行から読む（中項目を選ぶ途中でも表示名を消さない）。
function usedMajors() {
  return [...new Set(destinations().flatMap((dest, i) => (i === current
    ? [...listOf('expense').children].map(readMajor)
    : destCategories(dest).map((category) => splitCategory(category).major))).filter(Boolean))];
}

function renderMajorSettings() {
  const majors = usedMajors();
  $('major-labels').replaceChildren(...majors.map((major) => {
    const entry = isObject(settings.majors) && Object.hasOwn(settings.majors, major) && isObject(settings.majors[major])
      ? settings.majors[major]
      : null;
    const input = el('input', {
      type: 'text',
      className: 'major-label',
      value: typeof entry?.label === 'string' ? entry.label : '',
      placeholder: major,
      ariaLabel: `${major} の通知表示名`,
    });
    input.dataset.majorLabel = major;
    const notify = el('input', {
      type: 'checkbox',
      className: 'major-notify',
      checked: entry?.notify !== false,
      ariaLabel: `${major} の通知トリガー`,
    });
    notify.dataset.majorNotify = major;
    return el('tr', {}, el('td', { className: 'major-name', textContent: major }), el('td', {}, input), el('td', {}, notify));
  }));
}

function settingsForExport() {
  const output = { ...settings };
  // 貯金目標を消して空になった savings は書かない
  if (Array.isArray(settings.destinations)) {
    output.destinations = settings.destinations.map((dest) => {
      if (!isObject(dest) || !isObject(dest.savings) || Object.keys(dest.savings).length) return dest;
      const { savings, ...rest } = dest;
      return rest;
    });
  }
  if (settings.advisor == null) delete output.advisor;
  else if (isObject(settings.advisor)) {
    output.advisor = { ...settings.advisor };
    if (output.advisor.model == null || output.advisor.model === '') delete output.advisor.model;
    if (output.advisor.timeoutSeconds == null || output.advisor.timeoutSeconds === '') delete output.advisor.timeoutSeconds;
  }
  if (!isObject(settings.majors)) return output;
  const used = new Set(destinations().flatMap(destCategories).map((category) => splitCategory(category).major).filter(Boolean));
  const majors = Object.fromEntries(Object.entries(settings.majors).flatMap(([name, value]) => {
    if (!used.has(name)) return [];
    if (!isObject(value)) return [[name, value]];
    const entry = { ...value };
    if (entry.label == null || entry.label === '') delete entry.label;
    if (entry.notify == null || entry.notify === true) delete entry.notify;
    return Object.keys(entry).length ? [[name, entry]] : [];
  }));
  if (Object.keys(majors).length) output.majors = majors;
  else delete output.majors;
  return output;
}

function syncMajorLabel(input) {
  const configured = new Map(Object.entries(isObject(settings.majors) ? settings.majors : {}));
  const previous = configured.get(input.dataset.majorLabel);
  const entry = isObject(previous) ? { ...previous } : {};
  if (input.value === '') delete entry.label;
  else entry.label = input.value;
  if (Object.keys(entry).length) configured.set(input.dataset.majorLabel, entry);
  else configured.delete(input.dataset.majorLabel);
  if (configured.size) settings.majors = Object.fromEntries(configured);
  else delete settings.majors;
  changed();
}

function syncMajorNotify(input) {
  const configured = new Map(Object.entries(isObject(settings.majors) ? settings.majors : {}));
  const previous = configured.get(input.dataset.majorNotify);
  const entry = isObject(previous) ? { ...previous } : {};
  if (input.checked) delete entry.notify;
  else entry.notify = false;
  if (Object.keys(entry).length) configured.set(input.dataset.majorNotify, entry);
  else configured.delete(input.dataset.majorNotify);
  if (configured.size) settings.majors = Object.fromEntries(configured);
  else delete settings.majors;
  changed();
}

function toggleAdvisor(input) {
  if (input.checked) {
    if (!isObject(settings.advisor)) settings.advisor = { provider: 'claude' };
  } else delete settings.advisor;
  renderAdvisor();
  changed();
}

// 中項目 select の特別な値。カテゴリ名に NUL は入らないので候補と衝突しない。
const WHOLE = '\0whole'; // （大項目全体）
const FREE = '\0free'; // その他（自由入力）
const FREE_LABEL = 'その他（自由入力）';

// 行 = 大項目 + 中項目（+ 月予算）、口座は名前だけ。
// categories.json の候補があれば select、無ければ text（major-options の datalist 付き）。
// 候補に無い値は「その他（自由入力）」の text に出して保持する。
function makeRow(kind, value, budget, reserved = false) {
  const remove = el('button', { type: 'button', className: 'remove', textContent: '削除', ariaLabel: 'この行を削除' });
  let row;
  remove.addEventListener('click', () => {
    row.remove();
    syncRows(kind);
  });
  if (kind === 'accounts') {
    row = el('div', { className: 'row' }, el('input', { type: 'text', className: 'value', value, ariaLabel: '口座名' }), remove);
    return row;
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
    if (kind === 'expense') {
      parts.splice(0, 2, el('div', { className: 'pick' }, majorInput), el('div', { className: 'pick' }, minorInput));
    }
  }
  if (kind === 'expense') {
    const budgetInput = el('input', {
      type: 'number', className: 'budget', value: budget ?? '', min: 1, step: 1, inputMode: 'numeric',
      placeholder: reserved ? '積立月額（空なら自動）' : '月予算（任意）', ariaLabel: reserved ? '積立月額' : '月予算',
    });
    budgetInput.dataset.yen = '';
    const reserveInput = el('input', {
      type: 'checkbox', className: 'reserve', checked: reserved,
      ariaLabel: value ? `${value} を積立にする` : 'このカテゴリを積立にする',
    });
    parts.push(
      el('div', { className: 'budget-cell' }, budgetInput, el('output', { className: 'yen' })),
      el('span', { className: 'reserve-cell' }, reserveInput),
      el('span', { className: 'suggest-slot' }),
    );
  }
  const removeCell = kind === 'expense' ? el('span', { className: 'remove-cell' }, remove) : remove;
  row = el('div', { className: kind === 'expense' ? 'row expense-row' : 'row' }, ...parts, removeCell, el('span', { className: 'row-error' }));
  if (kind === 'expense') {
    row.setAttribute('role', 'row');
    for (const cell of [...row.children].slice(0, 6)) cell.setAttribute('role', 'cell');
    updateYen(row.querySelector('.budget'));
  }
  return row;
}

// 行のカテゴリ値。select があればそれを、自由入力・候補なしなら text を読む。
// 大項目が空なら ''、select で中項目を選んでいない（自由入力が空も含む）なら null。
function readMajor(row) {
  const select = row.querySelector('.major-select');
  return (select && select.value !== FREE ? select.value : row.querySelector('.major').value).trim();
}

function readCategory(row) {
  const major = readMajor(row);
  const select = row.querySelector('.minor-select');
  const minor = select && select.value !== FREE ? select.value : row.querySelector('.minor').value.trim();
  if (!major) return '';
  if (minor === '' && select) return null;
  return joinCategory(major, minor === WHOLE ? '' : minor);
}

function syncRows(kind) {
  const rows = [...listOf(kind).children];
  if (kind === 'accounts') {
    setPath(settings, LIST_PATHS.accounts, rows.map((r) => r.querySelector('.value').value.trim()));
  } else {
    // 中項目未選択の行は大項目単独にせず空にする（refresh が行の下にエラーを出して保存を止める）
    const values = rows.map((r) => readCategory(r) ?? '');
    setPath(settings, resolve(LIST_PATHS[kind]), values);
    if (kind === 'expense') {
      rows.forEach((row, index) => {
        const reserved = row.querySelector('.reserve')?.checked;
        const input = row.querySelector('.budget');
        input.placeholder = reserved ? '積立月額（空なら自動）' : '月予算（任意）';
        input.setAttribute('aria-label', reserved ? '積立月額' : '月予算');
        row.querySelector('.reserve').setAttribute('aria-label', values[index]
          ? `${values[index]} を積立にする` : 'このカテゴリを積立にする');
      });
      const byCategory = Object.fromEntries(rows.flatMap((r, i) => {
        if (!values[i] || r.querySelector('.reserve')?.checked) return [];
        const b = readNumber(r.querySelector('.budget'), undefined);
        return b === undefined ? [] : [[values[i], b]];
      }));
      if (Object.keys(byCategory).length) setPath(settings, resolve(`${DEST}budgets.monthlyByCategory`), byCategory);
      else if (isObject(currentDest().budgets)) delete currentDest().budgets.monthlyByCategory;
      const reserves = rows.flatMap((r, i) => {
        if (!values[i] || !r.querySelector('.reserve')?.checked) return [];
        const monthly = readNumber(r.querySelector('.budget'), undefined);
        return [{ category: values[i], ...(monthly === undefined ? {} : { monthly }) }];
      });
      if (reserves.length) currentDest().reserves = reserves;
      else delete currentDest().reserves;
      renderMajorSettings();
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
    setPath(settings, resolve(input.dataset.path), readInput(input));
    changed();
    return;
  }
  const list = input.closest('[data-list]');
  if (list) syncRows(list.dataset.list);
}

// 検証して、誤りを該当項目の下（無ければ親の項目、さらに無ければフォーム先頭）に出す。
// 通知先の誤りは表示中の通知先のものだけを欄に出し、件数は各タブに出す。
function refresh() {
  renderAllocation();
  errors = settings ? validate(settings) : [];
  for (const slot of slots.values()) slot.textContent = '';
  const others = [];
  const counts = {};
  for (const { path: fullPath, message } of errors) {
    const dest = /^destinations\.(\d+)(?=\.|$)/.exec(fullPath);
    const tab = dest ? Number(dest[1]) : fullPath === 'destinations' ? null : 'common';
    if (tab !== null) counts[tab] = (counts[tab] ?? 0) + 1;
    if (dest && Number(dest[1]) !== current) continue;
    const path = dest ? `destinations.*${fullPath.slice(dest[0].length)}` : fullPath;
    let p = path;
    while (p && !slots.has(p)) p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '';
    if (!p) {
      others.push(el('li', { textContent: `${fullPath || '設定全体'}: ${message}` }));
      continue;
    }
    const slot = slots.get(p);
    const text = p === path ? message : `${path.slice(p.length + 1)}: ${message}`;
    slot.textContent = slot.textContent ? `${slot.textContent} / ${text}` : text;
  }
  $('other-errors').replaceChildren(...others);
  // 中項目未選択の行は validate では分からないので、行の下に出して保存を止める。
  // 他の通知先と重なる・同じ通知先で重複する行も行の下に出す（保存は validate が止める）。
  if (settings) {
    for (const kind of ['expense', 'income']) {
      const seen = [];
      [...listOf(kind).children].forEach((row, i) => {
        const rule = readCategory(row);
        const pending = rule === null;
        const owner = kind === 'expense' && rule ? ownerOf(rule) : -1;
        const duplicate = kind === 'expense' && rule && seen.includes(rule);
        seen.push(rule);
        row.querySelector('.row-error').textContent = pending ? '中項目を選んでください'
          : owner >= 0 ? `${destinationLabel(destinations()[owner], owner)} に割り当て済み`
            : duplicate ? 'この通知先で重複しています' : '';
        if (pending) {
          errors.push({ path: `${resolve(LIST_PATHS[kind])}.${i}`, message: '中項目を選んでください' });
          const tab = kind === 'expense' ? current : 'common';
          counts[tab] = (counts[tab] ?? 0) + 1;
        }
      });
    }
    renderTabs(counts);
  }
  if (errors.length) toast(`入力エラーが ${errors.length} 件あります`, true);
  else if ($('toast').classList.contains('error') && $('toast').textContent.startsWith('入力エラー')) toast('');
  setBusy(busy);
}

// ---- 起動

form.addEventListener('input', (event) => {
  if (event.target === $('advisor-enabled')) toggleAdvisor(event.target);
  else if (Object.hasOwn(event.target.dataset, 'majorLabel')) syncMajorLabel(event.target);
  else if (Object.hasOwn(event.target.dataset, 'majorNotify')) syncMajorNotify(event.target);
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
// 選んだ大項目の中項目のうち、まだ行に無く、ほかの通知先とも重ならないものを `大項目/中項目` の行としてまとめて足す
$('bulk-add-button').addEventListener('click', () => {
  const major = $('bulk-major').value;
  const added = missingMinors(options, major, [...listOf('expense').children].map(readCategory))
    .filter((minor) => ownerOf(joinCategory(major, minor)) < 0);
  if (!added.length) {
    toast('追加する中項目はありません');
    return;
  }
  listOf('expense').append(...added.map((minor) => makeRow('expense', joinCategory(major, minor), undefined)));
  syncRows('expense');
});
$('tablist').addEventListener('keydown', moveTab);
$('add-destination').addEventListener('click', addDestination);
$('remove-destination').addEventListener('click', removeDestination);
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
