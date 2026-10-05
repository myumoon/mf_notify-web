import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getFile, putFile, listInstallationRepos, exchangeCode, GitHubError, ConflictError } from '../github.js';

const TOKEN = 'ghp_secret_token_value';
const REPO = 'owner/data';
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// 応答本文は contracts/github.contract.json の実測値（必要なキーだけ抜粋）。
const CONTRACT = {
  getMissing: { status: 404, body: { message: 'Not Found', status: '404' } },
  getExisting: {
    status: 200,
    body: { path: 'contract-probe.txt', sha: '34ad0028d92821d54f83c55cfea2d32976f53fc5', type: 'file', content: 'djEg5pel5pys6KqeCg==\n', encoding: 'base64' },
  },
  putUpdate: { status: 200, body: { content: { sha: '8c1384d825dbbe41309b7dc18ee7991a9085c46e' }, commit: { sha: '32d2d4c1' } } },
  putCreate: { status: 201, body: { content: { sha: '34ad0028d92821d54f83c55cfea2d32976f53fc5' }, commit: { sha: '76b4ebfb' } } },
  putStaleSha: { status: 409, body: { message: 'contract-probe.txt does not match 0000000000000000000000000000000000000000', status: '409' } },
  putMissingSha: { status: 422, body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.', status: '422' } },
  installationsForbidden: { status: 403, body: { message: 'You must authenticate with an access token authorized to a GitHub App in order to list installations', status: '403' } },
};

// 呼び出しを記録し、route(url, init) が返す { status, body } で応答する fetch。
function mockFetch(route) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status, body } = typeof route === 'function' ? route(new URL(url), init) : route;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

function assertApiHeaders(init) {
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers.Accept, 'application/vnd.github+json');
  assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(init.signal instanceof AbortSignal);
}

test('getFile: 404 は null', async () => {
  const f = mockFetch(CONTRACT.getMissing);
  assert.equal(await getFile(TOKEN, REPO, 'settings.yml', f), null);
});

test('getFile: base64 を UTF-8 で復号し sha を返す。GET に branch クエリを付けない', async () => {
  const f = mockFetch(CONTRACT.getExisting);
  assert.deepEqual(await getFile(TOKEN, REPO, 'settings.yml', f), { text: 'v1 日本語\n', sha: CONTRACT.getExisting.body.sha });
  const [call] = f.calls;
  assert.equal(call.init.method, 'GET');
  assert.equal(call.url.origin + call.url.pathname, 'https://api.github.com/repos/owner/data/contents/settings.yml');
  assert.equal(call.url.searchParams.has('branch'), false);
  assertApiHeaders(call.init);
});

test('getFile: 他の失敗は GitHubError(status)。メッセージにトークン・repo を入れない', async () => {
  const err = await getFile(TOKEN, REPO, 'settings.yml', mockFetch({ status: 401, body: {} })).catch((e) => e);
  assert.ok(err instanceof GitHubError);
  assert.ok(!(err instanceof ConflictError));
  assert.equal(err.status, 401);
  assert.equal(err.message, 'GitHub API error: 401');
});

test('全リクエストに 30 秒タイムアウト', async (t) => {
  const timeout = t.mock.method(AbortSignal, 'timeout');
  await getFile(TOKEN, REPO, 'a', mockFetch(CONTRACT.getMissing));
  await putFile(TOKEN, REPO, 'a', 'x', 'sha', 'm', mockFetch(CONTRACT.putUpdate));
  await listInstallationRepos(TOKEN, mockFetch({ status: 200, body: { installations: [] } }));
  await exchangeCode('https://worker.example/token', 'c', mockFetch({ status: 200, body: { token: 't' } }));
  assert.deepEqual(timeout.mock.calls.map((c) => c.arguments[0]), [30_000, 30_000, 30_000, 30_000]);
});

