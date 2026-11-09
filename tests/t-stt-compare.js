// 文字起こし比較ページ（stt-compare.html）の計算部分を、実物の関数のまま検査する (2026-11-09)。
//
// Gemini と Groq Whisper を同じ音声で比べるページ。比較そのものが狂うと結論を誤るので、
// 「同じ場所で切る」「正しい WAV を送る」「Whisper の prompt が上限を超えない」を確かめる。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const file = path.join(SRC, 'stt-compare-core.js');
if (!fs.existsSync(file)) { console.log('✕ stt-compare-core.js が無い'); process.exit(1); }

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const ctx = { Math, Float32Array, ArrayBuffer, DataView, Number, String, JSON };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const C = ctx;

console.log('■ 区切り（最短〜最長のいちばん静かなところで切る）');
{
  // 0.1 秒ごと 60 秒。15 秒・33 秒・50 秒のところだけ静か
  const frames = Array.from({ length: 600 }, (_, i) => ([150, 330, 500].some(q => Math.abs(i - q) <= 4) ? 0.0005 : 0.1));
  const ch = C.sttPlanChunks(frames, 0.1, { minSec: 12, maxSec: 20 });
  eq('切れ目は静かなところ', ch.map(c => Math.round(c.end)), [15, 33, 50, 60]);
  eq('静かなところで切ったら endsAtSilence', ch.map(c => c.endsAtSilence), [true, true, true, true]);
  eq('次の区切りの startsAtSilence に引き継ぐ', ch.map(c => c.startsAtSilence), [true, true, true, true]);
  eq('すき間なくつながる', ch.every((c, i) => i === 0 || c.start === ch[i - 1].end), true);
}
{
  // ずっと話している（静かなところが無い）→ 最長で切られ、「無音で切れていない」と正直に言う
  const frames = Array.from({ length: 450 }, (_, i) => 0.1 + 0.001 * (i % 7));
  const ch = C.sttPlanChunks(frames, 0.1, { minSec: 12, maxSec: 20 });
  eq('全部最長以下', ch.every(c => c.end - c.start <= 20 + 1e-9), true);
  eq('全部最短以上（最後を除く）', ch.slice(0, -1).every(c => c.end - c.start >= 12 - 1e-9), true);
  eq('静かでない切れ目は endsAtSilence=false', ch.slice(0, -1).map(c => c.endsAtSilence), ch.slice(0, -1).map(() => false));
  eq('次は startsAtSilence=false', ch[1].startsAtSilence, false);
}
{
  // 14〜17 秒がずっと静か → 入り口ではなく真ん中で切る（次の発話の頭を削らない）
  const frames = Array.from({ length: 400 }, (_, i) => (i >= 140 && i < 170 ? 0.0005 : 0.1));
  const ch = C.sttPlanChunks(frames, 0.1, { minSec: 12, maxSec: 20 });
  eq('長い無音は真ん中で切る', Math.round(ch[0].end * 10) / 10, 15.5);
}
eq('短い音声は 1 個', C.sttPlanChunks(new Array(80).fill(0.1), 0.1).length, 1);
eq('空は 0 個', C.sttPlanChunks([], 0.1).length, 0);

console.log('\n■ 範囲を選ぶ');
{
  const ch = [{ start: 0, end: 15 }, { start: 15, end: 33 }, { start: 33, end: 50 }, { start: 50, end: 60 }];
  eq('20〜40 秒にかかるもの', C.sttPickRange(ch, 20, 20).map(c => c.start), [15, 33]);
  eq('ちょうど境目からなら前のは含めない', C.sttPickRange(ch, 15, 10).map(c => c.start), [15]);
}

console.log('\n■ ノーマライズ（雑音を持ち上げすぎない）');
{
  const r = C.sttNormalizePeak(new Float32Array([0.1, -0.05]), { targetDb: -1 });
  eq('いちばん大きいところが -1dB', Math.round(C.sttDb(Math.abs(r.samples[0])) * 10) / 10, -1);
  const q = C.sttNormalizePeak(new Float32Array([0.0001]), { targetDb: -1, maxGainDb: 20 });
  eq('無音に近いものは +20dB で止める', Math.round(q.gainDb), 20);
  eq('全くの無音は変えない', C.sttNormalizePeak(new Float32Array([0, 0])).gainDb, 0);
}

