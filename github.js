// GitHub REST API の薄いラッパ。fetch は引数で差し替えられる（テスト用）。
// 例外メッセージには HTTP ステータスだけを入れる（URL・トークン・本文を入れない）。

const API = 'https://api.github.com';
const TIMEOUT_MS = 30_000;

export class GitHubError extends Error {
  constructor(status) {
    super(`GitHub API error: ${status}`);
    this.name = 'GitHubError';
    this.status = status;
  }
}

// sha 不一致（409）や sha 欠落（422）。他で更新されたので再読込が必要。
export class ConflictError extends GitHubError {
  constructor(status) {
    super(status);
    this.name = 'ConflictError';
  }
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function toBase64(text) {
  return btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(''));
}

function fromBase64(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
}

function api(fetchFn, token, method, path, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  return fetchFn(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function getFile(token, repo, path, fetchFn = fetch) {
  const res = await api(fetchFn, token, 'GET', `/repos/${encodePath(repo)}/contents/${encodePath(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(res.status);
  const data = await res.json();
  if (typeof data?.content !== 'string' || typeof data.sha !== 'string') throw new GitHubError(res.status);
  return { text: fromBase64(data.content), sha: data.sha };
}

// 本文は message / content / sha だけ（未知キーは GitHub に黙って無視されるので足さない）。
export async function putFile(token, repo, path, text, sha, message, fetchFn = fetch) {
  const body = { message, content: toBase64(text) };
  if (sha) body.sha = sha;
  const res = await api(fetchFn, token, 'PUT', `/repos/${encodePath(repo)}/contents/${encodePath(path)}`, body);
  if (res.status === 409 || res.status === 422) throw new ConflictError(res.status);
  if (!res.ok) throw new GitHubError(res.status);
  const data = await res.json();
  return { sha: data.content.sha };
}

// GitHub App のユーザートークンで、インストール先のリポジトリを列挙する（100 件を超える想定はしない）。
export async function listInstallationRepos(token, fetchFn = fetch) {
  const get = async (path) => {
    const res = await api(fetchFn, token, 'GET', path);
    if (!res.ok) throw new GitHubError(res.status);
    return res.json();
  };
  const { installations = [] } = await get('/user/installations?per_page=100');
  const repos = [];
  for (const { id } of installations) {
    const { repositories = [] } = await get(`/user/installations/${encodeURIComponent(id)}/repositories?per_page=100`);
    for (const r of repositories) repos.push({ fullName: r.full_name });
  }
  return repos;
}

// Worker の POST /token で code をトークンに換える。
export async function exchangeCode(tokenEndpoint, code, fetchFn = fetch) {
  const res = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new GitHubError(res.status);
  const data = await res.json();
  if (typeof data?.token !== 'string' || !data.token) throw new GitHubError(res.status);
  return { token: data.token };
}
