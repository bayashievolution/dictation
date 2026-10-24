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
vm.runInContext([grab(app, 'recordingLabel'), grab(app, 'restoreStatus')].join('\n'), ctx);

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

console.log('\n■ 直書きが残っていないこと（直すたびに食い違うのを防ぐ）');
const body = app.replace(grab(app, 'recordingLabel'), '');
const strays = body.split('\n')
  .filter(l => /setStatus\([^)]*'録音中'/.test(l));
eq('setStatus に「録音中」を直書きしていない', strays, []);
const geminiStray = body.includes("'録音中 (Gemini)'");
eq('「録音中 (Gemini)」が残っていない', geminiStray, false);

console.log(fail ? `\n${fail}件 失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
