// セッションのタブの動き（v0.24.61・TODO「動きを SUMADO の仕様書に合わせる」の 2）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-tabs-browser.js
//
// 増える・閉じるで全部作り直していて、残りのタブが一瞬で跳んでいた。下の色の線は CSS の transition だった。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const raf = 'new Promise(r => requestAnimationFrame(() => r()))';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(800);
  await page.evaluate(() => { for (let i = 0; i < 3; i++) createSession({ activate: true }); });
  await page.waitForTimeout(900);

  console.log('■ タブが増える');
  {
    const r = await page.evaluate(async (raf) => {
      createSession({ activate: true });
      await eval(raf); await eval(raf);
      const tabs = Array.from(document.querySelectorAll('#tabs-list .tab'));
      const added = tabs[tabs.length - 1];
      const mid = Number(getComputedStyle(added).opacity);
      await new Promise(r => setTimeout(r, 900));
      return { mid, end: Number(getComputedStyle(added.isConnected ? added : document.querySelector('#tabs-list .tab:last-of-type')).opacity),
               style: Array.from(document.querySelectorAll('#tabs-list .tab')).map(t => t.style.transform + t.style.opacity).join('') };
    }, raf);
    eq('新しいタブはふわっと出る（途中の濃さを通る。作り直しが続いても途切れない）', r.mid > 0 && r.mid < 1, true);
    eq('止まったら濃さ 1、style に値を残さない', [r.end, r.style], [1, '']);
  }

  console.log('■ タブを閉じる');
  {
    const r = await page.evaluate(async (raf) => {
      const tabs = Array.from(document.querySelectorAll('#tabs-list .tab'));
      const victim = tabs[1];
      const id = victim.dataset.id;
      const nextBefore = tabs[2].getBoundingClientRect().left;
      closeSession(id);
      const next = document.querySelector(`#tabs-list .tab[data-id="${tabs[2].dataset.id}"]`);
      const nextNow = next.getBoundingClientRect().left;
      const ghost = Array.from(document.body.children).find(e => e.classList && e.classList.contains('tab') && e.getAttribute('aria-hidden') === 'true');
      await eval(raf); await eval(raf);
      const ghostMid = ghost ? Number(ghost.style.opacity) : -1;
      const nextMid = next.getBoundingClientRect().left;
      await new Promise(r => setTimeout(r, 900));
      return { nextBefore, nextNow, nextMid, nextEnd: next.getBoundingClientRect().left, ghost: !!ghost, ghostMid,
               ghostGone: !Array.from(document.body.children).some(e => e.classList && e.classList.contains('tab') && e.getAttribute('aria-hidden') === 'true'),
               gone: !document.querySelector(`#tabs-list .tab[data-id="${id}"]`), style: next.style.transform };
    }, raf);
    eq('閉じたタブは一覧からすぐ消える', r.gone, true);
    eq('写しがふわっと消える', [r.ghost, r.ghostMid > 0 && r.ghostMid < 1, r.ghostGone], [true, true, true]);
    eq('右のタブは、閉じた直後は前の場所に見えている（跳ばない）', Math.abs(r.nextNow - r.nextBefore) < 1, true);
    eq('そこから左へすっと寄る（途中を通る）', r.nextMid < r.nextBefore - 0.5 && r.nextMid > r.nextEnd + 0.5, true);
    eq('止まったら style に値を残さない', r.style, '');
  }

  console.log('■ 下の色の線は、ばねで移る');
  {
    const r = await page.evaluate(async (raf) => {
      const bar = els.tabsList.__activeIndicator;
      const tabs = Array.from(document.querySelectorAll('#tabs-list .tab'));
      const target = tabs[0];
      const transition = getComputedStyle(bar).transitionProperty;
      switchSession(target.dataset.id);
      await eval(raf); await eval(raf); await eval(raf); await eval(raf);
      const mid = bar.getBoundingClientRect().left;
      await new Promise(r => setTimeout(r, 900));
      // 切り替えでタブは作り直されるので、選んだタブは探し直す
      const now = document.querySelector(`#tabs-list .tab[data-id="${target.dataset.id}"]`);
      return { transition, mid, end: bar.getBoundingClientRect().left, want: now.getBoundingClientRect().left };
    }, raf);
    eq('CSS の transition で位置・幅を動かしていない', /transform|width|all/.test(r.transition), false);
    eq('途中を通って', Math.abs(r.mid - r.end) > 1, true);
    eq('最後は選んだタブの位置', Math.abs(r.end - r.want) < 1, true);
  }

  // v0.24.78: セッションを切り替えたときの中身の横送りも、keyframes の ease からばねに
  console.log('■ セッションを切り替えたとき、中身は横に送られる（ばね）');
  {
    const r = await page.evaluate(async () => {
      const tabs = Array.from(document.querySelectorAll('#tabs-list .tab'));
      const target = tabs[tabs.length - 1].dataset.id === state.activeId ? tabs[0] : tabs[tabs.length - 1];
      switchSession(target.dataset.id);
      const xs = [];
      for (let i = 0; i < 40; i++) { await new Promise(r => requestAnimationFrame(r)); xs.push(+new DOMMatrix(getComputedStyle(els.mainArea).transform).e.toFixed(1)); }
      await new Promise(r => setTimeout(r, 300));
      return { xs, anim: getComputedStyle(els.mainArea).animationName, style: els.mainArea.getAttribute('style') || '' };
    });
    eq('送る向きの端から、途中を通って元の位置へ', [Math.abs(r.xs[0]) > 5, Math.abs(r.xs[r.xs.length - 1]) < 0.5, r.xs.some(x => Math.abs(x) > 0.5 && Math.abs(x) < Math.abs(r.xs[0]) - 0.5)], [true, true, true]);
    eq('keyframes の動きは使っていない', r.anim, 'none');
    eq('止まったら style に値を残さない', r.style.replace(/\s/g, ''), '');
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
