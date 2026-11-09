// 設定画面（index.html の #settings-modal）の入れ子が崩れていないかを検査する (v0.24.45)。依存なし。
//
// v0.24.44 で「一部を Claude Code で処理する」を消したとき、閉じタグ </div> を1つ余分に残し、
// 設定の中身の入れ物（.modal-body）が AI機能の直後で閉じていた。それより後ろの欄
// （SUMADO・録音の保持・停止条件・表示・Notion 連携・診断ログ）が入れ物の外に出て、
// v0.24.45 で音声入力を一番上に動かしたときに表示が崩れて気づいた。
// 文字列の置き換えで HTML を直すと起こりうるので、見出しの並びと入れ子の深さで確かめる。
const fs = require('fs'), path = require('path');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const s = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const start = s.indexOf('<div class="modal-body">', s.indexOf('id="settings-modal"'));
const seg = s.slice(start);
let depth = 0;
const groups = [];
let closedAt = -1;
for (const m of seg.matchAll(/<(\/?)div\b[^>]*>(\s*<h3 class="field-group-title">([^<]*))?/g)) {
  if (!m[1] && m[3] !== undefined) groups.push({ title: m[3].trim(), depth });
  depth += m[1] ? -1 : 1;
  if (depth === 0) { closedAt = m.index; break; }
}

const top = groups.filter((g) => g.depth === 1).map((g) => g.title);
// v0.24.95: 詳細設定の下は、押すと開くまとまり（見出しはボタンの中の字）。並びはこちらで見る
const accs = [];
{
  let d = 0;
  for (const m of seg.slice(0, closedAt).matchAll(/<(\/?)div\b[^>]*>|<span class="settings-acc-label">([^<]*)<\/span>/g)) {
    if (m[2] !== undefined) { accs.push({ label: m[2], depth: d }); continue; }
    d += m[1] ? -1 : 1;
  }
}
eq('欄はすべて設定の入れ物の直下に並ぶ（途中で入れ物が閉じていない）', top,
   ['文字起こしのモード', 'AI 設定', '使用するAI', '詳細設定']);
eq('詳細設定のまとまりの並び（設定の見本の 4 段目）', accs.map((a) => a.label),
   ['音声入力', '録音の保持（話者判別）', 'AI の動き', '停止条件', '表示', 'Notion 連携', 'そのほか']);
eq('まとまりも入れ物の直下（見出しはまとまりの div の中＝深さ 2）', accs.every((a) => a.depth === 2), true);
// v0.24.87: 一番上は「文字起こしのモード」。見出しの「音声入力」は消し、こまかい設定は下の「音声入力」へ（やっさんの指定）
eq('文字起こしのモードが一番上（やっさんの指定）', top[0], '文字起こしのモード');
eq('入れ物は最後の欄（診断ログ）より後ろで閉じる', closedAt > seg.indexOf('診断ログ'), true);

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
