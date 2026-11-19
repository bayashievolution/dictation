// 使用量（usage.js・v0.24.104）の数え方を、実物の関数のまま検査する。
// 数え方を間違えると、料金の目安や Groq の無料枠の残りが嘘になる。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const file = path.join(SRC, 'usage.js');
if (!fs.existsSync(file)) { console.log('✕ usage.js が無い'); process.exit(1); }
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const ctx = { Date, Math, Number, String, JSON, Object, localStorage: { getItem: () => null, setItem: () => {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const t = (s) => new Date(s);

console.log('■ Gemini');
{
  const u = {};
  ctx.usageAddGeminiTo(u, 'transcribe', { promptTokenCount: 1000, candidatesTokenCount: 50, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 640 }, { modality: 'TEXT', tokenCount: 360 }] }, t('2026-11-10T10:00:00'));
  ctx.usageAddGeminiTo(u, 'summary', { promptTokenCount: 3000, candidatesTokenCount: 400, thoughtsTokenCount: 100 }, t('2026-11-20T10:00:00'));
  const m = u.gemini['2026-11'];
  eq('文字・音声・出力に分ける（音声は入力から引く）', [m.text, m.audio, m.output], [360 + 3000, 640, 50 + 500]);
  eq('働きごと', [m.byFeature.transcribe.tokens, m.byFeature.summary.tokens], [1050, 3500]);
  eq('料金の目安（文字 0.30・音声 1.00・出力 2.50 / 100万）', Math.round(ctx.usageGeminiCost(m) * 1e6), Math.round(3360 * 0.30 + 640 * 1.00 + 550 * 2.50));
  ctx.usageAddGeminiTo(u, 'chat', { promptTokenCount: 10 }, t('2026-12-01T00:00:01'));
  eq('月が変わると別に数える', Object.keys(u.gemini).sort(), ['2026-11', '2026-12']);
  for (let i = 0; i < 20; i++) ctx.usageAddGeminiTo(u, 'chat', { promptTokenCount: 1 }, t(`20${28 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-01T00:00:00`));
  eq('13 か月より古い月は消す', Object.keys(u.gemini).length, 13);
  eq('usageMetadata が無ければ数えない', JSON.stringify(ctx.usageAddGeminiTo({}, 'x', null)), '{}');
}

console.log('\n■ Groq');
{
  const u = {};
  ctx.usageAddGroqTo(u, 4, null, t('2026-11-10T14:05:00'));
  eq('10 秒未満は 10 秒として数える', [u.groq.daySec, u.groq.dayReq], [10, 1]);
  ctx.usageAddGroqTo(u, 18.5, { 'x-ratelimit-remaining-requests': '1998' }, t('2026-11-10T14:30:00'));
  eq('足していく', [u.groq.daySec, u.groq.hourSec, u.groq.dayReq], [28.5, 28.5, 2]);
  ctx.usageAddGroqTo(u, 20, null, t('2026-11-10T15:01:00'));
  eq('時が変わると、この1時間は 0 から（今日は続く）', [u.groq.hourSec, u.groq.daySec], [20, 48.5]);
  eq('いまの時刻で見ると', ctx.usageGroqNow(u, t('2026-11-10T15:30:00')).hourSec, 20);
  eq('次の日になったら 0', ctx.usageGroqNow(u, t('2026-11-11T09:00:00')).daySec, 0);
  eq('返事の残り（1 時間以内のものだけ）', ctx.usageGroqNow(u, t('2026-11-10T15:00:00')).headers['x-ratelimit-remaining-requests'], '1998');
  eq('古い返事は出さない', ctx.usageGroqNow(u, t('2026-11-10T17:00:00')).headers, null);
}

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
