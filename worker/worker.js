// Cloudflare Worker: the only place the GitHub write token exists.
//
// The static site is fully public (that's the point — anyone can browse and
// upload with zero setup), so this worker is deliberately unauthenticated.
// What keeps it safe is a strict allowlist: it will only ever read or write
// the two known JSON data files, and only ever write images into
// images/trades/ or images/backtests/ under a UUID-shaped filename. It can
// never touch the site's own HTML/JS/CSS, and there's a hard size cap per
// file. Deploy with `wrangler deploy` — see ../README.md.

const JSON_PATHS = new Set(['data/trades.json', 'data/backtests.json', 'data/tags.json']);
const IMAGE_PATH_RE = /^images\/(trades|backtests)\/[a-f0-9-]{16,160}\.jpg$/i;
const MAX_BASE64_LENGTH = 6 * 1024 * 1024; // ~4.5MB of actual image data

function isAllowedPath(path) {
  return JSON_PATHS.has(path) || IMAGE_PATH_RE.test(path);
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'bo-tracker-worker'
  };
}

function contentsUrl(env, path) {
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function handleGet(url, env) {
  const path = url.searchParams.get('path') || '';
  if (!JSON_PATHS.has(path)) return json(env, { error: 'Path not readable via this endpoint.' }, 400);

  const res = await fetch(`${contentsUrl(env, path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`, {
    headers: githubHeaders(env)
  });
  if (res.status === 404) return json(env, { text: null, sha: null });
  if (!res.ok) return json(env, { error: `GitHub error ${res.status}` }, 502);
  const data = await res.json();
  return json(env, { text: base64ToUtf8(data.content), sha: data.sha });
}

async function handlePut(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: 'Invalid JSON body.' }, 400); }

  const { path, content, sha, message } = body || {};
  if (typeof path !== 'string' || !isAllowedPath(path)) return json(env, { error: 'Path not allowed.' }, 400);
  if (typeof content !== 'string' || content.length === 0) return json(env, { error: 'Missing content.' }, 400);
  if (content.length > MAX_BASE64_LENGTH) return json(env, { error: 'File too large.' }, 413);

  const res = await fetch(contentsUrl(env, path), {
    method: 'PUT',
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: typeof message === 'string' && message ? message.slice(0, 300) : `Update ${path}`,
      content,
      branch: env.GITHUB_BRANCH || 'main',
      ...(sha ? { sha } : {})
    })
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch (e) { /* ignore */ }
    return json(env, { error: detail }, res.status);
  }
  const data = await res.json();
  return json(env, { sha: data.content && data.content.sha });
}

async function handleDelete(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: 'Invalid JSON body.' }, 400); }

  const { path, sha, message } = body || {};
  if (typeof path !== 'string' || !isAllowedPath(path)) return json(env, { error: 'Path not allowed.' }, 400);
  if (typeof sha !== 'string' || !sha) return json(env, { error: 'Missing sha.' }, 400);

  const res = await fetch(contentsUrl(env, path), {
    method: 'DELETE',
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: typeof message === 'string' && message ? message.slice(0, 300) : `Delete ${path}`,
      sha,
      branch: env.GITHUB_BRANCH || 'main'
    })
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try { detail = JSON.parse(text).message || text; } catch (e) { /* ignore */ }
    return json(env, { error: detail }, res.status);
  }
  return json(env, { ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (url.pathname !== '/api/file') {
      return json(env, { error: 'Not found.' }, 404);
    }
    if (request.method === 'GET') return handleGet(url, env);
    if (request.method === 'PUT') return handlePut(request, env);
    if (request.method === 'DELETE') return handleDelete(request, env);
    return json(env, { error: 'Method not allowed.' }, 405);
  }
};
