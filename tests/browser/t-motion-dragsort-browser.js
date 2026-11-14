// ドラッグで並べ替えたあとの動き（v0.24.72・TODO「動きを SUMADO の仕様書に合わせる」の 11）を、本物の Chromium で
// 本物のマウス操作で検査する。
//   - 設定の「ペインの並び順」: 並べ替えるとその場で一覧を描き直すので、新しい並びへ一瞬で跳んでいた
//   - セッションのタブ・中のタブ: 同じ仕組み（enablePointerDragSort）を使っている
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-dragsort-browser.js
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

/** a を b の後ろへドラッグして、離した直後からの各項目の位置を毎フレーム記録する */
async function dragAndTrace(page, listSel, itemSel, keyAttr, fromIdx, toIdx) {
  const boxes = await page.$$eval(`${listSel} ${itemSel}`, (els) => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }));
  const a = boxes[fromIdx], b = boxes[toIdx];
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 5, a.y + 5, { steps: 3 });
  // b の後ろ半分へ
  const horiz = Math.abs(boxes[1].y - boxes[0].y) < 4;
  const tx = horiz ? b.x + b.w * 0.3 : b.x;
  const ty = horiz ? b.y : b.y + b.h * 0.3;
  await page.mouse.move(tx, ty, { steps: 8 });
  // 離した直後の並びと位置を、ページの中で毎フレーム取る
  await page.evaluate(([listSel, itemSel, keyAttr]) => {
    window.__trace = [];
    const rec = () => {
      const items = Array.from(document.querySelectorAll(`${listSel} ${itemSel}`));
      window.__trace.push(items.map(e => ({ k: e.getAttribute(keyAttr), x: Math.round(e.getBoundingClientRect().left), y: Math.round(e.getBoundingClientRect().top), t: e.style.transform })));
      if (window.__trace.length < 50) requestAnimationFrame(rec);
    };
    document.addEventListener('pointerup', () => requestAnimationFrame(rec), { once: true, capture: true });
  }, [listSel, itemSel, keyAttr]);
  await page.mouse.up();
  await page.waitForTimeout(1100);
  return page.evaluate(() => window.__trace);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(800);

  console.log('■ 設定のペインの並び順');
  {
    await page.evaluate(() => { document.getElementById('btn-settings').click(); expandAllSettingsSections(); });   // v0.24.95: 表示はたたんである
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById('pane-order-list').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    const before = await page.$$eval('#pane-order-list .pane-order-item', (els) => els.map(e => e.getAttribute('data-pane-id')));
    const tr = await dragAndTrace(page, '#pane-order-list', '.pane-order-item', 'data-pane-id', 0, 1);
    const after = await page.$$eval('#pane-order-list .pane-order-item', (els) => els.map(e => e.getAttribute('data-pane-id')));
    eq('並べ替わる（1 つ目が 2 つ目の後ろへ）', after.slice(0, 2), [before[1], before[0]]);
    const moved = before[0];
    const ys = tr.map(f => (f.find(x => x.k === moved) || {}).y).filter(v => v !== undefined);
    const end = ys[ys.length - 1];
    eq('描き直したあとも、動かした項目は前の場所から新しい場所へ途中を通って動く（一瞬で跳ばない）', ys.some(y => Math.abs(y - end) > 2 && Math.abs(y - ys[0]) > 0.5) || (Math.abs(ys[0] - end) > 2), true);
    eq('最初のフレームは、まだ新しい場所に着いていない', Math.abs(ys[0] - end) > 2, true);
    eq('止まったら style に値を残さない', tr[tr.length - 1].every(x => !x.t), true);
    eq('CSS の transition に transform を入れていない（ばねの値を CSS がさらに遅らせない）',
       await page.evaluate(() => /transform|all/.test(getComputedStyle(document.querySelector('#pane-order-list .pane-order-item')).transitionProperty)), false);
    await page.evaluate(() => saveSettingsFromForm());
    await page.waitForTimeout(700);
  }

  console.log('■ セッションのタブ');
  {
    await page.evaluate(() => { for (let i = 0; i < 3; i++) createSession({ activate: true }); });
    await page.waitForTimeout(900);
    const before = await page.$$eval('#tabs-list .tab', (els) => els.map(e => e.getAttribute('data-id')));
    const tr = await dragAndTrace(page, '#tabs-list', '.tab', 'data-id', 0, 2);
    const after = await page.$$eval('#tabs-list .tab', (els) => els.map(e => e.getAttribute('data-id')));
    eq('並べ替わる', after.indexOf(before[0]) > 0, true);
    const xs = tr.map(f => (f.find(x => x.k === before[0]) || {}).x).filter(v => v !== undefined);
    eq('前の場所から新しい場所へ途中を通って動く', Math.abs(xs[0] - xs[xs.length - 1]) > 2, true);
    eq('止まったら style に値を残さない', tr[tr.length - 1].every(x => !x.t), true);
    eq('CSS の transition で動かしていない', await page.evaluate(() => Array.from(document.querySelectorAll('#tabs-list .tab')).every(t => !t.style.transition)), true);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
