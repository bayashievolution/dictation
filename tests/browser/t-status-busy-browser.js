// 右上の状態表示が、要約の途中で「停止」に戻らないか（v0.24.56）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-status-busy-browser.js
//
// やっさん報告「要約を生成中の表示だけど、設定を開いて設定を閉じたら待機中になってたけど、まだ要約中だった」。
// 原因: お知らせが引っ込むときの戻し先（restoreStatus）が「録音中か・停止か」しか見ていなかった。
// 録音を止めるとライブ要約の最終版 → 要約の順に回り、ライブ要約の「更新しました」（2.5秒）が
// 要約の最中に引っ込んで「停止」に戻していた。Claude（/api/claude）と Gemini は page.route で差し替える。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const LIVE_MD = '## 目次\n1. 評価の観点\n\n## 1. 評価の観点\n- 観点は3つ';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.addInitScript(() => {
    class FakeRec extends EventTarget { start() {} stop() {} abort() {} }
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
  });
  await page.route('**/generativelanguage.googleapis.com/**', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }) }));
  await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, invocation: 'claude', features: ['effort', 'timeout', 'session'], auth: { ok: true, loggedIn: true } }) }));
  await page.route('**/api/claude', async r => {
    const p = JSON.parse(r.request().postData() || '{}').prompt || '';
    if (p.includes('目次付きの要約')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, text: LIVE_MD, seconds: 0.2 }) });
    if (/タイトル/.test(p) && !/要約/.test(p.slice(0, 200))) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, text: '講義', seconds: 0.1 }) });
    // 要約は時間がかかる（ライブ要約のお知らせが引っ込むより長く）
    await new Promise(res => setTimeout(res, 7000));
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, text: '## 概要\n- 要約の中身', seconds: 7 }) });
  });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({
    apiKey: 'AIza-test', inputMode: 'web-speech', aiEnabled: false, autoSummarize: true, claudeCode: true, liveSummary: true,
  })));
  await page.reload();
  await page.waitForTimeout(1000);
  const status = () => page.evaluate(() => document.getElementById('status-indicator').textContent);

  console.log('■ 録音を止めたあと（ライブ要約の最終版 → 要約）');
  await page.evaluate(() => startRecording());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const p = document.createElement('div'); p.className = 'paragraph';
    p.textContent = '今日は評価論の話をします。評価の観点は三つあります。'.repeat(10);
    document.getElementById('confirmed').appendChild(p);
    snapshotActiveToSession();
  });
  await page.evaluate(() => stopRecording());
  await page.waitForTimeout(1500);
  eq('要約を回している', await page.evaluate(() => isBusy('summary', state.activeId)), true);
  await page.waitForTimeout(3000);   // ライブ要約の「更新しました」（2.5秒）が引っ込んだあと
  eq('ライブ要約のお知らせが引っ込んでも「要約生成中」のまま', (await status()).startsWith('要約生成中'), true);

  console.log('■ 要約の途中で設定を開いて閉じる');
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => saveSettingsFromForm());
  await page.waitForTimeout(300);
  eq('「要約生成中」のまま', (await status()).startsWith('要約生成中'), true);

  console.log('■ 要約の途中で、ほかのお知らせが出て引っ込む');
  await page.evaluate(() => statusNotice('error', 'なにかのお知らせ', { ms: 500 }));
  await page.waitForTimeout(200);
  eq('お知らせは出る', await status(), 'なにかのお知らせ');
  await page.waitForTimeout(600);
  eq('引っ込んだら「要約生成中」に戻る（「停止」にしない）', (await status()).startsWith('要約生成中'), true);

  console.log('■ 要約が終わったら');
  await page.waitForTimeout(4000);
  eq('要約ができた', await page.evaluate(() => document.getElementById('summary').textContent.includes('要約の中身')), true);
  eq('「停止」に戻る', await status(), '停止');

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
