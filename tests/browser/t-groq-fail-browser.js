// 無音のかたまりの Web Speech の字・Groq が空のときの送り直し・Gemini に回すかどうかと失敗の小窓（v0.24.152）を、
// 本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-groq-fail-browser.js
//
// 実機 2026-11-17（やっさん）: 止めたときの最後のかたまりは無音（発話なし・−98〜−86dB）。Groq の「ご視聴ありがとうございました」は落としたが、
// 前のかたまりの Web Speech の字が遅れて届き、「[Groq は聞き取れず・Web Speech の結果です]」として同じ内容が 2 度出た。
// やっさんの指定: はっきり無音なら残さない／声があるのに空ならもう一度 Groq に送る／それでもだめなら設定に従って Gemini に回す
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
  // Groq の返事は順に取り出す（空・字・エラー）
  let groqQueue = [], groqCalls = 0, geminiTranscribe = 0;
  await page.route('**/api.groq.com/**', r => { if (r.request().method() === 'GET') return r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }); /* v0.24.157: キーの確かめ（モデルの一覧） */
    groqCalls++;
    const next = groqQueue.shift() ?? '';
    if (next === 'ERR') return r.fulfill({ status: 400, body: 'bad' });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: next, segments: next ? [{ text: next, no_speech_prob: 0.05, avg_logprob: -0.3 }] : [] }) });
  });
  await page.route('**/generativelanguage.googleapis.com/**', r => { if (r.request().method() === 'GET') return r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }); /* v0.24.157: キーの確かめ（モデルの一覧） */
    const body = JSON.parse(r.request().postData());
    const parts = body.contents[0].parts;
    if (parts.some((p) => p.inlineData || p.inline_data)) {
      geminiTranscribe++;
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini で聞き取った字' }] }, finishReason: 'STOP' }] }) });
    }
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] }) });
  });
  await page.goto(URL);
  const setup = (extra) => page.evaluate((x) => localStorage.setItem('dictation:settings', JSON.stringify(Object.assign({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', transcribeEngine: 'groq', aiEnabled: false }, x))), extra);
  await setup({});
  await page.reload();
  await page.waitForTimeout(500);
  eq('既定は Gemini に回さない（v0.24.155）', await page.evaluate(() => [state.settings.groqFallbackGemini, groqMayFallBackToGemini()]), [false, false]);
  await setup({ groqFallbackGemini: true, groqFallbackV: 2 });
  await page.reload();
  await page.waitForTimeout(700);
  const send = (prov, edges) => page.evaluate(([p, e]) => sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), p, Object.assign({ startsAtSilence: true, endsAtSilence: true, durationMs: 8300 }, e)), [prov, edges]);
  const paras = () => page.evaluate(() => [...document.querySelectorAll('#confirmed .paragraph')].map((p) => p.innerText.trim()));
  const clear = () => page.evaluate(() => { els.confirmed.innerHTML = ''; });
  const PROV = '前のかたまりで話していた内容の続きです';

  console.log('■ はっきり無音のかたまり');
  groqQueue = ['ご視聴ありがとうございました'];
  await send(PROV, { hadSpeech: false, maxDb: -86 });
  await page.waitForTimeout(500);
  eq('Groq が空（決まり文句は落とす）なら、Web Speech の字も残さない', await paras(), []);
  eq('送り直さない（Groq は 1 回だけ）', groqCalls, 1);

  console.log('\n■ 声があったのに Groq が空');
  await clear(); groqCalls = 0;
  groqQueue = ['', '二回目で聞き取れた字'];
  await send(PROV, { hadSpeech: true, maxDb: -40 });
  await page.waitForTimeout(500);
  eq('もう一度 Groq に送る', groqCalls, 2);
  eq('2 回目の字を出す', await paras(), ['二回目で聞き取れた字']);

  await clear(); groqCalls = 0; geminiTranscribe = 0;
  groqQueue = ['', ''];
  await send(PROV, { hadSpeech: true, maxDb: -40 });
  await page.waitForTimeout(500);
  eq('2 回とも空なら、設定（オン）どおり Gemini で文字にする', [groqCalls, geminiTranscribe], [2, 1]);
  eq('Gemini の字を出す', await paras(), ['Gemini で聞き取った字']);

  await clear(); groqCalls = 0;
  groqQueue = [''];
  await send('はい', { hadSpeech: true, maxDb: -40 });
  await page.waitForTimeout(500);
  eq('Web Speech の字が短いときは送り直さない（相づち・物音を正しく空にしたとみる）', groqCalls, 1);

  console.log('\n■ Gemini に回さない設定');
  await setup({ groqFallbackGemini: false, groqFallbackV: 2, geminiLiveDisplay: true });
  await page.reload();
  await page.waitForTimeout(700);
  await clear(); groqCalls = 0; geminiTranscribe = 0;
  eq('設定の行がある', await page.evaluate(() => document.getElementById('input-groq-fallback').checked), false);
  groqQueue = ['ERR'];
  await send(PROV, { hadSpeech: true, maxDb: -40 });
  await page.waitForTimeout(500);
  eq('Gemini には送らない', geminiTranscribe, 0);
  const kept = await paras();
  eq('Web Speech の字は残る', kept.length === 1 && kept[0].startsWith(PROV), true);
  eq('小窓が出る', await page.evaluate(() => !document.getElementById('groq-fail-dialog').classList.contains('hidden')), true);
  eq('トグルの初めの値（Web Speech は設定どおりオン・Gemini はオフ）', await page.evaluate(() => [document.getElementById('groq-fail-webspeech').checked, document.getElementById('groq-fail-gemini').checked]), [true, false]);
  eq('ボタンはキャンセルが左・決定が右', await page.evaluate(() => [...document.querySelectorAll('#groq-fail-dialog .modal-footer button')].map((b) => b.textContent)), ['キャンセル', '決定']);
  await page.click('#groq-fail-dialog label:has(#groq-fail-gemini)');
  await page.click('#groq-fail-dialog [data-groq-fail="ok"]');
  await page.waitForTimeout(400);
  eq('決定で小窓が閉じる', await page.evaluate(() => document.getElementById('groq-fail-dialog').classList.contains('hidden')), true);
  await clear();
  groqQueue = ['ERR'];
  await send(PROV, { hadSpeech: true, maxDb: -40 });
  await page.waitForTimeout(500);
  eq('この録音のあいだは Gemini で文字にする', [geminiTranscribe, await paras()], [1, ['Gemini で聞き取った字']]);
  eq('小窓は 1 回だけ', await page.evaluate(() => document.getElementById('groq-fail-dialog').classList.contains('hidden')), true);
  eq('設定は変わらない', await page.evaluate(() => state.settings.groqFallbackGemini), false);
  await page.evaluate(() => { state.groqOverride = null; state.groqFailAsked = false; });   // 次の録音を始めたのと同じ
  eq('次の録音では設定どおり（Gemini に回さない）', await page.evaluate(() => groqMayFallBackToGemini()), false);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
