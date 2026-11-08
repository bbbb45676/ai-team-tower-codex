// Codex 引擎：在背景驅動本機的官方 Codex（codex app-server），把它的事件轉成大樓原本的格式。
// 大樓讀的格式：{ type: 'assistant' | 'user' | 'result', session_id, ... }，跟原本的 Claude 版一樣，
// 所以部門、審核、報告的流程都不用改。
// 指令和改檔的批准請求會交給 options.canUseTool（也就是大樓裡的主管）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const WIN = process.platform === 'win32';

/* ---------- 找到 codex 執行檔 ---------- */
// 依序：環境變數 CODEX_PATH → Codex 桌面版內建 → npm 全域安裝 → 常見路徑
export function findCodex() {
  if (process.env.CODEX_PATH && fs.existsSync(process.env.CODEX_PATH)) return process.env.CODEX_PATH;
  const exe = WIN ? 'codex.exe' : 'codex';
  const found = [];
  const add = f => { try { if (fs.statSync(f).isFile()) found.push(f); } catch {} };
  // Codex 桌面版（Windows）：%LOCALAPPDATA%\OpenAI\Codex\bin\<版本>\codex.exe，取最新的
  const appBin = WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin') : '';
  if (appBin) try { for (const d of fs.readdirSync(appBin)) add(path.join(appBin, d, exe)); } catch {}
  // npm install -g @openai/codex：直接用裡面的原生執行檔（.cmd 不好在背景啟動）
  const npmRoot = WIN ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex') : '';
  if (npmRoot) try { const v = path.join(npmRoot, 'vendor'); for (const t of fs.readdirSync(v)) add(path.join(v, t, 'codex', exe)); } catch {}
  if (!WIN) for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local', 'bin'), '/Applications/Codex.app/Contents/Resources']) add(path.join(d, exe));
  for (const d of String(process.env.PATH || '').split(path.delimiter)) if (d) add(path.join(d, exe));
  if (!found.length) return undefined;
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

/* ---------- codex app-server：一行一個 JSON-RPC 訊息 ---------- */
export class AppServer {
  constructor(exe, { env, cwd, config = [] } = {}) {
    const args = ['app-server'];
    for (const c of config) args.push('-c', c);
    this.child = spawn(exe, args, { env, cwd, windowsHide: true });
    this.pending = new Map(); this.nextId = 1; this.stderr = '';
    this.onNotify = () => {}; this.onRequest = async () => { throw new Error('不支援'); };
    this.child.stderr.on('data', d => { this.stderr += d; if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000); });
    this.closed = new Promise(r => this.child.on('close', code => {
      this.exitCode = code;
      for (const p of this.pending.values()) p.reject(new Error(`Codex 結束（代碼 ${code}）：${this.stderr.trim().slice(-600) || '沒有輸出'}`));
      this.pending.clear(); r(code);
    }));
    this.child.on('error', e => { this.stderr += e.message; });
    readline.createInterface({ input: this.child.stdout }).on('line', line => this.#line(line));
  }
  #write(obj) { if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + '\n'); }
  async #line(line) {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method) { // 伺服器要我們回答（批准請求等）
      try { this.#write({ id: m.id, result: await this.onRequest(m.method, m.params || {}) }); }
      catch (e) { this.#write({ id: m.id, error: { code: -32601, message: String(e.message || e) } }); }
    } else if (m.id !== undefined) { // 我們請求的回覆
      const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) this.onNotify(m.method, m.params || {});
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.#write({ id, method, params }); });
  }
  notify(method, params) { this.#write(params === undefined ? { method } : { method, params }); }
  async init() {
    await this.request('initialize', { clientInfo: { name: 'ai_team_tower', title: 'AI 團隊大樓', version: '1.0.0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
    this.notify('initialized');
    return this;
  }
  kill() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

/* ---------- 權限：大樓的權限模式對應到 Codex 的沙箱與批准方式 ---------- */
// plan：只讀、不問；manual：只讀沙箱，改檔和指令都要問主管；acceptEdits：專案內可以改檔，指令要問主管；
// auto：專案內可以改檔，越界的請求交給 Codex 自己的自動審核；bypassPermissions：不限制
function policyOf(mode) {
  if (mode === 'plan') return { sandbox: 'read-only', approvalPolicy: 'never' };
  if (mode === 'manual') return { sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' };
  if (mode === 'auto') return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' };
  if (mode === 'bypassPermissions') return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
  return { sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' };
}

// Windows 上 Codex 的指令長這樣："C:\...\powershell.exe" -Command 'Get-ChildItem'；拆出裡面真正的指令
export function unwrapCommand(cmd) {
  const s = String(cmd || '').trim();
  let m = s.match(/^"?[^"\s]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*?-Command\s+'([\s\S]*)'$/i);
  if (m) return { tool: 'PowerShell', command: m[1].replace(/''/g, "'") };
  m = s.match(/^"?[^"\s]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*?-Command\s+"([\s\S]*)"$/i);
  if (m) return { tool: 'PowerShell', command: m[1] };
  m = s.match(/^(?:\/\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+'([\s\S]*)'$/);
  if (m) return { tool: 'Bash', command: m[1].replace(/'\\''/g, "'") };
  return { tool: WIN ? 'PowerShell' : 'Bash', command: s };
}
const kindName = k => ({ add: 'Write', delete: 'Delete' }[k?.type] || 'Edit');
const absIn = (cwd, p) => path.isAbsolute(p) ? p : path.join(cwd, p);
const mcpText = r => (r?.content || []).map(c => c?.text || (c?.type ? `[${c.type}]` : '')).join('\n');

/* ---------- 引擎：一次執行 ---------- */
// options：cwd、mode（plan|manual|acceptEdits|auto|bypassPermissions）、model、resume、developerInstructions、
// maxTurns、mcp（{ 名稱: { url } 或 { command, args, env } }）、env、abortController、canUseTool
// 大樓裡只用大樓給的工具：你自己 Codex 裝的外掛、電腦操作、瀏覽器、MCP 伺服器、子代理都不載入
// （跟 Claude 版的 --strict-mcp-config 一樣；否則部門會去操作你的電腦或瀏覽器）
const TOWER_OFF_FEATURES = ['plugins', 'apps', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'multi_agent', 'multi_agent_v2', 'tool_suggest', 'memories', 'goals'];
function userMcpNames(env) {
  const home = env?.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let s = ''; try { s = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return []; }
  const names = new Set();
  for (const m of s.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[\].]/gm)) names.add(m[1] || m[2] || m[3]);
  return [...names];
}
const tomlKey = k => /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);

export async function* codexQuery({ prompt, options }, exe) {
  const config = [];
  for (const f of TOWER_OFF_FEATURES) config.push(`features.${f}=false`);
  for (const n of userMcpNames(options.env)) if (!(n in (options.mcp || {}))) config.push(`mcp_servers.${tomlKey(n)}.enabled=false`);
  for (const [name, s] of Object.entries(options.mcp || {})) {
    const k = `mcp_servers.${name}`;
    if (s.url) config.push(`${k}.url=${JSON.stringify(s.url)}`);
    else {
      config.push(`${k}.command=${JSON.stringify(s.command)}`, `${k}.args=${JSON.stringify(s.args || [])}`);
      for (const [ek, ev] of Object.entries(s.env || {})) config.push(`${k}.env.${ek}=${JSON.stringify(String(ev))}`);
    }
    config.push(`${k}.tool_timeout_sec=86400`);
  }
  const srv = new AppServer(exe, { env: options.env, cwd: options.cwd, config });
  const queue = []; let wake = null, finished = false, threadId = options.resume || null, turnId = null;
  const push = m => { if (threadId) m.session_id = threadId; queue.push(m); if (wake) { wake(); wake = null; } };
  const finish = () => { finished = true; if (wake) { wake(); wake = null; } };
  const signal = options.abortController.signal;
  const files = new Map(); // fileChange itemId -> changes（批准時要顯示改哪些檔）
  let steps = 0, lastText = '', usage = null, error = '';
  const tooMany = () => options.maxTurns && ++steps > options.maxTurns * 2; // Codex 沒有回合上限；用工具次數估算

  const ask = (tool, input) => options.canUseTool(tool, input, { signal }).then(d => d.behavior === 'allow');
  srv.onRequest = async (method, p) => {
    if (method === 'item/commandExecution/requestApproval') {
      const { tool, command } = unwrapCommand(p.command || (p.commandActions || []).map(a => a.command).join(' && '));
      const ok = await ask(tool, { command, description: p.reason || (p.networkApprovalContext ? '需要連網' : '') });
      return { decision: ok ? 'accept' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval') {
      const ch = files.get(p.itemId) || [];
      const first = ch[0] ? absIn(options.cwd, ch[0].path) : (p.grantRoot || '（Codex 沒說是哪個檔案）');
      const input = { file_path: first, changes: ch.map(c => `${kindName(c.kind)} ${c.path}`), reason: p.reason || undefined, diff: ch.map(c => c.diff || '').join('\n').slice(0, 4000) };
      return { decision: (await ask(kindName(ch[0]?.kind), input)) ? 'accept' : 'decline' };
    }
    if (method === 'item/permissions/requestApproval') { // 要額外的權限（例如寫專案外的資料夾）：一律只給本回合、交給主管
      const ok = await ask('Permissions', { command: p.reason || JSON.stringify(p.permissions).slice(0, 300), description: '要求額外權限' });
      return { permissions: ok ? p.permissions : {}, scope: 'turn' };
    }
    if (method === 'mcpServer/elicitation/request') { // MCP 工具要確認：大樓自己的工具才放行
      const ok = (options.trustedMcp || []).includes(p.serverName) || await ask(`mcp__${p.serverName}`, { command: p.message || '', description: 'MCP 工具要求確認' });
      return { action: ok ? 'accept' : 'decline', content: ok && p.mode === 'form' ? {} : null, _meta: null };
    }
    if (method === 'item/tool/requestUserInput') return { answers: {} }; // 大樓裡不讓 AI 停下來問問題
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: { denied: { rejection: '請改用其他做法' } } };
    throw new Error('大樓不支援這個請求：' + method);
  };
  srv.onNotify = (method, p) => {
    if (p.threadId && threadId && p.threadId !== threadId) return; // 子代理的事件不畫
    if (method === 'item/started') {
      const it = p.item;
      if (it.type === 'commandExecution') { const { tool, command } = unwrapCommand(it.command); push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: it.id, name: tool, input: { command } }] } }); }
      else if (it.type === 'fileChange') { files.set(it.id, it.changes || []); push({ type: 'assistant', message: { content: (it.changes || []).map(c => ({ type: 'tool_use', id: it.id, name: kindName(c.kind), input: { file_path: absIn(options.cwd, c.path) } })) } }); }
      else if (it.type === 'mcpToolCall') push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: it.id, name: `mcp__${it.server}__${it.tool}`, input: it.arguments || {} }] } });
      else if (it.type === 'webSearch') push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: it.id, name: 'WebSearch', input: { query: it.query || '' } }] } });
      else return;
      if (tooMany()) { error = 'error_max_turns'; if (turnId) srv.request('turn/interrupt', { threadId, turnId }).catch(() => {}); }
    } else if (method === 'item/completed') {
      const it = p.item;
      if (it.type === 'agentMessage' && it.text?.trim()) { lastText = it.text.trim(); push({ type: 'assistant', message: { content: [{ type: 'text', text: lastText }] } }); }
      else if (it.type === 'commandExecution') push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: it.id, content: (it.aggregatedOutput || '') + (it.status === 'declined' ? '（主管拒絕）' : ''), is_error: it.status !== 'completed' || (it.exitCode ?? 0) !== 0 }] } });
      else if (it.type === 'fileChange') push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: it.id, content: it.status === 'completed' ? '已修改：' + (it.changes || []).map(c => c.path).join('、') : '沒有修改（' + it.status + '）', is_error: it.status !== 'completed' }] } });
      else if (it.type === 'mcpToolCall') push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: it.id, content: it.error?.message || mcpText(it.result), is_error: !!it.error }] } });
      // Codex 打開網頁時，換成大樓看得懂的 WebFetch，放大螢幕才會顯示那一頁
      else if (it.type === 'webSearch' && /^(openPage|findInPage)$/.test(it.action?.type || '') && it.action.url) push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: it.id + ':page', name: 'WebFetch', input: { url: it.action.url } }] } });
    } else if (method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.total || usage;
    else if (method === 'error' && !p.willRetry) error = error || p.error?.message || '執行時發生錯誤';
    else if (method === 'turn/completed') {
      const t = p.turn || {};
      if (t.status === 'completed') push({ type: 'result', subtype: 'success', result: lastText, total_cost_usd: 0, usage });
      else if (error === 'error_max_turns') push({ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0 });
      else if (t.status === 'interrupted' && signal.aborted) push({ type: 'result', subtype: 'error_during_execution', errors: ['任務已取消'], total_cost_usd: 0 });
      else push({ type: 'result', subtype: 'error_during_execution', errors: [t.error?.message || error || t.status], total_cost_usd: 0 });
      finish();
    }
  };
  const onAbort = () => { if (turnId) srv.request('turn/interrupt', { threadId, turnId }).catch(() => {}); setTimeout(() => srv.kill(), 3000); };
  signal.addEventListener('abort', onAbort);
  srv.closed.then(finish);
  try {
    await srv.init();
    const pol = policyOf(options.mode);
    const common = { cwd: options.cwd, model: options.model || null, developerInstructions: options.developerInstructions || null, ...pol };
    let th = null;
    if (options.resume) th = await srv.request('thread/resume', { threadId: options.resume, ...common, excludeTurns: true }).catch(() => null); // 找不到舊對話就開新的
    if (!th) th = await srv.request('thread/start', common);
    threadId = th.thread.id;
    push({ type: 'system', subtype: 'init', model: th.model });
    const turn = await srv.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
    turnId = turn?.turn?.id || null;
    while (true) {
      while (queue.length) yield queue.shift();
      if (finished) break;
      await new Promise(r => { wake = r; });
    }
    while (queue.length) yield queue.shift();
    if (signal.aborted) throw new Error('任務已取消');
  } finally {
    signal.removeEventListener('abort', onAbort);
    srv.kill();
  }
}

