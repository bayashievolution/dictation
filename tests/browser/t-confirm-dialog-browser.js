// 確認の小窓（ブラウザの confirm のかわり・v0.24.94）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-confirm-dialog-browser.js
//
// やっさん「タブを閉じようとしたときのモーダルがブラウザ依存なので、オリジナルのモーダルに」
// 「（Notion の前回の保存先の）リセットを赤い丸に × に。押したら一応モーダルで確認」。
// 見ること: ブラウザの小窓は一度も出ない／キャンセル・Esc では閉じない・消えない／OK で閉じる・忘れる
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
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const native = [];
  page.on('dialog', d => { native.push(d.message()); d.dismiss(); });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ notionLastDataSourceId: 'ds1', notionLastDataSourceTitle: '講義ノート', notionEnabled: true, notionToken: 'ntn_x' })));
  await page.reload();
  await page.waitForTimeout(700);
  const shown = () => page.evaluate(() => !document.getElementById('confirm-dialog').classList.contains('hidden'));
  const count = () => page.evaluate(() => state.sessions.length);

  console.log('■ 中身のあるタブを閉じる');
  await page.evaluate(() => { createSession({ activate: true, title: '講義A' }); const s = getActiveSession(); s.transcript = '<p>本文</p>'; persistSessions(); });
  const n0 = await count();
  const id = await page.evaluate(() => state.activeId);
  await page.evaluate((id) => { closeSession(id); }, id);
  await page.waitForTimeout(400);
  eq('自前の確認の小窓が出る', await shown(), true);
  eq('見出しと消すボタン', [await page.textContent('#confirm-title'), await page.textContent('#confirm-ok'), await page.evaluate(() => document.getElementById('confirm-ok').classList.contains('btn-danger'))],
     ['「講義A」を閉じますか？', '閉じる', true]);
  eq('消す確認は、キャンセルに指が置いてある（うっかり Enter で消さない）', await page.evaluate(() => document.activeElement.id), 'confirm-cancel');
  await page.click('#confirm-cancel');
  await page.waitForTimeout(500);
  eq('キャンセルなら閉じない', [await shown(), await count()], [false, n0]);
  await page.evaluate((id) => { closeSession(id); }, id);
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  eq('Esc でも閉じない', [await shown(), await count()], [false, n0]);
  await page.evaluate((id) => { closeSession(id); }, id);
  await page.waitForTimeout(400);
  await page.click('#confirm-ok');
  await page.waitForTimeout(500);
  eq('「閉じる」で閉じる', [await shown(), await count()], [false, n0 - 1]);

  console.log('\n■ 何枚かまとめて閉じる');
  await page.evaluate(() => { for (const t of ['X', 'Y']) { createSession({ activate: true, title: t }); getActiveSession().memo = 'メモ'; } persistSessions(); });
  const n1 = await count();
  await page.evaluate(() => { closeMultipleSessions(state.sessions.slice(-2).map(s => s.id)); });
  await page.waitForTimeout(400);
  eq('まとめての確認も自前の小窓', [await shown(), await page.textContent('#confirm-title')], [true, '2個のタブを閉じますか？']);
  await page.click('#confirm-ok');
  await page.waitForTimeout(500);
  eq('2 枚閉じる', await count(), n1 - 2);

  console.log('\n■ Notion の前回の保存先を忘れる');
  await page.evaluate(() => openSettings());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('btn-notion-forget').scrollIntoView({ block: 'center' }));
  eq('赤い丸の × が保存先の名前の左にある', await page.evaluate(() => {
    const b = document.getElementById('btn-notion-forget'), t = document.getElementById('notion-last-target');
    return [b.classList.contains('clear-chip'), b.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING ? 'left' : 'right', getComputedStyle(b).borderRadius];
  }), [true, 'left', '50%']);
  await page.click('#btn-notion-forget');
  await page.waitForTimeout(400);
  eq('押すと確認の小窓', [await shown(), await page.textContent('#confirm-title')], [true, '前回の保存先を忘れますか？']);
  await page.click('#confirm-cancel');
  await page.waitForTimeout(400);
  eq('キャンセルなら覚えたまま', await page.evaluate(() => state.settings.notionLastDataSourceTitle), '講義ノート');
  await page.click('#btn-notion-forget');
  await page.waitForTimeout(400);
  await page.click('#confirm-ok');
  await page.waitForTimeout(400);
  eq('「忘れる」で忘れる・× は隠れる', [await page.evaluate(() => state.settings.notionLastDataSourceTitle), await page.isVisible('#btn-notion-forget')], ['', false]);

  eq('ブラウザの小窓は一度も出ていない', native, []);
  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
