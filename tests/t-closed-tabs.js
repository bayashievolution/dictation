// 閉じたタブの期限切れの判断（closed-tabs.js の closedTabsExpired・v0.24.160）
// 既定は 1 週間（やっさんの指定）。0 は「残さない」＝全部すぐ消す
const path = require('path');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const { closedTabsExpired } = require(path.join(SRC, 'closed-tabs.js'));
const D = 24 * 3600 * 1000, now = 100 * D;
const list = [{ id: 'a', closedAt: now - 1 * D }, { id: 'b', closedAt: now - 6.9 * D }, { id: 'c', closedAt: now - 7 * D }, { id: 'd', closedAt: now - 30 * D }, { id: 'e' }];
eq('1 週間: 7 日たったものと、閉じた時刻が無いものが期限切れ', closedTabsExpired(list, now, 7), ['c', 'd', 'e']);
eq('1 日', closedTabsExpired(list, now, 1), ['a', 'b', 'c', 'd', 'e']);
eq('1 か月', closedTabsExpired(list, now, 30), ['d', 'e']);
eq('残さない（0）は全部', closedTabsExpired(list, now, 0), ['a', 'b', 'c', 'd', 'e']);
eq('空でも動く', closedTabsExpired(null, now, 7), []);
console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
