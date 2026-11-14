// ライブ整形の「見出し追加」（ミドル整形＝溜まった文字起こしをまとめ直して見出しを付ける）が、
// 段落の数ではなく設定の秒数だけで動くかを、本物の Chromium で検査する (v0.24.51)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-mid-consolidate-browser.js
//
// やっさん「見出し付けは秒数を設定できるようにしよう」「段落で、という処理はなくそう」「今はむしろ多すぎる」。
// 以前は「3段落たまったら、または60秒」で、Gemini Audio モードではチャンクが20秒前後で届くので
// 実質1分ごとに見出しが付いていた。Gemini は page.route で差し替える。
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
  const bodies = [];
  let delayConsolidate = 0;
  await page.route('**/generativelanguage.googleapis.com/**', async r => {
    const body = JSON.parse(r.request().postData() || '{}');
    const isAudio = JSON.stringify(body).includes('inline_data');
    bodies.push({ isAudio, maxOut: body.generationConfig && body.generationConfig.maxOutputTokens });
    if (!isAudio && delayConsolidate) await new Promise(res => setTimeout(res, delayConsolidate));
    r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: isAudio ? '今日は評価論の話をします。観点は三つあります。' : '## 評価論\nまとめた本文' }] }, finishReason: 'STOP' }] }) });
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'AIza-test', aiEnabled: true, midConsolidateSec: 30 }));
  });
  await page.goto(URL);
  await page.waitForTimeout(800);

  const chunk = () => page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null));
  const consolidations = () => bodies.filter(b => !b.isAudio).length;
  await page.evaluate(() => { state.isRecording = true; });   // 録音中のふり（停止処理中の待ちに入らないように）

  console.log('■ 段落がいくつ溜まっても、秒数が来るまではまとめない');
  for (let i = 0; i < 5; i++) await chunk();
  await page.waitForTimeout(300);
  eq('5かたまり溜まってもまとめていない（以前は3つで発火）', consolidations(), 0);
  eq('文字起こしは5段落のまま', await page.evaluate(() => document.querySelectorAll('#confirmed .paragraph.short-refined').length), 5);

  console.log('■ 設定の秒数が過ぎたら、次のかたまりが届いたところでまとめる');
  // 最初のかたまりを31秒前に届いたことにする（30秒待つ代わり）
  await page.evaluate(() => { document.querySelector('#confirmed .paragraph.short-refined').dataset.shortTs = String(Date.now() - 31000); });
  delayConsolidate = 800;
  await chunk();
  await page.waitForTimeout(300);
  eq('まとめ直しを1回頼んだ', consolidations(), 1);
  eq('待っている間も元の文字が見えている（「文脈整形中」の1行にしない）',
     await page.evaluate(() => { const p = document.querySelector('#confirmed .paragraph.refining'); return !!p && p.textContent.includes('評価論の話'); }), true);
  await page.waitForTimeout(900);
  eq('終わると見出し付きの1段落になる', await page.evaluate(() => document.querySelector('#confirmed .paragraph.refined h2')?.textContent), '評価論');
  const mo = bodies.filter(b => !b.isAudio)[0].maxOut;
  eq('返事の上限を量に合わせて広げている（既定の2048で切れないように）', mo >= 2048, true);

  console.log('■ 設定欄');
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await page.waitForTimeout(300);
  eq('「見出し追加のタイミング（秒）」に保存した値が入る', await page.evaluate(() => document.getElementById('input-mid-consolidate-sec').value), '30');
  await page.evaluate(() => { document.getElementById('input-mid-consolidate-sec').value = '600'; saveSettingsFromForm(); });
  eq('保存できる', await page.evaluate(() => state.settings.midConsolidateSec), 600);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
