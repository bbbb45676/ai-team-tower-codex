// 大樓專用瀏覽器的 MCP 工具（給背景部門用）。
// 透過 Chrome DevTools Protocol 連到大樓自己開的瀏覽器視窗（獨立設定檔，擁有者在裡面登入一次）。
// 安全限制寫死在這裡：只能開允許的網站、不進私訊和帳號設定、不按登出／刪除／封鎖／檢舉。
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PORT = +process.env.TOWER_BROWSER_PORT || 9333;
const ALLOW = String(process.env.TOWER_BROWSER_ALLOW || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CWD = path.resolve(process.env.TOWER_PROJECT_DIR || process.cwd());
const BASE = `http://127.0.0.1:${PORT}`;
const BLOCK_PATH = /\/(direct|messages|inbox|settings|accounts\/(edit|password|logout)|logout)\b/i;
const BLOCK_CLICK = /^(登出|log ?out|刪除|delete|封鎖|block|檢舉|report|取消追蹤|unfollow)$/i;

const hostOk = u => { try { const h = new URL(u).hostname.toLowerCase(); return ALLOW.some(a => h === a || h.endsWith('.' + a)); } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastAct = 0;
async function pace() { const gap = 1200 + Math.random() * 900, wait = lastAct + gap - Date.now(); if (wait > 0) await sleep(wait); lastAct = Date.now(); }

/* ---------- CDP ---------- */
let tab = null, ws = null, seq = 0;
const pending = new Map();
async function connect() {
  if (ws && ws.readyState === 1) return;
  let r;
  try { r = await fetch(`${BASE}/json/new?about:blank`, { method: 'PUT' }); } catch { throw new Error('大樓瀏覽器沒有開。請主管在大樓「自動」面板按「開啟大樓瀏覽器」。'); }
  tab = await r.json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('連不上大樓瀏覽器')); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  ws.onclose = () => { ws = null; };
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
}
function send(method, params = {}) {
  return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 逾時')); } }, 30000); });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('頁面執行錯誤：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function settle() {
  for (let i = 0; i < 40; i++) { try { if (await evaluate('document.readyState') === 'complete') break; } catch {} await sleep(500); }
  await sleep(1500);
}
async function guard() {
  const url = await evaluate('location.href');
  if (url !== 'about:blank' && (!hostOk(url) || BLOCK_PATH.test(new URL(url).pathname))) {
    await send('Page.navigate', { url: 'about:blank' });
    throw new Error(`頁面跑到不允許的地方（${url}），已離開。大樓瀏覽器只能開：${ALLOW.join('、')}，而且不能進私訊或帳號設定。`);
  }
  return url;
}
async function closeTab() { try { if (tab) await fetch(`${BASE}/json/close/${tab.id}`); } catch {} }
process.on('exit', () => {}); process.stdin.on('close', async () => { await closeTab(); process.exit(0); });

/* ---------- 工具 ---------- */
const server = new McpServer({ name: 'tower-browser', version: '1.0.0' });
const ok = text => ({ content: [{ type: 'text', text }] });
const wrap = fn => async args => { try { await connect(); return await fn(args); } catch (e) { return { content: [{ type: 'text', text: '失敗：' + (e.message || e) }], isError: true }; } };

server.registerTool('open', { description: `在大樓瀏覽器開網址。只能開：${ALLOW.join('、')}（擁有者已在這個瀏覽器登入）。`, inputSchema: { url: z.string() } }, wrap(async ({ url }) => {
  if (!hostOk(url)) throw new Error(`不允許的網站。只能開：${ALLOW.join('、')}`);
  if (BLOCK_PATH.test(new URL(url).pathname)) throw new Error('不能開私訊、收件匣或帳號設定頁');
  await pace(); await send('Page.navigate', { url }); await settle(); const at = await guard();
  const login = await evaluate(`!!document.querySelector('input[type=password]') || /\\/login/.test(location.pathname) || [...document.querySelectorAll('a,button,[role=button]')].some(e => /^(登入|log in)$/i.test((e.innerText || '').trim()))`);
  return ok(`已開啟 ${at}\n標題：${await evaluate('document.title')}${login ? '\n⚠️ 看起來是登入頁：大樓瀏覽器還沒登入。不要嘗試登入，停下來回報「卡住（大樓瀏覽器沒登入）」。' : ''}`);
}));

server.registerTool('read', { description: '讀目前頁面的文字（網址、標題、可見文字）。讀貼文、留言、數字用這個，比截圖省。', inputSchema: { maxChars: z.number().optional() } }, wrap(async ({ maxChars }) => {
  const at = await guard();
  const t = await evaluate('document.body ? document.body.innerText : ""');
  const n = Math.min(Math.max(+maxChars || 15000, 1000), 60000);
  return ok(`網址：${at}\n標題：${await evaluate('document.title')}\n\n${t.length > n ? t.slice(0, n) + `\n…（還有 ${t.length - n} 字，往下捲動後再讀，或加大 maxChars）` : t}`);
}));

server.registerTool('links', { description: '列出頁面上的連結（文字與網址）。找文章或貼文的永久連結用。', inputSchema: { contains: z.string().optional() } }, wrap(async ({ contains }) => {
  await guard();
  const list = await evaluate(`(() => { const seen = new Set(), out = []; for (const a of document.querySelectorAll('a[href]')) { const h = a.href; if (seen.has(h)) continue; seen.add(h); out.push({ t: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80), h }); } return out; })()`);
  const f = contains ? list.filter(x => x.h.includes(contains) || x.t.includes(contains)) : list;
  return ok(f.slice(0, 150).map((x, i) => `${i + 1}. ${x.t || '（無文字）'} → ${x.h}`).join('\n') || '沒有符合的連結');
}));

const FIND = `(q, nth, list) => {
  const sel = 'a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=textbox],input,textarea,[contenteditable=true],[aria-label]';
  const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = e => ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.innerText || e.value || '')).trim().replace(/\\s+/g, ' ');
  const all = [...document.querySelectorAll(sel)].filter(vis).filter(e => label(e).toLowerCase().includes(q.toLowerCase()));
  // 先選真正能點、能輸入的元素（輸入框 > 按鈕、連結 > 只是有 aria-label 的外框），同一級再選文字最短的
  const rank = e => { const r = e.getAttribute('role') || '', t = e.tagName; if (r === 'textbox' || e.isContentEditable || t === 'INPUT' || t === 'TEXTAREA') return 0; if (t === 'BUTTON' || t === 'A' || ['button', 'link', 'menuitem', 'tab'].includes(r)) return 1; return 2; };
  all.sort((a, b) => rank(a) - rank(b) || label(a).length - label(b).length);
  if (list) return all.slice(0, 25).map((e, i) => ({ i, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', text: label(e).slice(0, 100) }));
  const e = all[nth || 0]; if (!e) return null;
  e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: label(e).slice(0, 100), aria: (e.getAttribute('aria-label') || '').trim(), inner: (e.innerText || '').trim().slice(0, 40) };
}`;
server.registerTool('find', { description: '找頁面上含某段文字或 aria-label 的可點元素，列出編號（給 click 的 nth 用）。', inputSchema: { text: z.string() } }, wrap(async ({ text }) => {
  await guard();
  const r = await evaluate(`(${FIND})(${JSON.stringify(text)}, 0, true)`);
  return ok(r.length ? r.map(x => `nth=${x.i} <${x.tag}${x.role ? ' role=' + x.role : ''}> ${x.text}`).join('\n') : '找不到');
}));

async function clickAt(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
server.registerTool('click', { description: '點擊含某段文字（或 aria-label）的元素；同名很多個時用 nth（從 0 起算，先用 find 看）。也可以給 x、y 座標（看過 screenshot 後用）。', inputSchema: { text: z.string().optional(), nth: z.number().optional(), x: z.number().optional(), y: z.number().optional() } }, wrap(async ({ text, nth, x, y }) => {
  await guard(); await pace();
  if (text) {
    const r = await evaluate(`(${FIND})(${JSON.stringify(text)}, ${+nth || 0}, false)`);
    if (!r) throw new Error(`找不到「${text}」`);
    if (BLOCK_CLICK.test(r.aria) || BLOCK_CLICK.test(r.inner)) throw new Error(`大樓瀏覽器不允許按「${r.aria || r.inner}」`);
    await sleep(300); await clickAt(r.x, r.y); await sleep(1500); const at = await guard();
    return ok(`已點擊「${r.text}」，目前在 ${at}`);
  }
  if (x == null || y == null) throw new Error('要給 text，或 x 和 y');
  const hit = await evaluate(`(() => { const e = document.elementFromPoint(${+x}, ${+y}); const b = e && (e.closest('a,button,[role=button],[role=menuitem]') || e); return b ? ((b.getAttribute('aria-label') || '') + '|' + (b.innerText || '').trim().slice(0, 40)) : ''; })()`);
  if (hit.split('|').some(s => BLOCK_CLICK.test(s.trim()))) throw new Error('大樓瀏覽器不允許按這個按鈕');
  await clickAt(+x, +y); await sleep(1500); const at = await guard();
  return ok(`已點擊 (${x}, ${y})，目前在 ${at}`);
}));

// 換行一律用 Shift+Enter：很多留言框按 Enter 會直接送出，兩行的內容只會送出第一行
server.registerTool('type', { description: '在目前聚焦的輸入框打字（先用 click 點輸入框）。文字裡的 \\n 會用 Shift+Enter 換行，不會送出。打完會回傳輸入框目前的內容，送出前一定要逐字比對。這個工具永遠不會送出，送出要另外 click「發佈」之類的按鈕。', inputSchema: { text: z.string(), clearFirst: z.boolean().optional() } }, wrap(async ({ text, clearFirst }) => {
  await guard(); await pace();
  if (clearFirst) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); }
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await send('Input.insertText', { text: lines[i] });
    if (i < lines.length - 1) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8, windowsVirtualKeyCode: 16 });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8, windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 8, windowsVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0, windowsVirtualKeyCode: 16 });
    }
    await sleep(80);
  }
  const now = await evaluate(`(() => { const e = document.activeElement; return e ? (e.value != null ? e.value : e.innerText) : ''; })()`);
  return ok(`已輸入（還沒送出）。輸入框目前的內容：\n「${now}」\n送出前逐字比對核可版本（含換行、標點、表情符號）；不一致就清掉重打，不要送出。`);
}));

