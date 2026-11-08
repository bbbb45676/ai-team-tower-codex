// 打開大樓背景使用的那份 Codex，用來登入或檢查狀態。
// 用法：npm run login   → 瀏覽器會打開 OpenAI 的登入頁，用你的 ChatGPT 帳號登入
//       npm run status  → 看目前登入的是哪種方式
// 也可以直接在大樓的登入指引按「用 ChatGPT 登入」，效果一樣。
import { spawn } from 'node:child_process';
import os from 'node:os';
import { findCodex } from '../lib/codex.mjs';

const exe = findCodex();
if (!exe) { console.error('找不到 Codex，請先安裝 Codex 桌面版，或執行 npm install -g @openai/codex。'); process.exit(1); }
console.log('Codex：' + exe);
if (process.argv[2] === 'login' && !process.argv[3]) console.log('瀏覽器會打開登入頁，用你的 ChatGPT 帳號登入後回到這裡。\n');
spawn(exe, process.argv.slice(2), { stdio: 'inherit', cwd: os.homedir() }).on('exit', c => process.exit(c ?? 0));
