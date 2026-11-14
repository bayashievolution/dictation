// chatWithGemini が組み立てるプロンプトを、実物の関数を走らせて検査する。
// _callGemini を差し替えて、送られる body を捕まえるだけ。
const fs = require('fs'), vm = require('vm');
function grab(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} が見つからない`);
  let depth = 0, i = src.indexOf('{', src.indexOf(')', start)), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
const gem = fs.readFileSync((process.env.SRC || __dirname + '/../') + 'gemini.js', 'utf8');
let captured = null;
const ctx = { console, Error, Promise,
  _callGemini: async (body) => { captured = body; return 'ok'; } };
vm.createContext(ctx);
vm.runInContext(grab(gem, 'chatWithGemini'), ctx);

let fail = 0;
const has = (label, needle) => {
  const ok = String(captured.system_instruction.parts[0].text).includes(needle);
  console.log(`${ok ? '✓' : '✕'} ${label}`);
  if (!ok) fail++;
};
const lacks = (label, needle) => {
  const ok = !String(captured.system_instruction.parts[0].text).includes(needle);
  console.log(`${ok ? '✓' : '✕'} ${label}`);
  if (!ok) fail++;
};

(async () => {
  await ctx.chatWithGemini({
    apiKey: 'k',
    contextSources: { transcript: '評価は三つの観点で見ます', memo: '', summary: '' },
    history: [],
    question: 'ルーブリックの説明をまとめて',
  });

  console.log('■ 逃げ道に名前を付けない（これが出しすぎの原因だった）');
  lacks('決まり文句を渡していない', '「資料からは分かりません」と正直に答える');
  lacks('結びつけることまで禁止していない', '推測や外部知識は使わない');

  console.log('\n■ やってほしいことを具体的に書く');
  has('別の言い方を探させる', '同じことを別の言い方で話している箇所');
  has('例まで示す（具体の指示は一般則より強い）', 'ルーブリック」と言っていなくても');
  has('複数箇所をつなげさせる', 'つなげて1つの答えにする');
  has('結びつけるのは読み取りだと明言', '推測ではなく読み取り');
  has('直接述べられていないなら断らせる', 'そう断ったうえで');
  has('断り方の例も示す', 'という言い方はされていませんが');

  console.log('\n■ 捏造の歯止めは残す');
  has('資料に無い事実を足さない', '資料に無い事実を足さない');
  has('外部知識で補わない', '外部知識で補わない');
  has('引用は実際の言葉だけ', '引用は実際に話された言葉だけ');

  console.log('\n■ 「分からない」の条件を上げる');
  has('1つも無いときだけ', '本当に1つも見つからないとき');
  has('それでも何か添えさせる', '資料では何が話されているのかを一言添える');

  console.log('\n■ 資料は今までどおり全部渡す');
  has('文字起こしが入っている', '評価は三つの観点で見ます');
  console.log(captured.contents.slice(-1)[0].parts[0].text === 'ルーブリックの説明をまとめて'
    ? '✓ 質問がそのまま渡る' : '✕ 質問がそのまま渡る') || 0;

  console.log(fail ? `\n${fail}件 失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
