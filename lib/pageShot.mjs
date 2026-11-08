// 人物「看網頁」時，放大螢幕上顯示那個網頁的真實畫面。
// 另開一個無頭瀏覽器（獨立的空設定檔，不帶任何登入）截圖；只截人物真的用 WebFetch 打開過的網址。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EXTRA = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const VW = 1280, VH = 800, MAX_H = 3600, KEEP = 10 * 60000, IDLE = 5 * 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createPageShot(exe, profile) {
  exe = [exe, ...EXTRA].find(p => p && fs.existsSync(p)) || null;
  const allowed = new Map();   // 畫面上看到的網址（最多 60 字）→ 完整網址
  const cache = new Map();     // 完整網址 → { at, jpg } 或 { at, job }
  let proc = null, port = 0, idleTimer = null, starting = null;

  function allow(url) {
    url = String(url || '');
    if (!/^https?:\/\//i.test(url)) return;
    allowed.delete(url.slice(0, 60)); allowed.set(url.slice(0, 60), url);
    while (allowed.size > 200) allowed.delete(allowed.keys().next().value);
  }

  async function start() {
    if (proc && port) return true;
    if (starting) return starting;
    starting = (async () => {
      fs.mkdirSync(profile, { recursive: true });
      const portFile = path.join(profile, 'DevToolsActivePort');
      try { fs.unlinkSync(portFile); } catch {}
      proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        '--hide-scrollbars', '--mute-audio', '--disable-gpu', `--window-size=${VW},${VH}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
      proc.on('exit', () => { proc = null; port = 0; });
      for (let i = 0; i < 40 && proc; i++) {
        await sleep(250);
        try { const p = +fs.readFileSync(portFile, 'utf8').split('\n')[0]; if (p) { port = p; return true; } } catch {}
      }
      stop(); return false;
    })();
    try { return await starting; } finally { starting = null; }
  }
  function stop() { try { proc?.kill(); } catch {} proc = null; port = 0; }
  function touch() { clearTimeout(idleTimer); idleTimer = setTimeout(stop, IDLE); idleTimer.unref?.(); }

  async function shoot(url) {
    if (!await start()) throw new Error('瀏覽器開不起來');
    touch();
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let id = 0; const wait = new Map(), events = [];
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else if (m.method) events.push(m.method); };
    const cmd = (method, params = {}) => new Promise((ok, no) => { const n = ++id; wait.set(n, m => m.error ? no(new Error(m.error.message)) : ok(m.result)); ws.send(JSON.stringify({ id: n, method, params })); });
    try {
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('連不上瀏覽器')); });
      await cmd('Page.enable');
      await cmd('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
      await cmd('Page.navigate', { url });
      for (let i = 0; i < 60 && !events.includes('Page.loadEventFired'); i++) await sleep(250);
      // 往下捲一遍，讓「捲到才出現」的區塊都顯示出來，再回到最上面截整頁
      const h = Math.min(MAX_H, Math.ceil((await cmd('Page.getLayoutMetrics')).cssContentSize?.height || VH));
      for (let y = 0; y < h; y += 600) { await cmd('Runtime.evaluate', { expression: `window.scrollTo(0, ${y})` }); await sleep(120); }
      await cmd('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' }); await sleep(2500);
      const r = await cmd('Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: true, clip: { x: 0, y: 0, width: VW, height: Math.max(VH, h), scale: 1 } });
      return Buffer.from(r.data, 'base64');
    } finally {
      try { ws.close(); } catch {}
      fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`).catch(() => {});
    }
  }

  // shown：畫面上顯示的網址。回傳 JPEG；不能截或截不到回傳 null
  async function get(shown) {
    const url = allowed.get(String(shown || ''));
    if (!url || !exe) return null;
    const c = cache.get(url);
    if (c?.jpg && Date.now() - c.at < KEEP) return c.jpg;
    if (c?.job) return c.job;
    const job = shoot(url).then(jpg => { cache.set(url, { at: Date.now(), jpg }); return jpg; }, e => { cache.delete(url); console.log(`網頁截圖失敗 ${url}：${e.message}`); return null; });
    cache.set(url, { at: Date.now(), job });
    for (const [k, v] of cache) if (v.jpg && Date.now() - v.at > KEEP) cache.delete(k);
    return job;
  }

  return { allow, get, close: stop, enabled: !!exe };
}
