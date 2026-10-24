// 要約のプロンプトに何が入るかを、実物の関数を走らせて検査する。
// _callGemini を差し替えて、送られる body を捕まえるだけ。
//
// v0.24.3 でメモを素材に加えた。やっさんの確認
// 「要約の中にノートの内容は反映されるんだっけ」→ されていなかった。
//
// ここで押さえたいのは2つ:
//   1. メモを書いたときだけ効く（空なら v0.24.2 までと同じプロンプト）
//   2. 短いメモに要約の骨格を乗っ取られない形で渡している
const fs = require('fs'), vm = require('vm');

// optional: 旧版に無い関数は空の張りぼてにする。
// こうしないと SRC= で旧版に当てたとき「関数が無い」で死ぬだけで、
// **旧版の振る舞いが間違っていたことの証明にならない**。
function grab(src, name, optional) {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  if (start < 0 && optional) return `function ${name}() { return ''; }`;
  if (start < 0) throw new Error(`${name} が見つからない`);
  let depth = 0, i = src.indexOf('{', src.indexOf(')', start)), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
function grabBlock(src, head, tail) {
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`${head} が見つからない`);
  const end = src.indexOf(tail, start);
  if (end < 0) throw new Error(`${head} の終わりが見つからない`);
  return src.slice(start, end + tail.length);
}

const gem = fs.readFileSync((process.env.SRC || __dirname + '/../') + 'gemini.js', 'utf8');
let captured = null;
const ctx = { console, Error, Promise,
  _callGemini: async (body) => { captured = body; return 'ok'; } };
vm.createContext(ctx);
vm.runInContext([
  grabBlock(gem, 'const SUMMARY_PROMPTS = {', '\n};'),
  grab(gem, 'buildNoInventionRule'),
  grab(gem, 'buildNoPaddingRule'),
  grab(gem, 'buildMemoRule', true),
  grab(gem, 'summarizeWithGemini'),
].join('\n'), ctx);

let fail = 0;
const sys = () => String(captured.system_instruction.parts[0].text);
const usr = () => String(captured.contents[0].parts[0].text);
const check = (label, ok) => {
  console.log(`${ok ? '✓' : '✕'} ${label}`);
  if (!ok) fail++;
};
const has   = (label, needle, where) => check(label, where().includes(needle));
const lacks = (label, needle, where) => check(label, !where().includes(needle));

const TRANSCRIPT = '評価は三つの観点で見ます。それぞれに段階を置きます。';
const MEMO = '・ルーブリック要確認\n・来週までに提出';

(async () => {
  console.log('■ メモが空のとき（v0.24.2 までと同じであること）');
  await ctx.summarizeWithGemini({ apiKey: 'k', transcript: TRANSCRIPT, detail: 'medium' });
  const noMemoSys = sys(), noMemoUsr = usr();
  lacks('システム側にメモの節を出さない', '■ メモの扱い', sys);
  lacks('ユーザー側に【メモ】を出さない', '【メモ】', usr);
  has('見出しは「文字起こしにある内容だけ」', '■ 最重要：文字起こしにある内容だけを書く', sys);
  has('禁止の主語は「音声」', '音声に無い内容は絶対に足さない', sys);
  await ctx.summarizeWithGemini({ apiKey: 'k', transcript: TRANSCRIPT, memo: '', detail: 'medium' });
  check('memo: "" は渡さないのと同じ', sys() === noMemoSys && usr() === noMemoUsr);
  await ctx.summarizeWithGemini({ apiKey: 'k', transcript: TRANSCRIPT, memo: '  \n \n ', detail: 'medium' });
  check('空白だけのメモも同じ', sys() === noMemoSys && usr() === noMemoUsr);

  console.log('\n■ メモがあるとき');
  await ctx.summarizeWithGemini({ apiKey: 'k', transcript: TRANSCRIPT, memo: MEMO, detail: 'medium' });
  has('メモの本文が入る', 'ルーブリック要確認', usr);
  has('【メモ】の見出しが付く', '【メモ】', usr);
  has('メモの字数を添える（短いことを隠さない）', `（${MEMO.length}字`, usr);
  has('本体が文字起こしだと書く', '本体は上の文字起こし', usr);
  check('メモは文字起こしの**あと**に置く', usr().indexOf('【文字起こし全文】') < usr().indexOf('【メモ】'));
  has('見出しは「文字起こしとメモ」', '■ 最重要：文字起こしとメモにある内容だけを書く', sys);
  has('禁止の主語が「資料」になる', '資料に無い内容は絶対に足さない', sys);
  lacks('「音声に無い内容」とは言わない（メモを捨てさせない）', '音声に無い内容は絶対に足さない', sys);
  has('メモの節が出る', '■ メモの扱い', sys);
  has('音声に無くても捨てないと書く', '音声に無いからといって捨てない', sys);
  has('短いほうに引っ張られるなと書く', '短いほうに全体を引っ張られないこと', sys);
  has('断片を想像で埋めるなと書く', '書かれていない部分を想像で埋めない', sys);
  has('メモは引用しないと書く', '引用は実際に話された言葉だけ', sys);
  has('捏造の歯止めは残っている', '項目数や行数を満たすために、話されていないことを書かない', sys);

  console.log('\n■ 粒度を混ぜていないか（メモを足しても各粒度の指示は残る）');
  for (const [detail, needle] of [['low', '詳細な議事録'], ['medium', 'バランスよく'], ['high', '最小限の要点']]) {
    await ctx.summarizeWithGemini({ apiKey: 'k', transcript: TRANSCRIPT, memo: MEMO, detail });
    has(`${detail} の指示が残る`, needle, sys);
  }
  await ctx.summarizeWithGemini({ apiKey: 'k', transcript: TRANSCRIPT, memo: MEMO, detail: 'nonsense' });
  has('知らない粒度はバランスに落ちる', 'バランスよく', sys);

  console.log('\n■ 文字起こしが空なら、メモがあっても断る（別の機能なので広げない）');
  let threw = null;
  try { await ctx.summarizeWithGemini({ apiKey: 'k', transcript: '', memo: MEMO, detail: 'medium' }); }
  catch (e) { threw = e.message; }
  check('メモだけでは要約しない', threw === '要約対象のテキストがありません');

  console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
  process.exit(fail === 0 ? 0 : 1);
})();
