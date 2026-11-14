// 録音を「残す」・ファイルに保存（v0.24.103）を、本物の Chromium と本物の IndexedDB で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-audio-pin-browser.js
//
// やっさん「今日の会議の録音を検証用にキープできないかな。間違って消したらもったいない」。
// 消える道は 4 つある（タブを閉じる・起動時の掃除・保持をオフにする・「すべて消す」）。全部で残るかを見る
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
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', audioKeepRecording: true, audioRetention: 'close' })));
  await page.reload();
  await page.waitForTimeout(700);
  // 会議（残す）と、ほかの録音（残さない）を仕込む
  const ids = await page.evaluate(async () => {
    createSession({ activate: true, title: '今日の会議' }); getActiveSession().transcript = '<p>会議</p>';
    const a = state.activeId;
    createSession({ activate: true, title: 'ほかの録音' }); getActiveSession().transcript = '<p>ほか</p>';
    const b = state.activeId;
    persistSessions();
    for (const id of [a, b]) await audioStorePut(id, new Blob(['x'.repeat(1000)], { type: 'audio/webm' }), 0, 0);
    return { a, b };
  });
  const stored = () => page.evaluate(async () => (await audioStoreSummary()).sessions.map(s => s.sessionId));

  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(800);
  eq('一覧に 2 つ出る（名前つき）', (await page.$$eval('#audio-recordings .recording-title', ns => ns.map(n => n.textContent))).sort(), ['ほかの録音', '今日の会議']);
  // 「今日の会議」を残す
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#audio-recordings .recording-row')].find(r => r.textContent.includes('今日の会議'));
    row.querySelector('input').click();
  });
  eq('残すにすると覚える', await page.evaluate((a) => isAudioPinned(a), ids.a), true);
  eq('トグルは右端（ほかの設定と同じ）', await page.evaluate(() => [...document.querySelectorAll('#audio-recordings .recording-row input')].every(cb => {
    const row = cb.closest('label').getBoundingClientRect(), r = cb.getBoundingClientRect(); return row.right - r.right <= 4;
  })), true);

  console.log('\n■ ファイルに保存');
  // headless の Chromium は、日本語のファイル名を「download」と報告する（ASCII の名前はそのまま。実際の Chrome は日本語の名前で保存する）。
  // なので、ページが頼んだ名前（a.download）を見る。保存が本当に始まったかは download の知らせで見る
  await page.evaluate(() => { window.__dlNames = []; const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dlNames.push(this.download); return c.call(this); }; });
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => [...document.querySelectorAll('#audio-recordings .recording-row')].find(r => r.textContent.includes('今日の会議')).querySelector('.recording-save').click()),
  ]);
  eq('名前つきの webm ファイルを保存する', await page.evaluate(() => window.__dlNames), ['今日の会議.webm']);
  eq('保存が始まる', !!dl, true);
  await page.click('#btn-settings-save');
  await page.waitForTimeout(300);

  console.log('\n■ 1. タブを閉じる');
  await page.evaluate(({ a, b }) => { closeSession(a); }, ids);
  await page.waitForTimeout(400);
  await page.click('#confirm-ok');
  await page.waitForTimeout(400);
  await page.evaluate(({ b }) => { closeSession(b); }, ids);
  await page.waitForTimeout(400);
  await page.click('#confirm-ok');
  await page.waitForTimeout(600);
  eq('残すにした会議は残り、ほかは消える', await stored(), [ids.a]);

  console.log('\n■ 2. 起動時の掃除（タブはもう無い）');
  await page.reload();
  await page.waitForTimeout(1200);
  eq('読み込み直しても残る', await stored(), [ids.a]);
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(800);
  eq('タブを閉じても、覚えておいた名前で出る', await page.$$eval('#audio-recordings .recording-title', ns => ns.map(n => n.textContent)), ['今日の会議']);

  console.log('\n■ 3. 「すべて消す」');
  await page.click('#btn-clear-audio');
  await page.waitForTimeout(400);
  eq('確認に「残す」は消さないと書いてある', (await page.textContent('#confirm-message')).includes('消しません'), true);
  await page.click('#confirm-ok');
  await page.waitForTimeout(600);
  eq('すべて消すでも残る', await stored(), [ids.a]);

  console.log('\n■ 4. 保持をオフにする');
  await page.uncheck('#input-keep-recording');
  await page.click('#btn-settings-save');
  await page.waitForTimeout(800);
  eq('保持をオフにしても残る', await stored(), [ids.a]);

  console.log('\n■ 残すを外したら、次の掃除で消える');
  await page.evaluate((a) => { setAudioPinned(a, false); return sweepStoredAudio(); }, ids.a);
  await page.waitForTimeout(400);
  eq('外すと消える', await stored(), []);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
