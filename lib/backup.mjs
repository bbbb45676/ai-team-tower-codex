// 每次執行前後的專案快照（通用備份）
// 做法：每棟大樓一個「影子 git 備份庫」，工作目錄指向專案資料夾。
// - 不碰專案自己的 .git、分支或暫存區
// - 沿用專案自己的 .gitignore，再加上一份大型檔案排除清單
// - 只存有變動的檔案，可以還原到任何一次快照
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const EXCLUDES = [
  'node_modules/', '.pnpm-store/', '.venv/', 'venv/', '__pycache__/', '.cache/', 'dist/', 'build/',
  '*.safetensors', '*.ckpt', '*.pt', '*.pth', '*.onnx', '*.gguf', '*.bin',
  '*.zip', '*.rar', '*.7z', '*.tar', '*.gz', '*.iso',
  '*.mp4', '*.mov', '*.mkv', '*.avi', '*.wav', '*.psd', '*.blend', '*.blend1',
];

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: opts.timeout || 15 * 60e3, env: { ...process.env, GIT_AUTHOR_NAME: 'AI 團隊大樓', GIT_AUTHOR_EMAIL: 'tower@localhost', GIT_COMMITTER_NAME: 'AI 團隊大樓', GIT_COMMITTER_EMAIL: 'tower@localhost' } },
      (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim().slice(0, 400))) : resolve(stdout));
  });
}

export function backupRoot(cfg, towerDir) {
  if (cfg.backupRoot) return cfg.backupRoot;
  return path.join(towerDir, 'backups');
}
export function backupDirOf(b, root) {
  return b.backup?.dir ? path.resolve(b.dir, b.backup.dir) : path.join(root, b.id + '.git');
}

async function ensureRepo(gd, work) {
  if (fs.existsSync(path.join(gd, 'HEAD'))) return;
  fs.mkdirSync(gd, { recursive: true });
  await run(['--git-dir', gd, 'init', '-q']);
  await run(['--git-dir', gd, 'config', 'core.bare', 'false']);
  await run(['--git-dir', gd, 'config', 'core.worktree', work.replace(/\\/g, '/')]);
  await run(['--git-dir', gd, 'config', 'core.autocrlf', 'false']);
  await run(['--git-dir', gd, 'config', 'core.longpaths', 'true']);
  await run(['--git-dir', gd, 'config', 'core.quotepath', 'false']);
  await run(['--git-dir', gd, 'config', 'gc.auto', '0']);
  fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'info', 'exclude'), '# AI 團隊大樓備份：大型檔案不備份\n' + EXCLUDES.join('\n') + '\n');
  fs.writeFileSync(path.join(gd, '備份說明.txt'), [
    '這是「AI 團隊大樓」替專案做的快照備份（影子 git 備份庫），不會動到專案自己的 git。',
    '專案資料夾：' + work,
    '',
    '看所有快照：',
    `  git --git-dir="${gd}" log --oneline`,
    '看某次快照改了哪些檔案：',
    `  git --git-dir="${gd}" show --stat <快照編號>`,
    '把某個檔案還原成某次快照的版本：',
    `  git --git-dir="${gd}" --work-tree="${work}" checkout <快照編號> -- <檔案路徑>`,
    '',
    '不備份：專案 .gitignore 排除的檔案、node_modules、模型權重、壓縮檔、影片、.psd、.blend 等大型檔案。',
  ].join('\r\n'));
}

// 同一棟大樓的快照排隊進行，避免 git 互相鎖住
const chains = new Map();
export function snapshot(b, root, label) {
  const gd = backupDirOf(b, root);
  const prev = chains.get(gd) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    const t0 = Date.now();
    await ensureRepo(gd, b.dir);
    const wt = ['--git-dir', gd, '--work-tree', b.dir];
    await run([...wt, 'add', '-A']);
    for (const extra of b.backup?.include || []) if (fs.existsSync(path.join(b.dir, extra))) await run([...wt, 'add', '-f', '--', extra]).catch(() => {});
    const changed = (await run([...wt, 'diff', '--cached', '--name-only'])).split('\n').filter(Boolean).length;
    const hasHead = await run(['--git-dir', gd, 'rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
    if (changed || !hasHead) await run([...wt, 'commit', '-q', '--allow-empty', '-m', label]);
    const id = (await run(['--git-dir', gd, 'rev-parse', '--short', 'HEAD'])).trim();
    return { id, changed, ms: Date.now() - t0, dir: gd };
  });
  chains.set(gd, job);
  return job;
}
