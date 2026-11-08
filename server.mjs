// AI 團隊大樓（Codex 版）：本機橋接伺服器
// 在背景驅動本機的官方 Codex，把工作流程（需求 → 部門方案 → 主管審核 → 執行 → 報告）接到 3D 大樓介面。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { snapshot, backupRoot, backupDirOf } from './lib/backup.mjs';
import { isReadOnlyCommand } from './lib/readonly.mjs';
import { browserConfig, browserUp, ensureBrowser } from './lib/towerBrowser.mjs';
import { createPageShot } from './lib/pageShot.mjs';
import { findCodex, codexQuery, codexAccount, codexApiKeyLogin, codexChatgptLogin } from './lib/codex.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.TOWER_CONFIG ? path.resolve(process.env.TOWER_CONFIG) : path.join(ROOT, 'tower.config.json');
const CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const PORT = +process.env.TOWER_PORT || CFG.port || 7778;
const PUBLIC = path.join(ROOT, 'public');

const MOCK = process.argv.includes('--mock');

/* ---------- 登入方式：ChatGPT 帳號或 OpenAI API 金鑰（可在大樓工具列切換） ---------- */
// 選擇與金鑰只存在本機的 .tower-local.json（已列在 .gitignore），不會進版本控制
const LOCAL_FILE = path.join(ROOT, '.tower-local.json');
let LOCAL = {}; try { LOCAL = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')) || {}; } catch {}
const AUTH_MODES = ['subscription', 'api'];
const AUTH_LABEL = { subscription: 'ChatGPT 登入', api: 'API 金鑰' };
const authMode = () => AUTH_MODES.includes(LOCAL.auth) ? LOCAL.auth : AUTH_MODES.includes(CFG.auth) ? CFG.auth : 'subscription';
const apiKey = () => LOCAL.apiKey || process.env.OPENAI_API_KEY || '';
const KEY_RE = /^sk-[\w-]{20,}$/;
function authInfo() { const k = apiKey(); return { auth: authMode(), chosen: !!LOCAL.auth, apiKeySet: !!k, apiKeySource: LOCAL.apiKey ? 'local' : process.env.OPENAI_API_KEY ? 'env' : '', apiKeyHint: k ? '…' + k.slice(-4) : '', login: loginJob ? { url: loginJob.url, code: loginJob.code, status: loginJob.status, error: loginJob.error || '' } : null }; }
function saveLocal() { fs.writeFileSync(LOCAL_FILE, JSON.stringify(LOCAL, null, 1)); }
// 給 Codex 的環境變數：ChatGPT 登入用這台電腦上 Codex 的登入（~/.codex，跟 Codex 桌面版共用）；
// API 金鑰模式用大樓自己的 Codex 資料夾（.tower-codex-api/），免得蓋掉你 Codex 的 ChatGPT 登入
const API_HOME = path.join(ROOT, '.tower-codex-api');
function authEnv(mode = authMode()) {
  const env = { ...process.env };
  if (mode === 'api') {
    if (!apiKey()) throw new Error('登入方式是「API 金鑰」，但還沒設定金鑰。請在工具列的「登入」填入金鑰，或改用 ChatGPT 登入。');
    env.CODEX_HOME = API_HOME;
  }
  return env;
}
// API 金鑰模式：金鑰換了（或第一次用）就先登入大樓自己的 Codex 資料夾
const keyTag = k => crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);
async function prepareAuth() {
  if (MOCK || authMode() !== 'api') return;
  const k = apiKey(), tag = keyTag(k || '');
  if (LOCAL.apiHomeKey === tag && fs.existsSync(path.join(API_HOME, 'auth.json'))) return;
  fs.mkdirSync(API_HOME, { recursive: true });
  const r = await codexApiKeyLogin(CODEX_PATH, authEnv('api'), k);
  if (!r.ok) throw new Error('用 API 金鑰登入 Codex 失敗：' + r.error);
  LOCAL.apiHomeKey = tag; saveLocal();
}
// 用 ChatGPT 帳號登入：大樓在背景請 Codex 開登入頁，使用者在瀏覽器登入後自動完成
let loginJob = null;
async function startChatgptLogin(device) {
  if (loginJob?.status === 'waiting') loginJob.cancel();
  const env = { ...process.env };
  const r = await codexChatgptLogin(CODEX_PATH, env, { device });
  const job = loginJob = { url: r.url, code: r.code, status: 'waiting', cancel: r.cancel };
  r.done.then(res => {
    if (loginJob !== job) return;
    job.status = res.ok ? 'done' : 'error'; job.error = res.error || '';
    if (res.ok) { LOCAL.auth = 'subscription'; saveLocal(); console.log(`已用 ChatGPT 登入${res.email ? '：' + res.email : ''}`); }
    emit('auth', authInfo());
    setTimeout(() => { if (loginJob === job) { loginJob = null; emit('auth', authInfo()); } }, 60e3);
  });
  return job;
}
// 大樓只驅動使用者自己電腦上的官方 Codex（用他自己的登入）；--mock 是不呼叫 Codex 的模擬模式
const ENGINE = MOCK ? 'mock' : 'codex';
let engineError = '';
let query = null;  // 依引擎決定，見下方

// 模擬模式：不呼叫 Codex，用假資料走完整個流程，方便測試介面
const MOCK_DESIGN = '```json\n' + JSON.stringify({
  summary: '（模擬）依需求設計了企劃、內容、工程、品管四個部門，由總管統籌。',
  pm: { name: '總管', description: '拆解需求、安排部門、彙整報告', prompt: '你是這個專案的總管（模擬）。', handbook: '# 00 總管手冊\n\n## 負責範圍\n- 拆解需求、安排先後順序。' },
  departments: [
    { id: 'planning', name: '企劃部', line: '製作線', members: 2, style: 'board', icon: 'target', description: '規劃需求與優先順序', prompt: '你是企劃部的企劃（模擬）。', handbook: '# 01 企劃部手冊\n\n## 負責範圍\n- 規劃需求。' },
    { id: 'content', name: '內容部', line: '製作線', members: 2, style: 'research', icon: 'book', description: '撰寫文案與內容', prompt: '你是內容部的編輯（模擬）。', handbook: '# 02 內容部手冊\n\n## 負責範圍\n- 撰寫內容。' },
    { id: 'engineering', name: '工程部', line: '製作線', members: 3, style: 'dev', icon: 'code', description: '實作功能', prompt: '你是工程部的工程師（模擬）。', handbook: '# 03 工程部手冊\n\n## 負責範圍\n- 實作功能。' },
    { id: 'qa', name: '品管部', line: '製作線', members: 2, style: 'test', icon: 'check', description: '驗收與測試', prompt: '你是品管部的測試員（模擬）。', handbook: '# 04 品管部手冊\n\n## 負責範圍\n- 驗收。' },
  ],
  plan: '# 公司計畫書（模擬）\n\n## 年度目標\n- 完成第一版。',
}) + '\n```';
async function* mockQuery({ prompt, options }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sid = options.resume || 'mock-' + crypto.randomUUID();
  const planning = options.permissionMode === 'default';
  yield { type: 'system', subtype: 'init', session_id: sid };
  const cwd = options.cwd;
  const steps = planning
    ? [['Glob', { pattern: '**/*' }], ['Read', { file_path: cwd + '/README.md' }], ['Grep', { pattern: 'TODO' }]]
    : [['Read', { file_path: cwd + '/README.md' }], ['WebFetch', { url: 'https://developer.mozilla.org/zh-TW/docs/Web/HTML' }], ['Write', { file_path: cwd + '/index.html' }], ['Edit', { file_path: cwd + '/style.css' }], ['Bash', { command: 'npx serve -l 5000 --no-clipboard', description: '啟動預覽' }], ['Edit', { file_path: cwd + '/index.html' }]];
  for (const [i, [name, input]] of steps.entries()) {
    await sleep(1200 + Math.random() * 800 + (steps[i - 1]?.[0] === 'WebFetch' ? 8000 : 0));
    if (options.abortController.signal.aborted) throw new Error('任務已取消');
    if (name === 'Bash') { const d = await options.canUseTool(name, input, { signal: options.abortController.signal }); if (d.behavior !== 'allow') { yield { type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: '指令被拒絕，改用其他方式驗證。' }] } }; continue; } }
    yield { type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: '接著' + ({ Glob: '看一下專案有哪些檔案', Read: '讀取說明文件', Grep: '搜尋待辦標記', Write: '建立頁面', Edit: '調整內容', Bash: '啟動預覽確認畫面', WebFetch: '看參考網站' }[name] || '處理') + '。' }, { type: 'tool_use', id: crypto.randomUUID(), name, input }] } };
    yield { type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', content: name === 'Read' ? '# 示範專案\n這是測試用的專案資料夾。' : name === 'Glob' ? 'README.md' : '完成', is_error: false }] } };
  }
  let result;
  if (/【設計大樓】/.test(prompt)) result = MOCK_DESIGN;
  else if (/【方案提問】/.test(prompt)) result = '（模擬）會這樣規劃是因為專案裡已經有 `index.html` 與 `style.css`，直接沿用比較省工。\n\n- 依據：`README.md` 的專案說明\n- 設計部的配色還沒定，所以先用樣式變數保留彈性\n\n建議：如果你希望拆成多頁，可以叫我修改方案，把「會新增或修改的檔案」改成多個頁面。';
  else if (/【目標提問】/.test(prompt)) result = '（模擬）這樣設定是因為計畫書第 3 節把**上線前**的人力放在設計與開發，所以先排這兩個部門。\n\n- 依據：`docs/company-plan.md` 導入時程\n- 推廣相關的目標等到第二階段才啟動\n\n建議：如果你想提早做行銷，可以叫我把行銷部的 Q1 目標往前移。';
  else if (/【目標調整】|【目標規劃】/.test(prompt)) {
    const m = prompt.match(/```json\n([\s\S]*?)\n```/);
    let base = { goals: [{ id: 'g1', level: 'year', period: '2027', dept: 'company', title: '模擬年度目標', metric: '營收', target: '100 萬', due: '2027-10-31', parent: null, automation: '人' }], schedule: [{ id: 's1', title: '模擬里程碑', dept: 'company', start: '2026-12-01', end: '2026-12-01', kind: 'milestone' }] };
    let changes = [], reply = '已從計畫書拆出模擬目標。';
    if (/【目標調整】/.test(prompt) && m) {
      try { base = JSON.parse(m[1]); } catch {}
      const ask = (prompt.match(/主管這次說：\n"{3}\n([\s\S]*?)\n"{3}/) || [])[1] || '';
      if (/\?|？|嗎/.test(ask)) reply = '（模擬）這是問題，不需要調整目標。';
      else {
        const g0 = base.goals[0]; if (g0) { g0.title += '（已調整）'; changes.push('修改 ' + g0.id + '：標題加上「已調整」'); }
        base.goals.push({ id: 'g' + (base.goals.length + 10), level: 'month', period: '2026-11', dept: 'company', title: '（模擬）依主管意見新增：' + ask.slice(0, 20), metric: '', target: '', due: '2026-11-30', parent: g0?.id || null, automation: '核可' });
        changes.push('新增 月目標「依主管意見新增」');
        if (base.goals.length > 3) { const rm = base.goals.splice(1, 1)[0]; changes.push('刪除 ' + rm.id + '「' + rm.title + '」'); }
        reply = '（模擬）已依你的意見調整：改了 1 個、新增 1 個目標。';
      }
    }
    result = '```json\n' + JSON.stringify({ reply, summary: '模擬拆解。', changes, goals: base.goals, schedule: base.schedule }) + '\n```';
  } else if (/只回傳一個 JSON/.test(prompt)) {
    const follow = /追加了需求/.test(prompt);
    result = '```json\n' + JSON.stringify(follow
      ? { title: '追加調整', summary: '主管追加的需求只影響畫面與功能，由設計部調整版面、開發部實作。', stages: [['design'], ['dev']], assignments: { design: '依追加需求調整版面設計', dev: '實作追加的功能' } }
      : { title: '團隊介紹網站', summary: '先研究同類網站與內容結構，同時由設計部定版面風格；開發部實作一頁式網站；最後測試部驗證連結、響應式與表單。', stages: [['research', 'design'], ['dev'], ['test']], assignments: { research: '整理同類網站的內容結構與文案建議', design: '定出配色、字體與各區塊版面', dev: '用 HTML/CSS 實作一頁式網站', test: '檢查各裝置版面、連結與表單驗證' } }) + '\n```';
  } else if (/總報告/.test(prompt)) result = '## 需求達成狀況\n- 一頁式網站已完成，包含簡介、作品集與聯絡表單。\n\n## 各部門重點\n- 研究部整理了 3 個參考網站的內容結構。\n- 設計部定出暖白色系與版面規範。\n- 開發部完成 index.html 與 style.css。\n- 測試部驗證手機與桌機版面。\n\n## 風險與待辦\n- 聯絡表單尚未接後端。\n\n## 建議的下一步\n- 接上表單服務，並補上作品集圖片。';
  else if (planning) result = '## 目標\n- 完成這個部門負責的部分。\n\n## 做法與步驟\n1. 閱讀專案現況\n2. 依分工完成交付物\n3. 自我檢查\n\n## 會新增或修改的檔案\n- `index.html`\n- `style.css`\n\n## 交付物\n- 可直接開啟的頁面\n\n## 風險與待確認事項\n- 作品集圖片需要主管提供。\n\n## 需要其他部門配合\n- 需要設計部確認配色。';
  else result = '## 完成項目\n- 依核准方案完成工作。\n\n## 修改與新增的檔案\n- `index.html`\n- `style.css`\n\n## 驗證方式與結果\n- 在桌機與手機尺寸開啟，版面正常。\n\n## 未完成或待確認\n- 表單送出尚未接後端。\n\n## 給下一個部門或主管的建議\n- 測試時請特別注意表單驗證。';
  yield { type: 'result', subtype: 'success', result, total_cost_usd: 0, session_id: sid };
}

/* ---------- 找到可用的 Codex 執行檔（Codex 桌面版內建，或 npm 安裝的 @openai/codex） ---------- */
const CODEX_PATH = findCodex();
if (ENGINE === 'mock') query = mockQuery;
else if (CODEX_PATH) query = args => codexQuery(args, CODEX_PATH);
else engineError = '找不到 Codex。請安裝 Codex 桌面版，或執行 npm install -g @openai/codex，也可以在環境變數 CODEX_PATH 指定 codex 執行檔。';

// 開一個看得到的視窗跑指令：Windows 用命令提示字元、Mac 用「終端機」，其他系統在背景跑
function runInWindow(title, cmd, cwd) {
  if (process.platform === 'win32') return spawn(`start "${title}" cmd /k ${cmd}`, { cwd, shell: true, detached: true, stdio: 'ignore', windowsHide: false }).unref();
  if (process.platform === 'darwin') {
    const sh = `cd '${cwd.replace(/'/g, `'\\''`)}' && ${cmd}`;
    const as = sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return spawn('osascript', ['-e', `tell application "Terminal" to do script "${as}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  }
  spawn(cmd, { cwd, shell: true, detached: true, stdio: 'ignore' }).unref();
}
// 用系統的檔案管理員打開（Windows 檔案總管、Mac Finder）
const openInFiles = f => spawn(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [f], { detached: true, stdio: 'ignore' }).unref();

/* ---------- 部門設定 ---------- */
const DEPTS = {
  research: { name: '研究部', role: '研究員', brief: '調查需求背景、現有程式碼與外部資料，整理結論與建議，必要時把研究筆記寫到 docs/research/。' },
  design: { name: '設計部', role: '設計師', brief: '負責介面、使用流程與視覺規範，可撰寫設計文件（docs/design/）並調整樣式與版面相關檔案。' },
  dev: { name: '開發部', role: '工程師', brief: '依核准方案實作功能，維持程式碼整潔，必要時補充說明文件。' },
  test: { name: '測試部', role: '測試工程師', brief: '撰寫並執行測試、逐項驗證需求是否達成、回報缺陷與風險。' },
};
const DEPT_KEYS = Object.keys(DEPTS);
// 每棟大樓可以有自己的部門（例如沿用專案裡 .codex/agents 或 .claude/agents 的角色設定）
const deptsOf = b => b.deptMap || DEPTS;
function readAgent(b, rel) {
  try {
    const raw = fs.readFileSync(path.resolve(b.dir, rel), 'utf8');
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    const desc = m && (m[1].match(/^description:\s*(.*)$/m) || [])[1];
    return { body: (m ? m[2] : raw).trim(), desc: desc || '' };
  } catch { return null; }
}
const TOWER_RULES = `
在「AI 團隊大樓」裡工作的規則：
- 方案與報告一律用繁體中文、Markdown，具體到檔案名稱。
- 只在目前的專案資料夾內工作，不要修改資料夾外的檔案。
- 不要替其他部門做他們的工作；需要配合時寫在方案或報告裡。
- 規劃階段只能閱讀與研究；方案經主管核准後才動手。
- 讀檔、找檔、搜尋內容用只讀的終端機指令（例如 Get-Content、Get-ChildItem、Select-String、rg、git log），這些會自動放行；改檔案用內建的修改功能（apply_patch），不要用指令寫檔。會寫入或修改的終端機指令要主管批准。`;
const PERM_MODES = ['auto', 'manual', 'acceptEdits', 'bypassPermissions'];
const PERM_LABEL = { auto: '自動', manual: '手動', acceptEdits: '接受編輯', bypassPermissions: '略過權限確認' };
function permOf(b) { const m = apState(b).permMode; return PERM_MODES.includes(m) ? m : 'acceptEdits'; }
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Delete'];
const AUTO_ALLOW = [...READ_TOOLS, ...WRITE_TOOLS];
const NEVER = ['Agent', 'Task', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'];

function deptSystem(b, dept) {
  const d = deptsOf(b)[dept];
  if (d && d.agentFile) { const ag = readAgent(b, d.agentFile); if (ag) return ag.body + '\n' + TOWER_RULES + deptExtra(b, dept); }
  return `你是「AI 團隊大樓」裡${d.name}的${d.role}。${d.brief}
工作規則：
- 一律使用繁體中文撰寫方案與報告。
- 只在目前的專案資料夾內工作，不要修改資料夾外的檔案。
- 不要替其他部門做他們的工作；需要其他部門配合時，寫在方案或報告裡。
- 方案與報告用 Markdown，條理清楚、具體到檔案名稱。` + deptExtra(b, dept);
}

/* ---------- 資料存取 ---------- */
function normBuilding(b) {
  const o = { ...b, dir: path.resolve(ROOT, b.projectDir) };
  if (Array.isArray(b.departments)) o.deptMap = Object.fromEntries(b.departments.map(d => [d.id, d]));
  return o;
}
const buildings = (CFG.buildings || []).map(normBuilding);
// 正在由 Codex 設計、還沒正式加入的大樓（讓設計那一輪有地方放對話紀錄）
const draftBuildings = new Map();
const bldOf = id => buildings.find(x => x.id === id) || draftBuildings.get(id);
const tasks = new Map();        // taskId -> task
const runtime = new Map();      // taskId -> { abort: AbortController }
const approvals = new Map();    // approvalId -> { ...info, resolve }

// Codex 版的任務、方案、報告放在 .tower-codex/，跟 Claude 版的 .tower/ 分開，兩版管同一個專案也不會互相蓋掉
function towerDir(b) { return path.join(b.dir, '.tower-codex'); }
async function loadTasks() {
  for (const b of buildings) {
    await fsp.mkdir(towerDir(b), { recursive: true });
    const f = path.join(towerDir(b), 'tasks.json');
    if (!fs.existsSync(f)) continue;
    const list = JSON.parse(await fsp.readFile(f, 'utf8'));
    for (const t of list) {
      for (const r of t.rounds) for (const d of Object.values(r.depts)) {
        if (d.asking) { d.asking = false; if (d.qa?.at(-1)?.role === 'user') d.qa.push({ role: 'sys', text: '伺服器重新啟動，這個問題沒有回答到，可以再問一次', at: Date.now() }); }
        if (['planning', 'running', 'reporting'].includes(d.status)) { d.status = 'error'; d.error = '伺服器重新啟動，這一步被中斷了，可以按「重試」。'; }
      }
      if (['planning', 'running', 'summarizing'].includes(t.status)) t.status = 'attention';
      tasks.set(t.id, t);
    }
  }
}
const saveTimers = new Map();
function save(t) {
  const b = buildings.find(x => x.id === t.building);
  clearTimeout(saveTimers.get(b.id));
  saveTimers.set(b.id, setTimeout(async () => {
    const list = [...tasks.values()].filter(x => x.building === b.id);
    await fsp.mkdir(towerDir(b), { recursive: true });
    await fsp.writeFile(path.join(towerDir(b), 'tasks.json'), JSON.stringify(list, null, 1));
  }, 300));
}
async function writeDoc(t, name, text) {
  const b = buildings.find(x => x.id === t.building);
  const dir = path.join(towerDir(b), 'tasks', t.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, name), text);
  return path.relative(b.dir, path.join(dir, name)).replace(/\\/g, '/');
}

/* ---------- 即時事件（SSE） ---------- */
const clients = new Map(); // res -> { ext }
/* ---------- 對外展示模式（Cloudflare 臨時入口） ---------- */
// 從外面連進來的（不是 localhost）一律唯讀、要帶分享金鑰，而且只看得到開放展示的大樓
const SHARE_FILE = path.join(ROOT, '.share-token');
const SHARE_TOKEN = (() => { try { const t = fs.readFileSync(SHARE_FILE, 'utf8').trim(); if (t) return t; } catch {} const t = crypto.randomBytes(12).toString('base64url'); try { fs.writeFileSync(SHARE_FILE, t); } catch {} return t; })();
const SHARE_BUILDINGS = () => CFG.shareBuildings || [];
const isExternal = req => !!req.headers['cf-connecting-ip'] || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
function taskBuilding(id) {
  const t = tasks.get(id); if (t) return t.building;
  const b = buildings.find(x => fs.existsSync(path.join(towerDir(x), 'tasks', String(id).replace(/[^\w-]/g, ''))));
  return b?.id || null;
}
function shareAllows(type, data) {
  if (type === 'approval_done' || type === 'state') return true;
  const bid = data?.building || (data?.taskId ? taskBuilding(data.taskId) : null);
  return !!bid && SHARE_BUILDINGS().includes(bid);
}
function emit(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, c] of clients) { if (c.ext && !shareAllows(type, data)) continue; res.write(line); }
}
function pushTask(t) { save(t); emit('task', t); if (t.goalId) { const b = buildings.find(x => x.id === t.building); if (b) emit('goals', { building: b.id, goals: goalsView(b) }); } }

