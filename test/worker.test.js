import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

const ENV = { GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'secret-value', ALLOWED_ORIGIN: 'https://pages.example' };
const realFetch = globalThis.fetch;
let calls;
let upstream;

beforeEach(() => {
  calls = [];
  upstream = { status: 200, body: { access_token: 'gho_abc', token_type: 'bearer', scope: '' } };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(upstream.body), { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const post = (body, path = '/token') =>
  worker.fetch(new Request(`https://worker.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), ENV);

test('成功: access_token を { token } で返し、CORS は ALLOWED_ORIGIN 固定', async () => {
  const res = await post(JSON.stringify({ code: 'the-code' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { token: 'gho_abc' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://pages.example');
  const [call] = calls;
  assert.equal(call.url, 'https://github.com/login/oauth/access_token');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Accept, 'application/json');
  assert.ok(call.init.signal instanceof AbortSignal);
  // 契約 silent_ignore oauth.exchange.status-200-on-error: redirect_url など余計なキーを送らない
  assert.deepEqual(call.body, { client_id: 'Iv1.test', client_secret: 'secret-value', code: 'the-code' });
});

test('GitHub エラー: HTTP 200 でも access_token が無ければ 400', async () => {
  upstream = { status: 200, body: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } };
  const res = await post(JSON.stringify({ code: 'x' }));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'exchange_failed' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://pages.example');
});

test('GitHub エラー: 契約の 404 { error: "Not Found" } も 400', async () => {
  upstream = { status: 404, body: { error: 'Not Found' } };
  assert.equal((await post(JSON.stringify({ code: 'x' }))).status, 400);
});

test('GitHub に届かない・JSON でない応答は 502', async () => {
  globalThis.fetch = async () => new Response('<html>', { status: 500 });
  assert.equal((await post(JSON.stringify({ code: 'x' }))).status, 502);
});

test('code が無い・JSON でない本文は 400（GitHub を呼ばない）', async () => {
  for (const body of ['{}', 'not json', 'null', JSON.stringify({ code: 1 })]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('CORS プリフライト', async () => {
  const res = await worker.fetch(new Request('https://worker.example/token', { method: 'OPTIONS' }), ENV);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://pages.example');
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /Content-Type/);
});

test('他のパス・メソッドは 404', async () => {
  assert.equal((await post('{"code":"x"}', '/other')).status, 404);
  assert.equal((await worker.fetch(new Request('https://worker.example/'), ENV)).status, 404);
  assert.equal((await worker.fetch(new Request('https://worker.example/token'), ENV)).status, 404);
  assert.equal((await worker.fetch(new Request('https://worker.example/other', { method: 'OPTIONS' }), ENV)).status, 404);
  assert.equal(calls.length, 0);
});
