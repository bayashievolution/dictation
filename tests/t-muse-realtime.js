// Muse のリアルタイム（話者付き）の届いた通信の組み立て（stt-compare-core.js の sttMuseRtReduce / sttMuseRtSummary・v0.24.161）
// 通信の形は Meta の公式の説明書（dev.meta.ai/docs/speech-to-text の DIARIZATION の例）のとおりに並べて流す
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const ctx = { Math, Float32Array, ArrayBuffer, DataView, Number, String, JSON, Map, Set };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(SRC, 'stt-compare-core.js'), 'utf8'), ctx);
if (typeof ctx.sttMuseRtReduce !== 'function') { console.log('✕ sttMuseRtReduce が無い'); process.exit(1); }

const st = {};
const feed = (ev, sent) => ctx.sttMuseRtReduce(st, ev, sent);
feed({ sessionId: 'abc' }, 0);
feed({ type: 'speechStart', turnId: 1, audioProcessedMs: 1200 }, 1300);
feed({ type: 'transcript', transcript: 'thanks for calling', final: false, audioProcessedMs: 2400 }, 2700);
eq('受け付けの印から sessionId', st.sessionId, 'abc');
eq('途中の字（turnId が無くても、いちばん新しい発言のもの）', [st.live, st.turns.get(1).partial], ['thanks for calling', 'thanks for calling']);
eq('途中の字が出るまでの遅れ（送った長さ − 処理した位置）', st.turns.get(1).firstPartialLagMs, 300);
feed({ type: 'speaker', label: 'A', audioProcessedMs: 2480 }, 2800);
feed({ type: 'transcript', transcript: 'thanks for calling how can i help', final: false, audioProcessedMs: 3400 }, 3500);
feed({ type: 'speechEnd', turnId: 1, audioProcessedMs: 3600 }, 3700);
// 発言は重なることがある: 2 つ目が始まってから 1 つ目の確定が届く
feed({ type: 'speechStart', turnId: 2, audioProcessedMs: 3800 }, 3900);
feed({ type: 'speechComplete', turnId: 1, transcript: 'Thanks for calling. How can I help?', audioProcessedMs: 3600 }, 4500);
feed({ type: 'transcript', transcript: 'こんにちは', final: false, audioProcessedMs: 4600 }, 4800);
feed({ type: 'speaker', label: 'B', audioProcessedMs: 4700 }, 4900);
feed({ type: 'speechComplete', turnId: 2, transcript: ' こんにちは。 ', audioProcessedMs: 5000 }, 5600);   // 実機では頭に空白が付いて届いた
const sum = ctx.sttMuseRtSummary(st);
eq('確定した発言（話者つき・始まった順）', sum.turns.map((t) => [t.speaker, t.transcript]), [['A', 'Thanks for calling. How can I help?'], ['B', 'こんにちは。']]);
eq('確定までの遅れ', sum.turns.map((t) => t.lagMs), [900, 600]);
eq('まとめ（平均・最大・話者の数）', [sum.lagAvgMs, sum.lagMaxMs, sum.speakers], [750, 900, 2]);
feed({ type: 'error', message: 'invalid handshake' }, 5700);
eq('エラーを覚える', st.error, 'invalid handshake');
console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
