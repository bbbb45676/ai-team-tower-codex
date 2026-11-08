// 大樓專用的瀏覽器視窗（Brave 或 Chrome）：獨立設定檔（不碰擁有者平常用的瀏覽器），開著除錯連接埠讓背景部門透過 browser-mcp 控制。
// 擁有者在這個視窗登入需要的網站一次，之後一直有效。連接埠只有本機能連。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
  path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  // Mac
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // Linux
  '/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/chromium',
];
export function browserConfig(cfg, root) {
  const c = cfg.towerBrowser || {};
  return {
    enabled: c.enabled !== false,
    exe: c.exe || CANDIDATES.find(p => p && fs.existsSync(p)) || null,
    port: +c.port || 9333,
    profile: c.profile || path.join(root, '.browser-profile'),
  };
}
export async function browserUp(bc) {
  try { const r = await fetch(`http://127.0.0.1:${bc.port}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
export async function ensureBrowser(bc, startUrl) {
  if (await browserUp(bc)) return true;
  if (!bc.enabled || !bc.exe) return false;
  fs.mkdirSync(bc.profile, { recursive: true });
  const args = [`--remote-debugging-port=${bc.port}`, `--user-data-dir=${bc.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-features=CalculateNativeWinOcclusion'];
  if (startUrl) args.push(startUrl);
  spawn(bc.exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 500)); if (await browserUp(bc)) return true; }
  return false;
}
