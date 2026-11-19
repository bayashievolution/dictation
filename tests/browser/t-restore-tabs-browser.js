// 閉じたタブを復元（v0.24.160）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-restore-tabs-browser.js
//
// やっさんの指定（2026-11-18〜19・見本 https://claude.ai/artifact/QW2nLZGryaiJ5jMCJ4BNQs ）:
//   雲の右に「閉じたタブを復元」（時計と戻る矢印）。一覧で選んで戻す。区切り線なし。「戻す（n）」の幅はばねで。
//   残す期間は既定 1 週間・「保持するデータの取り扱い」で変えられる。録音は今までどおり閉じたら消す
// 前の版（v0.24.159）に当てると落ちる
const { chromium } = require('playwright');
const PAGE = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 520, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.route(/generativelanguage\.googleapis\.com|api\.groq\.com/, r => r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }));
  await page.goto(PAGE);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'web-speech' })); indexedDB.deleteDatabase('dictation-closed-tabs'); });
  await page.reload();
  await page.waitForTimeout(800);

  console.log('■ 閉じる → 一覧に出る → 戻す');
  const sid = await page.evaluate(() => {
    state.sessions[0].title = '11/19 10:00 公衆衛生学';
    loadActiveSessionIntoDOM();
    appendRawChunk('感染症の予防について話します。');
    snapshotActiveToSession();
    const id = state.activeId;
    createSession({ activate: true });
    appendRawChunk('二つ目のタブ');
    renderTabs();
    return id;
  });
  eq('雲の右に復元のボタン（時計と戻る矢印）', await page.evaluate(() => { const b = document.getElementById('btn-restore-tabs'); return [b.previousElementSibling.id, b.querySelector('[data-icon]').dataset.icon, b.getAttribute('aria-label')]; }), ['btn-notion-upload', 'sm-history', '閉じたタブを復元']);
  await page.evaluate((id) => { closeSession(id); }, sid);
  await page.waitForTimeout(300);
  eq('閉じる確認の一言は「戻せます」（削除されますとは言わない）', await page.textContent('#confirm-message'), '閉じてから1週間は「閉じたタブを復元」で戻せます。');
  eq('戻せるので、ボタンは赤くしない', await page.evaluate(() => document.getElementById('confirm-ok').classList.contains('btn-danger')), false);
  await page.click('#confirm-ok');
  await page.waitForTimeout(500);
  eq('タブは閉じた', await page.evaluate((id) => !state.sessions.some((s) => s.id === id), sid), true);

  await page.click('#btn-restore-tabs');
  await page.waitForTimeout(600);
  const dlg = await page.evaluate(() => ({
    title: document.getElementById('restore-title').textContent,
    lead: document.getElementById('restore-lead').textContent,
    rows: [...document.querySelectorAll('#restore-list .restore-row .restore-name')].map((e) => e.textContent),
    day: [...document.querySelectorAll('#restore-list .restore-day')].map((e) => e.textContent),
    lines: [...document.querySelectorAll('#restore-box .restore-row, #restore-box .restore-day')].map((e) => getComputedStyle(e).borderTopWidth),
    ok: [document.getElementById('restore-ok').textContent, document.getElementById('restore-ok').disabled],
  }));
  eq('小窓の題・一言・一覧', [dlg.title, dlg.lead, dlg.rows, dlg.day], ['閉じたタブを復元', '閉じてから1週間たつと消えます。', ['11/19 10:00 公衆衛生学'], ['今日']]);
  eq('区切り線なし', dlg.lines.every((w) => w === '0px'), true);
  eq('選ぶまでは押せない', dlg.ok, ['戻す', true]);
  const widths = await page.evaluate(async () => {
    const b = document.getElementById('restore-ok'); const out = [Math.round(b.getBoundingClientRect().width)];
    document.getElementById('restore-all').click();
    for (let i = 0; i < 30; i++) { await new Promise((r) => requestAnimationFrame(r)); out.push(Math.round(b.getBoundingClientRect().width)); }
    return { out, text: b.textContent, disabled: b.disabled };
  });
  const steps = widths.out.slice(1).map((w, i) => Math.abs(w - widths.out[i]));
  const total = Math.abs(widths.out[widths.out.length - 1] - widths.out[0]);
  eq('すべて選ぶで「戻す（1）」になり、押せる', [widths.text, widths.disabled], ['戻す（1）', false]);
  eq('幅はばねで伸びる（1 コマで跳ばない）', [total > 5, Math.max(...steps) < total * 0.6, widths.out.some((w) => w > widths.out[0] + 1 && w < widths.out[widths.out.length - 1] - 1)], [true, true, true]);
  await page.click('#restore-ok');
  await page.waitForTimeout(700);
  eq('戻ると、そのタブを開いて中身も戻る', await page.evaluate((id) => [state.activeId === id, state.sessions.length, document.getElementById('title-display').textContent, (state.sessions.find((s) => s.id === id) || {}).transcript.includes('感染症の予防')], sid), [true, 2, '11/19 10:00 公衆衛生学', true]);
  await page.click('#btn-restore-tabs');
  await page.waitForTimeout(500);
  eq('戻したものは一覧から消える（空の案内）', await page.evaluate(() => [!document.getElementById('restore-empty').hidden, document.getElementById('restore-box').hidden]), [true, true]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n■ 残す期間');
  await page.evaluate(async () => {
    await closedTabsPut([{ id: 'old1', title: '古いタブ', transcript: 'むかし' }], Date.now() - 8 * 864e5);
  });
  await page.reload();
  await page.waitForTimeout(1200);
  eq('1 週間を過ぎたものは、立ち上げたときに消える', await page.evaluate(async () => (await closedTabsList()).map((r) => r.id)), []);
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(700);
  eq('Web Speech モードでも期間の欄は出る・音声ファイルの部分は隠れる', await page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.getBoundingClientRect().height > 2; };
    return [vis('keep-recording-group'), vis('closed-tab-days-field'), vis('keep-audio-fields'), els.inputClosedTabDays.value];
  }), [true, true, false, '7']);
  await page.evaluate(() => { els.inputClosedTabDays.value = '0'; saveSettingsFromForm(); });
  const sid2 = await page.evaluate(() => { appendRawChunk('残さないタブ'); snapshotActiveToSession(); const id = state.activeId; createSession({ activate: true }); return id; });
  await page.evaluate((id) => { closeSession(id); }, sid2);
  await page.waitForTimeout(300);
  eq('「残さない」なら今までどおり「削除されます」', await page.textContent('#confirm-message'), 'このタブの内容は削除されます。');
  await page.click('#confirm-ok');
  await page.waitForTimeout(500);
  eq('保管庫にも入らない', await page.evaluate(async (id) => (await closedTabsList()).some((r) => r.id === id), sid2), false);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