/* ---------- 共用：執行一次 Codex（函式名稱沿用 runClaude，跟開源版對得上） ---------- */
function toolSummary(name, input = {}) {
  const base = p => String(p || '').split(/[\\/]/).pop();
  if (input.file_path) return `${name} ${base(input.file_path)}`;
  if (input.notebook_path) return `${name} ${base(input.notebook_path)}`;
  if (name === 'Bash' || name === 'PowerShell') return `${name}: ${String(input.command || '').slice(0, 80)}`;
  if (name === 'Grep') return `Grep "${String(input.pattern || '').slice(0, 40)}"`;
  if (name === 'Glob') return `Glob ${String(input.pattern || '').slice(0, 40)}`;
  if (name === 'WebSearch') return `WebSearch: ${String(input.query || '').slice(0, 60)}`;
  if (name === 'WebFetch') { PAGESHOT.allow(input.url); return `WebFetch: ${String(input.url || '').slice(0, 60)}`; }
  if (name === 'TodoWrite') return '更新待辦清單';
  return name;
}

// 不管成功或失敗，都要通知畫面「這個人停下來了」，否則他會一直顯示工作中
const BACKUP_ROOT = backupRoot(CFG, ROOT);
async function backupRun(args, when) {
  const b = buildings.find(x => x.id === args.t.building); if (!b || args.mode === 'plan' || CFG.backup === false) return;
  try {
    const r = await snapshot(b, BACKUP_ROOT, `${when}｜${args.t.title || args.t.id}｜${args.dept || 'pm'}｜${new Date().toLocaleString('zh-TW', { hour12: false })}`);
    if (r.changed) console.log(`備份 ${b.id} ${when}：${r.id}（${r.changed} 個檔案，${r.ms}ms）`);
  } catch (e) { console.log(`備份失敗 ${b.id}：${e.message}`); emit('notice', { building: b.id, text: '備份失敗：' + e.message.slice(0, 120) }); }
}
async function runClaude(args) {
  await backupRun(args, '執行前');
  try { const out = await runClaudeInner(args); await backupRun(args, '執行後'); return out; }
  catch (e) { emit('activity', { building: args.t.building, taskId: args.t.id, dept: args.dept || 'pm', kind: 'end', summary: '中斷：' + String(e.message || e).slice(0, 60) }); await backupRun(args, '執行後（中斷）'); throw e; }
}
async function runClaudeInner({ t, dept, prompt, mode, resume, phaseName = '', label, model, browser, system }) {
  if (!query) throw new Error(engineError);
  const b = bldOf(t.building);
  const rt = runtime.get(t.id) || { abort: new AbortController() };
  runtime.set(t.id, rt);
  const who = dept || 'pm';
  const planning = mode === 'plan';
  const canUseTool = async (toolName, input, opts) => {
    if (planning) return { behavior: 'deny', message: '現在是規劃階段，只能閱讀與研究，不能修改檔案或執行指令。' };
    if (NEVER.includes(toolName)) return { behavior: 'deny', message: '這個工具在大樓裡不可使用。' };
    if (browser && toolName.startsWith('mcp__browser__')) return { behavior: 'allow', updatedInput: input }; // 安全限制寫在 browser-mcp 裡
    // 改專案資料夾裡的檔案：除了「手動」模式，都自動放行（跟 Claude 版一樣）
    if (WRITE_TOOLS.includes(toolName) && permOf(b) !== 'manual' && inDir(b.dir, input?.file_path) && (input.changes || []).every(c => inDir(b.dir, String(c).replace(/^\S+\s+/, '')))) return { behavior: 'allow', updatedInput: input };
    // 只讀的終端機指令（列檔案、搜尋、看內容、看 git 紀錄）自動放行；會寫入或修改的照樣要主管批准
    if ((toolName === 'Bash' || toolName === 'PowerShell') && isReadOnlyCommand(toolName, input?.command)) return { behavior: 'allow', updatedInput: input };
    // 其餘工具（主要是 Bash）交給主管在大樓裡批准
    const id = crypto.randomUUID();
    const info = { id, taskId: t.id, building: t.building, dept: who, tool: toolName, summary: toolSummary(toolName, input), input: (toolName === 'Bash' || toolName === 'PowerShell') ? { command: input.command, description: input.description } : input, createdAt: Date.now() };
    emit('approval', info);
    const decision = await new Promise(resolve => {
      approvals.set(id, { ...info, resolve });
      opts?.signal?.addEventListener('abort', () => resolve({ allow: false, message: '任務已取消' }));
      // 自動排程：主管可能不在線，等 10 分鐘沒人批准就先拒絕，讓工作繼續
      if (t.auto) setTimeout(() => resolve({ allow: false, message: '主管不在線（自動排程），這個指令先不執行。請改用其他做法；真的需要的話，寫進待核可清單讓主管決定。' }), 10 * 60e3);
    });
    approvals.delete(id);
    emit('approval_done', { id, allow: decision.allow });
    return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.message || '主管拒絕了這個動作，請改用其他做法，或在報告中說明。' };
  };
  const options = {
    cwd: b.dir,
    abortController: rt.abort,
    maxTurns: planning ? (CFG.maxTurnsPlan || 25) : (CFG.maxTurnsRun || 80),
    mode: planning ? 'plan' : permOf(b),
    permissionMode: planning ? 'default' : permOf(b), // 模擬模式用
    canUseTool,
    developerInstructions: system || (dept ? deptSystem(b, dept) : pmSystem(b, !!t.auto)),
  };
  // 大樓專用瀏覽器（只有需要讀／發 Threads、ChatGPT 網頁的例行工作才會掛上）
  if (browser?.length && !planning) { options.mcp = { browser: { command: process.execPath, args: [path.join(ROOT, 'lib', 'browser-mcp.mjs')], env: { TOWER_BROWSER_PORT: String(BROWSER.port), TOWER_BROWSER_ALLOW: browser.join(','), TOWER_PROJECT_DIR: b.dir } } }; options.trustedMcp = ['browser']; }
  const useModel = codexModel(model || CFG.model || null);
  if (useModel) options.model = useModel;
  if (ENGINE !== 'mock') { await prepareAuth(); options.env = authEnv(); } // 依登入方式決定用哪個 Codex 資料夾
  if (resume) options.resume = resume;

  let sessionId = resume || null, text = '', cost = 0, files = new Set(), lastText = '';
  emit('activity', { building: t.building, taskId: t.id, dept: who, kind: 'start', mode, summary: label?.[0] || (planning ? '開始規劃' : '開始執行') });
  const rn = t.rounds.length;
  conv(t, rn, who, { role: 'phase', text: phaseName + (useModel ? `（模型：${useModel}${planning ? '' : '，權限：' + PERM_LABEL[permOf(b)]}）` : '') });
  conv(t, rn, who, { role: 'user', text: prompt });
  for await (const msg of query({ prompt, options })) {
    if (msg.session_id) sessionId = msg.session_id;
    if (msg.type === 'assistant') {
      for (const blk of msg.message?.content || []) {
        if (blk.type === 'tool_use') {
          conv(t, rn, who, { role: 'tool', name: blk.name, summary: toolSummary(blk.name, blk.input), input: clip(JSON.stringify(blk.input, null, 1), 2000) });
          if (WRITE_TOOLS.includes(blk.name) && blk.input?.file_path) files.add(path.relative(b.dir, blk.input.file_path).replace(/\\/g, '/'));
          const ev = { building: t.building, taskId: t.id, dept: who, kind: 'tool', tool: blk.name, summary: toolSummary(blk.name, blk.input), at: Date.now() };
          emit('activity', ev);
          logTo(t, who, ev.summary);
        } else if (blk.type === 'text' && blk.text?.trim()) {
          lastText = blk.text.trim();
          conv(t, rn, who, { role: 'assistant', text: lastText });
          emit('activity', { building: t.building, taskId: t.id, dept: who, kind: 'text', summary: lastText.slice(0, 120), at: Date.now() });
        }
      }
    } else if (msg.type === 'user') {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const blk of content) if (blk.type === 'tool_result') {
        const out = Array.isArray(blk.content) ? blk.content.map(c => c.text || '').join('\n') : String(blk.content ?? '');
        conv(t, rn, who, { role: 'result', error: !!blk.is_error, text: clip(out, 2500) });
      }
    } else if (msg.type === 'result') {
      cost = msg.total_cost_usd || 0;
      if (msg.subtype === 'success') text = msg.result || lastText;
      else throw new Error(({ error_max_turns: '超過回合上限', error_max_budget_usd: '超過預算上限', error_during_execution: '執行時發生錯誤' }[msg.subtype] || msg.subtype) + (msg.errors ? '：' + JSON.stringify(msg.errors).slice(0, 300) : ''));
    }
  }
  t.cost = (t.cost || 0) + cost;
  emit('activity', { building: t.building, taskId: t.id, dept: who, kind: 'end', summary: label?.[1] || (planning ? '方案完成' : '執行完成') });
  return { text: text || lastText, sessionId, cost, files: [...files] };
}
const inDir = (dir, f) => { if (!f) return false; const r = path.relative(dir, path.resolve(dir, String(f))); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n…（還有 ${s.length - n} 字）` : s || '');
function convFile(t, rn, who) { const b = bldOf(t.building); return path.join(towerDir(b), 'tasks', t.id, `r${rn}-${who}-對話.jsonl`); }
function conv(t, rn, who, entry) {
  entry.at = Date.now();
  const f = convFile(t, rn, who);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(entry) + '\n');
  emit('conv', { taskId: t.id, round: rn, dept: who, entry });
}
function logTo(t, who, line) {
  const r = t.rounds[t.rounds.length - 1];
  const d = r.depts[who];
  if (d) { d.log = d.log || []; d.log.push({ at: Date.now(), text: line }); if (d.log.length > 200) d.log.shift(); }
}

/* ---------- PM：拆解需求 ---------- */
const PM_SYSTEM = `你是「AI 團隊大樓」的專案經理（PM）。你負責把主管的需求拆給研究部（research）、設計部（design）、開發部（dev）、測試部（test），並安排先後順序。你自己不寫程式、不改檔案。一律使用繁體中文。`;

function pmSystem(b, auto) {
  if (auto && b.pm?.agentFile) { const ag = readAgent(b, b.pm.agentFile); if (ag) return ag.body + `\n\n你在大樓裡負責例行工作：照你的手冊做完這次的例行工作，可以讀寫手冊允許的檔案。` + TOWER_RULES + pmExtra(b); }
  if (b.pm?.agentFile) { const ag = readAgent(b, b.pm.agentFile); if (ag) return ag.body + `\n\n你在大樓裡擔任 PM：負責把主管的需求拆給各部門並安排先後順序。你自己不寫程式、不改檔案。` + TOWER_RULES; }
  return PM_SYSTEM;
}
function deptCatalog(b) {
  const ds = deptsOf(b);
  return Object.entries(ds).map(([k, d]) => { const ag = d.agentFile ? readAgent(b, d.agentFile) : null; return `- ${k}：${d.name}${ag?.desc ? '。' + ag.desc : d.brief ? '。' + d.brief : ''}`; }).join('\n');
}
function extractJson(s) {
  const m = s.match(/```json\s*([\s\S]*?)```/) || s.match(/(\{[\s\S]*\})/);
  if (!m) throw new Error('PM 沒有回傳可解析的分工 JSON');
  return JSON.parse(m[1]);
}
function history(t) {
  return t.rounds.slice(0, -1).map(r => `### 第 ${r.n} 輪需求\n${r.text}\n${r.summary ? '#### 總報告摘要\n' + r.summary.slice(0, 2500) : ''}`).join('\n\n');
}

async function pmPlan(t) {
  const r = t.rounds[t.rounds.length - 1], b = buildings.find(x => x.id === t.building), KEYS = Object.keys(deptsOf(b));
  t.status = 'planning'; r.status = 'planning'; pushTask(t);
  const prev = history(t);
  const prompt = `${prev ? '以下是這個任務之前的紀錄：\n' + prev + '\n\n---\n主管現在追加了需求，請只安排受影響的部門。\n' : ''}主管的需求：
"""
${r.text}
"""

請先快速瀏覽專案資料夾了解現況，再決定分工。只回傳一個 JSON（放在 \`\`\`json 區塊中），格式：
{
  "title": "任務名稱（15 字內）",
  "summary": "你對需求的理解與整體做法（3~5 句）",
  "stages": [["部門代號A","部門代號B"],["部門代號C"]],
  "assignments": { "部門代號A": "這個部門要做什麼、交付什麼", "部門代號B": "..." },
  "levels": { "部門代號A": "light|standard|heavy", "部門代號B": "..." }
}
可用的部門（代號：說明）：
${deptCatalog(b)}

規則：stages 是執行順序，同一組可以同時進行；只派真正需要的部門，不需要的不要放進 stages 與 assignments；部門代號只能用上面列出的代號。
levels 是每個部門這次工作的難易度，決定執行時用哪個模型（越難越貴，請省著用）：light＝照做即可、整理資料、小修改；standard＝一般工作（多數情況）；heavy＝需要複雜推理或大量程式，例如新功能開發、架構設計、困難除錯。`;
  try {
    const out = await runClaude({ t, dept: null, prompt, mode: 'plan', resume: t.pmSession, phaseName: r.n > 1 ? 'PM 安排追加需求' : 'PM 分工', model: MODELS.plan });
    t.pmSession = out.sessionId;
    const j = extractJson(out.text);
    const stages = (j.stages || []).map(g => g.filter(d => KEYS.includes(d))).filter(g => g.length);
    if (!stages.length) throw new Error('PM 沒有安排任何部門');
    if (r.n === 1 && j.title) t.title = String(j.title).slice(0, 30);
    r.plan = { summary: j.summary || '', stages, assignments: j.assignments || {} };
    r.depts = {};
    for (const d of stages.flat()) r.depts[d] = { status: 'planning', assignment: j.assignments?.[d] || '', level: LEVELS.includes(j.levels?.[d]) ? j.levels[d] : 'standard', log: [] };
    r.status = 'dept-planning'; pushTask(t);
    await Promise.all(Object.keys(r.depts).map(d => deptPlan(t, d)));
  } catch (e) {
    if (rtAborted(t)) return;
    r.status = 'error'; r.error = String(e.message || e); t.status = 'attention'; pushTask(t);
  }
}
function rtAborted(t) { return runtime.get(t.id)?.abort.signal.aborted; }

