// タブごとのオン・オフ（v0.24.143）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-tab-opts-browser.js
//
// やっさんの指定（2026-11-13）: タブのトグル（ライブ整形・要約・タイトル生成・ライブ要約）は設定のトグルと同じ働きで、タブごとに決められる。
// 設定は新しいタブの初めの値。つまみ＝このタブのオン・オフ、名前＝押すと小窓で「いま作るか（あれば作り直すか）」を聞く
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
  let gemini = 0;
  await page.route('**/generativelanguage.googleapis.com/**', (r) => { gemini++; r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '## 概要\n- 要約' }] }, finishReason: 'STOP' }] }) }); });
  await page.goto(URL);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'A', aiEnabled: true, autoSummarize: false, liveSummary: true, claudeCode: false })); });
  await page.reload();
  await page.waitForTimeout(800);
  const on = (id) => page.evaluate((id) => document.getElementById(id).classList.contains('on'), id);

  console.log('■ 名前');
  eq('ライブ整形・要約・タイトル生成・ライブ要約', await page.evaluate(() => ['btn-refine-transcript', 'btn-summary-combo', 'btn-live-combo'].map((id) => document.querySelector(`#${id} .toggle-label`).textContent.trim())),
    ['ライブ整形', '要約・タイトル生成', 'ライブ要約']);
  eq('前の［最初から要約し直す］は無い（名前を押す働きに入れた）', await page.evaluate(() => !document.getElementById('btn-live-redo')), true);

  console.log('\n■ 新しいタブは設定の値で始まり、つまみはこのタブだけ切り替える');
  // 読み直すときに前のタブが保存し直されることがあるので、いまの設定で新しいタブを作ってから見る
  await page.evaluate(() => createSession());
  await page.waitForTimeout(300);
  const a = await page.evaluate(() => state.activeId);
  eq('はじめは設定の値（整形オン・要約オフ・ライブ要約オン）', [await on('btn-refine-transcript'), await on('btn-summary-combo'), await on('btn-live-combo')], [true, false, true]);
  await page.click('#btn-refine-transcript .toggle-track');
  await page.waitForTimeout(200);
  eq('つまみでこのタブをオフ（設定はオンのまま）', [await on('btn-refine-transcript'), await page.evaluate(() => [tabOpt(state.activeId, 'liveRefine'), state.settings.aiEnabled, liveRefineReady()])], [false, [false, true, false]]);
  await page.evaluate(() => createSession());
  await page.waitForTimeout(300);
  eq('新しいタブは設定の値（オン）', await on('btn-refine-transcript'), true);
  await page.evaluate((a) => switchSession(a), a);
  await page.waitForTimeout(600);
  eq('元のタブに戻るとオフのまま', await on('btn-refine-transcript'), false);

  console.log('\n■ 要約・タイトル生成: 名前を押すと聞く');
  await page.evaluate(() => switchInnerPane('pane-summary'));
  await page.waitForTimeout(300);
  await page.evaluate(() => { els.confirmed.innerHTML = '<div class="paragraph">' + '今日は消防設備の話です。'.repeat(30) + '</div>'; snapshotActiveToSession(); });
  gemini = 0;
  await page.click('#btn-summary-combo .toggle-label');
  await page.waitForTimeout(400);
  eq('要約が無いときは「作りますか？」', await page.textContent('#confirm-title'), '要約とタイトルを作りますか？');
  await page.click('#confirm-cancel');
  await page.waitForTimeout(400);
  eq('キャンセルなら作らない', gemini, 0);
  await page.click('#btn-summary-combo .toggle-label');
  await page.waitForTimeout(400);
  await page.click('#confirm-ok');
  await page.waitForTimeout(1500);
  eq('作ると、要約とタイトルを作る（2 回呼ぶ）', [gemini >= 2, await page.evaluate(() => !!getActiveSession().summary)], [true, true]);
  await page.click('#btn-summary-combo .toggle-label');
  await page.waitForTimeout(400);
  eq('要約があると「作り直しますか？」', await page.textContent('#confirm-title'), '要約とタイトルを作り直しますか？');
  await page.click('#confirm-cancel');
  await page.waitForTimeout(300);
  await page.click('#btn-summary-combo .toggle-track');
  eq('つまみでこのタブの要約をオン（止めたら作る）', await page.evaluate(() => [tabOpt(state.activeId, 'autoSummary'), state.settings.autoSummarize]), [true, false]);

  console.log('\n■ ライブ要約: つまみと名前');
  await page.evaluate(() => switchInnerPane('pane-live'));
  await page.waitForTimeout(300);
  await page.click('#btn-live-combo .toggle-track');
  eq('つまみでこのタブだけオフ', await page.evaluate(() => [tabOpt(state.activeId, 'liveSummary'), state.settings.liveSummary, liveSummaryActive()]), [false, true, false]);
  await page.evaluate(() => { els.liveSummary.innerHTML = '<p>前の要約</p>'; });
  await page.click('#btn-live-combo .toggle-label');
  await page.waitForTimeout(400);
  eq('ライブ要約があると「作り直しますか？」', await page.textContent('#confirm-title'), 'ライブ要約を作り直しますか？');
  await page.click('#confirm-cancel');

  console.log('\n■ 設定はこれまでどおり（新しいタブの初めの値）');
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(500);
  eq('設定のトグルは設定の値（このタブのつまみとは別）', await page.evaluate(() => [document.getElementById('input-ai-enabled').checked, document.getElementById('input-live-summary').checked]), [true, true]);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
