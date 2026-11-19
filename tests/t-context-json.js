// 文脈の自動抽出（Gemini）の返事を読む parseContextJson を、実物の関数のまま検査する (v0.24.23)。
//
// やっさんの実機ログ（2026-11-02）で4回「[context] JSON として読めませんでした」→ 語0件になった。
// 下の SAMPLES はそのログに残っていた返事の頭（ログは先頭200字で切っているので、実物はもっと長い。
// いずれにしても**途中で切れた JSON** で、配列で包まれ、改行とインデントが入っている）。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const src = fs.readFileSync(path.join(SRC, 'gemini.js'), 'utf8');
const start = src.indexOf('function parseContextJson(');
if (start < 0) { console.log('✕ parseContextJson が無い'); process.exit(1); }
let depth = 0, i = src.indexOf('{', src.indexOf(')', start)), end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const ctx = { JSON, Array, String };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);
const P = ctx.parseContextJson;

const S1 = `[
  {
    "terms": ["ワークエンゲージメント尺度", "抑うつ尺度", "不安尺度", "媒介性", "自立性", "JDRモデル", "アウトカム", "授業改善", "児童の変容", "組織の変容", "教員の変容", "指導計画の日常的な運用", "特別支援教育の質的向上", "ICT", "職務満足感尺度", "働き方改革", "個別の指導計画", "PDCA", "教`;
const S2 = `[
  {
    "terms": [
      "ワークエンゲージメント",
      "ICT",
      "JDRモデル",
      "職務満足感尺度"
    ],
    "topicPath": [
      "ワークエンゲージメントの必要性"
    ],
    "flow": "ワークエンゲージメントの必要性について、その効果測定の難しさや、JDRモデルの活用につ`;
const S3 = `[
  {
    "terms": [
      "個別の指導計画",
      "PDCA",
      "教育データ活用",
      "MBL",
      "津村",
      "キャリアパスポート",
      "DX化",
      "働き方改革",
      "キャリア教育",
      "キャリア発達",
      "特別支援教育",
      "授業改善`;

console.log('■ 実機ログの返事（途中で切れている）');
{
  const r = P(S1);
  eq('読めたことにする（語0件にしない）', [r.ok, r.salvaged], [true, true]);
  eq('閉じている語は全部拾い、切れた最後の1語（"教）は捨てる', r.out.terms.length, 18);
  eq('先頭と末尾', [r.out.terms[0], r.out.terms[17]], ['ワークエンゲージメント尺度', 'PDCA']);
}
{
  const r = P(S2);
  eq('語・議題は拾い、切れた flow は空にする', [r.out.terms, r.out.topicPath, r.out.flow],
     [['ワークエンゲージメント', 'ICT', 'JDRモデル', '職務満足感尺度'], ['ワークエンゲージメントの必要性'], '']);
}
{
  const r = P(S3);
  eq('改行・インデント入りでも拾う', r.out.terms.length, 11);
}

console.log('\n■ ちゃんとした返事');
eq('指定どおりの1行', P('{"terms":["a","b"],"topicPath":["x"],"flow":"f"}'),
   { ok: true, out: { terms: ['a', 'b'], topicPath: ['x'], flow: 'f' } });
eq('配列で包まれていても中身を使う', P('[{"terms":["a"],"topicPath":[],"flow":""}]').out.terms, ['a']);
eq('コードフェンス付き', P('```json\n{"terms":["a"],"topicPath":[],"flow":""}\n```').out.terms, ['a']);
eq('エスケープを戻す', P('{"terms":["\\"引用\\"の語"], "topicPath":[], "fl').out.terms, ['"引用"の語']);

console.log('\n■ 読めないもの');
eq('JSON らしくもない', P('すみません、抽出できませんでした').ok, false);
eq('空', P('').ok, false);

// 抽出の指示に、切れた原因への手当てが入っているか
console.log('\n■ 指示と上限');
eq('1行で・配列で包まない', src.includes('**1行で書く（改行やインデントを入れない）。全体を [ ] で包まない。**'), true);
eq('上限は 2048', /maxOutputTokens: 2048,\s*responseMimeType: 'application\/json'/.test(src), true);

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
