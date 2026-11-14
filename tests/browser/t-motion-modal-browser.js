// モーダルの出入り（v0.24.62・TODO「動きを SUMADO の仕様書に合わせる」の 3）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-modal-browser.js
//
// 開くときは CSS の keyframes（ease）、閉じると一瞬で消えていた。
// 仕様書 2.2: アラートは少し大きいところから縮んで、少し行き過ぎて収まる。しまうときは行き過ぎない。
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
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(800);

  // 開いてから閉じるまでの大きさの移り変わりを毎フレーム記録する
  const trace = (id) => page.evaluate(async (id) => {
    const modal = document.getElementById(id);
    const scaleOf = (el) => { const m = new DOMMatrix(getComputedStyle(el).transform); return m.a; };
    const open = [];
    modal.classList.remove('hidden');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const c = modal.querySelector('.modal-card');
      open.push(+scaleOf(c).toFixed(3));
    }
    const card = modal.querySelector('.modal-card');
    const openStyle = card.getAttribute('style') || '';
    const anim = getComputedStyle(card).animationName;
    modal.classList.add('hidden');
    const hiddenNow = modal.classList.contains('hidden') && getComputedStyle(modal).display === 'none';
    await Promise.resolve();   // 見張り（MutationObserver）が写しを置くのは、この処理が終わった直後
    const ghost = Array.from(document.body.children).find(e => e.classList.contains('modal') && e.getAttribute('aria-hidden') === 'true');
    const close = [];
    for (let i = 0; i < 12; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const gc = ghost && ghost.querySelector('.modal-card');
      close.push(gc ? +Number(gc.style.opacity).toFixed(3) : -1);
    }
    await new Promise(r => setTimeout(r, 800));
    return { open, openStyle, anim, hiddenNow, ghost: !!ghost, close,
             ghostGone: !Array.from(document.body.children).some(e => e.classList.contains('modal') && e.getAttribute('aria-hidden') === 'true') };
  }, id);

  for (const id of ['settings-modal', 'context-modal', 'notion-picker', 'silence-dialog', 'captions-modal']) {
    console.log(`■ ${id}`);
    const r = await trace(id);
    eq('少し大きいところから出る（最初は 1 より大きい）', r.open[0] > 1.03, true);
    eq('少し行き過ぎて（1 より小さくなる瞬間がある）、1 に収まる', [Math.min(...r.open) < 0.995, Math.abs(r.open[r.open.length - 1] - 1) < 0.002], [true, true]);
    eq('keyframes の動きは使っていない', r.anim, 'none');
    eq('止まったら style に値を残さない', r.openStyle, '');
    eq('閉じたら本物はすぐ隠れる（「開いていたら」の判定がずれない）', r.hiddenNow, true);
    eq('写しが、だんだん薄くなって消える', [r.ghost, r.close.some(v => v > 0.05 && v < 0.95), r.ghostGone], [true, true, true]);
  }

  console.log('■ 設定の写しには、いま打ち込んでいる値が出る');
  {
    const r = await page.evaluate(async () => {
      const modal = document.getElementById('settings-modal');
      modal.classList.remove('hidden');
      await new Promise(r => setTimeout(r, 500));
      document.getElementById('input-api-key').value = 'AIza-打ち込み中';
      modal.classList.add('hidden');
      await Promise.resolve();
      const ghost = Array.from(document.body.children).find(e => e.classList.contains('modal') && e.getAttribute('aria-hidden') === 'true');
      const v = ghost && ghost.querySelector('input[type="password"], input');
      const vals = ghost ? Array.from(ghost.querySelectorAll('input')).map(i => i.value) : [];
      const dupIds = ghost ? ghost.querySelectorAll('[id]').length : -1;
      await new Promise(r => setTimeout(r, 800));
      return { has: vals.includes('AIza-打ち込み中'), dupIds, v: !!v };
    });
    eq('写しにも同じ値', r.has, true);
    eq('写しには id を残さない（getElementById が写しを拾わない）', r.dupIds, 0);
  }

  console.log('■ Esc で閉じても同じ');
  {
    const r = await page.evaluate(async () => {
      document.getElementById('btn-settings').click();
      await new Promise(r => setTimeout(r, 400));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const hidden = document.getElementById('settings-modal').classList.contains('hidden');
      await Promise.resolve();
      const ghost = Array.from(document.body.children).some(e => e.classList.contains('modal') && e.getAttribute('aria-hidden') === 'true');
      await new Promise(r => setTimeout(r, 800));
      return { hidden, ghost };
    });
    eq('閉じて、写しが消えていく', [r.hidden, r.ghost], [true, true]);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
