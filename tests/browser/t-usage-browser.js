// 使用量のカード（v0.24.104）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-usage-browser.js
//
// 見ること: 本当に Gemini・Groq を呼んだときに数えられる（呼ぶ道に入っているか ── CLAUDE.md「誰がいつ呼ぶか」）／
// 設定のいちばん下にカードが出て、数字が入る
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
  await page.route('**/generativelanguage.googleapis.com/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({
    candidates: [{ content: { parts: [{ text: '文字です。' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 480 }] },
  }) }));
  await page.route('**/api.groq.com/**', r => r.fulfill({ contentType: 'application/json',
    // 拡張（host_permissions あり）なら x-ratelimit-* を読める。ここはブラウザ版のページなので、読めるように expose を付けて同じ状況にする
    // （本物の Groq がブラウザ版に見せているかは未確認。見せていなければ、ブラウザ版では「返事の残り」の行が出ないだけ）
    headers: { 'x-ratelimit-remaining-requests': '1999', 'x-ratelimit-limit-requests': '2000', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining-requests, x-ratelimit-limit-requests' },
    body: JSON.stringify({ text: 'ウィスパー', segments: [{ text: 'ウィスパー', no_speech_prob: 0, avg_logprob: -0.1 }] }) }));
  await page.goto(URL);
  await page.evaluate(() => { localStorage.removeItem('dictation:usage'); localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', transcribeEngine: 'gemini', aiEnabled: false })); });
  await page.reload();
  await page.waitForTimeout(700);

  // 本体の道で 1 回ずつ呼ぶ（Gemini で文字起こし → Groq で文字起こし）
  await page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'.repeat(2000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 15000 }));
  await page.waitForTimeout(300);
  await page.evaluate(() => { state.settings.transcribeEngine = 'groq'; return sendAudioChunkToGemini(new Blob(['x'.repeat(2000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 15000 }); });
  await page.waitForTimeout(300);
  const u = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:usage')));
  const mk = Object.keys(u.gemini)[0];
  eq('Gemini の文字起こしが今月に数えられる', [u.gemini[mk].audio, u.gemini[mk].text, u.gemini[mk].output, Object.keys(u.gemini[mk].byFeature)], [480, 520, 20, ['transcribe']]);
  eq('Groq は 15 秒・1 回と数える', [u.groq.daySec, u.groq.dayReq, u.groq.hourSec], [15, 1, 15]);
  eq('Groq の返事の残りも覚える', u.groq.headers['x-ratelimit-remaining-requests'], '1999');

  await page.evaluate(() => openSettings());
  await page.waitForTimeout(500);
  eq('カードは設定のいちばん下（詳細設定の下）', await page.evaluate(() => {
    const t = [...document.querySelectorAll('#settings-modal .settings-section > .field-group-title')].map(n => n.textContent.trim());
    return t.slice(-2);
  }), ['詳細設定', '使用量']);
  const text = await page.textContent('#usage-card');
  eq('Gemini のトークン数と料金の目安が出る', [text.includes('1,020'), text.includes('料金の目安')], [true, true]);
  eq('Groq の残り（今日・この1時間・回数）', [text.includes('今日の音声'), text.includes('この1時間の音声'), text.includes('残り 1,999回')], [true, true, true]);
  eq('Groq の返事の残りも出る', text.includes('Groq の返事では、残り 1999 回'), true);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
