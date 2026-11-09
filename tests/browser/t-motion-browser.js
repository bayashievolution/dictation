// motion.js（SUMADO のばねを写したもの）が、本物の Chromium で毎フレーム動くかを検査する (v0.24.59)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-browser.js
//
// 途中の値（動いている最中）と、止まったあとの値（style に何も残さない）を見る。
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
  await page.waitForTimeout(600);
  eq('読み込まれている', await page.evaluate(() => typeof Motion === 'object' && typeof Motion.animate === 'function'), true);

  console.log('■ reveal（出す・しまう）');
  const r = await page.evaluate(async () => {
    const box = document.createElement('div');
    box.innerHTML = '<div style="height:120px">中身</div>';
    box.hidden = true;
    document.body.appendChild(box);
    Motion.reveal(box, true);
    await new Promise(r => setTimeout(r, 60));
    const mid = { h: box.offsetHeight, op: Number(box.style.opacity) };
    await new Promise(r => setTimeout(r, 900));
    const end = { h: box.offsetHeight, hidden: box.hidden, style: box.getAttribute('style') || '' };
    Motion.reveal(box, false);
    await new Promise(r => setTimeout(r, 60));
    const mid2 = box.offsetHeight;
    await new Promise(r => setTimeout(r, 900));
    return { mid, end, mid2, hiddenEnd: box.hidden };
  });
  eq('出す途中は高さが伸びている途中・濃さも途中', [r.mid.h > 0 && r.mid.h < 120, r.mid.op > 0 && r.mid.op < 1], [true, true]);
  eq('出しきったら元の高さで、style に値を残さない', [r.end.h, r.end.hidden, r.end.style.replace(/\s/g, '')], [120, false, '']);
  eq('しまう途中は縮んでいる途中', r.mid2 > 0 && r.mid2 < 120, true);
  eq('しまいきったら hidden', r.hiddenEnd, true);

  // v0.24.79: 余白（padding）だけでできた箱（空のときの案内）が、まったく縮まなかった
  console.log('■ reveal: 余白だけでできた箱も 0 まで縮む');
  {
    const r = await page.evaluate(async () => {
      const box = document.createElement('div');
      box.style.cssText = 'padding: 60px 20px';
      document.body.appendChild(box);
      const full = box.offsetHeight;
      Motion.reveal(box, false);
      const f = [];
      for (let i = 0; i < 40; i++) { await new Promise(r => requestAnimationFrame(r)); f.push(box.hidden ? 0 : box.offsetHeight); }
      Motion.reveal(box, true);
      await new Promise(r => setTimeout(r, 900));
      return { full, f, back: box.offsetHeight, style: box.getAttribute('style') };
    });
    eq('途中の高さを通って縮む', [r.full, r.f.some(h => h > 2 && h < r.full - 2)], [120, true]);
    eq('出し直すと元の高さ・余白も元どおり', [r.back, r.style.replace(/\s/g, '')], [120, 'padding:60px20px;']);
  }

  console.log('■ flipList（並びの変化）');
  const f = await page.evaluate(async () => {
    const list = document.createElement('div');
    list.innerHTML = '<div data-key="a" style="height:30px">a</div><div data-key="b" style="height:30px">b</div>';
    document.body.appendChild(list);
    Motion.flipList(list, () => { list.insertBefore(list.lastElementChild, list.firstElementChild); });
    await new Promise(r => requestAnimationFrame(() => r()));
    const a = list.querySelector('[data-key="a"]');
    const mid = a.style.transform;
    await new Promise(r => setTimeout(r, 900));
    return { mid, end: a.style.transform };
  });
  const y = Number((/translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(f.mid) || [])[1]);
  eq('動いた行は前の場所から動いている途中（a は下へ 30px 動く → -30 から 0 へ）', y < -1 && y > -31, true);
  eq('止まったら style に値を残さない', f.end, '');

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
