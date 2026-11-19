// Gemini のトークン節約（v0.24.55）の純関数を、実物のまま検査する。
//   - 直前の文脈を末尾から縮める（tailForContextHint）
//   - 使用量を処理ごとに数えて1行にする（geminiUsageAdd / formatGeminiUsage）
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
function grab(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} が見つからない`);
  let depth = 0, i = src.indexOf('{', src.indexOf(')', start)), end = -1;
  for (; i < src.length; i++) {
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
const src = fs.readFileSync(path.join(SRC, 'gemini.js'), 'utf8');
const ctx = { JSON, Object, Number, String };
vm.createContext(ctx);
const labels = /const GEMINI_USAGE_LABELS = \{[\s\S]*?\};/.exec(src);
vm.runInContext([
  grab(src, 'tailForContextHint'), 'var _geminiUsage = {};', grab(src, 'geminiUsageAdd'),
  grab(src, 'geminiUsageReset'), grab(src, 'geminiUsageSnapshot'),
  labels ? labels[0].replace('const ', 'var ') : '', grab(src, 'formatGeminiUsage'),
].join('\n'), ctx);

console.log('■ 直前の文脈を縮める');
{
  const t = ctx.tailForContextHint;
  eq('短ければそのまま', t('今日は評価論の話です。', 300), '今日は評価論の話です。');
  const long = '前置きの話です。'.repeat(500) + '最後の文です。';
  const r = t(long, 300);
  eq('上限以内に収める', r.length <= 300, true);
  eq('末尾（いちばん新しいところ）を残す', r.endsWith('最後の文です。'), true);
  eq('文の途中から始めない（前半に句点があればそこから）', r.startsWith('前置きの話です。'), true);
  eq('句点が無くても上限で切る', t('あ'.repeat(1000), 300).length, 300);
  eq('上限なしならそのまま', t('あいう', 0), 'あいう');
}

console.log('\n■ 使用量を数える');
{
  ctx.geminiUsageAdd('transcribe', { promptTokenCount: 900, candidatesTokenCount: 80,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 420 }, { modality: 'AUDIO', tokenCount: 480 }] });
  ctx.geminiUsageAdd('transcribe', { promptTokenCount: 1000, candidatesTokenCount: 120,
    promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 640 }] });
  ctx.geminiUsageAdd('summary', { promptTokenCount: 5000, candidatesTokenCount: 700, thoughtsTokenCount: 0 });
  ctx.geminiUsageAdd('x', null);   // 返事に usageMetadata が無い
  eq('処理ごとに足す', ctx.geminiUsageSnapshot(), {
    transcribe: { calls: 2, input: 1900, audio: 1120, output: 200 },
    summary: { calls: 1, input: 5000, audio: 0, output: 700 },
  });
  eq('1行にする（料金には換算しない）', ctx.formatGeminiUsage(ctx.geminiUsageSnapshot()),
     'Gemini の使用量（トークン）: 合計 入力 6,900 / 出力 900 ― 文字起こし 2回 入力 1,900（うち音声 1,120） / 出力 200、要約 1回 入力 5,000 / 出力 700');
  ctx.geminiUsageReset();
  eq('録音を始めたら数え直す', ctx.formatGeminiUsage(ctx.geminiUsageSnapshot()), '');
}

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