/* ---------- 部門：提方案 / 修改方案 ---------- */
async function deptPlan(t, dept, feedback) {
  const r = t.rounds[t.rounds.length - 1], d = r.depts[dept];
  d.status = 'planning'; d.error = null; pushTask(t);
  t.sessions = t.sessions || {};
  const prompt = feedback
    ? `主管看了你的方案後給了以下回饋，請據此修改並重新提出完整方案（只輸出方案本身）：\n"""\n${feedback}\n"""`
    : `整體需求（第 ${r.n} 輪）：\n"""\n${r.text}\n"""\nPM 的整體做法：${r.plan.summary}\n\n你的分工：${d.assignment}\n\n請先閱讀專案現況，再提出你部門的執行方案，送給主管審核。這個階段只能閱讀與研究，不要修改任何檔案。\n方案請用以下段落：\n## 目標\n## 做法與步驟\n## 會新增或修改的檔案\n## 交付物\n## 風險與待確認事項\n## 需要其他部門配合\n只輸出方案本身，不要加前言。`;
  try {
    const out = await runClaude({ t, dept, prompt: feedback ? prompt + planQaNote(d) : prompt, model: MODELS.plan, mode: 'plan', resume: t.sessions[dept], phaseName: feedback ? '依主管意見修改方案' : '提出方案' });
    t.sessions[dept] = out.sessionId;
    d.plan = out.text; d.edited = null; d.status = 'review'; d.planVersion = (d.planVersion || 0) + 1;
    d.planFile = await writeDoc(t, `r${r.n}-${dept}-plan-v${d.planVersion}.md`, d.plan);
    refreshStatus(t); pushTask(t);
  } catch (e) {
    if (rtAborted(t)) return;
    d.status = 'error'; d.error = String(e.message || e); refreshStatus(t); pushTask(t);
  }
}

/* ---------- 主管審核 ---------- */
function refreshStatus(t) {
  const r = t.rounds[t.rounds.length - 1];
  const ds = Object.values(r.depts);
  if (ds.some(d => d.status === 'error')) t.status = 'attention';
  else if (ds.some(d => d.status === 'review')) t.status = 'review';
  else if (ds.some(d => d.status === 'planning')) t.status = 'planning';
}
async function review(t, dept, action, body) {
  const r = t.rounds[t.rounds.length - 1], d = r.depts[dept];
  if (!d) throw new Error('這一輪沒有這個部門');
  if (action === 'approve') {
    if (d.status !== 'review') throw new Error('這份方案目前不能核准');
    if (body.text && body.text.trim() !== (d.plan || '').trim()) { d.edited = body.text; d.planFile = await writeDoc(t, `r${r.n}-${dept}-plan-v${d.planVersion}-主管修改.md`, body.text); }
    d.status = 'approved'; d.approvedAt = Date.now();
    refreshStatus(t); pushTask(t);
    maybeExecute(t);
  } else if (action === 'revise') {
    if (!body.feedback?.trim()) throw new Error('請寫下修改意見');
    d.feedback = [...(d.feedback || []), { at: Date.now(), text: body.feedback }];
    if (d.qa?.length) d.qa.push({ role: 'sys', text: '主管要求修改方案（v' + (d.planVersion || 1) + '）', at: Date.now() });
    deptPlan(t, dept, body.feedback);
  } else if (action === 'retry') {
    if (d.status !== 'error') throw new Error('只有失敗的步驟可以重試');
    if (d.plan && d.approvedAt) { d.status = 'approved'; maybeExecute(t, true); } else deptPlan(t, dept);
  }
}

// 要求修改時，把先前的提問與回答一併交給部門
function planQaNote(d) {
  const qa = (d.qa || []).filter(m => m.role !== 'sys' && !m.error);
  if (!qa.length) return '';
  return '\n\n主管先前對這份方案的提問與你的回答（舊到新），修改時一併納入；主管說「照你的建議改」時，就套用你回答裡的建議：\n' + qa.map(m => `${m.role === 'user' ? '主管' : '你'}：${clip(m.text, 1500)}`).join('\n');
}
// 主管對方案提問：部門只回答，不改方案、狀態與方案檔
async function askPlan(t, dept, text) {
  const r = t.rounds[t.rounds.length - 1], d = r.depts[dept];
  d.qa = d.qa || [];
  d.qa.push({ role: 'user', text, at: Date.now(), v: d.planVersion || 1 });
  d.asking = true; pushTask(t);
  t.sessions = t.sessions || {};
  const sid0 = t.sessions[dept], v0 = d.planVersion, q3 = '"'.repeat(3), label = ['回答主管的提問', '回答完畢'];
  const recent = d.qa.slice(-9, -1).filter(m => m.role !== 'sys').map(m => `${m.role === 'user' ? '主管' : '你'}：${m.text}`).join('\n');
  const ask = `【方案提問】主管看了你提出的方案（v${v0 || 1}）後有問題。這次只要回答，不要修改方案，也不要重新輸出整份方案。

主管問：
${q3}
${text}
${q3}

回答方式：
- 用白話回答，3~8 句或幾個條列；說明你這樣規劃的理由，並引用依據（專案裡的檔名、段落或程式位置）。
- 如果主管的問題點出了方案真正的問題，最後用一句「建議：…」說明你會怎麼改，讓主管決定要不要叫你修改方案。
- 不要修改任何檔案。`;
  const full = `${ask}

整體需求（第 ${r.n} 輪）：
${q3}
${r.text}
${q3}
你的分工：${d.assignment || '（未註明）'}
${recent ? `\n最近的問答（舊到新）：\n${recent}\n` : ''}
你提出的方案：
${q3}
${d.plan || ''}
${q3}
需要時可以先閱讀專案裡的檔案再回答。`;
  try {
    let out = null;
    if (sid0) { try { out = await runClaude({ t, dept, prompt: ask, mode: 'plan', resume: sid0, phaseName: '回答主管的提問', label, model: MODELS.standard }); } catch (e) { if (rtAborted(t)) throw e; out = null; } }
    if (!out || !String(out.text || '').trim()) out = await runClaude({ t, dept, prompt: full, mode: 'plan', resume: null, phaseName: '回答主管的提問（重新開始）', label, model: MODELS.standard });
    else if (out.sessionId && t.sessions[dept] === sid0 && d.status === 'review' && d.planVersion === v0) t.sessions[dept] = out.sessionId;
    d.qa.push({ role: 'dept', text: String(out.text || '').trim() || '（沒有回答）', at: Date.now(), v: v0 || 1 });
  } catch (e) {
    d.qa.push({ role: 'dept', text: rtAborted(t) ? '任務已取消，這個問題沒有回答到' : '回答失敗：' + (e.message || e), at: Date.now(), error: true });
  }
  d.asking = false; pushTask(t);
}

/* ---------- 執行 ---------- */
async function maybeExecute(t, force) {
  const r = t.rounds[t.rounds.length - 1];
  const ds = Object.entries(r.depts);
  if (!ds.every(([, d]) => ['approved', 'done'].includes(d.status))) return;
  if (r.status === 'running' && !force) return;
  r.status = 'running'; t.status = 'running'; pushTask(t);
  const handoff = [];
  const DN = deptsOf(buildings.find(x => x.id === t.building));
  for (const d of Object.keys(r.depts)) if (r.depts[d].status === 'done' && r.depts[d].report) handoff.push(`### ${DN[d].name}的報告\n${r.depts[d].report.slice(0, 4000)}`);
  for (const stage of r.plan.stages) {
    const todo = stage.filter(d => r.depts[d] && r.depts[d].status === 'approved');
    if (todo.length) {
      emit('stage', { building: t.building, taskId: t.id, depts: todo, from: handoff.length ? Object.keys(r.depts).filter(d => r.depts[d].status === 'done') : [] });
      const results = await Promise.all(todo.map(d => deptExecute(t, d, handoff.join('\n\n'))));
      if (rtAborted(t)) return;
      if (results.some(x => !x)) { t.status = 'attention'; r.status = 'error'; pushTask(t); return; }
    }
    for (const d of stage) if (r.depts[d]?.report) {
      const sec = `### ${DN[d].name}的報告\n${r.depts[d].report.slice(0, 4000)}`;
      if (!handoff.includes(sec)) handoff.push(sec);
    }
  }
  await pmSummary(t);
}
async function deptExecute(t, dept, handoff) {
  const r = t.rounds[t.rounds.length - 1], d = r.depts[dept];
  d.status = 'running'; d.startedAt = Date.now(); pushTask(t);
  const plan = d.edited || d.plan;
  const prompt = `主管已核准你的方案${d.edited ? '（主管有修改，請以這個版本為準）' : ''}，請開始執行：
"""
${plan}
"""
${handoff ? '\n前面部門的交接內容：\n' + handoff + '\n' : ''}
讀寫專案內的檔案會自動放行；執行終端機指令需要主管在大樓裡批准，被拒絕時請改用其他方式。
全部完成後，最後一則訊息請只輸出任務報告（Markdown），段落如下：
## 完成項目
## 修改與新增的檔案
## 驗證方式與結果
## 未完成或待確認
## 給下一個部門或主管的建議`;
  try {
    d.model = MODELS[d.level] || MODELS.standard; pushTask(t);
    const out = await runClaude({ t, dept, prompt, mode: 'run', resume: t.sessions?.[dept], phaseName: '執行方案', model: d.model });
    t.sessions[dept] = out.sessionId;
    d.report = out.text; d.files = out.files; d.cost = out.cost; d.status = 'done'; d.doneAt = Date.now();
    if (b0(t).autoCommit) { const cm = await autoCommit(b0(t), out.files, t.title, deptsOf(b0(t))[dept]?.name || dept, d.model); if (cm) d.commit = cm.msg; }
    d.reportFile = await writeDoc(t, `r${r.n}-${dept}-report.md`, d.report);
    emit('activity', { building: t.building, taskId: t.id, dept, kind: 'report', summary: '交出任務報告' });
    pushTask(t);
    return true;
  } catch (e) {
    if (rtAborted(t)) return false;
    d.status = 'error'; d.error = String(e.message || e); pushTask(t);
    return false;
  }
}
async function pmSummary(t) {
  const r = t.rounds[t.rounds.length - 1];
  t.status = 'summarizing'; pushTask(t);
  const DN = deptsOf(buildings.find(x => x.id === t.building));
  const reports = Object.entries(r.depts).map(([d, x]) => `### ${DN[d].name}\n${x.report || '（沒有報告）'}`).join('\n\n');
  const prompt = `各部門都完成了第 ${r.n} 輪需求。需求原文：\n"""\n${r.text}\n"""\n\n各部門報告：\n${reports}\n\n請寫一份給主管的總報告（Markdown），段落：\n## 需求達成狀況\n## 各部門重點\n## 風險與待辦\n## 建議的下一步\n只輸出報告本身。`;
  try {
    const out = await runClaude({ t, dept: null, prompt, mode: 'plan', resume: t.pmSession, phaseName: 'PM 總報告', model: MODELS.standard });
    t.pmSession = out.sessionId;
    r.summary = out.text; r.summaryFile = await writeDoc(t, `r${r.n}-總報告.md`, r.summary);
  } catch (e) {
    if (rtAborted(t)) return;
    r.summary = '（PM 總報告產生失敗：' + (e.message || e) + '）';
  }
  r.status = 'done'; t.status = 'done'; t.doneAt = Date.now(); pushTask(t);
  emit('activity', { building: t.building, taskId: t.id, dept: 'pm', kind: 'done', summary: `「${t.title}」第 ${r.n} 輪完成` });
}

/* ---------- 目標與排程 ---------- */
const goalsState = new Map(); // buildingId -> { status, source, draft, goals, schedule, error, updatedAt, summary, session }
const specialTitles = new Map();
function goalsFile(b) { return path.join(towerDir(b), 'goals.json'); }
function loadGoals(b) {
  if (goalsState.has(b.id)) return goalsState.get(b.id);
  let g = { status: 'none', source: b.plan || '', goals: [], schedule: [], draft: null };
  try { g = { ...g, ...JSON.parse(fs.readFileSync(goalsFile(b), 'utf8')) }; } catch {}
  if (g.asking) g.asking = null;
  if (g.status === 'drafting') { g.status = g.draft ? 'review' : (g.goals.length ? 'approved' : 'none'); g.error = '伺服器重新啟動，拆解被中斷了，可以重新拆解。'; }
  goalsState.set(b.id, g); return g;
}
function saveGoals(b) {
  const g = loadGoals(b); g.updatedAt = Date.now();
  fs.mkdirSync(towerDir(b), { recursive: true });
  fs.writeFileSync(goalsFile(b), JSON.stringify(g, null, 1));
  emit('goals', { building: b.id, goals: g });
}
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const GOAL_FMT = `{
  "reply": "回覆主管的話（2~4 句：你做了什麼、有什麼要提醒）",
  "summary": "整份目標怎麼拆的（3~5 句）",
  "changes": ["這次的變動，一句一項，例如：新增 設計部 11 月目標「…」"],
  "goals": [
    { "id": "g1", "level": "year", "period": "2026", "dept": "company", "title": "目標", "metric": "衡量方式", "target": "目標值", "due": "YYYY-MM-DD", "parent": null, "automation": "自動|核可|人" }
  ],
  "schedule": [
    { "id": "s1", "title": "里程碑或工作", "dept": "部門代號或 company", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "kind": "milestone|work|routine", "goal": "g1", "recur": "daily|weekly:1|monthly:1（只有 routine 才填）" }
  ]
}`;
const slimGoal = x => ({ id: x.id, level: x.level, period: x.period, dept: x.dept, title: x.title, metric: x.metric, target: x.target, due: x.due, parent: x.parent, automation: x.automation, ...(x.byBoss ? { byBoss: true } : {}) });
// feedback 為空：從計畫書重新拆解；有 feedback：派 PM 依主管的話調整目前版本（草案優先）
async function importGoals(b, feedback) {
  const g = loadGoals(b);
  if (g.status === 'drafting' || g.asking) throw new Error((b.pm?.name || 'PM') + '正在處理中，等他完成再交辦');
  g.chat = g.chat || [];
  const base = g.draft || (g.goals.length ? { goals: g.goals, schedule: g.schedule, summary: g.summary } : null);
  const adjusting = !!(feedback && base);
  const t = { id: 'goals-' + Date.now().toString(36), building: b.id, title: '目標規劃', rounds: [{ n: 1, depts: {} }], cost: 0 };
  specialTitles.set(t.id, adjusting ? '目標調整' : '目標規劃');
  runtime.set(t.id, { abort: new AbortController() });
  if (feedback) g.chat.push({ role: 'user', text: feedback, at: Date.now() });
  const back = g.draft ? 'review' : g.goals.length ? 'approved' : 'none';
  g.status = 'drafting'; g.error = null; g.taskId = t.id; saveGoals(b);
  const keys = Object.keys(deptsOf(b));
  const src = g.source || b.plan || '（請在 docs/ 找公司計畫書）';
  // 這一輪討論（上次核准／捨棄之後）的所有提問與回答，修改時一併納入
  const lastSys = g.chat.map(m => m.role).lastIndexOf('sys');
  const recent = g.chat.slice(lastSys + 1, -1).slice(-20).map(m => `${m.role === 'user' ? (m.ask ? '主管提問' : '主管要求修改') : '你' + (m.ask ? '的回答' : '')}：${String(m.text).slice(0, 1500)}`).join('\n');
  const rules = `規則：
- level：year 是年度、quarter 是季、month 是月；period 寫成 2026、2026-Q4、2026-11 這種格式；下層目標用 parent 指向上層 id。
- automation 照計畫書的核可等級：自動、核可、人。
- routine 是例行節奏（每天、每週、每月），要填 recur（weekly:1 代表每週一，monthly:1 代表每月 1 號）。
- dept 只能用 company 或這些代號：${keys.join('、')}。
- 沒寫日期的，依合理順序推估，並在 title 後面加「（推估）」。
- 只輸出 JSON，不要修改任何檔案。`;
  const prompt = adjusting
    ? `【目標調整】今天是 ${today()}。你是${b.pm?.name || 'PM'}，主管要調整公司的目標與排程。

主管這次說：
"""
${feedback}
"""
${recent ? `\n這一輪你們之前的提問與回答（舊到新）。修改時要一併納入；主管說「照你的建議改」之類的話時，就套用你回答裡的「建議」：\n${recent}\n` : ''}
目前的${g.draft ? '草案（還沒核准）' : '正式版本（已核准）'}：
\`\`\`json
${JSON.stringify({ goals: base.goals.map(slimGoal), schedule: base.schedule }, null, 1)}
\`\`\`

需要時可以再讀計畫書 \`${src}\` 或部門手冊，也可以看專案裡的進度檔。
請照主管的話修改，輸出「完整的新版本」（放在 \`\`\`json 區塊）：
${GOAL_FMT}

調整規則：
- 只改主管要求的部分（以及因此必須連帶調整的上下層目標、排程）；其餘目標與排程原樣保留，id 不變。
- 標了 byBoss 的項目是主管親手改過的，除非主管這次明確要求，否則不要動它。
- 修改過的目標保留原 id；新增的用沒用過的新 id；刪掉的就不要輸出。
- changes 逐項列出這次的新增、修改、刪除，讓主管一眼看懂。
- 如果主管只是在問問題、不需要改，goals 與 schedule 原樣輸出，changes 給空陣列，在 reply 回答他。
${rules}`
    : `【目標規劃】今天是 ${today()}。請閱讀公司計畫書 \`${src}\`，必要時參考各部門手冊，把它拆成「目標」與「排程」，送給主管審核。
${feedback ? `\n主管補充：\n"""\n${feedback}\n"""\n` : ''}
只輸出一個 JSON（放在 \`\`\`json 區塊）：
${GOAL_FMT}

${rules}
- 年度目標 1~3 個（公司層級）；接下來 4 季每季 2~4 個；接下來 3 個月，每個相關部門每月 1~2 個月目標。
- schedule 涵蓋未來 12 個月的主要里程碑與工作期間（依計畫書的導入時程），加上計畫書寫的例行節奏。
- changes 給空陣列。`;
  try {
    const out = await runClaude({ t, dept: null, prompt, mode: 'plan', resume: null, phaseName: adjusting ? '依主管的話調整目標' : '從計畫書拆解目標', model: MODELS.plan });
    const j = extractJson(out.text);
    const okDept = d => d === 'company' || keys.includes(d);
    const goals = (j.goals || []).filter(x => x && x.title).map((x, i) => ({ id: String(x.id || 'g' + i), level: ['year', 'quarter', 'month'].includes(x.level) ? x.level : 'month', period: String(x.period || ''), dept: okDept(x.dept) ? x.dept : 'company', title: String(x.title), metric: x.metric || '', target: x.target || '', due: x.due || '', parent: x.parent || null, automation: x.automation || '', status: 'todo', progress: 0 }));
    const schedule = (j.schedule || []).filter(x => x && x.title && x.start).map((x, i) => ({ id: String(x.id || 's' + i), title: String(x.title), dept: okDept(x.dept) ? x.dept : 'company', start: x.start, end: x.end || x.start, kind: ['milestone', 'work', 'routine'].includes(x.kind) ? x.kind : 'work', goal: x.goal || null, recur: x.kind === 'routine' ? (x.recur || 'weekly:1') : null }));
    const changes = Array.isArray(j.changes) ? j.changes.map(String).filter(Boolean) : [];
    g.session = out.sessionId; g.cost = (g.cost || 0) + (out.cost || 0);
    const noChange = adjusting && !changes.length;
    g.chat.push({ role: 'chief', text: String(j.reply || (noChange ? '這次不需要調整。' : '已依你的意見調整，請審核。')), changes, at: Date.now(), taskId: t.id, draft: !noChange });
    if (noChange) g.status = back;
    else {
      if (!goals.length) throw new Error((b.pm?.name || 'PM') + '回傳的目標是空的');
      g.draft = { summary: j.summary || base?.summary || '', goals, schedule, changes, at: Date.now(), from: adjusting ? (g.draft ? 'draft' : 'approved') : 'plan' };
      g.status = 'review';
      await writeDoc(t, '目標草案.json', JSON.stringify(g.draft, null, 1));
    }
  } catch (e) {
    g.status = back; g.error = (adjusting ? '調整失敗：' : '拆解失敗：') + (e.message || e);
    g.chat.push({ role: 'chief', text: g.error, at: Date.now(), taskId: t.id, error: true });
  }
  saveGoals(b);
}
// 只提問：PM 用文字回答，不動目標與草案
async function askGoals(b, text) {
  const g = loadGoals(b);
  if (g.status === 'drafting' || g.asking) throw new Error((b.pm?.name || 'PM') + '正在處理上一件事');
  g.chat = g.chat || [];
  g.chat.push({ role: 'user', text, at: Date.now(), ask: true });
  const t = { id: 'goals-' + Date.now().toString(36), building: b.id, title: '目標提問', rounds: [{ n: 1, depts: {} }], cost: 0 };
  specialTitles.set(t.id, '目標提問');
  runtime.set(t.id, { abort: new AbortController() });
  g.asking = t.id; g.error = null; saveGoals(b);
  const which = g.draft ? '目標草案（還沒核准）' : '目前的正式目標';
  const base = g.draft || { goals: g.goals, schedule: g.schedule };
  const recent = g.chat.slice(-9, -1).map(m => `${m.role === 'user' ? '主管' : m.role === 'sys' ? '（系統）' : '你'}：${m.text}`).join('\n');
  const ask = `【目標提問】主管對${which}有問題。這次只要回答，不要修改目標，也不要輸出 JSON。

主管問：
"""
${text}
"""

回答方式：
- 用白話回答，3~8 句或幾個條列；說明你這樣設定的理由，並引用依據（計畫書或部門手冊的檔名與段落）。
- 如果主管的問題點出了真正的問題，最後用一句「建議：…」提出你會怎麼改，讓主管決定要不要叫你修改。
- 不要修改任何檔案。`;
  const full = `${ask}
${recent ? `\n最近的對話（舊到新）：\n${recent}\n` : ''}
${which}：
\`\`\`json
${JSON.stringify({ goals: base.goals.map(slimGoal), schedule: base.schedule })}
\`\`\`
需要時可以讀計畫書 \`${g.source || b.plan || ''}\` 或部門手冊。`;
  try {
    let out;
    if (g.session) { try { out = await runClaude({ t, dept: null, prompt: ask, mode: 'plan', resume: g.session, phaseName: '回答主管的提問', model: MODELS.standard }); } catch { out = null; } }
    if (!out || !String(out.text || '').trim()) out = await runClaude({ t, dept: null, prompt: full, mode: 'plan', resume: null, phaseName: '回答主管的提問', model: MODELS.standard });
    g.session = out.sessionId || g.session; g.cost = (g.cost || 0) + (out.cost || 0);
    g.chat.push({ role: 'chief', text: String(out.text || '').trim() || '（沒有回答）', at: Date.now(), taskId: t.id, ask: true });
  } catch (e) {
    g.chat.push({ role: 'chief', text: '回答失敗：' + (e.message || e), at: Date.now(), taskId: t.id, error: true });
  }
  g.asking = null; saveGoals(b);
}
function goalProgress(b, g) {
  // 目標連到的任務完成比例，自動回填進度
  const linked = [...tasks.values()].filter(t => t.building === b.id && t.goalId === g.id);
  if (!linked.length) return g;
  const done = linked.filter(t => t.status === 'done').length;
  return { ...g, linked: linked.map(t => ({ id: t.id, title: t.title, status: t.status })), progress: g.manualProgress ?? Math.round(done / linked.length * 100), status: g.manualStatus || (done === linked.length ? 'done' : 'doing') };
}
function goalsView(b) {
  const g = loadGoals(b);
  return { ...g, goals: g.goals.map(x => goalProgress(b, x)) };
}

