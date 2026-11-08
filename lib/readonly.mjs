// 判斷一行終端機指令是不是「只讀」：只讀的自動放行，會寫入或修改的照樣要主管批准。
// 原則：看不懂、不確定的一律當成「不是只讀」，交給主管決定。

const BASH_OK = new Set([
  'cd', 'ls', 'dir', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'find', 'echo', 'printf', 'pwd',
  'stat', 'file', 'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'date', 'du', 'df', 'tree', 'diff', 'cmp',
  'md5sum', 'sha1sum', 'sha256sum', 'jq', 'realpath', 'readlink', 'which', 'type', 'test', '[', '[[', 'true', 'false',
  'column', 'nl', 'comm', 'paste', 'fold', 'expand', 'od', 'hexdump', 'xxd', 'strings', 'less', 'more', 'seq', 'sleep',
]);
const GIT_OK = new Set(['log', 'status', 'diff', 'show', 'ls-files', 'grep', 'rev-parse', 'blame', 'shortlog', 'ls-tree', 'cat-file', 'describe', 'reflog', 'whatchanged', 'count-objects']);
// 迴圈、條件判斷的關鍵字（本身不做事）
const FLOW = new Set(['for', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'case', 'esac', 'in', '!', '{', '}']);

function stripSafeRedirects(s) {
  // 丟掉錯誤訊息、丟進黑洞，這些不寫檔
  return s.replace(/\d?&?>\s*\/dev\/null/g, ' ').replace(/2>&1/g, ' ').replace(/\d?>\s*\$null/gi, ' ').replace(/2>&1/g, ' ');
}

function firstWord(seg) {
  let t = seg.trim();
  // 前面的變數設定（例如 LC_ALL=C grep …）
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(t)) t = t.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  const m = t.match(/^(\S+)/); return m ? m[1] : '';
}

// 把引號裡的內容換成 x，這樣 grep "a|b"、echo "==>" 這類字面上的符號不會被當成管線或寫檔
function maskQuotes(s) {
  let out = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"' && i + 1 < s.length) { out += 'xx'; i++; continue; } if (c === q) { q = null; out += c; } else out += 'x'; continue; }
    if (c === '\\' && i + 1 < s.length) { out += 'xx'; i++; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    out += c;
  }
  return q ? null : out; // 引號沒關好：看不懂，當成不是只讀
}

export function isReadOnlyBash(cmd) {
  if (!cmd || typeof cmd !== 'string' || cmd.length > 4000) return false;
  // 子指令、反引號、程序替換：不管在不在引號裡都不放行（雙引號裡也會執行）
  if (/`|\$\(|<\(|>\(/.test(cmd)) return false;
  let s = maskQuotes(stripSafeRedirects(cmd));
  if (s === null) return false;
  // heredoc、寫檔重導向：一律不算只讀
  if (/<<|>/.test(s)) return false;
  // 單純的變數設定（f=xxx）也可以
  const segs = s.split(/&&|\|\||;|\||\n/).map(x => x.trim()).filter(Boolean);
  if (!segs.length) return false;
  for (let seg of segs) {
    // 去掉迴圈、條件判斷的關鍵字前綴（例如 "do cat x"、"then echo"）
    let w = firstWord(seg);
    while (FLOW.has(w)) { seg = seg.trim().slice(w.length).trim(); if (!seg) break; w = firstWord(seg); }
    if (!seg) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg) && !/\s/.test(seg.trim())) continue; // x=1
    if (/^[A-Za-z_][A-Za-z0-9_]*\s+in\s/.test(seg)) continue; // for 迴圈的「f in a b c」部分
    if (w === 'git') {
      const sub = (seg.match(/^git\s+(?:-C\s+("[^"]*"|\S+)\s+)?(?:--no-pager\s+)?(\S+)/) || [])[2];
      if (!GIT_OK.has(sub)) return false;
      if (/\s--output(=|\s)|\s-o\s/.test(seg)) return false;
      continue;
    }
    if (w === 'find' && /\s-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)\b/.test(seg)) return false;
    if (w === 'sort' && /\s-o\b|--output/.test(seg)) return false;
    if (!BASH_OK.has(w)) return false;
  }
  return true;
}

const PS_OK = /^(get-[a-z]+|select-(object|string)|measure-object|sort-object|where-object|foreach-object|group-object|format-(list|table|wide)|out-string|out-null|test-path|resolve-path|split-path|join-path|write-output|convertto-json|convertfrom-json|compare-object|set-location|push-location|pop-location|dir|ls|cat|type|gci|gc|gi|sls|cd|pwd|echo|sort|select|where|measure|findstr|git)$/i;
const PS_BAD = /\b(remove|set|new|move|copy|rename|clear|start|stop|invoke|add|export|import|install|uninstall|update|restart|enable|disable|register|unregister|send|out-file|write-host|iex|rm|del|mv|cp|ni|ri|sc|ac)\b-?|\[io\.|\[system\.|\.write|\.delete|\.move|\.copy|&\s*["'(]|>\s*(?!\$null)/i;

export function isReadOnlyPowerShell(cmd) {
  if (!cmd || typeof cmd !== 'string' || cmd.length > 4000) return false;
  if (/\$\(/.test(cmd)) return false;
  const s = maskQuotes(stripSafeRedirects(cmd).replace(/`/g, ' '));
  if (s === null) return false;
  // Get-* 只讀，但 Set-Location 例外（只切換目錄）；黑名單先擋掉寫入類
  const scrub = s.replace(/set-location/ig, 'sl_ok').replace(/out-string/ig, 'os_ok').replace(/out-null/ig, 'on_ok');
  if (PS_BAD.test(scrub)) return false;
  for (const seg of s.split(/\||;|\n/).map(x => x.trim()).filter(Boolean)) {
    const w = (seg.replace(/^[{(]+/, '').match(/^(\S+)/) || [])[1] || '';
    if (/^\$[\w:]+\s*=/.test(seg)) continue;            // $x = …（右邊已經過黑名單）
    if (/^[})]+$/.test(w)) continue;
    if (w.toLowerCase() === 'git') { const sub = (seg.match(/^git\s+(?:-C\s+("[^"]*"|'[^']*'|\S+)\s+)?(\S+)/i) || [])[2]; if (!GIT_OK.has(sub)) return false; continue; }
    if (!PS_OK.test(w)) return false;
  }
  return true;
}

export function isReadOnlyCommand(tool, cmd) {
  if (tool === 'Bash') return isReadOnlyBash(cmd);
  if (tool === 'PowerShell') return isReadOnlyPowerShell(cmd);
  return false;
}