console.log('\n■ WAV');
{
  const buf = C.sttEncodeWav16(new Float32Array([0, 1, -1, 0.5]), 16000);
  const v = new DataView(buf);
  const s = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  eq('RIFF/WAVE', s(0, 4) + s(8, 4), 'RIFFWAVE');
  eq('長さ', buf.byteLength, 44 + 8);
  eq('16kHz・モノラル・16bit', [v.getUint32(24, true), v.getUint16(22, true), v.getUint16(34, true)], [16000, 1, 16]);
  eq('サンプル', [v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)], [0, 32767, -32768]);
}

console.log('\n■ Groq');
eq('10 秒未満は 10 秒で数えられる', C.sttGroqBilledSec(4), 10);
eq('それ以上はそのまま', C.sttGroqBilledSec(18.5), 18.5);
{
  const p = C.sttWhisperPrompt('ルーブリック、形成的評価', 'あ'.repeat(500), 150);
  eq('prompt は上限内', p.length <= 150, true);
  eq('語が先頭', p.startsWith('語: ルーブリック'), true);
  eq('直前の文は末尾を使う', p.endsWith('あ'), true);
  eq('語が長すぎても直前の文の場所が残る', C.sttWhisperPrompt('語'.repeat(500), 'おわり', 150).endsWith('おわり'), true);
  eq('両方空なら空', C.sttWhisperPrompt('', ''), '');
}
{
  const s = C.sttSuspiciousSegments([
    { text: ' ご視聴ありがとうございました', no_speech_prob: 0.9, avg_logprob: -1.3, compression_ratio: 1 },
    { text: 'はい、それでは始めます', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 },
    { text: 'ですですですですですです', no_speech_prob: 0.1, avg_logprob: -0.3, compression_ratio: 3.2 },
    { text: '小さい声', no_speech_prob: 0.7, avg_logprob: -0.4, compression_ratio: 1 },
  ]);
  eq('雑音から作った文と繰り返しだけに印', s.map(x => x.text), ['ご視聴ありがとうございました', 'ですですですですですです']);
  eq('自信のある小さい声には印を付けない', s.some(x => x.text === '小さい声'), false);
  eq('segments が無くても落ちない', C.sttSuspiciousSegments(undefined).length, 0);
}

console.log('\n■ 書き出し');
{
  const rows = [
    { start: 0, end: 15, peakDb: -12, gemini: { text: 'こんにちは。', ms: 2100, tokens: { input: 900, audio: 480 } }, groq: { text: 'こんにちは', ms: 700, suspicious: [] } },
    { start: 15, end: 20, peakDb: -60, gemini: { text: '', ms: 1500, tokens: { input: 600, audio: 160 } }, groq: { text: 'ご視聴ありがとうございました', ms: 600, suspicious: [{ text: 'ご視聴ありがとうございました', reasons: ['話していない見込み'] }] } },
  ];
  const s = C.sttSummarize(rows);
  eq('Gemini のトークンを足す', [s.gemini.input, s.gemini.audio], [1500, 640]);
  eq('Groq の数えられた秒（5 秒は 10 秒）', s.groq.billedSec, 25);
  const t = C.sttResultText({ source: 'テスト' }, rows);
  eq('空は（空）と書く', t.includes('[Gemini 1.5秒] （空）'), true);
  eq('印も書き出す', t.includes('⚠ 話していない見込み: ご視聴ありがとうございました'), true);
}

console.log('\n■ 拡張から Groq に届くか');
{
  const m = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  eq('host_permissions に Groq', m.host_permissions.includes('https://api.groq.com/*'), true);
  eq('CSP の connect-src に Groq', /connect-src[^;]*https:\/\/api\.groq\.com/.test(m.content_security_policy.extension_pages), true);
  const html = fs.readFileSync(path.join(SRC, 'stt-compare.html'), 'utf8');
  eq('比較ページに inline script が無い（拡張の CSP で止まる）', /<script>(?!\s*<\/script>)/.test(html), false);
  const idx = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  eq('本体は比較ページのファイルを読み込まない', /stt-compare/.test(idx), false);
}

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
