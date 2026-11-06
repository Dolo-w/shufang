// 一纸书房 · 轻量后端
// 只做两件事：收订阅邮箱、记页面访问次数。数据存在 KV 里，不接任何第三方。

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// token 优先取请求头（不出现在 URL 和访问日志里），其次取 query
function tokenOf(request) {
  const h = request.headers.get('x-export-token');
  if (h) return h.trim();
  return (new URL(request.url).searchParams.get('token') || '').trim();
}

function tokenOk(request, env) {
  return Boolean(env.EXPORT_TOKEN) && tokenOf(request) === env.EXPORT_TOKEN;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/api/subscribe' && request.method === 'POST') return onSubscribe(request, env);
    if (p === '/api/subscribe/export' && request.method === 'GET') return onExport(request, env);
    if (p === '/api/hit' && request.method === 'POST') return onHit(request, env, ctx);
    if (p === '/api/stats' && request.method === 'GET') return onStats(request, env);

    return env.ASSETS.fetch(request);
  },
};

async function onSubscribe(request, env) {
  if (!env.SUBSCRIBERS) return json({ ok: false, error: 'storage_not_configured' }, 503);

  let email = '';
  let from = '';
  try {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const b = await request.json();
      email = b.email || '';
      from = b.from || '';
    } else {
      const f = await request.formData();
      email = f.get('email') || '';
      from = f.get('from') || '';
    }
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  email = String(email).trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ ok: false, error: 'invalid_email' }, 400);

  // 简单限流：同一 IP 每小时最多 10 次
  const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const hour = new Date().toISOString().slice(0, 13);
  const rlKey = `rl:${ip}:${hour}`;
  const used = parseInt((await env.SUBSCRIBERS.get(rlKey)) || '0', 10);
  if (used >= 10) return json({ ok: false, error: 'rate_limited' }, 429);
  await env.SUBSCRIBERS.put(rlKey, String(used + 1), { expirationTtl: 3600 });

  const key = `sub:${email}`;
  if (await env.SUBSCRIBERS.get(key)) return json({ ok: true, duplicate: true });

  await env.SUBSCRIBERS.put(
    key,
    JSON.stringify({
      email,
      ts: new Date().toISOString(),
      from: String(from).slice(0, 60),
      ua: (request.headers.get('user-agent') || '').slice(0, 120),
    })
  );
  return json({ ok: true });
}

async function onExport(request, env) {
  if (!tokenOk(request, env)) return json({ ok: false, error: 'forbidden' }, 403);
  if (!env.SUBSCRIBERS) return json({ ok: false, error: 'storage_not_configured' }, 503);

  const rows = [['email', 'subscribed_at', 'source']];
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const v = await env.SUBSCRIBERS.get(k.name);
      if (!v) continue;
      const o = JSON.parse(v);
      rows.push([o.email, o.ts, o.from || '']);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="subscribers.csv"',
      'cache-control': 'no-store',
    },
  });
}

async function onHit(request, env, ctx) {
  if (!env.SUBSCRIBERS) return new Response(null, { status: 204 });

  let p = '/';
  try {
    const b = await request.json();
    p = String(b.p || '/');
  } catch {}
  if (!p.startsWith('/')) p = '/';
  p = p.slice(0, 120).split('?')[0];

  const day = new Date().toISOString().slice(0, 10);
  const key = `pv:${day}:${p}`;
  ctx.waitUntil(
    (async () => {
      const cur = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
      await env.SUBSCRIBERS.put(key, String(cur + 1), { expirationTtl: 60 * 60 * 24 * 400 });
    })()
  );
  return new Response(null, { status: 204 });
}

async function onStats(request, env) {
  if (!tokenOk(request, env)) return json({ ok: false, error: 'forbidden' }, 403);
  if (!env.SUBSCRIBERS) return json({ ok: false, error: 'storage_not_configured' }, 503);

  const day = new Date().toISOString().slice(0, 10);
  const pageviews = {};
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: `pv:${day}:`, cursor });
    for (const k of page.keys) {
      pageviews[k.name.slice(`pv:${day}:`.length)] = parseInt((await env.SUBSCRIBERS.get(k.name)) || '0', 10);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  let subscribers = 0;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: 'sub:', cursor });
    subscribers += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({ date: day, pageviews, subscribers });
}
