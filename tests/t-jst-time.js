// 録音の時刻を日本時間で書く（v0.24.146・カルディから）
//
// 講義ノートの見出し「<名前>(MM/DD HH:MM)（YYYY-MM-DD HH:MM）」の時刻が UTC のまま入っていた（10:04 の録音が「01:04」）。
// 前は動いている環境の時刻帯で書いていた。環境の時刻帯を UTC・ニューヨークにしても、日本時間で書くことを確かめる。
// Notion の「録音日」は時差つき（+09:00）で送る。
// SRC=/tmp/old/ で v0.24.145 に当てると落ちる（この入れ物の時計は UTC）。
const fs = require('fs'), vm = require('vm');
const SRC = process.env.SRC || __dirname + '/../';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
function grab(src, head) {
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`${head} が見つからない`);
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
const notionSrc = fs.readFileSync(SRC + 'notion.js', 'utf8');
const appSrc = fs.readFileSync(SRC + 'app.js', 'utf8');

// 2026-11-13 10:04（日本時間）＝ 01:04Z
const TS = Date.UTC(2026, 10, 13, 1, 4, 30);
for (const tz of ['UTC', 'America/New_York']) {
  process.env.TZ = tz;
  const ctx = { console, Date, Intl, String, Math, window: {}, location: { protocol: 'http:' } };
  vm.createContext(ctx);
  vm.runInContext(notionSrc, ctx);
  vm.runInContext(grab(appSrc, 'function formatDatePart(ts)'), ctx);
  console.log(`■ 環境の時刻帯が ${tz} のとき`);
  eq('タイトルの日時「(MM/DD HH:MM)」は日本時間', ctx.formatDatePart(TS), '11/13 10:04');
  eq('Notion の録音日は日本時間・時差つき', ctx.notionLocalIso(TS), '2026-11-13T10:04:30+09:00');
  eq('追記の見出しの「（YYYY-MM-DD HH:MM）」も日本時間', ctx.notionLocalIso(TS).slice(0, 16).replace('T', ' '), '2026-11-13 10:04');
  eq('同じ瞬間を指している（送った時刻を読み直すと元に戻る）', new Date(ctx.notionLocalIso(TS)).getTime(), Math.floor(TS / 1000) * 1000);
  // 日をまたぐ: 2026-11-13 23:30Z は日本時間で 11/14 08:30
  eq('日をまたいでも日本時間の日付', ctx.formatDatePart(Date.UTC(2026, 10, 13, 23, 30)), '11/14 08:30');
}

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
