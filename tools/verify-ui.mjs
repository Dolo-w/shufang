// 用 Chrome CDP 真机视口验证：三页面无横向溢出 + 门页点击动画跳转
// 用法：node tools/verify-ui.mjs [chromePath]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CHROME = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9444;
const BASE = 'file:///D:/workspace/WorkBuddy/一纸书房-preview';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=D:/workspace/WorkBuddy/一纸书房-preview/cdp-verify',
  'about:blank'
], { stdio: 'ignore' });

async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) {
        const page = (await r.json()).find(t => t.type === 'page');
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP 未启动');
}

function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const wait = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id; wait.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { ws, ready, send };
}

let fail = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`);
  if (!ok) fail++;
};

try {
  const target = await cdp();
  const { ws, ready, send } = session(target);
  await ready;
  await send('Page.enable');
  await send('Runtime.enable');

  // 真机视口 360x780
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });

  for (const name of ['gate', 'tools', 'toolbox']) {
    await send('Page.navigate', { url: `${BASE}/probe-${name}.html` });
    await sleep(900);
    const r = await send('Runtime.evaluate', {
      expression: `({t:document.title,w:window.innerWidth,sw:document.documentElement.scrollWidth})`,
      returnByValue: true
    });
    const v = r.result?.result?.value;
    const m = v?.t?.match(/scrollW=(\d+)\|innerW=(\d+)/);
    const sw = m ? +m[1] : v?.sw, iw = m ? +m[2] : v?.w;
    check(sw <= iw + 1, `${name} 360px 无横向溢出`, `scrollW=${sw} innerW=${iw}`);
  }

  // 门页点击跳转流程（用本地 HTTP 服务，让 /tools/ 真实可达）
  await send('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(700);
  const before = await send('Runtime.evaluate', { expression: `document.getElementById('intro').className`, returnByValue: true });
  check(before.result?.result?.value === 'intro', '门页初始动画层未激活', `class=${before.result?.result?.value}`);
  await send('Runtime.evaluate', { expression: `document.getElementById('enterBtn').click()` });
  await sleep(400);
  const during = await send('Runtime.evaluate', { expression: `document.getElementById('intro').className`, returnByValue: true });
  check(during.result?.result?.value.includes('on'), '点击印章后动画层激活', `class=${during.result?.result?.value}`);
  await sleep(3400);
  const url = await send('Runtime.evaluate', { expression: `location.pathname`, returnByValue: true });
  check(url.result?.result?.value.endsWith('/tools/'), '动画结束跳转到 /tools/', `path=${url.result?.result?.value}`);

  ws.close();
} catch (e) {
  console.error('ERROR', e.message);
  fail++;
} finally {
  chrome.kill();
}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
