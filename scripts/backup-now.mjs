// 手動替所有大樓拍一張快照：node scripts/backup-now.mjs [大樓代號]
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { snapshot, backupRoot } from '../lib/backup.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'tower.config.json'), 'utf8'));
const only = process.argv[2];
for (const b of cfg.buildings.filter(x => !only || x.id === only)) {
  const dir = path.resolve(root, b.projectDir);
  try { const r = await snapshot({ ...b, dir }, backupRoot(cfg, root), '手動快照 ' + new Date().toLocaleString('zh-TW')); console.log(b.id, r); }
  catch (e) { console.log(b.id, '失敗：', e.message); }
}
