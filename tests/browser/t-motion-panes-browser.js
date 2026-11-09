// 中のタブ（文字起こし・メモ・要約…）の切り替えの動き（v0.24.67・TODO「動きを SUMADO の仕様書に合わせる」の 8）を、
// 本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-panes-browser.js
//
// 前は入ってくる側だけ keyframes（ease）で動き、出ていく側は一瞬で消えていた。下の線は CSS の transition だった。
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
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(800);

  console.log('■ 右のタブへ（メモへ）');
  {
    const r = await page.evaluate(async () => {
      const oldP = document.getElementById('pane-transcript');
      const newP = document.getElementById('pane-memo');
      const tx = (el) => new DOMMatrix(getComputedStyle(el).transform).e;
      const op = (el) => Number(getComputedStyle(el).opacity);
      switchInnerPane('pane-memo');
      const frames = [];
      for (let i = 0; i < 50; i++) {
        await new Promise(r => requestAnimationFrame(r));
        frames.push({ ox: +tx(oldP).toFixed(1), oo: +op(oldP).toFixed(3), oshown: getComputedStyle(oldP).display !== 'none', nx: +tx(newP).toFixed(1), no: +op(newP).toFixed(3) });
      }
      await new Promise(r => setTimeout(r, 300));
      return { frames, state: state.activePane, oldGone: getComputedStyle(oldP).display === 'none', oldClass: oldP.className,
               style: (oldP.getAttribute('style') || '') + (newP.getAttribute('style') || ''), anim: getComputedStyle(newP).animationName,
               oldPE: null };
    });
    const f = r.frames;
    eq('すぐに新しいタブが選ばれている（state は待たない）', r.state, 'pane-memo');
    eq('出ていく側は、すぐには消えない（重ねて描かれて薄くなっていく）', [f[1].oshown, f.some(x => x.oshown && x.oo > 0.05 && x.oo < 0.95)], [true, true]);
    eq('出ていく側は左へ、入ってくる側は右から', [f.some(x => x.ox < -2), f[1].nx > 2], [true, true]);
    eq('入ってくる側は最後に元の位置・濃さ', [Math.abs(f[f.length - 1].nx) < 0.5, Math.abs(f[f.length - 1].no - 1) < 0.01], [true, true]);
    eq('keyframes の動きは使っていない', r.anim, 'none');
    eq('出ていき終わったら隠れて、印も style も残さない', [r.oldGone, /pane-leaving/.test(r.oldClass), r.style], [true, false, '']);
  }

  console.log('■ 出ていく途中のペインは押せない');
  {
    const r = await page.evaluate(async () => {
      switchInnerPane('pane-transcript');
      await new Promise(r => requestAnimationFrame(r));
      const leaving = document.getElementById('pane-memo');
      const pe = getComputedStyle(leaving).pointerEvents;
      await new Promise(r => setTimeout(r, 800));
      return pe;
    });
    eq('pointer-events: none', r, 'none');
  }

  console.log('■ すばやく行ったり来たりしても、最後は選んだタブだけが出ている');
  {
    const r = await page.evaluate(async () => {
      switchInnerPane('pane-memo');
      await new Promise(r => requestAnimationFrame(r));
      switchInnerPane('pane-transcript');
      await new Promise(r => requestAnimationFrame(r));
      switchInnerPane('pane-memo');
      await new Promise(r => setTimeout(r, 1000));
      const shown = Array.from(document.querySelectorAll('.pane')).filter(p => getComputedStyle(p).display !== 'none').map(p => p.id);
      const memo = document.getElementById('pane-memo');
      return { shown, op: Number(getComputedStyle(memo).opacity), x: new DOMMatrix(getComputedStyle(memo).transform).e };
    });
    eq('メモだけ', r.shown, ['pane-memo']);
    eq('ちゃんと濃さ 1・元の位置', [Math.abs(r.op - 1) < 0.01, Math.abs(r.x) < 0.5], [true, true]);
  }

  console.log('■ 下の線は、ばねで移る');
  {
    const r = await page.evaluate(async () => {
      const bar = document.querySelector('.inner-tabs-list').__activeIndicator;
      const transition = getComputedStyle(bar).transitionProperty;
      switchInnerPane('pane-summary');
      for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));
      const mid = bar.getBoundingClientRect().left;
      await new Promise(r => setTimeout(r, 900));
      const t = document.querySelector('.inner-tab[data-pane="pane-summary"]');
      return { transition, mid, end: bar.getBoundingClientRect().left, want: t.getBoundingClientRect().left };
    });
    eq('CSS の transition で位置・幅を動かしていない', /transform|width|all/.test(r.transition), false);
    eq('途中を通って、選んだタブの位置へ', [Math.abs(r.mid - r.end) > 1, Math.abs(r.end - r.want) < 1], [true, true]);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
