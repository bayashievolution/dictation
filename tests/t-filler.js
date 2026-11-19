// 相づちだけのチャンクを見分ける isFillerOnly を、実物の関数のまま検査する (v0.24.34)。
//
// やっさんの実機（2026-11-02）: 無言でキーボードを打っている間、文字起こしに「はい。」が17行並んだ。
// 相づちだけのチャンクが続いたら2つ目以降を出さない。**本当の発言を消さない**ことが大事。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const src = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const re = src.match(/const FILLER_ONLY_RE = [^\n]+/);
const fn = src.indexOf('function isFillerOnly(');
if (!re || fn < 0) { console.log('✕ isFillerOnly が無い'); process.exit(1); }
const end = src.indexOf('\n}\n', fn) + 2;
const ctx = { String };
vm.createContext(ctx);
vm.runInContext(re[0] + '\n' + src.slice(fn, end), ctx);
const F = ctx.isFillerOnly;

console.log('■ 相づちだけ');
for (const t of ['はい。', 'はい', 'はい、はい。', 'はいはい', ' うん。', 'ええ。', 'あ、はい。', 'はーい！', 'ふーん']) {
  eq(`「${t}」`, F(t), true);
}

console.log('\n■ 本当の発言（消してはいけない）');
for (const t of ['はい、そうです。', '記入よろしくお願いします。', 'はい。では始めます。', 'うんうん、それでいい', 'いいえ', 'はい！質問です', 'ええと、次の資料']) {
  eq(`「${t}」`, F(t), false);
}

console.log('\n■ 空');
eq('空は相づちではない（前の段落が無いとき）', F(''), false);
eq('句読点だけも相づちではない', F('。、'), false);

console.log('\n■ Gemini への指示');
const gem = fs.readFileSync(path.join(SRC, 'gemini.js'), 'utf8');
eq('キーボードの音は発話ではないと伝える', gem.includes('キーボードを打つ音・紙の音・物音は発話ではない'), true);

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
