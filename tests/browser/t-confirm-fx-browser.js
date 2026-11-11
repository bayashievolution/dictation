// 確定の演出（v0.24.119）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-confirm-fx-browser.js
//
// 見ること:
//   - 本当の道（sendAudioChunkToGemini → Groq → 整形）で、仮の字が入れ替わるときに演出がかかる（呼ぶ道に入っているか）
//   - 演出が終わると包み（span.fxc）が残らない／途中で保存しても包みが保存されない
//   - 「なし」なら包まない
//   - 設定の「表示」に選ぶ欄と見本があり、選ぶと見本が動く（起動時の登録が関数の中に入っていないか ── CLAUDE.md）
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
  await page.route('**/api.groq.com/**', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ text: '今日は家庭科室で火事が起きたらどうなるか考えてみます', segments: [{ text: '今日は家庭科室で火事が起きたらどうなるか考えてみます', no_speech_prob: 0, avg_logprob: -0.1 }] }) }));
  await page.route('**/generativelanguage.googleapis.com/**', async r => {
    await new Promise(res => setTimeout(res, 900));   // 整形は少しあとに返る（Groq の字の演出が見えるように）
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '今日は、家庭科室で火事が起きたらどうなるかを考えてみます。' }] }, finishReason: 'STOP' }] }) });
  });
  await page.goto(URL);
  const setMode = (m) => page.evaluate((m) => {
    localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', transcribeEngine: 'groq', aiEnabled: true, confirmEffect: m }));
  }, m);

  for (const mode of ['type', 'diff', 'fade', 'blur']) {
    console.log(`\n■ ${mode}`);
    await setMode(mode);
    await page.reload();
    await page.waitForTimeout(700);
    await page.evaluate(() => { window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), 'えーと今日はかていかしつで火事が', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
    // Groq の字に入れ替わった直後: 包みがあり、薄い字がある
    await page.waitForFunction(() => document.querySelector('#confirmed .paragraph .fxc'), null, { timeout: 4000 }).catch(() => {});
    const mid = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('#confirmed .fxc')];
      return { n: spans.length, faint: spans.some((s) => Number(getComputedStyle(s).opacity) < 0.99 || s.style.backgroundColor || s.style.filter), saved: savableHtml(els.confirmed.innerHTML).includes('fxc') };
    });
    eq('Groq の字に入れ替わるときに演出がかかる', [mid.n > 0, mid.faint], [true, true]);
    eq('途中で保存しても包みは保存されない', mid.saved, false);
    await page.evaluate(() => window.__p);
    if (mode === 'diff') {
      // 整形の字に入れ替わった直後は、足された句読点などだけが包まれる
      const marked = await page.evaluate(() => [...document.querySelectorAll('#confirmed .fxc')].map((s) => s.textContent).join(''));
      eq('整形の入れ替えでは、変わった字だけ光る（全部ではない）', marked.length > 0 && marked.length < 10, true);
    }
    await page.waitForTimeout(2200);
    const end = await page.evaluate(() => ({ n: document.querySelectorAll('#confirmed .fxc').length, text: document.querySelector('#confirmed .paragraph').textContent, cls: document.querySelector('#confirmed .paragraph').className }));
    eq('終わると包みが残らず、整形の字になる', [end.n, end.text, end.cls], [0, '今日は、家庭科室で火事が起きたらどうなるかを考えてみます。', 'paragraph short-refined']);
  }

  console.log('\n■ なし');
  await setMode('none');
  await page.reload();
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), '仮の字です', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
  let seen = 0;
  for (let i = 0; i < 20; i++) { seen += await page.evaluate(() => document.querySelectorAll('#confirmed .fxc').length); await page.waitForTimeout(100); }
  await page.evaluate(() => window.__p);
  eq('「なし」なら包まない', seen, 0);

  console.log('\n■ 設定の見本');
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(600);
  eq('選ぶ欄に なし＋4 つ', await page.$$eval('#input-confirm-fx option', (o) => o.map((x) => x.textContent)), ['なし', 'ふわっと', '一文字ずつ流れる', 'ぼかしが晴れる', '直ったところが光る']);
  eq('いまの設定が選ばれている', await page.inputValue('#input-confirm-fx'), 'none');
  await page.selectOption('#input-confirm-fx', 'type');
  await page.waitForTimeout(300);
  eq('選ぶと見本に仮の字が出る', await page.evaluate(() => document.querySelector('#confirm-fx-preview .paragraph').className), 'paragraph provisional');
  await page.waitForTimeout(600);
  eq('少しして AI の字に入れ替わり、一文字ずつ流れる', await page.evaluate(() => document.querySelectorAll('#confirm-fx-preview .fxc').length > 10), true);
  await page.waitForTimeout(2000);
  eq('見本も終わると包みが残らない', await page.evaluate(() => [document.querySelectorAll('#confirm-fx-preview .fxc').length, document.querySelector('#confirm-fx-preview').textContent]), [0, '今日は、家庭科室で火事が起きたらどうなるかを考えてみます。熱感知器が']);
  await page.click('#btn-confirm-fx-try');
  await page.waitForTimeout(300);
  eq('［試す］でもう一度', await page.evaluate(() => document.querySelector('#confirm-fx-preview .paragraph').className), 'paragraph provisional');
  await page.click('#btn-save-settings').catch(async () => { await page.evaluate(() => saveSettingsFromForm()); });
  await page.waitForTimeout(400);
  eq('保存すると設定に入る', await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:settings')).confirmEffect), 'type');

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
