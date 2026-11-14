// 設定の「既定値に戻す」（AI の動き・停止条件・表示・v0.24.113）を、本物の Chromium で本体を読み込んで押して確かめる。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-settings-defaults-browser.js
//
// 登録がページの読み込みで効いているか（CLAUDE.md「誰がいつ呼ぶか」）と、押して保存すると既定値に戻るかを見る
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
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  // 既定値から外した設定で始める
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({
    apiKey: 'A', claudeCode: true, aiEnabled: false, silenceSec: 9, midConsolidateSec: 900, liveSummary: true, liveSummaryMin: 30,
    autoSummarize: false, summaryDetail: 'high', claudeFallbackGemini: true,
    autoStopEnabled: false, autoStopSec: 500,
    transcriptSize: 22, memoSize: 20, summarySize: 19,
    paneOrder: ['pane-chat', 'pane-summary', 'pane-live', 'pane-memo', 'pane-transcript'],
  })));
  await page.reload();
  await page.waitForTimeout(700);
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(600);

  eq('ボタンがそれぞれのまとまりの中にある', await page.evaluate(() => ['btn-ai-defaults', 'btn-autostop-defaults', 'btn-display-defaults']
    .map(id => document.getElementById(id).closest('.settings-acc').querySelector('.settings-acc-label').textContent)), ['AI の動き', '停止条件', '表示']);

  for (const id of ['btn-ai-defaults', 'btn-autostop-defaults', 'btn-display-defaults']) {
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'center' }), id);
    await page.click('#' + id);
  }
  await page.waitForTimeout(300);
  eq('押しただけでは保存しない', await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:settings')).autoStopSec), 500);
  await page.click('#btn-settings-save');
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:settings')));
  eq('AI の動きが既定値に', [st.aiEnabled, st.silenceSec, st.midConsolidateSec, st.liveSummary, st.liveSummaryMin, st.autoSummarize, st.summaryDetail, st.claudeFallbackGemini],
     [true, 3, 300, false, 10, true, 'medium', false]);
  eq('停止条件が既定値に', [st.autoStopEnabled, st.autoStopSec], [true, 120]);
  eq('表示が既定値に（タブの順・文字の大きさ）', [st.paneOrder, st.transcriptSize, st.memoSize, st.summarySize],
     [['pane-transcript', 'pane-memo', 'pane-live', 'pane-summary', 'pane-chat'], 15, 15, 15]);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
