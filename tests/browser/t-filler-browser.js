// 相づちだけのチャンクが続いたときに2つ目以降を出さないことを、本物の Chromium で検査する (v0.24.34)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-filler-browser.js
//
// Gemini は page.route で差し替え、返す文字を順番に決めておく。sendAudioChunkToGemini を
// 直接呼ぶ（録音そのものは始めない）。やっさんの実機で「はい。」が17行並んだ状況の再現。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function run(browser, replies) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const q = replies.slice();
  await page.route('**/generativelanguage.googleapis.com/**', r => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: q.shift() || '' }] }, finishReason: 'STOP' }] }),
  }));
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'AIza-test', aiEnabled: false })));
  await page.reload();
  await page.waitForTimeout(700);
  for (let i = 0; i < replies.length; i++) {
    await page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null));
  }
  await page.waitForTimeout(300);
  const lines = await page.evaluate(() => Array.from(document.querySelectorAll('#confirmed .paragraph')).map(p => p.textContent.trim()));
  await ctx.close();
  return lines;
}

(async () => {
  const browser = await chromium.launch();

  console.log('■ 無言でキーボードを打っている間（実機の再現）');
  eq('「はい。」は1つだけ残す', await run(browser, [
    '続いて、うちの院生のフォルダーのところにコメントを今から5分間で記入よろしくお願いします。',
    'はい。', 'はい。', 'はい。', 'はい。', 'はい、はい。', 'はい。',
  ]), ['続いて、うちの院生のフォルダーのところにコメントを今から5分間で記入よろしくお願いします。', 'はい。']);

  console.log('■ 話が戻れば、また普通に出す');
  eq('相づちのあとの本当の発言は消さない', await run(browser, [
    'はい。', 'はい。', 'では、書けた人から発表してください。', 'はい。',
  ]), ['はい。', 'では、書けた人から発表してください。', 'はい。']);

  console.log('■ 「はい、そうです」は相づちではない');
  eq('続いても消さない', await run(browser, ['はい、そうです。', 'はい、そうです。']), ['はい、そうです。', 'はい、そうです。']);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
