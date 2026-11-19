// 右上に出す文言を、実物の関数のまま検査する。
// Gemini モードで「録音中」と出すのは、録音が残っていると読めるので嘘になる。
const fs = require('fs'), vm = require('vm');
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
const R = process.env.SRC || __dirname + '/../';
const app = fs.readFileSync(R + 'app.js', 'utf8');

let shown = null;
const ctx = { console, state: { settings: {}, isRecording: false },
              setStatus: (mode, label) => { shown = { mode, label }; } };
vm.createContext(ctx);
// v0.24.56: restoreStatus は走っている処理（statusTasks）を先に見る。旧版には無いので、無ければ飛ばす
const hasTasks = app.includes('function beginStatusTask(');
// v0.24.83: 聞き取りを Groq にしたときの印。旧版には無いので、無ければ飛ばす
const hasGroq = app.includes('function usesGroqTranscribe(');
vm.runInContext([grab(app, 'recordingLabel'), grab(app, 'restoreStatus'), ...(hasGroq ? [grab(app, 'usesGroqTranscribe')] : []), ...(app.includes('function geminiKey(') ? [grab(app, 'geminiKey')] : []),
  ...(hasTasks ? ['var statusTasks = []; var statusNoticeTimer = null;', grab(app, 'beginStatusTask'), grab(app, 'endStatusTask')] : []),
].join('\n'), ctx);

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}: ${JSON.stringify(got)}${ok ? '' : `（期待 ${JSON.stringify(want)}）`}`);
  if (!ok) fail++;
};

console.log('■ 文言');
ctx.state.settings.inputMode = 'gemini-audio';
eq('Gemini モードは「聞き取り中 (Gemini)」', ctx.recordingLabel(), '聞き取り中 (Gemini)');
ctx.state.settings.inputMode = 'web-speech';
eq('Web Speech モードは「録音中」', ctx.recordingLabel(), '録音中');
ctx.state.settings.inputMode = undefined;
eq('設定が無ければ「録音中」', ctx.recordingLabel(), '録音中');

console.log('\n■ 聞き取りを Groq にしたとき（v0.24.83）');
if (!hasGroq) { console.log('✕ usesGroqTranscribe が無い'); fail++; }
else {
  ctx.state.settings.inputMode = 'gemini-audio';
  ctx.state.settings.transcribeEngine = 'groq';
  ctx.state.settings.groqApiKey = 'gsk_x';
  eq('Groq が聞いているなら「聞き取り中 (Groq)」', ctx.recordingLabel(), '聞き取り中 (Groq)');
  ctx.state.settings.groqApiKey = '';
  eq('キーが無ければ Gemini が聞くので (Gemini)', ctx.recordingLabel(), '聞き取り中 (Gemini)');
  ctx.state.settings.groqApiKey = 'gsk_x';
  ctx.state.settings.inputMode = 'web-speech';
  eq('Web Speech モードなら Groq を選んでいても「録音中」', ctx.recordingLabel(), '録音中');
  delete ctx.state.settings.transcribeEngine; delete ctx.state.settings.groqApiKey;
}

console.log('\n■ 状態を戻すとき（エラー表示のあとなど）');
ctx.state.settings.inputMode = 'gemini-audio';
ctx.state.isRecording = true;
ctx.restoreStatus();
eq('Gemini・聞き取り中', shown, { mode: 'listening', label: '聞き取り中 (Gemini)' });
ctx.state.isRecording = false;
ctx.restoreStatus();
eq('Gemini・停止中', shown, { mode: 'idle', label: '停止' });
ctx.state.settings.inputMode = 'web-speech';
ctx.state.isRecording = true;
ctx.restoreStatus();
eq('Web Speech・録音中', shown, { mode: 'listening', label: '録音中' });

console.log('\n■ 走っている処理があれば、そちらに戻す（v0.24.56）');
if (!hasTasks) { console.log('✕ beginStatusTask が無い'); fail++; }
else {
  ctx.state.isRecording = false;
  ctx.beginStatusTask('summary:a', '要約生成中（Claude）');
  eq('始めたら出す', shown, { mode: 'listening', label: '要約生成中（Claude）' });
  ctx.restoreStatus();
  eq('ほかのお知らせが引っ込んでも「停止」にしない', shown, { mode: 'listening', label: '要約生成中（Claude）' });
  ctx.beginStatusTask('live:a', 'ライブ要約を更新中（Claude）');
  ctx.endStatusTask('live:a');
  eq('あとから始まった処理が終わったら、残っているほうに戻す', shown, { mode: 'listening', label: '要約生成中（Claude）' });
  ctx.endStatusTask('summary:a');
  eq('全部終わったら「停止」', shown, { mode: 'idle', label: '停止' });
  vm.runInContext('statusNoticeTimer = 1', ctx);
  shown = null;
  ctx.beginStatusTask('summary:b', '要約生成中（Gemini）');
  eq('お知らせを出している最中は上書きしない', shown, null);
  ctx.restoreStatus();
  eq('お知らせが引っ込んだら出る', shown, { mode: 'listening', label: '要約生成中（Gemini）' });
  ctx.endStatusTask('summary:b');
  vm.runInContext('statusNoticeTimer = null', ctx);
}

console.log('\n■ 直書きが残っていないこと（直すたびに食い違うのを防ぐ）');
const body = app.replace(grab(app, 'recordingLabel'), '');
const strays = body.split('\n')
  .filter(l => /setStatus\([^)]*'録音中'/.test(l));
eq('setStatus に「録音中」を直書きしていない', strays, []);
const geminiStray = body.includes("'録音中 (Gemini)'");
eq('「録音中 (Gemini)」が残っていない', geminiStray, false);

console.log(fail ? `\n${fail}件 失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
