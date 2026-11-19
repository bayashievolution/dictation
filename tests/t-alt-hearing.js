// 整形に、同じ部分の Web Speech の字も渡す（v0.24.144・やっさんの案）
//
// 渡すときは「整形の元は Groq の字。Web Speech は聞き違いの確かめだけ。片方にしか無い文は足さない」と必ず添える。
// 渡さない（空・同じ字）ときは、プロンプトを前と同じにする（使っていない人の結果を変えない）。
// SRC=/tmp/old/ で v0.24.143 に当てると落ちる。
const fs = require('fs'), vm = require('vm');
const SRC = process.env.SRC || __dirname + '/../';
let fail = 0;
const ok = (label, cond) => { console.log(`${cond ? '✓' : '✕'} ${label}`); if (!cond) fail++; };

const ctx = { console, Error, Promise, JSON, Math, setTimeout, window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC + 'gemini.js', 'utf8'), ctx);
vm.runInContext('_callGemini = async (body) => { globalThis.__sent = JSON.stringify(body); return "整形した文です。"; };', ctx);

(async () => {
  const groq = '今日は熱感知器の仕組みについて考えていきます';
  await ctx.refineWithGemini({ apiKey: 'k', context: '', newChunk: groq, altText: '今日は熱関知器の仕組みについて考えて行きます' });
  const withAlt = ctx.__sent;
  ok('Web Speech の字を渡す', withAlt.includes('熱関知器') && withAlt.includes('別の聞き取り（Web Speech'));
  ok('整形の元は Groq の字だと言う', withAlt.includes('整形の元は【新しい生チャンク】'));
  ok('片方にしか無い文を足させない', withAlt.includes('別の聞き取りにしか無い文・語句は足さない'));

  await ctx.refineWithGemini({ apiKey: 'k', context: '', newChunk: groq, altText: '' });
  ok('渡さないときは、別の聞き取りの段を付けない', !ctx.__sent.includes('別の聞き取り'));
  await ctx.refineWithGemini({ apiKey: 'k', context: '', newChunk: groq, altText: groq.replace(/の/g, 'の ') });
  ok('同じ字（空白の違いだけ）なら付けない', !ctx.__sent.includes('別の聞き取り'));

  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
