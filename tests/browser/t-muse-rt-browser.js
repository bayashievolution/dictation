// 文字起こし比較ページの「Muse のリアルタイム（話者付き）」（v0.24.161）を、本物の Chromium で通す。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-muse-rt-browser.js
//
// Meta のリアルタイムの口（wss://api.meta.ai/v1/asr/realtime）の代わりに、偽の WebSocket を置く。
// 見ること: 公式の説明書どおりの最初の設定（accessToken・PCM_16KHZ・DIARIZATION・日本語・keywords）を送るか、
// 受け付けの印のあとに音を実際の速さ（80ms ずつ）で送るか、最後に endStream を送るか、届いた発言を話者つきで出し、結果の写しに入るか
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const URL = (process.env.URL || 'http://127.0.0.1:8765/') + 'stt-compare.html';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
function makeWav(sec) {
  const sr = 16000, n = sr * sec;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(0.3 * Math.sin(2 * Math.PI * 220 * i / sr) * 32767), 44 + i * 2);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'musert-')), 'test.wav');
  fs.writeFileSync(f, buf);
  return f;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await ctx.addInitScript(() => {
    // 偽のリアルタイムの口: 設定を受けたら受け付けの印、音を受けるたびに数え、決めた時刻に発言を返す
    window.__ws = { url: '', handshake: null, frames: [], end: false };
    class FakeWS {
      constructor(url) { this.url = url; window.__ws.url = url; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 20); }
      send(d) {
        const w = window.__ws;
        if (typeof d === 'string') {
          const j = JSON.parse(d);
          if (!w.handshake) { w.handshake = j; setTimeout(() => this._msg({ sessionId: 'sess-1' }), 30); return; }
          if (j.type === 'endStream') {
            w.end = true;
            this._msg({ type: 'speechComplete', turnId: 2, transcript: 'めっちゃいいっすよ。', audioProcessedMs: 3000 });
            setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1000, reason: '' }); }, 30);
          }
          return;
        }
        w.frames.push({ t: performance.now(), bytes: d.byteLength });
        const ms = w.frames.length * 80;
        if (ms === 400) { this._msg({ type: 'speechStart', turnId: 1, audioProcessedMs: 200 }); this._msg({ type: 'transcript', transcript: '上手に', final: false, audioProcessedMs: 300 }); }
        if (ms === 800) this._msg({ type: 'speaker', label: 'A', audioProcessedMs: 700 });
        if (ms === 1600) { this._msg({ type: 'speechEnd', turnId: 1, audioProcessedMs: 1200 }); this._msg({ type: 'speechComplete', turnId: 1, transcript: '上手に言えたかな。', audioProcessedMs: 1200 }); }
        if (ms === 2000) { this._msg({ type: 'speechStart', turnId: 2, audioProcessedMs: 1800 }); this._msg({ type: 'speaker', label: 'B', audioProcessedMs: 1900 }); }
      }
      close() { this.readyState = 3; }
      _msg(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
    }
    window.WebSocket = FakeWS;
  });
  await page.route(/generativelanguage\.googleapis\.com|api\.groq\.com/, r => r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }));
  await page.goto(URL);
  await page.fill('#muse-key', 'mk_test');
  await page.fill('#ctx-terms', '玄海高等学校、授業参観');
  await page.dispatchEvent('#ctx-terms', 'change');
  for (const id of ['use-gemini', 'use-groq', 'use-muse', 'use-diarize']) await page.setChecked('#' + id, false);
  await page.setChecked('#use-muse-rt', true);
  await page.setChecked('#muse-rt-play', false);
  await page.setInputFiles('#file', makeWav(3));
  await page.waitForFunction(() => !document.getElementById('btn-run').disabled, null, { timeout: 10000 });
  await page.click('#btn-run');
  await page.waitForFunction(() => /終わりました/.test(document.getElementById('muse-rt-stat').textContent), null, { timeout: 20000 });

  const w = await page.evaluate(() => window.__ws);
  eq('リアルタイムの口につなぐ', w.url.startsWith('wss://api.meta.ai/v1/asr/realtime?sessionId='), true);
  eq('最初の設定（公式の説明書どおり）', w.handshake && [w.handshake.authorization.accessToken, w.handshake.audioEncoding, w.handshake.model, w.handshake.mode, w.handshake.languageBias, w.handshake.keywords],
    ['Bearer mk_test', 'PCM_16KHZ', 'muse-voice-transcribe-1.0', 'DIARIZATION', ['Japanese'], ['玄海高等学校', '授業参観']]);
  eq('音は 80ms ずつ（16kHz・16bit で 2560 バイト）', w.frames.slice(0, -1).every((f) => f.bytes === 2560), true);
  const dur = w.frames[w.frames.length - 1].t - w.frames[0].t;
  eq('実際の速さで送る（3 秒の音に 2.5 秒以上かける。速すぎると切られる）', [w.frames.length, dur >= 2500], [38, true]);
  eq('最後に endStream', w.end, true);
  const turns = await page.textContent('#muse-rt-turns');
  eq('発言を話者つきで出す', turns.split('\n').map((l) => l.split('　')[0]), ['A: 上手に言えたかな。', 'B: めっちゃいいっすよ。']);
  eq('遅れの表示', /確定までの遅れ 平均 \d+\.\d秒/.test(await page.textContent('#muse-rt-stat')), true);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#btn-copy');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  eq('結果の写しに入る', clip.includes('# Muse リアルタイム（話者付き）') && clip.includes('A: 上手に言えたかな。'), true);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