server.registerTool('key', { description: '按一個鍵，例如 Escape、Enter、PageDown。', inputSchema: { key: z.enum(['Escape', 'Enter', 'PageDown', 'PageUp', 'Tab', 'Backspace', 'End', 'Home']) } }, wrap(async ({ key }) => {
  await guard(); await pace();
  const vk = { Escape: 27, Enter: 13, PageDown: 34, PageUp: 33, Tab: 9, Backspace: 8, End: 35, Home: 36 }[key];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk });
  await sleep(800); return ok(`已按 ${key}`);
}));

server.registerTool('scroll', { description: '往下（正數）或往上（負數）捲動，單位是畫面高度，預設 1。捲完再用 read 讀新出現的內容。', inputSchema: { screens: z.number().optional() } }, wrap(async ({ screens }) => {
  await guard(); await pace();
  await evaluate(`window.scrollBy(0, innerHeight * ${+screens || 1})`); await sleep(1500);
  return ok('已捲動');
}));

server.registerTool('screenshot', { description: '截目前畫面。要確認版面、配圖或發文結果時用；只是讀文字請用 read。saveTo 可存到專案資料夾內（例如 data/截圖/xx.png）。', inputSchema: { saveTo: z.string().optional() } }, wrap(async ({ saveTo }) => {
  await guard();
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  let note = '';
  if (saveTo) {
    const out = path.resolve(CWD, saveTo);
    if (!out.startsWith(CWD + path.sep)) throw new Error('只能存到專案資料夾裡');
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, Buffer.from(r.data, 'base64')); note = '已存到 ' + path.relative(CWD, out);
  }
  return { content: [{ type: 'image', data: r.data, mimeType: 'image/jpeg' }, ...(note ? [{ type: 'text', text: note }] : [])] };
}));

