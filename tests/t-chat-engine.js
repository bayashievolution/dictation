// 質問ペインの吹き出しに「実際に答えたほう」の名前が出るか (v0.24.17)。
//
// やっさんの確認「Claude 連携してるけど、吹き出しに Gemini って書いてある」。
// v0.24.16 までは答えの側を**いつも「Gemini」**と書いていた。
//
// 検査するのは2段:
//   1. _callGemini が、Claude で答えたか Gemini で答えたかを onEngine で知らせる
//   2. chatSpeakerLabel が、記録された engine から名前を決める
//      （記録の無い古い答えは「AI」。どちらとも言えないので）
const fs = require('fs'), vm = require('vm');
const SRC = process.env.SRC || __dirname + '/../';

function grab(src, head) {
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`${head} が見つからない`);
  // 引数の既定値に {} が入るので、引数の括弧を数えてから本体の { を探す
  let i = src.indexOf('(', start), paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) break; }
  }
  let depth = 0, end = -1;
  for (i = src.indexOf('{', i); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const gem = fs.readFileSync(SRC + 'gemini.js', 'utf8');
const app = fs.readFileSync(SRC + 'app.js', 'utf8');

function callGeminiWith({ claudeAnswer }) {
  const ctx = {
    console, Error, Promise, JSON, Math, encodeURIComponent,
    GEMINI_ENDPOINT: 'https://example.invalid',
    window: {},
    _sleep: async () => {},
    _stripThinkingArtifacts: (t) => t,
    _tryClaudeBridge: async () => claudeAnswer,
    fetch: async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'Gemini の答え' }] }, finishReason: 'STOP' }] }),
    }),
  };
  vm.createContext(ctx);
  vm.runInContext(grab(gem, 'async function _callGemini('), ctx);
  return ctx._callGemini;
}

(async () => {
  console.log('■ _callGemini が答えたほうを知らせる');
  {
    let engine = '';
    const call = callGeminiWith({ claudeAnswer: 'Claude の答え' });
    const text = await call({}, 'k', { feature: 'chat', onEngine: (e) => { engine = e; } });
    eq('Claude で答えたら claude', [text, engine], ['Claude の答え', 'claude']);
  }
  {
    let engine = '';
    // Claude に回せなかった（null）→ Gemini に戻った
    const call = callGeminiWith({ claudeAnswer: null });
    const text = await call({}, 'k', { feature: 'chat', onEngine: (e) => { engine = e; } });
    eq('Claude に回せず Gemini に戻ったら gemini', [text, engine], ['Gemini の答え', 'gemini']);
  }
  {
    const call = callGeminiWith({ claudeAnswer: null });
    eq('onEngine を渡さない呼び出し（要約など）はこれまでどおり動く',
       await call({}, 'k', { feature: 'summary' }), 'Gemini の答え');
  }

  console.log('\n■ chatWithGemini が onEngine を _callGemini まで通す');
  {
    let passed = null;
    const ctx = { console, Error, Promise,
      _callGemini: async (body, key, opts) => { passed = opts; return 'ok'; } };
    vm.createContext(ctx);
    vm.runInContext(grab(gem, 'async function chatWithGemini('), ctx);
    const cb = () => {};
    await ctx.chatWithGemini({ apiKey: 'k', contextSources: {}, history: [], question: 'q', onEngine: cb });
    eq('feature は chat のまま', passed && passed.feature, 'chat');
    eq('onEngine が渡る', passed && passed.onEngine === cb, true);
  }

  console.log('\n■ 吹き出しの名前');
  {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(grab(app, 'function chatSpeakerLabel('), ctx);
    const L = ctx.chatSpeakerLabel;
    eq('質問した側は「あなた」', L({ role: 'user', content: 'q' }), 'あなた');
    eq('Claude が答えたら「Claude」', L({ role: 'assistant', content: 'a', engine: 'claude' }), 'Claude');
    eq('Gemini が答えたら「Gemini」', L({ role: 'assistant', content: 'a', engine: 'gemini' }), 'Gemini');
    eq('記録の無い古い答えは「AI」（Gemini と決めつけない）', L({ role: 'assistant', content: 'a' }), 'AI');
  }

  console.log('\n■ 「Gemini」の決め打ちが残っていない');
  {
    const left = (app.match(/'あなた' : 'Gemini'/g) || []).length;
    eq('吹き出し・保存・コピー・Notion の5か所とも chatSpeakerLabel を通す', left, 0);
  }

  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
