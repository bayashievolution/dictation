// 「この録音の文脈」の小窓（v0.24.96 で設定と同じ形に並べ直した）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-context-modal-browser.js
//
// 並べ直しは HTML の入れ子だけ。見ること: 見出しの並び／書いた内容が今までどおりタブに保存される／説明の字は消していない
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
  await page.goto(URL);
  await page.waitForTimeout(700);
  await page.evaluate(() => openContextModal());
  await page.waitForTimeout(500);
  eq('見出しの並び', await page.$$eval('#context-modal .field-group-title', ns => ns.map(n => n.textContent)), ['この録音について', '語彙辞書', '自動で拾った内容']);
  eq('説明の字は消していない', await page.evaluate(() => {
    const t = document.getElementById('context-modal').textContent;
    return ['語彙のヒント', '台本としては使われません', '合計50語まで', '上の欄が最終権限'].every(w => t.includes(w));
  }), true);
  await page.fill('#input-context-field', '教育学の講義');
  await page.fill('#input-context-terms', 'ルーブリック、形成的評価');
  await page.click('#btn-context-save');
  await page.waitForTimeout(400);
  eq('タブに保存される', await page.evaluate(() => [getActiveSession().context.field, getActiveSession().context.terms]), ['教育学の講義', 'ルーブリック、形成的評価']);
  eq('閉じる', await page.evaluate(() => document.getElementById('context-modal').classList.contains('hidden')), true);
  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
