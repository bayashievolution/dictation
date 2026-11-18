// 録音日は、そのタブで録音を始めた日時（v0.24.151）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-recorded-at-browser.js
//
// やっさんの実機（2026-11-19）: Notion の録音日が「2026年11月17日 16:55」。11/17 に作ったタブで 11/19 に録音していた。
// 前はタブを作った時刻（createdAt）を使っていた。Web Speech は偽物にして、本当に［録音］を押す（録音を始めたところで記録しているか）
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.addInitScript(() => {
    class FakeRec extends EventTarget { start() { setTimeout(() => this.onstart && this.onstart(), 10); } stop() { setTimeout(() => this.onend && this.onend(), 10); } abort() { this.stop(); } }
    window.SpeechRecognition = FakeRec; window.webkitSpeechRecognition = FakeRec;
  });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'web-speech', aiEnabled: false, autoSummarize: false })));
  await page.reload();
  await page.waitForTimeout(800);

  // 2 日前に作ったタブ（名前は作ったときの既定のまま）
  const twoDaysAgo = await page.evaluate(() => {
    const s = createSession();
    s.createdAt = Date.now() - 2 * 86400000;
    s.title = formatDatePart(s.createdAt);
    loadActiveSessionIntoDOM(); renderTabs();
    return s.createdAt;
  });
  await page.click('#btn-toggle');
  await page.waitForTimeout(800);
  await page.click('#btn-toggle');
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => { const s = getActiveSession(); return { started: s.recordingStartedAt, title: s.title, at: recordedAtOf(s), now: Date.now() }; });
  eq('録音を始めた日時を覚える（作った時刻ではない）', [!!st.started, Math.abs(st.now - st.started) < 10000, st.at === st.started], [true, true, true]);
  eq('タブの名前（作ったときの既定）も、録音を始めた時刻に', st.title, await page.evaluate((t) => formatDatePart(t), st.started));
  eq('作った時刻とは違う日', st.title === await page.evaluate((t) => formatDatePart(t), twoDaysAgo), false);

  // Notion の録音日は録音を始めた日時で送る（送るところを差し替えて、渡した時刻を見る）
  const sent = await page.evaluate(async () => {
    let got = null;
    window.notionCreateNote = async (a) => { got = a.dateTs; return { id: 'p' }; };
    window.notionProgressSet = () => {}; window.notionProgressAddRow = () => {};
    els.confirmed.innerHTML = '<div class="paragraph">中身</div>'; snapshotActiveToSession();
    await notionSendSessions([getActiveSession()], { id: 'ds', title: 'x', titleProp: '名前', dateProp: '日付', pageId: '' });
    return got;
  });
  eq('Notion の録音日は、録音を始めた日時', sent, st.started);

  // 2 回目の録音では変えない（講義の始まりのまま）
  await page.click('#btn-toggle'); await page.waitForTimeout(600); await page.click('#btn-toggle'); await page.waitForTimeout(600);
  eq('2 回目の録音では変えない', await page.evaluate(() => getActiveSession().recordingStartedAt), st.started);

  // 自分で付けた名前は触らない
  const manual = await page.evaluate(() => { const s = createSession(); s.title = '自分で付けた名前'; s.titleIsManual = true; loadActiveSessionIntoDOM(); return s.id; });
  await page.click('#btn-toggle'); await page.waitForTimeout(600); await page.click('#btn-toggle'); await page.waitForTimeout(600);
  eq('自分で付けた名前は触らない', await page.evaluate((id) => state.sessions.find((x) => x.id === id).title, manual), '自分で付けた名前');

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