server.registerTool('upload', { description: '把專案資料夾裡的圖檔放進頁面的上傳欄位（發文附圖用；先點開發文框和附圖按鈕所在的畫面）。', inputSchema: { files: z.array(z.string()), nth: z.number().optional() } }, wrap(async ({ files, nth }) => {
  await guard(); await pace();
  const abs = files.map(f => path.resolve(CWD, f));
  for (const f of abs) { if (!f.startsWith(CWD + path.sep)) throw new Error('只能上傳專案資料夾裡的檔案'); if (!fs.existsSync(f)) throw new Error('找不到檔案 ' + f); }
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
  if (!nodeIds.length) throw new Error('頁面上找不到上傳欄位，先打開發文框');
  await send('DOM.setFileInputFiles', { nodeId: nodeIds[Math.min(+nth || 0, nodeIds.length - 1)], files: abs });
  await sleep(2500); return ok(`已放入 ${abs.length} 個檔案，請截圖確認預覽`);
}));

server.registerTool('wait', { description: '等幾秒（1–20），讓頁面載入或放慢節奏。', inputSchema: { seconds: z.number() } }, async ({ seconds }) => { await sleep(Math.min(Math.max(+seconds || 1, 1), 20) * 1000); return ok('好了'); });

await server.connect(new StdioServerTransport());
