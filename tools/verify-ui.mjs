// 门页改版验收：真机视口无溢出 + 动画跳转 + 目标页真实可达（不是只看 pathname）
// 自起本地 HTTP 服务，不依赖外部进程。用法：node tools/verify-ui.mjs [chromePath]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const CHROME = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 0, CDP_PORT = 9446;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// 自起静态服务（服务真实仓库文件，不用 probe 副本）
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/' ) p = '/index.html';
    else if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p)).replace(/\\/g, '/');
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('404'); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${ROOT}/../一纸书房-preview/cdp-verify2`, 'about:blank'
], { stdio: 'ignore' });

async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (r.ok) { const p = (await r.json()).find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; }
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 未启动');
}
function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const wait = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const n = ++id; wait.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  return { ws, ready, send };
}

let fail = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`); if (!ok) fail++; };
const ev = async (send, expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

// /tools/ 横排结构断言（堵三类回归：退回 grid / href 改错 / 图标挪到右边）
async function checkToolsLayout(tag, expectThumbW, send) {
  const L = await ev(send, `(() => {
    const g = document.querySelector('.grid'), s = g ? getComputedStyle(g) : {};
    const cards = [...document.querySelectorAll('.grid .card')];
    return {
      display: s.display, dir: s.flexDirection,
      cards: cards.map(c => {
        const b = c.getBoundingClientRect();
        const t = c.querySelector('.thumb')?.getBoundingClientRect();
        const d = c.querySelector('.body')?.getBoundingClientRect();
        return { href: c.getAttribute('href'), top: +b.top.toFixed(1), left: +b.left.toFixed(1),
          thumbW: t ? +t.width.toFixed(1) : -1, leftOk: !!(t && d && t.right <= d.left + 1) };
      }),
      svgs: [...document.querySelectorAll('.grid .thumb svg')].map(x => ({
        vb: x.getAttribute('viewBox'), stroke: getComputedStyle(x).stroke,
        pathOk: (() => {
          const ps = [...x.querySelectorAll('path')];
          return ps.length > 0 && ps.every(p => { try { return p.getTotalLength() > 0; } catch(e) { return false; } });
        })()
      }))
    };
  })()`);
  check(L.display === 'flex' && L.dir === 'column', `${tag} .grid 纵向 flex`, `${L.display}/${L.dir}`);
  check(L.cards.length === 4, `${tag} 四个工具卡`, `n=${L.cards.length}`);
  check(JSON.stringify(L.cards.map(c => c.href)) === JSON.stringify(['/token-calc/', '/ctx-calc/', '/usage-audit/', '/price-history/']),
    `${tag} 四卡 href 精确`, JSON.stringify(L.cards.map(c => c.href)));
  check(L.cards.every((c, i) => i === 0 || (c.top > L.cards[i-1].top && Math.abs(c.left - L.cards[0].left) < 1)),
    `${tag} 四卡垂直堆叠左对齐`, JSON.stringify(L.cards.map(c => [c.top, c.left])));
  check(L.cards.every(c => c.leftOk), `${tag} 图标在文字左侧`, JSON.stringify(L.cards.map(c => c.leftOk)));
  check(L.cards.every(c => Math.abs(c.thumbW - expectThumbW) < 0.6), `${tag} 图标宽 ${expectThumbW}px`, JSON.stringify(L.cards.map(c => c.thumbW)));
  check(L.svgs.length === 4 && L.svgs.every(s => s.vb === '0 0 48 48' && s.stroke === 'rgb(164, 52, 42)' && s.pathOk),
    `${tag} 四个 SVG 正常`, JSON.stringify(L.svgs));
}

try {
  const { ws, ready, send } = session(await cdp());
  await ready; await send('Page.enable'); await send('Runtime.enable');

  // 1) 真机视口：三页直接测真实 HTML，宽 360/320 都不许横向溢出
  for (const w of [360, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 780, deviceScaleFactor: 1, mobile: true });
    for (const p of ['/', '/tools/', '/toolbox/']) {
      await send('Page.navigate', { url: base + p });
      await sleep(500);
      const dims = await ev(send, `({w:window.innerWidth,sw:document.documentElement.scrollWidth,bw:document.body.scrollWidth})`);
      check(dims && dims.sw <= dims.w + 1, `${p} @${w}px 无横向溢出`, dims ? `scrollW=${dims.sw} innerW=${dims.w}` : 'no data');
      if (p === '/tools/') await checkToolsLayout(`${w}px`, 64, send);
    }
  }

  // 1b) 桌面视口：横排结构同样成立（thumb 88px）
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/tools/' });
  await sleep(500);
  await checkToolsLayout('桌面', 88, send);

  // 2) 目标页真实可达（P1-1 核心断言：不是只看 pathname）
  const dest = await fetch(base + '/tools/');
  const destHtml = await dest.text();
  check(dest.status === 200 && destHtml.includes('LLM 成本计算器'), '跳转目标 /tools/ 真实返回200且含工具内容', `status=${dest.status}`);

  // 3) 门页初始态：动画层未激活、印章是链接（无 JS 可降级）
  await send('Page.navigate', { url: base + '/' });
  await sleep(600);
  check(await ev(send, `document.getElementById('intro').className`) === 'intro', '初始动画层未激活');
  check(await ev(send, `document.getElementById('enterBtn').tagName`) === 'A', '印章是 <a> 链接（无JS可降级）');
  check(await ev(send, `!!document.getElementById('enterBtn').getAttribute('href')`), '印章有真实 href');

  // 4) 点击印章 → 动画激活 → 3.4s 后跳转，且落地页内容正确
  await ev(send, `document.getElementById('enterBtn').click()`);
  await sleep(300);
  check((await ev(send, `document.getElementById('intro').className`)).includes('on'), '点击后动画激活');
  await sleep(3400);
  const landed = await ev(send, `({path:location.pathname,title:document.title,h1:document.querySelector('h1')?.textContent||''})`);
  check(landed.path === '/tools/' && landed.h1.includes('把 LLM 账单算清楚'), '动画后落到 /tools/ 且内容正确', `path=${landed.path} h1=${landed.h1}`);

  // 5) 双击不重复注册定时器（P3-1）
  await send('Page.navigate', { url: base + '/' });
  await sleep(500);
  await ev(send, `window.__goCount=0;var _s=setTimeout;window.setTimeout=function(f,t){if(t===3400)window.__goCount++;return _s.apply(this,arguments)};document.getElementById('enterBtn').click();document.getElementById('enterBtn').click()`);
  await sleep(300);
  check(await ev(send, `window.__goCount`) === 1, '双击只注册1个跳转定时器', `count=${await ev(send, 'window.__goCount')}`);

  // 6) 跳过按钮立即跳
  await send('Page.navigate', { url: base + '/' });
  await sleep(500);
  await ev(send, `document.getElementById('enterBtn').click()`);
  await sleep(150);
  await ev(send, `document.getElementById('skipIntro').click()`);
  await sleep(400);
  check(await ev(send, `location.pathname`) === '/tools/', '点跳过立即跳 /tools/');

  // 7) reduced-motion 直接跳（不播动画）
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: base + '/' });
  await sleep(500);
  await ev(send, `document.getElementById('enterBtn').click()`);
  await sleep(400);
  const rm = await ev(send, `({path:location.pathname,on:document.getElementById('intro')?.classList.contains('on')})`);
  check(rm.path === '/tools/' && !rm.on, '减少动画偏好下直接跳且不播动画', `path=${rm.path} anim=${rm.on}`);
  await send('Emulation.setEmulatedMedia', { features: [] });

  ws.close();
} catch (e) {
  console.error('ERROR', e.stack || e.message); fail++;
} finally {
  chrome.kill(); server.close();
}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
