// Cloudflare Worker: GitHub App の OAuth code をユーザートークンに換える。ステートもログも持たない。
// env: GITHUB_CLIENT_ID（var）、GITHUB_CLIENT_SECRET（secret）、ALLOWED_ORIGIN（var）

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const TIMEOUT_MS = 10_000;

const corsHeaders = (env) => ({
  'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const json = (status, body, env) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) } });

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/token') return new Response('Not Found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (request.method !== 'POST') return new Response('Not Found', { status: 404 });

    let code;
    try {
      ({ code } = await request.json());
    } catch {
      // 本文が JSON でない
    }
    if (typeof code !== 'string' || !code) return json(400, { error: 'invalid_request' }, env);

    let data;
    try {
      const res = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      data = await res.json();
    } catch {
      return json(502, { error: 'upstream_error' }, env);
    }
    // GitHub は失敗でも HTTP 200 + error キーを返すので、ステータスではなく access_token の有無で判定する。
    if (typeof data?.access_token !== 'string' || !data.access_token) return json(400, { error: 'exchange_failed' }, env);
    return json(200, { token: data.access_token }, env);
  },
};