test('putFile: message / content / sha だけを送り、日本語を base64 で壊さない', async () => {
  const f = mockFetch(CONTRACT.putUpdate);
  const result = await putFile(TOKEN, REPO, 'settings.yml', 'v1 日本語\n', 'oldsha', 'Update settings', f);
  assert.deepEqual(result, { sha: CONTRACT.putUpdate.body.content.sha });
  const [call] = f.calls;
  assert.equal(call.init.method, 'PUT');
  assert.equal(call.url.href, 'https://api.github.com/repos/owner/data/contents/settings.yml');
  assertApiHeaders(call.init);
  // 契約 silent_ignore contents.put.unknown-key: 未知キー（branch_name 等）を生成しない
  assert.deepEqual(Object.keys(call.body), ['message', 'content', 'sha']);
  assert.deepEqual(call.body, { message: 'Update settings', content: 'djEg5pel5pys6KqeCg==', sha: 'oldsha' });
});

test('putFile: sha 無し（新規作成）は sha キーを送らない', async () => {
  const f = mockFetch(CONTRACT.putCreate);
  assert.deepEqual(await putFile(TOKEN, REPO, 'settings.yml', 'a', null, 'm', f), { sha: CONTRACT.putCreate.body.content.sha });
  assert.deepEqual(Object.keys(f.calls[0].body), ['message', 'content']);
});

test('putFile: 409 と 422 は ConflictError、他は GitHubError', async () => {
  for (const res of [CONTRACT.putStaleSha, CONTRACT.putMissingSha]) {
    const err = await putFile(TOKEN, REPO, 'settings.yml', 'a', 'sha', 'm', mockFetch(res)).catch((e) => e);
    assert.ok(err instanceof ConflictError);
    assert.equal(err.status, res.status);
  }
  const err = await putFile(TOKEN, REPO, 'settings.yml', 'a', 'sha', 'm', mockFetch({ status: 500, body: {} })).catch((e) => e);
  assert.ok(err instanceof GitHubError && !(err instanceof ConflictError));
  assert.equal(err.message, 'GitHub API error: 500');
});

test('listInstallationRepos: per_page を使い、全インストールのリポジトリを返す', async () => {
  const installations = fixture('installations.json');
  const repositories = fixture('repositories.json');
  const f = mockFetch((url) => {
    if (url.pathname === '/user/installations') return { status: 200, body: installations };
    return { status: 200, body: repositories[url.pathname.split('/')[3]] };
  });
  assert.deepEqual(await listInstallationRepos(TOKEN, f), [
    { fullName: 'octocat/mf_notify-data' }, { fullName: 'octo-org/a' }, { fullName: 'octo-org/b' },
  ]);
  assert.deepEqual(f.calls.map((c) => c.url.pathname), [
    '/user/installations', '/user/installations/101/repositories', '/user/installations/202/repositories',
  ]);
  for (const call of f.calls) {
    // 契約 silent_ignore installations.perpage: 綴り違いの perpage を生成しない
    assert.equal(call.url.searchParams.get('per_page'), '100');
    assert.equal(call.url.searchParams.has('perpage'), false);
    assertApiHeaders(call.init);
  }
});

test('listInstallationRepos: 通常トークンの 403 は GitHubError', async () => {
  const err = await listInstallationRepos(TOKEN, mockFetch(CONTRACT.installationsForbidden)).catch((e) => e);
  assert.ok(err instanceof GitHubError);
  assert.equal(err.status, 403);
});

test('exchangeCode: code を POST し token を返す。失敗は GitHubError', async () => {
  const f = mockFetch({ status: 200, body: { token: 'gho_x' } });
  assert.deepEqual(await exchangeCode('https://worker.example/token', 'the-code', f), { token: 'gho_x' });
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(f.calls[0].body, { code: 'the-code' });
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  for (const res of [{ status: 400, body: { error: 'exchange_failed' } }, { status: 200, body: {} }]) {
    const err = await exchangeCode('https://worker.example/token', 'the-code', mockFetch(res)).catch((e) => e);
    assert.ok(err instanceof GitHubError);
    assert.ok(!err.message.includes('the-code'));
  }
});
