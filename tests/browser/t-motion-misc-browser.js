// 洗い出しで見つかった、唐突に出る・消える・動くもの（v0.24.81）を、本物の Chromium で検査する。
//   - 使い方ガイド: 暗幕が一瞬で出入り・吹き出しは keyframes の ease・次の手順へは一瞬で跳んでいた
//   - 下の倍率と辞書の札: 質問のタブに出入りするときの薄くする・戻すが CSS の ease だった
//   - メモの画像のハンドル: 選ぶと一瞬で出て、外すと一瞬で消えていた
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-misc-browser.js
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
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(900);

  console.log('■ 使い方ガイド');
  {
    const r = await page.evaluate(async () => {
      const ob = document.getElementById('onboarding');
      const bubble = document.getElementById('onboarding-bubble');
      startOnboarding();
      const open = [];
      let anim = '';
      for (let i = 0; i < 40; i++) {
        await new Promise(r => requestAnimationFrame(r));
        open.push({ o: Number(getComputedStyle(ob).opacity), s: +new DOMMatrix(getComputedStyle(bubble).transform).a.toFixed(3) });
        if (i === 1) anim = getComputedStyle(bubble).animationName + '|' + getComputedStyle(ob.querySelector('.onboarding-overlay')).animationName;
      }
      const b0 = bubble.getBoundingClientRect().top;
      nextOnboarding();
      const tops = [];
      for (let i = 0; i < 40; i++) { await new Promise(r => requestAnimationFrame(r)); tops.push(Math.round(bubble.getBoundingClientRect().top)); }
      const trans = getComputedStyle(bubble).transitionDuration;
      closeOnboarding();
      const closing = [];
      for (let i = 0; i < 20; i++) { await new Promise(r => requestAnimationFrame(r)); closing.push({ o: Number(getComputedStyle(ob).opacity), h: ob.classList.contains('hidden') }); }
      await new Promise(r => setTimeout(r, 600));
      return { open, anim, b0, tops, trans, closing, hidden: ob.classList.contains('hidden'), style: (ob.getAttribute('style') || '') + (bubble.style.transform || '') };
    });
    eq('暗幕はふわっと出る', r.open.some(x => x.o > 0.05 && x.o < 0.95), true);
    eq('吹き出しは少し小さいところから、少し行き過ぎて 1 に収まる', [r.open[0].s < 0.99, Math.max(...r.open.map(x => x.s)) > 1.003, Math.abs(r.open[r.open.length - 1].s - 1) < 0.002], [true, true, true]);
    eq('keyframes の動きは使っていない', r.anim, 'none|none');
    const end = r.tops[r.tops.length - 1];
    // 最初のフレームの時点で、もう少し動いている。前の場所の近くから始まり、途中の場所を通って新しい場所に着くかを見る
    eq('次の手順へは、前の場所から途中を通って移る（一瞬で跳ばない）',
       [Math.abs(end - r.b0) > 20, Math.abs(r.tops[0] - r.b0) < Math.abs(r.tops[0] - end), r.tops.filter(t => Math.abs(t - r.b0) > 2 && Math.abs(t - end) > 2).length >= 3],
       [true, true, true]);
    eq('top / left の ease の transition は使っていない', r.trans.split(',').every(d => parseFloat(d) === 0), true);
    eq('閉じるときもふわっと消えて、最後は隠れる', [r.closing.some(x => !x.h && x.o > 0.05 && x.o < 0.95), r.hidden], [true, true]);
    eq('止まったら style に値を残さない', r.style.replace(/\s/g, ''), '');
  }

  console.log('■ 下の倍率と辞書の札（質問のタブに出入りするとき）');
  {
    const r = await page.evaluate(async () => {
      const bar = els.zoomBar;
      switchInnerPane('pane-chat');
      const ops = [];
      for (let i = 0; i < 60; i++) { await new Promise(r => requestAnimationFrame(r)); ops.push(+Number(getComputedStyle(bar).opacity).toFixed(3)); }
      await new Promise(r => setTimeout(r, 400));
      return { ops, chat: document.body.classList.contains('chat-active'), style: bar.getAttribute('style') || '', trans: getComputedStyle(bar).transitionDuration };
    });
    eq('薄くなって（途中を通って 0 へ）、場所を入れ替えてから戻る', [r.ops.some(o => o > 0.05 && o < 0.4), r.ops.some(o => o < 0.02), r.chat], [true, true, true]);
    eq('止まったら style に値を残さず、指を乗せたときの transition も元どおり', [r.style.replace(/\s/g, ''), r.trans !== '0s'], ['', true]);
    await page.evaluate(() => switchInnerPane('pane-transcript'));
    await page.waitForTimeout(900);
  }

  console.log('■ メモの画像のハンドル');
  {
    await page.evaluate(() => switchInnerPane('pane-memo'));
    await page.waitForTimeout(800);
    const r = await page.evaluate(async () => {
      const img = document.createElement('img');
      img.src = 'assets/icon-128.png';
      els.memo.appendChild(img);
      await new Promise(r => img.complete ? r() : img.addEventListener('load', r));
      selectMemoImage(img);
      const box = document.getElementById('img-handles');
      const show = [];
      for (let i = 0; i < 20; i++) { await new Promise(r => requestAnimationFrame(r)); show.push(Number(getComputedStyle(box).opacity)); }
      clearImageSelection();
      const hide = [];
      for (let i = 0; i < 20; i++) { await new Promise(r => requestAnimationFrame(r)); hide.push({ o: Number(getComputedStyle(box).opacity), h: box.hidden }); }
      return { show, hide, hidden: box.hidden, style: box.style.opacity + box.style.transform };
    });
    eq('選ぶと、ハンドルはふわっと出る', [r.show.some(o => o > 0.05 && o < 0.95), r.show[r.show.length - 1] > 0.99], [true, true]);
    eq('外すと、薄くなってから隠れる', [r.hide.some(x => !x.h && x.o > 0.05 && x.o < 0.95), r.hidden], [true, true]);
    eq('止まったら style に値を残さない', r.style, '');
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