/* ---------- 自動運行（排程派工） ---------- */
// 每棟大樓的例行工作寫在專案裡的 routines.json；開啟自動運行後，時間到就直接派給該部門
const autoTasks = new Map();   // auto 任務 id -> 假任務物件
const apStates = new Map();
const AP_GRACE_MIN = 30;       // 錯過排程時間 30 分鐘內仍會補跑
function apFile(b) { return path.join(towerDir(b), 'autopilot.json'); }
function apState(b) {
  if (apStates.has(b.id)) return apStates.get(b.id);
  let st = { enabled: false, dailyCap: 40, caps: {}, overrides: {}, runs: [] };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(apFile(b), 'utf8')) }; } catch {}
  for (const r of st.runs) if (r.status === 'running' || r.status === 'queued') { r.status = 'error'; r.error = '伺服器重新啟動，這次被中斷'; }
  for (const qa of Object.values(st.qa || {})) for (const m of qa) if (m.pending) { m.pending = false; m.error = true; m.text = '伺服器重新啟動，這個問題沒查完，可以再問一次。'; }
  for (const r of Object.values(st.replies || {})) if (r.status === 'landing') r.status = 'error';
  apStates.set(b.id, st); return st;
}
function apSave(b) {
  const st = apState(b); st.runs = st.runs.slice(-400);
  fs.mkdirSync(towerDir(b), { recursive: true }); fs.writeFileSync(apFile(b), JSON.stringify(st, null, 1));
  emit('autopilot', { building: b.id, view: apView(b) });
}
/* ---------- 專案的待核可清單 → 大樓「需要你處理」 ---------- */
// 各部門把要擁有者決定的事寫進專案自己的待核可清單（預設找專案根目錄的 approvals.md 或 docs/approvals.md，也可以用大樓設定 approvals 指定）。
// 大樓讀「待擁有者」「置頂」段的表格，每一列變成一個工作項目；擁有者在大樓回覆後，派 PM 照手冊落地。
/* ---------- 部門自主程度、部長、總管交辦 ---------- */
// 保守 < 正常 < 自主 < 放行。放行＝部門的問題全由部門自己解決；但下面的固定規則永遠要守，自己拍板的事一定要回報。
const AUTONOMY = ['conservative', 'normal', 'autonomous', 'release'];
const AUTONOMY_LABEL = { conservative: '保守', normal: '正常', autonomous: '自主', release: '放行' };
const AUTONOMY_NOTE = {
  conservative: '自主程度：保守。只做明確交辦的事。會改到規格、對外內容、數值，或影響其他部門的決定，都寫進待核可清單讓擁有者決定，不要自己拍板。',
  normal: '自主程度：正常。照你的部門手冊決定哪些事要擁有者核可。',
  autonomous: '自主程度：自主。部門職權內的決定（規格細節、措辭、先後順序、修正錯誤、部門內分工）由部長直接拍板，不用送擁有者核可；只有手冊列為「必須擁有者核可」的事和下面的固定規則才送核可。自己拍板的決定，寫進報告的「## 部門自行決定」段（決定了什麼、為什麼、改了哪些檔案）。',
  release: '自主程度：放行。除了下面的固定規則，部門的問題全由部門自己解決到完成，不送擁有者核可；總管交辦的事也直接處理完。每個自己拍板的決定都寫進報告的「## 部門自行決定」段（決定了什麼、為什麼、改了哪些檔案），讓擁有者事後看得到。',
};
const FIXED_RULES = `固定規則（不管自主程度多高都不能跳過）：
- 不輸入任何帳號密碼或金鑰；不花錢、不簽約、不寄信或私訊給外部的人。
- 正式上線、刪除資料、對外公開的內容，手冊規定要擁有者核可的照舊核可（擁有者另外授權的例外照授權）。
- 需要擁有者親自確認的成果（例如視覺、操作手感、對外文案）一定要他看過才算完成：做完在待核可清單放一列「請你看」，附上檔案或網址；等他看的期間可以先做別的。自動測試只能證明功能沒壞，不能代替他看。
- 手冊裡的安全紅線照舊。${(CFG.fixedRules || []).map(x => '\n- ' + x).join('')}`;
function levelOf(b, id) { const v = apState(b).autonomy?.[id] || deptsOf(b)[id]?.autonomy; return AUTONOMY.includes(v) ? v : 'normal'; }
function deptExtra(b, dept) {
  const d = deptsOf(b)[dept]; if (!d) return '';
  return `

## 部長與自主程度（大樓設定）
你同時是${d.name}的部長，帶 ${d.members || 2} 位成員。開工前先由你決定部門內分工：這件事拆成哪幾塊、每塊交給哪位成員、先後順序，在報告開頭用一兩行寫出分工。每塊只用需要的檔案（最少又足夠）。部門內的取捨由你拍板，範圍照下面的自主程度。
${AUTONOMY_NOTE[levelOf(b, dept)]}
${FIXED_RULES}`;
}
function pmExtra(b) {
  const ds = deptsOf(b), ids = Object.keys(ds), free = ids.filter(id => ['autonomous', 'release'].includes(levelOf(b, id)));
  return `

## 各部門自主程度（大樓設定）
${ids.map(id => `${ds[id].name}（${id}）：${AUTONOMY_LABEL[levelOf(b, id)]}`).join('、')}。` + (free.length ? `
遇到屬於「自主」或「放行」部門的問題，不要寫進待核可清單問擁有者，直接交辦給那個部門解決：在回報最後附一段
\`\`\`json
{"delegate":[{"dept":"部門代號","title":"一句話事項","change":"要改什麼","accept":"怎麼驗收","dont":"不能動什麼","files":["相關檔案"]}]}
\`\`\`
大樓會直接派給那個部門，做完把結果回報給擁有者。一件事一筆，只給對方需要的最少資訊。固定規則裡要擁有者看或核可的事，仍照舊送核可。
${FIXED_RULES}` : '');
}
const hhmm = n => String(n.h).padStart(2, '0') + ':' + String(n.m).padStart(2, '0');
function apReport(b, rep) { const st = apState(b); st.reports = (st.reports || []).concat(rep).slice(-80); return rep; }
function apDelegate(b, list, fromTitle) {
  const ds = deptsOf(b), n = nowIn(routinesOf(b)?.timezone);
  for (const x of (Array.isArray(list) ? list : []).slice(0, 5)) {
    const dept = String(x?.dept || ''); if (!ds[dept] || !['autonomous', 'release'].includes(levelOf(b, dept))) continue;
    const id = 'dlg-' + crypto.createHash('sha1').update(dept + String(x.title) + Date.now()).digest('hex').slice(0, 10);
    const rep = apReport(b, { id, kind: 'delegate', dept, title: String(x.title || '總管交辦').slice(0, 80), from: fromTitle, at: Date.now(), status: 'running', seen: false });
    const r = { id, dept, noHandoff: true, keepTier: true, tier: 'standard', maxMinutes: 25, title: '總管交辦：' + rep.title, time: hhmm(n),
      onDone: (ok, ent) => { rep.status = ok ? 'done' : 'error'; rep.summary = String((ok ? ent.summary : ent.error) || '').slice(0, 3000); rep.runId = ent.id; rep.endedAt = Date.now(); apSave(b); emit('notice', { building: b.id, text: `${ds[dept].name}處理完總管交辦的「${rep.title}」，結果在「需要你處理」的回報裡` }); },
      prompt: `${b.pm?.name || '總管'}把這件事直接交給你們部門解決（照你們的自主程度自己拍板，不用送擁有者核可；固定規則照守）：
- 事項：${rep.title}
- 要改什麼：${x.change || '—'}
- 怎麼驗收：${x.accept || '—'}
- 不能動什麼：${x.dont || '—'}
- 相關檔案：${(Array.isArray(x.files) ? x.files : []).join('、') || '—'}

做完用繁體中文回報：先寫結果和改了哪些檔案，再寫「## 部門自行決定」（你們自己拍板了什麼、為什麼）。` };
    apEnqueue(b, r, n, true);
  }
}
// 待核可那一列歸哪個部門：看「負責部門」「來自」欄寫的部門代號、名稱或手冊編號（01、05…）。只對到一個部門才直接交給它；跨部門或對不到就交給總管。
function ownerDept(b, it) {
  const ds = deptsOf(b), ids = Object.keys(ds), num = {};
  for (const id of ids) { const m = path.basename(ds[id].handbook || '').match(/^(\d\d)-/); if (m) num[m[1]] = id; }
  const pmNum = path.basename(b.pm?.handbook || '').match(/^(\d\d)-/)?.[1];
  const found = [], add = id => { if (id && !found.includes(id)) found.push(id); };
  const text = [it.owner, it.from].filter(Boolean).join(' ');
  for (const m of text.matchAll(/(?<![\d.§#\w]|\d-)(\d\d)(?![\d.]|-\d)/g)) add(m[1] === pmNum ? 'pm' : num[m[1]]);
  for (const id of ids) if (text.includes(id) || text.includes(ds[id].name)) add(id);
  if (!found.length) for (const p of it.paths || []) { const m = p.p.match(/progress\/(\d\d)-[^/]*\.md$/); if (m) add(m[1] === pmNum ? 'pm' : num[m[1]]); }
  const depts = found.filter(x => x !== 'pm');
  return depts.length === 1 && !found.includes('pm') ? depts[0] : null;
}
const replyDeptNote = dn => `你是這一列的負責部門（${dn}）。大樓把擁有者的回覆直接交給你落地，不經過總管：
- 待核可清單那一列由你自己移到「已決定」（寫上原話和落地到哪）。
- 需要其他部門配合的，只在對方手冊的收件匣加一列，寫三件事：要改什麼、怎麼驗收、不能動什麼。不要把討論過程整段貼過去。

`;
// 例行工作開跑前先用程式檢查有沒有事做（不花錢）。沒事就略過，不叫 AI。
function newestMtime(p, budget = { n: 20000 }) {
  let st; try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let best = st.mtimeMs, ents = [];
  try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return best; }
  for (const e of ents) {
    if (--budget.n < 0) break;
    if (['node_modules', '.git', 'dist', '.tower', '.tower-codex', '.turbo', '.next', 'coverage'].includes(e.name)) continue;
    best = Math.max(best, newestMtime(path.join(p, e.name), budget));
  }
  return best;
}
function gateCheck(b, r, n) {
  const g = (b.gates || {})[r.id] || r.gate; if (!g || g.alwaysOn?.includes(n.wd)) return null;
  const why = [];
  if (g.changed?.length) {
    const st = apState(b), last = [...st.runs].reverse().find(x => x.routine === r.id && x.status === 'done');
    if (!last) return null;
    const since = last.startedAt || last.at;
    if (g.changed.some(rel => newestMtime(path.resolve(b.dir, rel)) > since)) return null;
    why.push(`上次執行（${last.date.slice(5)} ${last.time}）之後，${g.changed.join('、')} 都沒有變動`);
  }
  if (g.match?.length) {
    if (g.match.some(m => { try { return new RegExp(fillVars(m.pattern, n), 'm').test(fs.readFileSync(path.resolve(b.dir, fillVars(m.file, n)), 'utf8')); } catch { return false; } })) return null;
    why.push(g.why || `${g.match.map(m => m.file).join('、')} 裡沒有要處理的項目`);
  }
  return why.length ? why.join('；') : null;
}
// 今天花了多少；超過預算七成，簡單的例行工作改用便宜的模型，額度留給重要的事
const todayCost = b => { const n = nowIn(routinesOf(b)?.timezone); return apState(b).runs.filter(x => x.date === n.date).reduce((s, x) => s + (+x.cost || 0), 0); };
const budgetOf = b => { const v = apState(b).budgetUsd ?? CFG.dailyBudgetUsd ?? 10; return +v > 0 ? +v : 0; };
function budgetTier(b, r, tier, ent) {
  const cap = budgetOf(b); if (!cap || r.keepTier || r.model) return tier;
  const used = todayCost(b); if (used < cap * 0.7) return tier;
  const down = { heavy: 'standard', plan: 'standard', standard: 'light' }[tier] || tier;
  if (down !== tier) ent.downgraded = `今天已花 $${used.toFixed(2)}，超過預算 $${cap} 的七成，改用較便宜的模型`;
  return down;
}
/* ---------- 做完一項工作自動 commit（大樓設定 autoCommit） ---------- */
// 只 commit 這次 AI 用 Edit/Write 改到的檔案（git commit -- <檔案>），不碰其他沒 commit 的改動；不 push、不切分支、不在 main 上 commit。
function git(b, args) {
  return new Promise(res => {
    const pr = spawn('git', args, { cwd: b.dir, windowsHide: true });
    let out = '', err = ''; pr.stdout.on('data', d => out += d); pr.stderr.on('data', d => err += d);
    pr.on('close', code => res({ code, out: out.trim(), err: err.trim() })); pr.on('error', e => res({ code: -1, out: '', err: e.message }));
  });
}
let gitBusy = Promise.resolve();
function autoCommit(b, files, title, deptName, model) {
  if (!b.autoCommit || !files?.length) return Promise.resolve(null);
  const job = gitBusy.then(async () => {
    const br = await git(b, ['branch', '--show-current']);
    if (br.code) return { ok: false, msg: '不是 git 專案或 git 出錯：' + (br.err || br.out).slice(0, 200) };
    if (!br.out || ['main', 'master'].includes(br.out)) return { ok: false, msg: `目前在 ${br.out || '沒有分支（detached）'}，大樓不在這裡自動 commit` };
    const rels = [...new Set(files)].filter(f => f && !f.startsWith('..') && !path.isAbsolute(f) && fs.existsSync(path.join(b.dir, f)));
    const keep = [];
    for (const f of rels) { const ig = await git(b, ['check-ignore', '-q', '--', f]); if (ig.code !== 0) keep.push(f); }
    if (!keep.length) return { ok: true, msg: '改到的都是 git 忽略的檔案，不用 commit' };
    const add = await git(b, ['add', '--', ...keep]);
    if (add.code) return { ok: false, msg: 'git add 失敗：' + add.err.slice(0, 200) };
    const diff = await git(b, ['diff', '--cached', '--quiet', '--', ...keep]);
    if (diff.code === 0) return { ok: true, msg: '改完的內容跟上一版一樣，不用 commit' };
    const msg = `${deptName}：${String(title).replace(/\s+/g, ' ').slice(0, 72)}\n\n大樓自動 commit：這次工作改到的 ${keep.length} 個檔案。\n\nCo-Authored-By: Codex (${model || 'auto'}) <noreply@openai.com>`;
    const c = await git(b, ['commit', '-q', '-m', msg, '--', ...keep]);
    if (c.code) return { ok: false, msg: 'git commit 失敗：' + (c.err || c.out).slice(0, 200) };
    const h = await git(b, ['rev-parse', '--short', 'HEAD']);
    return { ok: true, hash: h.out, branch: br.out, n: keep.length, msg: `已 commit ${h.out}（${br.out}，${keep.length} 個檔案）` };
  });
  gitBusy = job.catch(() => {});
  return job;
}
const b0 = t => buildings.find(x => x.id === t.building);
function approvalsFile(b) {
  for (const rel of [b.approvals, 'approvals.md', 'docs/approvals.md'].filter(Boolean)) {
    const f = path.resolve(b.dir, rel); if (fs.existsSync(f)) return f;
  }
  return null;
}
const cellsOf = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const plainMd = t => String(t || '').replace(/\*\*/g, '').replace(/<br\s*\/?>/gi, '\n').trim();
function ownerItems(b) {
  const f = approvalsFile(b); if (!f) return { file: null, items: [] };
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { return { file: null, items: [] }; }
  const items = [], lines = text.split(/\r?\n/);
  let sec = null, head = null;
  for (const line of lines) {
    const h = line.match(/^#{2,3}\s+(.*)/);
    if (h) { sec = /置頂/.test(h[1]) ? '置頂' : /待擁有者/.test(h[1]) ? '待擁有者' : null; head = null; continue; }
    if (!sec || !line.trim().startsWith('|')) { if (!line.trim()) head = head; continue; }
    const c = cellsOf(line);
    if (!head) { head = c; continue; }
    if (c.every(x => /^:?-{3,}:?$/.test(x))) continue;
    const col = re => { const i = head.findIndex(x => re.test(x)); return i >= 0 ? plainMd(c[i]) : ''; };
    const title = col(/^事項/); if (!title) continue;
    const raw = c.join(' '), paths = [];
    for (const m of [...raw.matchAll(/`([^`\s][^`]{1,160})`/g), ...raw.matchAll(/(?:^|[\s(（;；、,，:：])((?:[\w.-]+\/)+[\w.-]*\.(?:md|ts|tsx|json|html|py|mjs|png|jpg|webp|mp4|csv|txt)|(?:[\w.-]+\/){2,})/g)]) { const rel = m[1].replace(/[:：]\d.*$/, '').replace(/\s*§.*$/, '').trim(); if (!/[\/.]/.test(rel) || /^https?:/.test(rel) || paths.some(x => x.p === rel)) continue; let st = null; try { st = fs.statSync(path.resolve(b.dir, rel)); } catch {} if (st) paths.push({ p: rel, dir: st.isDirectory() }); }
    items.push({ paths, key: crypto.createHash('sha1').update(title).digest('hex').slice(0, 12), sec, no: col(/^#$/), added: col(/^加入/), from: col(/^來自|^來源/), owner: col(/^負責/), type: col(/^類型/), title, todo: col(/你要做的事/) || col(/選項/), opts: head.some(x => /你要做的事/.test(x)) ? col(/選項/) : '', due: col(/^期限/), files: col(/^檔案/) });
  }
  return { file: path.relative(b.dir, f).split(path.sep).join('/'), items };
}
// 有角色資料的專案（大樓設定 characters）：從專案資料找角色中文名 → 代號，卡片上的工坊按鈕就能直接開那個角色
const charCache = new Map();
function charIndex(b) {
  const c = b.characters; if (!c) return null;
  const hit = charCache.get(b.id); if (hit && Date.now() - hit.at < 10 * 60e3) return hit;
  const m = new Map();
  let art = null; try { art = new Set(fs.readdirSync(path.resolve(b.dir, c.art)).filter(f => /^[a-z0-9_]+\.png$/.test(f) && !f.includes('__')).map(f => f.slice(0, -4))); } catch {}
  const add = (nm, id) => { if (art && !art.has(id)) return; if (!/^[一-鿿]{1,5}$/.test(nm)) return; if (!m.has(nm) || id.length < m.get(nm).length) m.set(nm, id); };
  const walk = d => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch {} for (const f of ents) { const p2 = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== '__tests__') walk(p2); continue; } if (!/\.ts$/.test(f.name)) continue; const t = fs.readFileSync(p2, 'utf8'); for (const x of t.matchAll(/\b(?:as|say)\(\s*'([a-z0-9_]+)'\s*,\s*'([^']{1,8})'/g)) add(x[2], x[1]); for (const part of t.split(/\bid:\s*'/).slice(1)) { const id = part.match(/^([a-z0-9_]+)'/)?.[1], nm = part.slice(0, 600).match(/\bname:\s*'([^']{1,8})'/)?.[1]; if (id && nm) add(nm, id); } } };
  walk(path.resolve(b.dir, c.sources));
  let projects = []; if (c.projects) try { const pd = path.resolve(b.dir, c.projects); projects = fs.readdirSync(pd).filter(f => f.endsWith('.json')).map(f => ({ id: f.slice(0, -5), t: fs.statSync(path.join(pd, f)).mtimeMs })).sort((a, z) => z.t - a.t); } catch {}
  const names = [...m.keys()].sort((a, z) => z.length - a.length);
  const out = { at: Date.now(), map: m, names, projects }; charCache.set(b.id, out); return out;
}
function charsIn(b, text) {
  const ix = charIndex(b); if (!ix) return [];
  const found = [], seen = new Set(); let t = text;
  for (const nm of ix.names) { if (!t.includes(nm)) continue; const id = ix.map.get(nm); t = t.split(nm).join(' '); if (seen.has(id)) continue; seen.add(id); found.push({ id, name: nm, projects: ix.projects.filter(p => new RegExp('(^|_)' + id + '(_|$)').test(p.id)).slice(0, 3).map(p => p.id) }); }
  for (const id of new Set(ix.map.values())) { if (seen.has(id) || !new RegExp('(^|[^a-z])' + id + '([^a-z]|$)').test(String(text))) continue; seen.add(id); const nm = [...ix.map].find(([, v]) => v === id)?.[0] || id; found.push({ id, name: nm, projects: ix.projects.filter(p => new RegExp('(^|_)' + id + '(_|$)').test(p.id)).slice(0, 3).map(p => p.id) }); }
  return found.slice(0, 6);
}
const ownerWatch = new Set();
function watchOwner(b) {
  const f = approvalsFile(b); if (!f || ownerWatch.has(f)) return;
  ownerWatch.add(f);
  fs.watchFile(f, { interval: 3000 }, () => { try { emit('autopilot', { building: b.id, view: apView(b) }); } catch {} });
}
function ownerReply(b, key, text) {
  const { file, items } = ownerItems(b), it = items.find(x => x.key === key);
  if (!it) throw new Error('這一項已經不在待核可清單裡了（可能剛被處理掉）');
  const st = apState(b); st.replies = st.replies || {};
  const n = nowIn(routinesOf(b)?.timezone);
  const od = ownerDept(b, it), dn = od ? deptsOf(b)[od].name : (b.pm?.name || '總管');
  st.replies[key] = { text, at: Date.now(), title: it.title, status: 'landing', dept: dn };
  const after = b.afterReply;
  const r = { id: 'reply-' + key, dept: od || 'pm', noHandoff: true, keepTier: true, title: '落地你的回覆：' + it.title.slice(0, 24), time: String(n.h).padStart(2, '0') + ':' + String(n.m).padStart(2, '0'), tier: 'standard', maxMinutes: 20,
    onDone: ok => { const x = apState(b).replies?.[key]; if (x) { x.status = ok ? 'done' : 'error'; apSave(b); } if (ok && after?.routine) afterReplyCheck(b, after); },
    prompt: (od ? replyDeptNote(dn) : '') + `擁有者剛在大樓「需要你處理」回覆了待核可清單 \`${file}\` 的這一列：
- 段落：${it.sec}｜編號：${it.no || '—'}｜類型：${it.type || '—'}｜來自：${it.from || '—'}
- 事項：${it.title}
- 原本請他做的事：${it.todo || '—'}
- 期限：${it.due || '—'}｜相關檔案：${it.files || '—'}

擁有者原話：「${text}」${qaNote(st.qa?.[key])}

請照你的手冊把這個決定落地：
1. 照他的原話做；他改了字就一字不改套用。他的話不清楚、或只回答了一部分，不要猜：把該列「你要做的事」改寫成新的問題留在原處，其他能落地的先落地。
2. 落地完成後，把該列從「待擁有者」（或置頂）移到「已決定」，寫上原話和落地到哪；其他列重新編號。
3. 更新相關檔案，在相關部門手冊的收件匣加列通知他們接下來要做什麼。
4. 需要對外發布的內容，照手冊排進發布排程；有時效的，預定時間寫「立刻」、狀態「待發」。你自己不發布任何東西。
5. 不要 commit。最後用繁體中文兩三句回報做了什麼。` };
  apEnqueue(b, r, n, true);
  return st.replies[key];
}
const qaNote = qa => qa?.length ? `\n\n他回覆前問過的問題與總管的回答（一併考慮；他的回覆以原話為準）：\n${qa.map(m => (m.role === 'user' ? '擁有者問：' : '總管答：') + String(m.text).slice(0, 1500)).join('\n')}` : '';
// 擁有者對某一列有疑問、還沒要決定：派 PM 只讀不改，查相關檔案後回答
function ownerAsk(b, key, text) {
  const { file, items } = ownerItems(b), it = items.find(x => x.key === key);
  if (!it) throw new Error('這一項已經不在待核可清單裡了（可能剛被處理掉）');
  const st = apState(b); st.qa = st.qa || {}; const qa = st.qa[key] = st.qa[key] || [];
  if (qa.length && qa[qa.length - 1].pending) throw new Error('上一個問題還在查，等它回答完再問');
  const prev = qa.slice(-8);
  const od = ownerDept(b, it), dn = od ? deptsOf(b)[od].name : (b.pm?.name || '總管');
  qa.push({ role: 'user', text, at: Date.now() }); qa.push({ role: 'pm', who: dn, text: '', at: Date.now(), pending: true });
  const n = nowIn(routinesOf(b)?.timezone);
  const r = { id: 'ask-' + key, dept: od || 'pm', noHandoff: true, keepTier: true, title: '回答你的提問：' + it.title.slice(0, 24), time: String(n.h).padStart(2, '0') + ':' + String(n.m).padStart(2, '0'), tier: 'standard', maxMinutes: 12, mode: 'plan', noNote: true,
    onDone: (ok, ent) => { const a = apState(b).qa?.[key]?.find(m => m.pending); if (a) { a.pending = false; a.text = ok ? String(ent.summary || '（沒有回答）') : '查的時候出錯了：' + (ent.error || '') + '。可以再問一次。'; a.at = Date.now(); a.error = !ok; } apSave(b); emit('notice', { building: b.id, text: `${dn}回答了你的提問：「${it.title.slice(0, 20)}」` }); },
    prompt: `擁有者對待核可清單 \`${file}\` 的這一列有疑問，**還沒有要做決定**，只是想先問清楚：
- 段落：${it.sec}｜編號：${it.no || '—'}｜類型：${it.type || '—'}｜來自：${it.from || '—'}
- 事項：${it.title}
- 要他做的事：${it.todo || '—'}${it.opts ? '\n- 選項與後果：' + it.opts : ''}
- 期限：${it.due || '—'}｜相關檔案：${it.files || '—'}
${prev.length ? '\n之前的問答：\n' + prev.map(m => (m.role === 'user' ? '擁有者問：' : '你答：') + String(m.text).slice(0, 1200)).join('\n') + '\n' : ''}
他現在問：「${text}」

請先讀這一列提到的檔案和相關手冊，再用繁體中文直接回答他：
- 先講答案，短句，具體（引用檔案裡的實際內容、數字、段落位置），不用自創術語。
- 他問「為什麼」就講理由和依據；問「會怎樣」就講各選項的後果。
- 不知道或檔案裡沒寫的，直接說不知道、要誰補什麼，不要猜。
- 最後一行提醒他：想好了可以怎麼回（照這一列「你要做的事」的寫法）。
這一輪只能閱讀，不要修改任何檔案。` };
  apEnqueue(b, r, n, true);
  return qa;
}
function afterReplyCheck(b, after) {
  try {
    const txt = fs.readFileSync(path.resolve(b.dir, after.file), 'utf8');
    if (!new RegExp(after.pattern, 'm').test(txt)) return;
    const R = routinesOf(b), r = R?.routines.find(x => x.id === after.routine); if (!r) return;
    const st = apState(b);
    if (st.runs.some(x => x.routine === r.id && ['queued', 'running'].includes(x.status))) return;
    apEnqueue(b, r, nowIn(R.timezone), true);
    emit('notice', { building: b.id, text: `有要立刻發的核可內容，已派「${r.title}」` });
  } catch (e) { console.log('afterReply 檢查失敗：', e.message); }
}

function routinesOf(b) {
  for (const rel of [b.routines, 'docs/team/routines.json', 'docs/ai-team/routines.json'].filter(Boolean)) {
    const f = path.resolve(b.dir, rel);
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    // 例行工作表裡用 PM 自己的代號（例如 chief）時，當成 PM（大廳的總管）
    const pmId = b.pm?.agentFile ? path.basename(b.pm.agentFile, '.md') : null;
    const routines = (j.routines || []).filter(r => r && r.id && r.time && r.dept).map(r => (pmId && r.dept === pmId) || ['chief', 'pm-chief'].includes(r.dept) ? { ...r, dept: 'pm' } : r);
    return { ...j, file: rel, routines };
  }
  return null;
}
function nowIn(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const date = `${parts.year}-${parts.month}-${parts.day}`, h = +parts.hour % 24, m = +parts.minute;
  const d = new Date(date + 'T00:00:00'); const jan4 = new Date(d.getFullYear(), 0, 4);
  const wk = 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { date, wd, h, m, min: h * 60 + m, day: +parts.day, week: `${parts.year}-W${String(wk).padStart(2, '0')}` };
}
const WD = '日一二三四五六';
// 自動選模型：規劃用最強的（短、決定方向），執行依難易度（長、最耗用量）
// Codex 的模型：astra 最強、sol 是主力、luna 快又省（可在 tower.config.json 的 models 改）
const MODELS = { plan: 'gpt-6-astra', light: 'gpt-6-luna', standard: 'gpt-6.1-sol', heavy: 'gpt-6-astra', ...(CFG.models || {}) };
// 舊設定裡寫的 Claude 模型名稱（opus／sonnet／haiku）自動換成對應的 Codex 模型
const CLAUDE_TO_CODEX = { opus: 'heavy', sonnet: 'standard', haiku: 'light' };
function codexModel(m) { if (!m) return m; const k = Object.keys(CLAUDE_TO_CODEX).find(x => new RegExp(x, 'i').test(m)); return k ? MODELS[CLAUDE_TO_CODEX[k]] : m; }
const LEVELS = ['light', 'standard', 'heavy'];
function routineTier(r) {
  if (r.model) return null;
  if (r.tier && MODELS[r.tier]) return r.tier;
  const t = String(r.title || '') + ' ' + String(r.id || '');
  if (/週計畫|選題|提案|規劃|排程|月回顧|月報|計畫|plan|pitch/i.test(t)) return 'plan';
  if (CFG.deptTiers?.[r.dept] && MODELS[CFG.deptTiers[r.dept]]) return CFG.deptTiers[r.dept];
  if (/快照|對帳|檢查|插隊|簡報|排進|check|snapshot/i.test(t)) return 'light';
  return 'standard';
}
// 需要瀏覽器的能力：背景執行開不了瀏覽器，時間到時改成提醒主管，請桌面版 Codex 用瀏覽器做
const BROWSER_CAPS = new Set(CFG.browserCaps || ['browser', 'owner', 'local-model']);
// 地端模型的工作（例如只能在本機處理的敏感內容）：大樓只有雲端 AI，永遠不派給 Codex，也不產生給 Codex 的指令
const LOCAL_ONLY = new Set(['local-model']);
// 大樓專用瀏覽器：這些能力改由背景部門自己用大樓瀏覽器做，不用再交給桌面版 Codex
const BROWSER = browserConfig(CFG, ROOT);
// 人物看網頁時，放大螢幕顯示那個網頁的真實畫面（另開無頭瀏覽器、空的設定檔，不帶任何登入）
const PAGESHOT = createPageShot(BROWSER.exe, path.join(os.tmpdir(), 'ai-team-tower-pageshot-' + PORT));
process.on('exit', () => PAGESHOT.close());
const AUTO_BROWSER = CFG.autoBrowserCaps || {};
function browserHostsOf(r) {
  const req = (r.requires || []).filter(c => BROWSER_CAPS.has(c));
  if (!req.length || !BROWSER.enabled || !BROWSER.exe || !req.every(c => AUTO_BROWSER[c])) return null;
  return [...new Set(req.flatMap(c => AUTO_BROWSER[c]))];
}
const needsHandoff = r => (r.requires || []).some(c => BROWSER_CAPS.has(c)) && !browserHostsOf(r);
let browserIsUp = false, apBrowserBusy = false;
const checkBrowser = async () => { browserIsUp = await browserUp(BROWSER); };
checkBrowser(); setInterval(checkBrowser, 15e3);
const BROWSER_NOTE = `

---
這一輪你可以自己用「大樓瀏覽器」，不用等擁有者或桌面版 Codex：工具名稱是 mcp__browser__ 開頭（open、read、links、find、click、type、key、scroll、screenshot、upload、wait）。這是大樓專用的瀏覽器視窗，擁有者已經在裡面登入。手冊裡寫「用瀏覽器做」的步驟，這一輪都由你用這個瀏覽器做。
- 讀內容用 read 和 links（省），要看版面、配圖或確認發文結果才用 screenshot。
- 看到登入頁：不要登入、不要輸入任何帳號密碼，停下來，在產出檔「狀態」行寫「卡住（大樓瀏覽器沒登入）」並回報。
- 動作放慢，像真人一樣；只開這個工作需要的頁面。不發私訊，不做手冊沒寫的互動（追蹤、檢舉、封鎖、刪除一律不做）。
- 發文、留言、回覆：只能發待核可清單裡擁有者核可過的原文，一字不改。送出前截圖確認文字一字不差，送出後打開那一則確認真的出現，把連結記進手冊規定的紀錄檔。沒有核可的文字一律不發。`;
const routineOn = (st, r) => (st.overrides && r.id in st.overrides) ? !!st.overrides[r.id] : r.enabled !== false;
function dueToday(r, n) {
  if (Array.isArray(r.days) && r.days.length && !r.days.includes(n.wd)) return false;
  if (r.monthDay) {
    const md = String(r.monthDay), m = md.match(/^first-(sun|mon|tue|wed|thu|fri|sat)/i);
    if (m) { if (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[1].toLowerCase()) !== n.wd || n.day > 7) return false; }
    else if (/^\d+$/.test(md) && +md !== n.day) return false;
  }
  return true;
}
const slotMin = r => { const [h, m] = String(r.time).split(':').map(Number); return h * 60 + (m || 0); };
const ymdShift = (d, k) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
const fillVars = (s, n) => String(s).replaceAll('{yesterday}', ymdShift(n.date, -1)).replaceAll('{md}', n.date.slice(5)).replaceAll('{date}', n.date).replaceAll('{week}', n.week).replaceAll('{weekday}', '週' + WD[n.wd]);
const AUTO_NOTE = `

---
這是「AI 團隊大樓」自動排程派的例行工作，主管現在可能不在線：
- 照你的部門手冊做完這一次就好，不要擴大範圍，也不要開始別的專案。
- 需要主管核可、提供資料或做決定的事，寫進待核可清單（照你的手冊規定的檔案），不要自己拍板，也不要停下來等。
- 不要自己 commit、不要切換或建立 git 分支、不要 push、不要動 git 設定。（有開自動 commit 的專案，做完後大樓會替你 commit 這次改到的檔案。）
- 需要執行終端機指令時，主管可能 10 分鐘內不會批准，請優先用讀寫檔案完成。
- 寫進待核可清單時，一列只問一件事（一個決定）；好幾個決定就拆成好幾列。「來自」欄寫負責部門的編號與名稱，「你要做的事」寫清楚要他決定什麼、怎麼回。
最後用繁體中文回報：先寫結果（交了哪些檔案），再寫待主管處理的事。報告最後固定加一段「## 交接三行」，剛好三行，給下次做這個工作的人直接接手：
做完：…
卡在：…（沒有就寫「無」）
下次先：…`;
let apRunning = 0;
const apQueue = [];
function apView(b) {
  const st = apState(b), R = routinesOf(b), n = nowIn(R?.timezone);
  const today = st.runs.filter(x => x.date === n.date);
  const routines = (R?.routines || []).map(r => {
    const last = [...st.runs].reverse().find(x => x.routine === r.id && x.date === n.date);
    const miss = (r.requires || []).filter(c => !st.caps[c]);
    return { id: r.id, dept: r.dept, title: r.title, time: r.time, days: r.days, monthDay: r.monthDay || null, enabled: routineOn(st, r), fileEnabled: r.enabled !== false, requires: r.requires || [], browser: needsHandoff(r), towerBrowser: !!browserHostsOf(r), missing: miss, today: dueToday(r, n), last: last || null, handoff: st.handoff?.[r.id] || null, gated: !!((b.gates || {})[r.id] || r.gate) };
  });
  watchOwner(b);
  const own = ownerItems(b), reps = st.replies || {};
  return { owner: { file: own.file, uploadDir: b.uploadDir || '_owner-uploads', workshops: (b.workshops || []).map(({ id, name, desc, match, url, charUrl, projectUrl }) => ({ id, name, desc, match, url, charUrl, projectUrl })), items: own.items.map(x => ({ ...x, dept: (d => d ? deptsOf(b)[d].name : (b.pm?.name || '總管'))(ownerDept(b, x)), chars: charsIn(b, [x.title, x.todo, x.opts, x.files].join(' ')), qa: (st.qa || {})[x.key] || [], reply: reps[x.key] || null })) }, towerBrowserState: { up: browserIsUp, exe: !!BROWSER.exe, enabled: BROWSER.enabled }, permMode: permOf(b), models: MODELS, enabled: st.enabled, dailyCap: st.dailyCap, caps: st.caps, file: R?.file || null, tz: R?.timezone || 'Asia/Taipei', now: n, todayCount: today.filter(x => ['done', 'running', 'error'].includes(x.status) && !/^(reply|ask)-/.test(x.routine || '')).length, routines, runs: st.runs.slice(-60).reverse(), backupDir: backupDirOf(b, BACKUP_ROOT), autonomy: Object.fromEntries(Object.keys(deptsOf(b)).map(id => [id, levelOf(b, id)])), reports: (st.reports || []).slice(-30).reverse(), todayCost: +todayCost(b).toFixed(2), budgetUsd: budgetOf(b) };
}
function apEnqueue(b, r, n, manual) {
  const st = apState(b);
  const ent = { id: 'auto-' + r.id.replace(/[^\w-]/g, '') + '-' + n.date.replace(/-/g, '') + '-' + String(n.h).padStart(2, '0') + String(n.m).padStart(2, '0') + (st.runs.some(x => x.id.startsWith('auto-' + r.id.replace(/[^\w-]/g, '') + '-' + n.date.replace(/-/g, '') + '-' + String(n.h).padStart(2, '0') + String(n.m).padStart(2, '0'))) ? '-' + Date.now().toString(36).slice(-4) : ''), routine: r.id, title: r.title, dept: r.dept, date: n.date, time: r.time, status: 'queued', at: Date.now(), manual: !!manual };
  st.runs.push(ent); apQueue.push({ b, r, n, ent }); apSave(b); apPump();
}
function apPump() {
  const max = CFG.autopilotConcurrency || 2;
  for (let i = 0; i < apQueue.length && apRunning < max; i++) {
    const job = apQueue[i];
    const busy = [...autoTasks.values()].some(t => t.building === job.b.id && t.dept === job.r.dept && t.running);
    if (busy) continue;
    const needB = !!browserHostsOf(job.r); // 大樓瀏覽器一次只給一個部門用
    if (needB && apBrowserBusy) continue;
    apQueue.splice(i, 1); i--;
    if (needB) apBrowserBusy = true;
    apRunning++; apRun(job).finally(() => { apRunning--; if (needB) apBrowserBusy = false; apPump(); });
  }
}
async function apRun({ b, r, n, ent }) {
  const dept = r.dept === 'pm' ? null : r.dept;
  if (dept && !deptsOf(b)[dept]) { ent.status = 'error'; ent.error = '找不到部門 ' + dept; apSave(b); return; }
  const t = { id: ent.id, building: b.id, title: '自動：' + r.title, rounds: [{ n: 1, depts: {} }], cost: 0, auto: true, dept: r.dept, running: true };
  autoTasks.set(t.id, t); specialTitles.set(t.id, t.title);
  const rt = { abort: new AbortController() }; runtime.set(t.id, rt);
  const timer = setTimeout(() => rt.abort.abort(), Math.max(5, +r.maxMinutes || 25) * 60e3);
  ent.status = 'running'; ent.startedAt = Date.now(); apSave(b);
  try {
    ent.model = r.model || MODELS[budgetTier(b, r, routineTier(r), ent)] || MODELS.standard; apSave(b);
    const prev = !r.noHandoff && apState(b).handoff?.[r.id];
    const hosts = browserHostsOf(r);
    if (hosts) { ent.browser = true; if (!await ensureBrowser(BROWSER, 'https://' + hosts[0] + '/')) throw new Error('大樓瀏覽器開不起來（找不到 Brave／Chrome，或除錯連接埠被占用）'); browserIsUp = true; }
    const out = await runClaude({ model: ent.model, t, dept, browser: hosts, prompt: (prev ? `上次（${prev.date.slice(5)} ${prev.time}）這個工作留下的交接三行：\n${prev.text}\n先從這裡接著做，已經做完的不用重新翻找。\n\n` : '') + fillVars(r.prompt || r.title, n) + (hosts ? BROWSER_NOTE : '') + (r.noNote ? '' : AUTO_NOTE), mode: r.mode || 'run', phaseName: '自動排程：' + r.title, label: ['自動排程：' + r.title, '例行工作完成'] });
    ent.status = 'done'; ent.summary = String(out.text || '').slice(0, 4000); ent.cost = out.cost || 0;
    if (b.autoCommit && r.mode !== 'plan') { const cm = await autoCommit(b, out.files, r.title, dept ? (deptsOf(b)[dept]?.name || dept) : (b.pm?.name || '總管'), ent.model); if (cm) { ent.commit = cm.msg; if (cm.hash) ent.commitHash = cm.hash; } }
    const txt = String(out.text || ''), st2 = apState(b);
    if (!r.noHandoff) { const hm = txt.match(/交接三行[^\n]*\n([\s\S]{0,800})/); const lines = hm ? hm[1].split('\n').map(x => x.replace(/^[\s>*•-]+/, '').trim()).filter(x => /^(做完|卡在|下次先)/.test(x)).slice(0, 3) : []; if (lines.length) { st2.handoff = st2.handoff || {}; st2.handoff[r.id] = { text: lines.join('\n'), date: n.date, time: r.time }; ent.handoff = lines.join('\n'); } }
    if (!dept && r.mode !== 'plan') { for (const m of txt.matchAll(/```json\s*([\s\S]*?)```/g)) { try { const j = JSON.parse(m[1]); if (Array.isArray(j.delegate)) apDelegate(b, j.delegate, r.title); } catch {} } }
    if (dept && !String(r.id).startsWith('dlg-') && ['autonomous', 'release'].includes(levelOf(b, dept))) { const sm = txt.match(/#+\s*部門自行決定[^\n]*\n([\s\S]*?)(?=\n#+\s|$)/); const body = sm?.[1]?.trim(); if (body && !/^[（(]?無[)）]?$/.test(body)) apReport(b, { id: 'self-' + ent.id, kind: 'self', dept, title: r.title, summary: body.slice(0, 3000), runId: ent.id, at: Date.now(), status: 'done', seen: false }); }
    await writeDoc(t, `r1-${dept || 'pm'}-report.md`, `# ${r.title}\n\n${n.date} ${r.time} 自動排程\n\n${out.text || ''}`);
  } catch (e) {
    ent.status = 'error'; ent.error = rt.abort.signal.aborted ? `超過 ${r.maxMinutes || 25} 分鐘上限，已停止` : String(e.message || e).slice(0, 300);
  } finally {
    clearTimeout(timer); t.running = false; ent.endedAt = Date.now(); apSave(b);
    if (typeof r.onDone === 'function') { try { r.onDone(ent.status === 'done', ent); } catch (e) { console.log('onDone 失敗：', e.message); } }
    // 任何工作做完，發布排程裡有「立刻＋待發」的項目就馬上派發布
    else if (ent.status === 'done' && b.afterReply?.routine && r.id !== b.afterReply.routine) afterReplyCheck(b, b.afterReply);
  }
}
function apTick() {
  for (const b of buildings) {
    const st = apState(b); if (!st.enabled) continue;
    const R = routinesOf(b); if (!R) continue;
    const n = nowIn(R.timezone);
    for (const r of R.routines) {
      if (!routineOn(st, r) || !dueToday(r, n)) continue;
      const sm = slotMin(r); if (n.min < sm || n.min > sm + AP_GRACE_MIN) continue;
      if (st.runs.some(x => x.routine === r.id && x.date === n.date && !x.manual)) continue;
      const miss = (r.requires || []).filter(c => !st.caps[c]);
      if (miss.length) { st.runs.push({ id: 'skip-' + r.id + '-' + n.date, routine: r.id, title: r.title, dept: r.dept, date: n.date, time: r.time, status: 'skipped', error: '還沒開通：' + miss.join('、'), at: Date.now() }); apSave(b); continue; }
      const why = gateCheck(b, r, n);
      if (why) { st.runs.push({ id: 'gate-' + r.id + '-' + n.date, routine: r.id, title: r.title, dept: r.dept, date: n.date, time: r.time, status: 'skipped', gated: true, error: '沒有新東西，這次沒叫 AI：' + why, at: Date.now() }); apSave(b); continue; }
      if (needsHandoff(r)) {
        const dn = r.dept === 'pm' ? (b.pm?.name || 'PM') : (deptsOf(b)[r.dept]?.name || r.dept);
        if ((r.requires || []).some(c => LOCAL_ONLY.has(c))) {
          st.runs.push({ id: 'hand-' + r.id + '-' + n.date, routine: r.id, title: r.title, dept: r.dept, date: n.date, time: r.time, status: 'handoff', localOnly: true, at: Date.now() });
          apSave(b); emit('notice', { building: b.id, text: `輪到「${r.title}」：這是地端模型的工作，大樓不會交給雲端 AI，請用你的地端流程處理` }); continue;
        }
        st.runs.push({ id: 'hand-' + r.id + '-' + n.date, routine: r.id, title: r.title, dept: r.dept, date: n.date, time: r.time, status: 'handoff', at: Date.now(),
          prompt: `請照「${b.name}」大樓${dn}的手冊，用我的瀏覽器幫我做這件例行工作：「${r.title}」。\n專案資料夾：${b.dir}\n\n${fillVars(r.prompt || r.title, n)}` });
        apSave(b); emit('notice', { building: b.id, text: `輪到「${r.title}」：需要瀏覽器，請到「自動」面板複製指令給桌面版 Codex` }); continue;
      }
      const used = st.runs.filter(x => x.date === n.date && ['done', 'running', 'queued', 'error'].includes(x.status) && !/^(reply|ask)-/.test(x.routine || '')).length; // 擁有者自己的回覆、提問不算
      if (used >= (st.dailyCap || 40)) { st.runs.push({ id: 'cap-' + r.id + '-' + n.date, routine: r.id, title: r.title, dept: r.dept, date: n.date, time: r.time, status: 'skipped', error: `今天已達上限 ${st.dailyCap} 次`, at: Date.now() }); apSave(b); continue; }
      apEnqueue(b, r, n, false);
    }
  }
}
if (ENGINE !== 'mock' || process.env.TOWER_AUTOPILOT_TEST) setInterval(() => { try { apTick(); } catch (e) { console.log('排程錯誤：', e.message); } }, 20e3);

/* ---------- 任務建立 / 追加 / 取消 ---------- */
function newRound(t, text) {
  const r = { n: t.rounds.length + 1, text, createdAt: Date.now(), status: 'planning', depts: {}, plan: null };
  t.rounds.push(r);
  return r;
}
function createTask(building, text, goalId) {
  const t = { id: Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), building, title: text.slice(0, 18), createdAt: Date.now(), status: 'planning', rounds: [], sessions: {}, cost: 0, goalId: goalId || null };
  newRound(t, text); tasks.set(t.id, t); runtime.set(t.id, { abort: new AbortController() });
  pushTask(t); pmPlan(t);
  return t;
}
function followUp(t, text) {
  const last = t.rounds[t.rounds.length - 1];
  if (!['done', 'error'].includes(last.status) && t.status !== 'attention' && t.status !== 'cancelled') throw new Error('這一輪還在進行中，完成後才能追加需求');
  runtime.set(t.id, { abort: new AbortController() });
  newRound(t, text); pushTask(t); pmPlan(t);
}
function cancel(t) {
  runtime.get(t.id)?.abort.abort();
  for (const [id, a] of approvals) if (a.taskId === t.id) { a.resolve({ allow: false, message: '任務已取消' }); approvals.delete(id); emit('approval_done', { id, allow: false }); }
  const r = t.rounds[t.rounds.length - 1];
  for (const d of Object.values(r.depts)) if (['planning', 'running', 'review'].includes(d.status)) d.status = 'cancelled';
  r.status = 'cancelled'; t.status = 'cancelled'; pushTask(t);
}


/* ---------- 新增大樓：基本四部門，或由 Codex 設計整個團隊 ---------- */
const STYLES = ['board', 'research', 'design', 'dev', 'test'];
const ICON_NAMES = ['code', 'terminal', 'globe', 'book', 'pen', 'wrench', 'folder', 'cup', 'check', 'server', 'inbox', 'rocket', 'eye', 'target'];
const PALETTE = [['#cbe7ea', '#2f7f86'], ['#f6d2bd', '#b8643a'], ['#bfe3cf', '#2f8a5f'], ['#f3dc9a', '#a07818'], ['#e6d4f1', '#8a5aa8'], ['#d3e1f1', '#456f9e'], ['#f7c9dc', '#b04a78'], ['#d4e6c3', '#5b8a32'], ['#e3ddcf', '#77684a'], ['#f9d9ab', '#b5651d'], ['#c9e4f3', '#2c79a6'], ['#e6d6cf', '#8a5143']];
const setupJobs = new Map(); // 大樓代號 -> 設計進度
function newBuildingId(name) {
  const base = (String(name).toLowerCase().match(/[a-z0-9]+/g) || []).join('-').slice(0, 24) || 'b' + crypto.randomBytes(2).toString('hex');
  const root = /^[a-z]/.test(base) ? base : 'b-' + base;
  const taken = x => buildings.some(b => b.id === x) || setupJobs.has(x) || draftBuildings.has(x);
  let id = root, n = 2; while (taken(id)) id = root + '-' + n++;
  return id;
}
function resolveProjectDir(input, id) {
  const raw = String(input || '').trim().replace(/^["']+|["']+$/g, '');
  const rel = (raw || path.join('workspaces', id)).replace(/\\/g, '/');
  const dir = path.resolve(ROOT, rel);
  if (dir === ROOT) throw new Error('專案資料夾不能是大樓資料夾本身');
  const same = buildings.find(b => path.resolve(b.dir) === dir) || [...setupJobs.values()].find(j => j.status === 'designing' && j.dir === dir);
  if (same) throw new Error(`這個資料夾已經是「${same.name}」大樓了`);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new Error('這個路徑是檔案，不是資料夾');
  fs.mkdirSync(dir, { recursive: true });
  return { dir, projectDir: path.isAbsolute(rel) ? dir.replace(/\\/g, '/') : rel };
}
function addBuilding(entry) {
  let raw = {}; try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  raw.buildings = [...(raw.buildings || []).filter(x => x.id !== entry.id), entry];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n');
  CFG.buildings = raw.buildings;
  const b = normBuilding(entry); buildings.push(b);
  fs.mkdirSync(towerDir(b), { recursive: true });
  console.log(`新增大樓「${b.name}」→ ${b.dir}`);
  emit('buildings', { id: b.id, name: b.name });
  return b;
}
// 寫進專案的檔案一律不覆蓋：已經有同名檔案就另存成 -2、-3
function writeNew(dir, rel, text) {
  const ext = path.extname(rel), stem = rel.slice(0, rel.length - ext.length);
  let r = rel, n = 2; while (fs.existsSync(path.join(dir, r))) r = `${stem}-${n++}${ext}`;
  fs.mkdirSync(path.dirname(path.join(dir, r)), { recursive: true });
  fs.writeFileSync(path.join(dir, r), String(text).replace(/\r\n/g, '\n').trim() + '\n');
  return r;
}
const INBOX_MD = '\n\n## 收件匣\n其他部門需要你配合時，在這裡加一列：要改什麼、怎麼驗收、不能動什麼。\n\n| 日期 | 來自 | 要改什麼 | 怎麼驗收 | 不能動什麼 |\n|---|---|---|---|---|\n';
const withInbox = s => /##\s*收件匣/.test(s) ? s : s.trim() + INBOX_MD;
const agentMd = (id, desc, prompt, hb) => `---\nname: ${id}\ndescription: ${String(desc || id).replace(/\s+/g, ' ').slice(0, 200)}\n---\n\n${String(prompt).trim()}\n\n工作前先讀你的手冊：\`${hb}\`。\n`;
const APPROVALS_MD = `# 待核可清單

各部門需要你決定的事寫在這裡。大樓會讀「待擁有者」段的表格，每一列變成「需要你處理」裡的一個項目；你在大樓回覆後，負責的部門會照你的話落地，再把那一列移到「已決定」。

## 待擁有者

| # | 加入 | 來自 | 類型 | 事項 | 你要做的事 | 期限 | 檔案 |
|---|---|---|---|---|---|---|---|

## 已決定

| # | 決定日 | 事項 | 你的原話 | 落地到哪 |
|---|---|---|---|---|
`;
function cleanDesign(j) {
  if (!j || typeof j !== 'object') throw new Error('Codex 沒有回傳團隊設計');
  const seen = new Set(['pm', 'company', 'chief']);
  const depts = (Array.isArray(j.departments) ? j.departments : []).filter(d => d && String(d.prompt || '').trim()).slice(0, 10).map((d, i) => {
    let id = String(d.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    if (!/^[a-z]/.test(id)) id = 'dept-' + (i + 1);
    while (seen.has(id)) id += '-2'; seen.add(id);
    const [wall, ink] = PALETTE[i % PALETTE.length];
    return { id, name: String(d.name || id).trim().slice(0, 12), line: String(d.line || '').trim().slice(0, 8), members: Math.min(6, Math.max(1, Math.round(+d.members || 2))), style: STYLES.includes(d.style) ? d.style : 'research', icon: ICON_NAMES.includes(d.icon) ? d.icon : 'folder', wall, ink, description: String(d.description || '').trim(), prompt: String(d.prompt).trim(), handbook: String(d.handbook || '').trim() };
  });
  if (depts.length < 2) throw new Error('Codex 設計的部門少於 2 個，請把需求寫具體一點再試一次');
  const pm = j.pm || {};
  return { summary: String(j.summary || '').trim(), plan: String(j.plan || '').trim(), pm: { name: String(pm.name || '總管').trim().slice(0, 10), description: String(pm.description || '').trim(), prompt: String(pm.prompt || '').trim(), handbook: String(pm.handbook || '').trim() }, depts };
}
function writeTeam(job, dz) {
  const dir = job.dir, pmName = dz.pm.name;
  const hbPm = writeNew(dir, 'docs/team/00-chief.md', withInbox(dz.pm.handbook || `# 00 ${pmName}手冊\n\n## 負責範圍\n- 把擁有者的需求拆給各部門、安排先後順序、彙整報告。`));
  const agPm = writeNew(dir, '.codex/agents/chief.md', agentMd('chief', dz.pm.description || `${job.name}的${pmName}（PM）`, dz.pm.prompt || `你是${job.name}的${pmName}。你把擁有者的需求拆給各部門、安排先後順序，最後彙整報告。你自己不寫程式、不改檔案。`, hbPm));
  const departments = dz.depts.map((d, i) => {
    const no = String(i + 1).padStart(2, '0');
    const hb = writeNew(dir, `docs/team/${no}-${d.id}.md`, withInbox(d.handbook || `# ${no} ${d.name}手冊\n\n## 負責範圍\n- ${d.description || d.name}`));
    const ag = writeNew(dir, `.codex/agents/${d.id}.md`, agentMd(d.id, d.description || d.name, d.prompt, hb));
    return { id: d.id, name: d.name, ...(d.line ? { line: d.line } : {}), members: d.members, style: d.style, icon: d.icon, wall: d.wall, ink: d.ink, agentFile: ag, handbook: hb };
  });
  if (!['approvals.md', 'docs/approvals.md'].some(f => fs.existsSync(path.join(dir, f)))) writeNew(dir, 'approvals.md', APPROVALS_MD);
  let plan = ['docs/company-plan.md', 'docs/plan.md'].find(f => fs.existsSync(path.join(dir, f))) || '';
  if (!plan && dz.plan) plan = writeNew(dir, 'docs/company-plan.md', dz.plan);
  return { id: job.id, name: job.name, projectDir: job.projectDir, ...(plan ? { plan } : {}), pm: { name: pmName, agentFile: agPm, handbook: hbPm }, departments };
}
const DESIGN_SYSTEM = `你是「AI 團隊大樓」的組織設計顧問。你替一個專案設計 AI 團隊：一位 PM（總管）和幾個部門，並寫出每個角色的設定與手冊。你只閱讀專案、不修改任何檔案，最後只回傳 JSON。一律使用繁體中文。`;
const Q3 = '"'.repeat(3);
const designPrompt = job => `【設計大樓】今天是 ${today()}。擁有者要在「AI 團隊大樓」新增一棟大樓「${job.name}」，專案資料夾就是目前的工作目錄（可能是空的）。

擁有者的需求：
${Q3}
${job.brief}
${Q3}

請先看一下專案資料夾現有的內容（README、文件、程式結構、已經有的 AGENTS.md、.codex/agents、.claude/agents），再替這個專案設計 AI 團隊：一位 PM（總管）和 3～8 個部門。這一輪只能閱讀，不要修改任何檔案；檔案會由大樓照你的 JSON 建立。

只回傳一個 JSON（放在 \`\`\`json 區塊），格式：
{
  "summary": "你怎麼設計這個團隊、為什麼（2～3 句）",
  "pm": { "name": "PM 的稱呼，例如總管、總編輯", "description": "一句話職責", "prompt": "角色設定", "handbook": "PM 手冊（Markdown）" },
  "departments": [
    { "id": "英文代號", "name": "中文部門名，例如設計部", "line": "所屬產線，例如製作線（可留空）", "members": 2, "style": "dev", "icon": "code", "description": "一句話職責", "prompt": "角色設定", "handbook": "部門手冊（Markdown）" }
  ],
  "plan": "公司計畫書（Markdown）；專案裡已經有計畫書就給空字串"
}

規則：
- id 只能用小寫英文、數字、連字號，2～24 字，不能用 pm、company、chief。
- members 是部門人數，1～6，依工作量決定。
- style 是辦公室擺設，只能是 board（會議桌）、research（書架）、design（繪圖桌）、dev（電腦桌）、test（測試台）其中之一，選最像那個部門工作場景的。
- icon 只能是：${ICON_NAMES.join('、')}。
- prompt：用第二人稱寫這個角色是誰、負責什麼、不做什麼，5～10 行。
- handbook：至少包含「## 負責範圍」「## 要擁有者核可的事」「## 交付物放哪」三段，具體到這個專案的資料夾與檔案。手冊標題用「# 編號 部門名手冊」，PM 是 00，部門依陣列順序從 01 開始。
- plan：如果要寫，包含現況、年度目標、時程、核可等級（自動、核可、人）。
- 部門不要重疊；寧可少而清楚，不要為了湊數加部門。`;
async function designBuilding(job) {
  const t = { id: 'setup-' + job.id, building: job.id, title: '設計大樓：' + job.name, rounds: [{ n: 1, depts: {} }], cost: 0 };
  job.taskId = t.id;
  draftBuildings.set(job.id, { id: job.id, name: job.name, dir: job.dir });
  specialTitles.set(t.id, '設計大樓');
  runtime.set(t.id, { abort: new AbortController() });
  emit('setup', job);
  try {
    const out = await runClaude({ t, dept: null, prompt: designPrompt(job), mode: 'plan', phaseName: '設計大樓', label: ['開始設計團隊', '團隊設計完成'], model: MODELS.plan, system: DESIGN_SYSTEM });
    const dz = cleanDesign(extractJson(out.text));
    const entry = writeTeam(job, dz);
    Object.assign(job, { status: 'done', summary: dz.summary, cost: t.cost, depts: entry.departments.map(d => d.name) });
    draftBuildings.delete(job.id);
    addBuilding(entry);
  } catch (e) { job.status = 'error'; job.error = String(e.message || e).slice(0, 400); }
  finally { job.endedAt = Date.now(); draftBuildings.delete(job.id); runtime.delete(t.id); emit('setup', job); }
}
async function checkAuth(mode, key) {
  if (mode === 'subscription') {
    if (!CODEX_PATH) return { ok: false, text: '找不到 Codex。請先安裝 Codex 桌面版（或 npm install -g @openai/codex），再重新啟動大樓。' };
    const a = await codexAccount(CODEX_PATH, authEnv('subscription'));
    if (a.ok && a.type === 'chatgpt') return { ok: true, text: `已登入${a.email ? '：' + a.email : ''}${a.plan ? `（${a.plan} 方案）` : ''}` };
    if (a.ok) return { ok: false, text: '這台電腦的 Codex 目前是用 API 金鑰登入，不是 ChatGPT 帳號。請按「用 ChatGPT 登入」。' };
    if (a.error) return { ok: false, text: '檢查失敗：' + a.error };
    return { ok: false, text: '還沒登入。請按「用 ChatGPT 登入」，在打開的網頁用你的 ChatGPT 帳號登入。' };
  }
  if (!key) return { ok: false, text: '還沒有 API 金鑰' };
  if (!KEY_RE.test(key)) return { ok: false, text: '金鑰格式不對，應該是 sk- 開頭的一長串文字' };
  try {
    const r = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/models', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
    if (r.ok) return { ok: true, text: '金鑰有效' };
    return { ok: false, text: r.status === 401 ? '金鑰無效，請確認有沒有複製完整' : r.status === 403 ? '這把金鑰沒有權限' : `驗證失敗（HTTP ${r.status}）` };
  } catch (e) { return { ok: false, text: '連不到 OpenAI API：' + String(e.message || e).slice(0, 120) }; }
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function body(req) { let s = ''; for await (const c of req) { s += c; if (s.length > 2e6) throw new Error('內容太大'); } return s ? JSON.parse(s) : {}; }
function state(ext) {
  if (ext) { const st = state(false), ok = SHARE_BUILDINGS(); return { ...st, share: true, buildings: st.buildings.filter(b => ok.includes(b.id)).map(b => ({ ...b, projectDir: '' })), tasks: st.tasks.filter(t => ok.includes(t.building)), approvals: [], codexPath: '', apiKeyHint: '', login: null, setups: [] }; }
  return {
    live: true, ready: !!query, engineError, engine: ENGINE, codexPath: CODEX_PATH || '', codexFound: !!CODEX_PATH, ...authInfo(), setups: [...setupJobs.values()],
    depts: Object.fromEntries(Object.entries(DEPTS).map(([k, v]) => [k, v.name])),
    buildings: buildings.map(b => ({ id: b.id, name: b.name, projectDir: b.dir, counts: b.counts, departments: b.departments || null, pm: b.pm ? { name: b.pm.name } : null })),
    tasks: [...tasks.values()],
    approvals: [...approvals.values()].map(({ resolve, ...a }) => a),
  };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ext = isExternal(req);
  if (ext) {
    const cookieOk = (req.headers.cookie || '').split(/;\s*/).includes('tower_share=' + SHARE_TOKEN), qOk = url.searchParams.get('k') === SHARE_TOKEN;
    if (!cookieOk && !qOk) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<meta charset="utf-8"><title>AI 團隊大樓</title><body style="font-family:sans-serif;padding:40px;color:#444"><h2>這是私人展示</h2><p>請使用主人提供的完整分享連結開啟。</p></body>'); }
    if (qOk && !cookieOk) res.setHeader('Set-Cookie', `tower_share=${SHARE_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=86400`);
    if (req.method !== 'GET' || p.startsWith('/mcp/')) { res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '展示模式只能看，不能操作' })); }
    const bm = p.match(/^\/api\/b\/([\w-]+)\//), tm = p.match(/^\/api\/tasks\/([\w-]+)\//);
    if ((bm && !SHARE_BUILDINGS().includes(bm[1])) || (tm && !SHARE_BUILDINGS().includes(taskBuilding(tm[1])))) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '找不到' })); }
  }
  try {
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state(ext))}\n\n`);
      clients.set(res, { ext });
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    let mm;
    if ((mm = p.match(/^\/mcp\/([\w-]+)$/))) return handleMcp(req, res, mm[1]);
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-tower'] !== '1') return send(res, 403, { error: '拒絕跨站請求' });
      if (p === '/api/state') return send(res, 200, state(ext));
      if (p === '/api/pageshot') { const jpg = await PAGESHOT.get(url.searchParams.get('u')); if (!jpg) return send(res, 404, { error: '沒有這個網頁的畫面' }); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600' }); return res.end(jpg); }
      if (p === '/api/auth' && req.method === 'POST') {
        const bd = await body(req);
        if (bd.clearKey) delete LOCAL.apiKey;
        if (typeof bd.apiKey === 'string' && bd.apiKey.trim()) { const k = bd.apiKey.trim(); if (!KEY_RE.test(k)) return send(res, 400, { error: '金鑰格式不對，應該是 sk- 開頭的一長串文字' }); LOCAL.apiKey = k; }
        if (bd.mode) { if (!AUTH_MODES.includes(bd.mode)) return send(res, 400, { error: '不支援這種登入方式' }); if (bd.mode === 'api' && !apiKey()) return send(res, 400, { error: '請先填入 API 金鑰' }); LOCAL.auth = bd.mode; }
        if (authMode() === 'api' && !apiKey()) LOCAL.auth = 'subscription'; // 金鑰刪掉了就回到訂閱登入
        saveLocal(); emit('auth', authInfo()); console.log('登入方式：' + AUTH_LABEL[authMode()]);
        return send(res, 200, authInfo());
      }
      // 用 ChatGPT 帳號登入：回傳登入網址（畫面會打開它），登入完成後透過 auth 事件通知畫面
      if (p === '/api/auth/login' && req.method === 'POST') {
        const bd = await body(req);
        if (bd.cancel) { loginJob?.cancel(); loginJob = null; emit('auth', authInfo()); return send(res, 200, authInfo()); }
        if (!CODEX_PATH) return send(res, 400, { error: '找不到 Codex，請先安裝 Codex 桌面版' });
        try { await startChatgptLogin(!!bd.device); } catch (e) { return send(res, 500, { error: '打不開登入頁：' + String(e.message || e).slice(0, 200) }); }
        emit('auth', authInfo()); return send(res, 200, authInfo());
      }
      if (p === '/api/auth/check' && req.method === 'POST') {
        const bd = await body(req), mode = bd.mode === 'api' ? 'api' : 'subscription', given = typeof bd.apiKey === 'string' ? bd.apiKey.trim() : '';
        const r = await checkAuth(mode, given || apiKey());
        if (r.ok && bd.use) { if (given) LOCAL.apiKey = given; LOCAL.auth = mode; saveLocal(); emit('auth', authInfo()); console.log('登入方式：' + AUTH_LABEL[mode]); }
        return send(res, 200, { ...r, ...authInfo() });
      }
      if (p === '/api/buildings' && req.method === 'POST') {
        const bd = await body(req), name = String(bd.name || '').trim().slice(0, 30), ai = bd.mode !== 'basic';
        if (!name) return send(res, 400, { error: '請輸入大樓名稱' });
        if (ai && !query) return send(res, 400, { error: engineError });
        if (ai && !String(bd.brief || '').trim()) return send(res, 400, { error: '請寫下這個團隊要做什麼，Codex 才能設計部門' });
        const id = newBuildingId(name); let pd;
        try { pd = resolveProjectDir(bd.projectDir, id); } catch (e) { return send(res, 400, { error: e.message }); }
        if (!ai) { const b = addBuilding({ id, name, projectDir: pd.projectDir }); return send(res, 200, { ok: true, id: b.id, name: b.name }); }
        const job = { id, name, dir: pd.dir, projectDir: pd.projectDir, brief: String(bd.brief).trim().slice(0, 4000), status: 'designing', startedAt: Date.now() };
        setupJobs.set(id, job); designBuilding(job);
        return send(res, 200, job);
      }
      const sm = p.match(/^\/api\/buildings\/setup\/([\w-]+)\/cancel$/);
      if (sm && req.method === 'POST') {
        const rt = runtime.get('setup-' + sm[1]); if (rt) rt.abort.abort();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/browser' && req.method === 'GET') { await checkBrowser(); return send(res, 200, { up: browserIsUp, exe: !!BROWSER.exe }); }
      if (p === '/api/browser/open' && req.method === 'POST') { const bd = await body(req); const hosts = [...new Set(Object.values(AUTO_BROWSER).flat())], hostOk = s => { try { const h = new URL(s).hostname; return new URL(s).protocol === 'https:' && hosts.some(a => h === a || h.endsWith('.' + a)); } catch { return false; } }; const u = hostOk(bd.url) ? bd.url : hosts[0] ? 'https://' + hosts[0] + '/' : 'about:blank'; const ok = await ensureBrowser(BROWSER, u); browserIsUp = ok; return send(res, ok ? 200 : 500, ok ? { up: true } : { error: '大樓瀏覽器開不起來（找不到 Brave／Chrome，或連接埠被占用）' }); }
      // 人工處理：上傳素材、打開資料夾或檔案、開工坊（只限本機；展示模式的 POST 一律被擋）
      let om;
      if ((om = p.match(/^\/api\/b\/([\w-]+)\/owner\/(upload|open|workshop)$/)) && req.method === 'POST') {
        const b = buildings.find(x => x.id === om[1]); if (!b) return send(res, 404, { error: '找不到大樓' });
        const inside = f => { const r = path.relative(b.dir, f); return !r.startsWith('..') && !path.isAbsolute(r); };
        if (om[2] === 'upload') {
          const name = String(url.searchParams.get('name') || 'file').replace(/[\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-120) || 'file';
          const n = nowIn(routinesOf(b)?.timezone);
          const dir = path.resolve(b.dir, b.uploadDir || '_owner-uploads', n.date);
          if (!inside(dir)) return send(res, 400, { error: '上傳資料夾設定錯誤' });
          fs.mkdirSync(dir, { recursive: true });
          const ext = path.extname(name), stem = path.basename(name, ext);
          let out = path.join(dir, name); for (let i = 2; fs.existsSync(out); i++) out = path.join(dir, `${stem}-${i}${ext}`);
          const max = (b.uploadMaxMB || 4096) * 1048576; let size = 0;
          try {
            await new Promise((resolve, reject) => {
              const ws = fs.createWriteStream(out);
              req.on('data', c => { size += c.length; if (size > max) { req.unpipe(ws); ws.destroy(); reject(new Error(`檔案超過 ${b.uploadMaxMB || 4096} MB`)); } });
              req.on('error', reject); ws.on('error', reject); ws.on('finish', resolve); req.pipe(ws);
            });
          } catch (e) { try { fs.unlinkSync(out); } catch {} return send(res, 400, { error: e.message }); }
          return send(res, 200, { path: path.relative(b.dir, out).split(path.sep).join('/'), size });
        }
        const bd = await body(req);
        if (om[2] === 'open') {
          const rel = String(bd.path || '').trim(), f = path.resolve(b.dir, rel || '.');
          if (!inside(f) && f !== b.dir) return send(res, 400, { error: '只能打開專案資料夾裡的東西' });
          if (!fs.existsSync(f)) return send(res, 404, { error: '找不到 ' + rel });
          openInFiles(f);
          return send(res, 200, { ok: true });
        }
        if (om[2] === 'workshop') {
          const w = (b.workshops || []).find(x => x.id === bd.id); if (!w) return send(res, 404, { error: '找不到這個工坊' });
          const up = async () => { try { const r = await fetch(w.check || w.url, { signal: AbortSignal.timeout(1500) }); return r.status < 500; } catch { return false; } };
          if (!(await up())) {
            const svcs = w.services || (w.start ? [{ check: w.check || w.url, cmd: w.start }] : []);
            if (!svcs.length) return send(res, 409, { error: w.offHint || `${w.name}沒有開著` });
            // 只啟動沒開的服務，各開一個看得到的視窗（不會重開你已經開著的）
            for (const sv of svcs) { let on = false; try { on = (await fetch(sv.check, { signal: AbortSignal.timeout(1500) })).status < 500; } catch {} if (!on) runInWindow(sv.title || w.name, sv.cmd, path.resolve(b.dir, w.cwd || '.')); }
            let ok = false; for (let i = 0; i < 90 && !ok; i++) { await new Promise(r => setTimeout(r, 500)); ok = await up(); }
            if (!ok) return send(res, 504, { error: `${w.name}啟動中，還沒好；過幾秒再按一次` });
          }
          return send(res, 200, { url: w.url });
        }
      }
      let apm;
      if ((apm = p.match(/^\/api\/b\/([\w-]+)\/autopilot(?:\/(run|reply|ask))?$/))) {
        const b = buildings.find(x => x.id === apm[1]); if (!b) return send(res, 404, { error: '找不到大樓' });
        if (req.method === 'GET') return send(res, 200, apView(b));
        if (req.method !== 'POST') return send(res, 405, { error: 'method' });
        const bd = await body(req), st = apState(b);
        if (apm[2] === 'ask') {
          if (!query) return send(res, 400, { error: engineError });
          const text = String(bd.text || '').trim(); if (!text) return send(res, 400, { error: '問題不能是空的' });
          ownerAsk(b, String(bd.key || ''), text.slice(0, 2000)); return send(res, 200, apView(b));
        }
        if (apm[2] === 'reply') {
          if (!query) return send(res, 400, { error: engineError });
          const text = String(bd.text || '').trim(); if (!text) return send(res, 400, { error: '回覆不能是空的' });
          ownerReply(b, String(bd.key || ''), text.slice(0, 4000)); return send(res, 200, apView(b));
        }
        if (apm[2] === 'run') {
          if (!query) return send(res, 400, { error: engineError });
          const R = routinesOf(b), r = R?.routines.find(x => x.id === bd.id); if (!r) return send(res, 404, { error: '找不到這個例行工作' });
          if ((r.requires || []).some(c => LOCAL_ONLY.has(c))) return send(res, 400, { error: '這是地端模型的工作，大樓不會交給雲端 AI' });
          if (needsHandoff(r)) return send(res, 400, { error: '這項工作要用瀏覽器或你在場，背景沒辦法執行；請複製指令給桌面版 Codex' });
          apEnqueue(b, r, nowIn(R.timezone), true); return send(res, 200, apView(b));
        }
        if (bd.routine && typeof bd.routine.id === 'string') { st.overrides = st.overrides || {}; st.overrides[bd.routine.id] = !!bd.routine.enabled; }
        if (bd.handoffDone) { const h = st.runs.find(x => x.id === bd.handoffDone); if (h) { h.status = 'done'; h.summary = '主管已請桌面版 Codex 處理'; h.endedAt = Date.now(); } }
        if (bd.autonomy && typeof bd.autonomy.dept === 'string') { if (!deptsOf(b)[bd.autonomy.dept] || !AUTONOMY.includes(bd.autonomy.level)) return send(res, 400, { error: '沒有這個部門或自主程度' }); st.autonomy = { ...(st.autonomy || {}), [bd.autonomy.dept]: bd.autonomy.level }; }
        if (bd.budgetUsd != null) st.budgetUsd = Math.max(0, Math.min(500, +bd.budgetUsd || 0));
        if (bd.seenReport) for (const x of st.reports || []) if (bd.seenReport === 'all' || x.id === bd.seenReport) x.seen = true;
        if (bd.permMode) { if (!PERM_MODES.includes(bd.permMode)) return send(res, 400, { error: '沒有這個權限模式' }); st.permMode = bd.permMode; }
        if ('enabled' in bd) st.enabled = !!bd.enabled;
        if (bd.dailyCap) st.dailyCap = Math.max(1, Math.min(200, +bd.dailyCap));
        if (bd.caps && typeof bd.caps === 'object') for (const [k, v] of Object.entries(bd.caps)) if (/^[\w-]+$/.test(k)) st.caps[k] = !!v;
        apSave(b); return send(res, 200, apView(b));
      }
      let gm;
      if ((gm = p.match(/^\/api\/b\/([\w-]+)\/goals(?:\/(import|approve|discard|update|chat))?$/))) {
        const b = buildings.find(x => x.id === gm[1]); if (!b) return send(res, 404, { error: '找不到大樓' });
        if (req.method === 'GET' && !gm[2]) return send(res, 200, goalsView(b));
        if (req.method !== 'POST') return send(res, 405, { error: 'method' });
        const g = loadGoals(b), bd = await body(req);
        if (gm[2] === 'import') { if (!query) return send(res, 400, { error: engineError }); if (bd.source) g.source = bd.source; if (g.status === 'drafting') return send(res, 409, { error: (b.pm?.name || 'PM') + '正在處理中' }); importGoals(b, bd.feedback).catch(() => {}); return send(res, 200, { ok: true }); }
        if (gm[2] === 'chat') { if (!query) return send(res, 400, { error: engineError }); const text = String(bd.text || '').trim(); if (!text) return send(res, 400, { error: '請輸入要調整的內容' }); if (g.status === 'drafting' || g.asking) return send(res, 409, { error: (b.pm?.name || 'PM') + '正在處理上一件事，等他完成再交辦' }); (bd.mode === 'ask' ? askGoals(b, text) : importGoals(b, text)).catch(() => {}); return send(res, 200, { ok: true }); }
        if (gm[2] === 'approve') { if (!g.draft) return send(res, 400, { error: '沒有待審核的草案' }); const old = new Map(g.goals.map(x => [x.id, x])); g.goals = g.draft.goals.map(x => { const o = old.get(x.id); return o ? { ...x, manualStatus: o.manualStatus, manualProgress: o.manualProgress } : x; }); g.schedule = g.draft.schedule; if (g.chat?.length) g.chat.push({ role: 'sys', text: '主管核准了新版本', at: Date.now() }); g.summary = g.draft.summary; g.draft = null; g.status = 'approved'; g.approvedAt = Date.now(); saveGoals(b); return send(res, 200, goalsView(b)); }
        if (gm[2] === 'discard') { if (g.draft && g.chat?.length) g.chat.push({ role: 'sys', text: '主管捨棄了這版草案', at: Date.now() }); g.draft = null; g.status = g.goals.length ? 'approved' : 'none'; saveGoals(b); return send(res, 200, goalsView(b)); }
        if (gm[2] === 'update') {
          const src = bd.draft ? g.draft : g, coll = bd.kind === 'schedule' ? 'schedule' : 'goals', list = src?.[coll];
          if (!list) return send(res, 404, { error: '找不到資料' });
          const dk = Object.keys(deptsOf(b)), okDept = d => d === 'company' || dk.includes(d);
          const F = coll === 'goals' ? ['title', 'level', 'period', 'dept', 'metric', 'target', 'due', 'parent', 'automation', 'manualStatus', 'manualProgress'] : ['title', 'dept', 'start', 'end', 'kind', 'goal', 'recur'];
          const fix = it => {
            if (coll === 'goals') { if (!['year', 'quarter', 'month'].includes(it.level)) it.level = 'month'; if (!it.parent) it.parent = null; }
            else { if (!['milestone', 'work', 'routine'].includes(it.kind)) it.kind = 'work'; if (it.kind !== 'routine') it.recur = null; if (!it.end || it.kind === 'milestone') it.end = it.start; if (!it.goal) it.goal = null; }
            if (!okDept(it.dept)) it.dept = 'company';
            return it;
          };
          if (bd.add) {
            const it = {}; for (const k of F) if (k in bd.add) it[k] = bd.add[k];
            if (!String(it.title || '').trim()) return send(res, 400, { error: '請填寫名稱' });
            if (coll === 'schedule' && !it.start) return send(res, 400, { error: '請填寫開始日期' });
            it.id = (coll === 'goals' ? 'g' : 's') + 'm' + Date.now().toString(36);
            if (coll === 'goals') { it.status = 'todo'; it.progress = 0; }
            it.byBoss = true; list.push(fix(it));
          } else {
            const it = list.find(x => x.id === bd.id); if (!it) return send(res, 404, { error: '找不到項目' });
            if (bd.remove) { list.splice(list.indexOf(it), 1); if (coll === 'goals') for (const x of list) if (x.parent === it.id) x.parent = null; }
            else { const pt = bd.patch || {}; let content = false; for (const k of F) if (k in pt) { it[k] = pt[k]; if (!k.startsWith('manual')) content = true; } fix(it); if (content) it.byBoss = true; }
          }
          saveGoals(b); return send(res, 200, goalsView(b));
        }
      }
      let am;
      if ((am = p.match(/^\/api\/b\/([\w-]+)\/archive$/)) && req.method === 'GET') {
        const b = buildings.find(x => x.id === am[1]); if (!b) return send(res, 404, { error: '找不到大樓' });
        const root = path.join(towerDir(b), 'tasks'), items = [];
        if (fs.existsSync(root)) for (const tid of fs.readdirSync(root)) {
          const t = tasks.get(tid) || (specialTitles.has(tid) || tid.startsWith('goals-') ? { title: specialTitles.get(tid) || '目標規劃' } : tid.startsWith('auto-') ? { title: '自動：' + (apState(b).runs.find(x => x.id === tid)?.title || tid) } : null); const dir = path.join(root, tid);
          if (!fs.statSync(dir).isDirectory()) continue;
          for (const f of fs.readdirSync(dir)) {
            const st = fs.statSync(path.join(dir, f));
            let m, it = { taskId: tid, title: t?.title || tid, file: tid + '/' + f, size: st.size, at: st.mtimeMs };
            if ((m = f.match(/^r(\d+)-([\w-]+?)-plan-v(\d+)(-主管修改)?\.md$/))) Object.assign(it, { round: +m[1], dept: m[2], kind: m[4] ? 'plan-edited' : 'plan', version: +m[3] });
            else if ((m = f.match(/^r(\d+)-([\w-]+?)-report\.md$/))) Object.assign(it, { round: +m[1], dept: m[2], kind: 'report' });
            else if ((m = f.match(/^r(\d+)-總報告\.md$/))) Object.assign(it, { round: +m[1], dept: 'pm', kind: 'summary' });
            else if ((m = f.match(/^r(\d+)-([\w-]+?)-對話\.jsonl$/))) Object.assign(it, { round: +m[1], dept: m[2], kind: 'conv' });
            else continue;
            items.push(it);
          }
        }
        const list = [...tasks.values()].filter(t => t.building === b.id).map(t => ({ id: t.id, title: t.title, status: t.status, createdAt: t.createdAt, rounds: t.rounds.map(r => ({ n: r.n, text: r.text, createdAt: r.createdAt, status: r.status })) }));
        return send(res, 200, { items, tasks: list });
      }
      // 專案裡的文字檔（待核可卡片上的 md 等），只限本機；展示模式不開放
      let pf;
      if ((pf = p.match(/^\/api\/b\/([\w-]+)\/file$/)) && req.method === 'GET') {
        if (ext) return send(res, 403, { error: '展示模式不能讀專案檔案' });
        const b = buildings.find(x => x.id === pf[1]); if (!b) return send(res, 404, { error: '找不到大樓' });
        const rel = String(url.searchParams.get('f') || '').replace(/^[`'"]|[`'"]$/g, '').trim();
        const f = path.resolve(b.dir, rel), r = path.relative(b.dir, f);
        if (!rel || r.startsWith('..') || path.isAbsolute(r)) return send(res, 400, { error: '只能讀專案資料夾裡的檔案' });
        if (!/\.(md|markdown|txt|json|jsonl|csv|ya?ml|ts|tsx|js|mjs|py|html)$/i.test(f) || /(^|[\\/])\.env|\.(pem|key)$/i.test(f)) return send(res, 400, { error: '這種檔案不能在這裡讀，請用「在檔案總管打開」' });
        let st; try { st = fs.statSync(f); } catch { return send(res, 404, { error: '找不到 ' + rel }); }
        if (!st.isFile()) return send(res, 400, { error: '這是資料夾' });
        if (st.size > 3 * 1048576) return send(res, 400, { error: '檔案太大（超過 3 MB），請用「在檔案總管打開」' });
        return send(res, 200, { text: fs.readFileSync(f, 'utf8'), path: r.split(path.sep).join('/') });
      }
      if ((am = p.match(/^\/api\/b\/([\w-]+)\/doc$/)) && req.method === 'GET') {
        const b = buildings.find(x => x.id === am[1]); if (!b) return send(res, 404, { error: '找不到大樓' });
        const rel = url.searchParams.get('f') || '';
        if (!/^[\w-]+\/[^\\/]+\.(md|jsonl)$/.test(rel)) return send(res, 400, { error: '檔名不正確' });
        const f = path.join(towerDir(b), 'tasks', rel);
        if (!f.startsWith(path.join(towerDir(b), 'tasks')) || !fs.existsSync(f)) return send(res, 404, { error: '找不到檔案' });
        return send(res, 200, { text: fs.readFileSync(f, 'utf8') });
      }
      let cm;
      if ((cm = p.match(/^\/api\/tasks\/([\w-]+)\/conv$/)) && req.method === 'GET') {
        let t = tasks.get(cm[1]);
        if (!t && cm[1].startsWith('auto-')) { const ab = autoTasks.get(cm[1])?.building ? buildings.find(x => x.id === autoTasks.get(cm[1]).building) : buildings.find(x => fs.existsSync(path.join(towerDir(x), 'tasks', cm[1]))); if (ab) t = { id: cm[1], building: ab.id, rounds: [{}] }; }
        if (!t && cm[1].startsWith('goals-')) { const gb = buildings.find(x => loadGoals(x).taskId === cm[1]) || buildings.find(x => fs.existsSync(path.join(towerDir(x), 'tasks', cm[1]))); if (gb) t = { id: cm[1], building: gb.id, rounds: [{}] }; }
        if (!t) return send(res, 404, { error: '找不到任務' });
        const who = url.searchParams.get('dept') || 'pm', rn = +url.searchParams.get('round') || t.rounds.length;
        if (!/^[\w-]+$/.test(who)) return send(res, 400, { error: 'bad dept' });
        const f = convFile(t, rn, who);
        const entries = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
        return send(res, 200, { entries });
      }
      let m;
      if ((m = p.match(/^\/api\/b\/([\w-]+)\/tasks$/)) && req.method === 'POST') {
        if (!query) return send(res, 400, { error: engineError });
        const b = buildings.find(x => x.id === m[1]); if (!b) return send(res, 404, { error: '找不到大樓' });
        const { text, goalId } = await body(req); if (!text?.trim()) return send(res, 400, { error: '請輸入需求' });
        return send(res, 200, createTask(b.id, text.trim(), goalId));
      }
      if ((m = p.match(/^\/api\/tasks\/([\w-]+)\/(plans\/([\w-]+)|approve-all|followups|cancel)$/)) && req.method === 'POST') {
        const t = tasks.get(m[1]); if (!t) return send(res, 404, { error: '找不到任務' });
        const b = await body(req);
        if (m[3] && b.action === 'ask') {
          const x = t.rounds.at(-1).depts[m[3]]; if (!x) return send(res, 404, { error: '這一輪沒有這個部門' });
          if (!query) return send(res, 400, { error: engineError });
          const q = String(b.text || '').trim(); if (!q) return send(res, 400, { error: '請先寫下你的問題' });
          if (x.status !== 'review') return send(res, 400, { error: '這份方案不在待審核狀態，不能提問' });
          if (x.asking) return send(res, 409, { error: '部門正在回答上一個問題，等他回答完再問' });
          askPlan(t, m[3], q).catch(() => {}); return send(res, 200, t);
        }
        if (m[3]) await review(t, m[3], b.action, b);
        else if (m[2] === 'approve-all') { for (const [d, x] of Object.entries(t.rounds.at(-1).depts)) if (x.status === 'review') await review(t, d, 'approve', {}); }
        else if (m[2] === 'followups') { if (!b.text?.trim()) return send(res, 400, { error: '請輸入追加的需求' }); followUp(t, b.text.trim()); }
        else if (m[2] === 'cancel') cancel(t);
        return send(res, 200, t);
      }
      if ((m = p.match(/^\/api\/approvals\/([\w-]+)$/)) && req.method === 'POST') {
        const a = approvals.get(m[1]); if (!a) return send(res, 404, { error: '這個請求已處理或過期' });
        const b = await body(req); a.resolve({ allow: !!b.allow, message: b.message });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: '沒有這個 API' });
    }
    // 靜態檔案
    let f = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!f.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
    const data = await fsp.readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, { error: 'not found' });
    send(res, 400, { error: String(e.message || e) });
  }
});

await loadTasks();
server.requestTimeout = 0;      // 權限請求可能要等主管很久
server.headersTimeout = 120000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nAI 團隊大樓已啟動：http://localhost:${PORT}`);
  console.log(`引擎：${{ codex: '本機 Codex', mock: '模擬模式（不呼叫 Codex）' }[ENGINE]}`);
  if (ENGINE !== 'mock') console.log(`登入方式：${AUTH_LABEL[authMode()]}（可在大樓工具列的「登入」切換）`);
  if (ENGINE === 'codex') console.log(`Codex：${CODEX_PATH || '找不到'}`);
  if (!query) console.log('⚠ ' + engineError);
  if (ENGINE !== 'mock' && authMode() === 'api' && !apiKey()) console.log('⚠ 登入方式是 API 金鑰，但還沒設定金鑰。請在大樓工具列的「登入」填入，或設定環境變數 OPENAI_API_KEY。');
  for (const b of buildings) console.log(`大樓「${b.name}」→ ${b.dir}`);
});
