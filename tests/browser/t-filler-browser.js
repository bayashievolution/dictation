// 無音のあいだの「はい。」が続かないか・下書きの字の大きさ（v0.24.130）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-filler-browser.js
//
// 実機 2026-11-11（やっさん）: 無音部分で「はい、どうぞ。」「はい。」「はい。」「はい。」と出た。
// 前の版で再現すると、1 つのかたまりの中で Whisper が相づちを繰り返していた（segments が 4 つ）。全体では「どうぞ」が入るので
// 相づちだけとはみなされず、整形で行が分かれて 4 行になった（groq.js の GROQ_QUIET_FILLER のコメント）。
// 前の版（v0.24.129）に当てると 2 件とも落ちる
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const segs = ['はい、どうぞ。', 'はい。', 'はい。', 'はい。'].map((text) => ({ text, no_speech_prob: 0.05, avg_logprob: -0.3 }));
  await page.route('**/api.groq.com/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: segs.map((x) => x.text).join(''), segments: segs }) }));
  // 整形は、もらった字を空白で行に分けて返す（実機で 4 行になったのと同じ）
  await page.route('**/generativelanguage.googleapis.com/**', r => {
    const m = JSON.parse(r.request().postData()).contents[0].parts[0].text.match(/【新しい生チャンク（整形対象）】\n([\s\S]*)$/);
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: m ? m[1].replace(/ /g, '\n') : '' }] }, finishReason: 'STOP' }] }) });
  });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', transcribeEngine: 'groq', aiEnabled: true })));
  await page.reload();
  await page.waitForTimeout(700);
  const send = (hadSpeech) => page.evaluate((hs) => sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000, hadSpeech: hs }), hadSpeech);
  const paras = () => page.evaluate(() => [...document.querySelectorAll('#confirmed .paragraph')].map((p) => p.innerText.trim()));

  console.log('■ 1 つのかたまりの中で相づちが繰り返される');
  await send(false);
  await page.waitForTimeout(500);
  eq('無音（大きい音なし）なら何も出さない', await paras(), []);
  await send(true);
  await page.waitForTimeout(500);
  eq('大きい音があっても、繰り返しは 1 つに', await paras(), ['はい、どうぞ。']);

  console.log('\n■ 下書きの字の大きさは段落と同じ');
  const size = await page.evaluate(() => {
    els.interim.textContent = '下書き';
    const p = document.querySelector('#confirmed .paragraph .p-body');
    return [getComputedStyle(els.interim).fontSize, getComputedStyle(p).fontSize, getComputedStyle(els.interim).fontFamily === getComputedStyle(p).fontFamily];
  });
  eq('同じ大きさ・同じ書体', [size[0] === size[1], size[2]], [true, true]);
  await page.evaluate(() => { state.settings.transcriptSize = 22; applyDisplaySettings(); });
  const size2 = await page.evaluate(() => [getComputedStyle(els.interim).fontSize, getComputedStyle(document.querySelector('#confirmed .paragraph .p-body')).fontSize]);
  eq('文字の大きさの設定を変えても、そろったまま', size2[0] === size2[1], true);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
