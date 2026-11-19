// 小窓のボタンの並びを見る（v0.24.153 やっさんの指定）: やめるほうは左、決めるほう（btn-primary・btn-danger）は右（いちばん後ろ）。
// 前は設定・この録音の文脈・Notion の保存先・無音の確認で「保存（決定）」が左にあった。index.html の小窓の下の段を全部調べる
const fs = require('fs'), path = require('path');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const footers = [...html.matchAll(/<div class="(?:modal-footer|notion-float-footer)"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
let fail = 0;
for (const f of footers) {
  const btns = [...f.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ cls: (m[1].match(/class="([^"]*)"/) || [])[1] || '', text: m[2].trim() }));
  const decide = btns.map((b, i) => (/btn-(primary|danger)/.test(b.cls) ? i : -1)).filter((i) => i >= 0);
  const ghosts = btns.map((b, i) => (/btn-ghost/.test(b.cls) && !/中止/.test(b.text) ? i : -1)).filter((i) => i >= 0);
  // 中止（保存中だけ出る）は、閉じる・残すと同時には出ないので並びを問わない
  const ok = !decide.length || !ghosts.length || Math.max(...ghosts) < Math.min(...decide);
  console.log(`${ok ? '✓' : '✕'} ${btns.map((b) => b.text).join(' ｜ ')}`);
  if (!ok) fail++;
}
if (footers.length < 6) { console.log(`✕ 小窓の下の段が ${footers.length} 個しか見つからない`); fail++; }
console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