/* ---------- 登入 ---------- */
// 查目前的登入狀態：{ ok, type, email, plan }
export async function codexAccount(exe, env) {
  const srv = new AppServer(exe, { env, cwd: os.homedir() });
  const tm = setTimeout(() => srv.kill(), 20000);
  try {
    await srv.init();
    const r = await srv.request('account/read', { refreshToken: false });
    const a = r?.account;
    return a ? { ok: true, type: a.type, email: a.email || '', plan: a.planType || '' } : { ok: false, type: '' };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
  finally { clearTimeout(tm); srv.kill(); }
}
// 用 API 金鑰登入（寫進這個 CODEX_HOME 的登入檔）
export async function codexApiKeyLogin(exe, env, apiKey) {
  const srv = new AppServer(exe, { env, cwd: os.homedir() });
  const tm = setTimeout(() => srv.kill(), 20000);
  try { await srv.init(); await srv.request('account/login/start', { type: 'apiKey', apiKey }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e).slice(0, 300) }; }
  finally { clearTimeout(tm); srv.kill(); }
}
// 用 ChatGPT 帳號登入：回傳登入網址，使用者在瀏覽器登入後 done 會完成。
// device=true 用裝置代碼（給打不開本機回呼網址的情況）
export async function codexChatgptLogin(exe, env, { device = false, timeoutMs = 15 * 60e3 } = {}) {
  const srv = new AppServer(exe, { env, cwd: os.homedir() });
  await srv.init();
  let settle; const done = new Promise(r => { settle = r; });
  srv.onNotify = (m, p) => { if (m === 'account/login/completed') settle(p.success ? { ok: true } : { ok: false, error: p.error || '登入沒有完成' }); };
  srv.closed.then(() => settle({ ok: false, error: '登入程序結束了' }));
  const r = await srv.request('account/login/start', device ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' });
  const tm = setTimeout(() => settle({ ok: false, error: '等太久了，請再試一次' }), timeoutMs);
  const finished = done.then(async res => { clearTimeout(tm); if (res.ok) Object.assign(res, await codexAccountOn(srv)); srv.kill(); return res; });
  return { url: r.authUrl || r.verificationUrl, code: r.userCode || '', loginId: r.loginId, done: finished, cancel: () => { srv.request('account/login/cancel', { loginId: r.loginId }).catch(() => {}); settle({ ok: false, error: '已取消' }); } };
}
async function codexAccountOn(srv) {
  try { const a = (await srv.request('account/read', { refreshToken: false }))?.account; return a ? { type: a.type, email: a.email || '', plan: a.planType || '' } : {}; } catch { return {}; }
}
