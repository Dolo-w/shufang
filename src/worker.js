// 一纸书房 · 轻量后端
// 做四件事：收订阅邮箱、记页面访问次数、导出订阅名单、每天早上给订阅者发「今日一笺」。
// 数据存在 KV 里，不接任何第三方；发邮件走 Resend（RESEND_API_KEY 未配置时推送静默跳过）。

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
    // 手动触发今日一笺（测试用）：dry_run=1 只生成不发送
    if (p === '/api/cron/daily' && request.method === 'GET') {
      if (!tokenOk(request, env)) return json({ ok: false, error: 'forbidden' }, 403);
      const dry = new URL(request.url).searchParams.get('dry_run') === '1';
      return onDailyMail(env, dry);
    }

    return env.ASSETS.fetch(request);
  },

  // Cron Trigger：UTC 00:00 = 北京时间 08:00，每天早上给订阅者发今日一笺
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(onDailyMail(env, false));
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

// ---------- 每日一笺 ----------

// 干支算法与 /daily/ 页保持一致（锚点验证过：1949-10-01 = 甲子日）
const GAN = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
const ZHI = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
const GAN_WX = ['木','木','火','火','土','土','金','金','水','水'];

function jdn(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524;
}
function dayGz(y, m, d) {
  const i = ((jdn(y, m, d) + 49) % 60 + 60) % 60;
  return GAN[i % 10] + ZHI[i % 12];
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

// 通用笺语池（订阅者暂无生辰，先发「今日通用笺」；个性化版待订阅表单收集生辰后上线）
const DAILY_POOL = [
  { line: '缓一缓，把今天过成一天，而不是一段日程。', yi: ['散步不设目的地', '把桌面收拾干净'], ji: ['连环开会', '刷到深夜'] },
  { line: '钝感一点，今天的话别都接。', yi: ['少看群里闲话', '把手头一件小事做完'], ji: ['逐条回应', '深夜下决定'] },
  { line: '今天适合收尾，不适合开新头。', yi: ['清掉一件悬着的事', '把承诺了的还上'], ji: ['立新 flag', '答应新的事'] },
  { line: '信息少吃一点，人反而清醒。', yi: ['读长文章不刷短消息', '饭后走走'], ji: ['连轴刷手机', '边吃边看屏幕'] },
  { line: '今天宜动手，不宜空想。', yi: ['把想法写成三行', '亲手做一顿饭'], ji: ['等完美时机', '只收藏不打开'] },
  { line: '锋芒收三分，事就成了。', yi: ['把话说软一点', '写点东西'], ji: ['硬碰硬', '当众较真'] },
  { line: '账目清楚，心里才清爽。', yi: ['对一遍账', '整理订阅与清单'], ji: ['冲动下单', '借钱给人'] },
  { line: '今天适合被提携，也适合提携自己。', yi: ['请教一个前辈', '读书半小时'], ji: ['硬撑', '拒绝帮助'] },
  { line: '松，是今天的关键字。', yi: ['好好吃一顿', '晒晒太阳'], ji: ['赶工到深夜', '把日程排满'] },
  { line: '少承诺，多兑现，今天够用。', yi: ['拒绝一个不想去的局', '运动出汗'], ji: ['答应帮忙', '给人担保'] },
];

function buildDailyContent(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1, d = now.getUTCDate();
  const gz = dayGz(y, m, d);
  const wx = GAN_WX[GAN.indexOf(gz[0])];
  const seed = hash(gz + ':' + y + m + d);
  const p = DAILY_POOL[seed % DAILY_POOL.length];
  const yi = [p.yi[seed % p.yi.length], p.yi[(seed + 1) % p.yi.length]];
  const ji = [p.ji[(seed >> 2) % p.ji.length], p.ji[((seed >> 2) + 1) % p.ji.length]];
  return {
    date: `${y} 年 ${m} 月 ${d} 日`, gz, wx, yi, ji, line: p.line,
    subject: `一纸日签 · ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${gz}`,
  };
}

function dailyHtml(c) {
  const li = (a) => a.map((x) => `<li>${x}</li>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><body style="margin:0;background:#faf7f0;font-family:Georgia,'Songti SC',serif;color:#2b2620">
<div style="max-width:480px;margin:0 auto;padding:32px 20px">
  <div style="border:2px solid #2b2620;border-radius:8px;background:#fff;padding:28px 24px;text-align:center">
    <div style="font-size:12px;letter-spacing:.3em;color:#1f5c54">一 纸 日 签</div>
    <div style="font-size:13px;color:#6b6257;margin-top:6px">${c.date}</div>
    <div style="font-size:34px;margin:18px 0 4px;letter-spacing:.2em">${c.gz}</div>
    <div style="font-size:12px;color:#9a6b15">今日日主五行属 ${c.wx}</div>
    <div style="font-size:16px;line-height:1.8;margin:20px 0;padding:16px 0;border-top:1px solid #e8e1d4;border-bottom:1px solid #e8e1d4">${c.line}</div>
    <table style="width:100%;font-size:14px"><tr>
      <td style="width:50%;vertical-align:top"><b style="color:#1f5c54">宜</b><ul style="text-align:left;padding-left:20px;margin:6px 0">${li(c.yi)}</ul></td>
      <td style="width:50%;vertical-align:top"><b style="color:#a04030">忌</b><ul style="text-align:left;padding-left:20px;margin:6px 0">${li(c.ji)}</ul></td>
    </tr></table>
  </div>
  <p style="font-size:12px;color:#6b6257;text-align:center;margin-top:16px">
    想要专属你的每日一笺？<a href="https://dolow.dev/daily/" style="color:#1f5c54">去书房填个生辰</a><br>
    同一人同一天，永出此签 · <a href="https://dolow.dev/" style="color:#6b6257">一纸书房</a>
  </p>
</div></body></html>`;
}

async function listSubEmails(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) out.push(k.name.slice('sub:'.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function onDailyMail(env, dryRun) {
  if (!env.SUBSCRIBERS) return json({ ok: false, error: 'storage_not_configured' }, 503);

  const day = new Date().toISOString().slice(0, 10);
  const lockKey = `last:daily:${day}`;
  const c = buildDailyContent();

  if (dryRun) {
    return json({ ok: true, dry_run: true, date: day, subject: c.subject, content: c, recipients: (await listSubEmails(env)).length });
  }
  if (await env.SUBSCRIBERS.get(lockKey)) return json({ ok: true, skipped: 'already_sent_today', date: day });
  if (!env.RESEND_API_KEY) return json({ ok: false, error: 'resend_not_configured', subject: c.subject }, 503);

  const emails = await listSubEmails(env);
  if (!emails.length) return json({ ok: true, sent: 0, note: 'no_subscribers', date: day });

  const from = env.MAIL_FROM || '一纸书房 <daily@dolow.dev>';
  const html = dailyHtml(c);
  let sent = 0, failed = 0;
  for (let i = 0; i < emails.length; i += 100) { // Resend batch 每请求最多 100 封
    const batch = emails.slice(i, i + 100);
    try {
      const resp = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, subject: c.subject, html, to: batch }),
      });
      if (resp.ok) sent += batch.length; else failed += batch.length;
    } catch { failed += batch.length; }
  }
  if (failed === 0) await env.SUBSCRIBERS.put(lockKey, String(sent));
  return json({ ok: failed === 0, date: day, subject: c.subject, total: emails.length, sent, failed });
}
