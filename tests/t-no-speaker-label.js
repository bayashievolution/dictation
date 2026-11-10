// 録音中の文字起こし・整形が、行の頭に名前を付けないように頼んでいるか (v0.24.118)
//
// 実機 2026-11-10: 模擬授業で、名前を決めていない（文脈の「話者」は空）のに
// 「中野　…」「吉澤　…」と行ごとに名前が付いた。録音中の道は声を聞き分けていないので当てずっぽう。
// 前は SYSTEM_PROMPT が「話者名は文脈から補正してよい」と許していた。
//
// プロンプトの中身を検査する（モデルが守るかは、実機で見る）。
// SRC=/tmp/old/ で v0.24.117 に当てると落ちる。
const fs = require('fs'), vm = require('vm');
const SRC = process.env.SRC || __dirname + '/../';

let fail = 0;
const ok = (label, cond) => { console.log(`${cond ? '✓' : '✕'} ${label}`); if (!cond) fail++; };

const ctx = { console, Error, Promise, JSON, Math, setTimeout, FileReader: function () {}, window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC + 'gemini.js', 'utf8'), ctx);
let sent = null;
vm.runInContext('_callGemini = async (body) => { globalThis.__sent = body; return "整形した文です。"; }; blobToBase64 = async () => "AAAA";', ctx);

const promptText = (b) => JSON.stringify(b);
const banLabel = (t) => /行や段落の頭に名前/.test(t) || /行の頭に名前/.test(t);

(async () => {
  await ctx.refineWithGemini({ apiKey: 'k', context: '前の文です。', newChunk: '家庭科室で火事が起きたらどうなるかを考えてみましょう。', sessionContext: { topicPath: ['授業'] } });
  sent = ctx.__sent;
  ok('整形（録音中）: 行の頭に名前を付けないと頼む', banLabel(promptText(sent)));
  ok('整形: 「話者名は文脈から補正してよい」を言わない', !/話者名・専門用語/.test(promptText(sent)));

  await ctx.transcribeAudioWithGemini({ apiKey: 'k', audioBlob: { size: 10, type: 'audio/webm' }, sessionContext: {}, edges: { startsAtSilence: true, endsAtSilence: true } });
  sent = ctx.__sent;
  ok('Gemini で聞き取る: 行の頭に名前を付けないと頼む', banLabel(promptText(sent)));
  ok('呼ばれた名前は本文に残すと言う（消しすぎない）', /呼ばれた名前は本文にそのまま/.test(promptText(sent)));

  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
