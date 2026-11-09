// もとから ease（CSS の transition）で動いていたものを、ばねに置き換える（TODO「動きを SUMADO の仕様書に合わせる」の 12）。
// 本物の Chromium で検査する。
//   v0.24.73: メモの Markdown 早見表（出し入れ）
//   v0.24.74: 設定の、モードによって出す・しまう行（Gemini だけ・Web Speech だけ・録音の保持）
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-ease-browser.js
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

/** 出し入れのあいだ、要素の高さと濃さを毎フレーム取る */
const traceReveal = (page, sel, action) => page.evaluate(async ([sel, action]) => {
  const el = document.querySelector(sel);
  eval(action);
  const f = [];
  for (let i = 0; i < 50; i++) { await new Promise(r => requestAnimationFrame(r)); f.push({ h: el.offsetHeight, o: +Number(getComputedStyle(el).opacity).toFixed(3), hidden: el.hidden }); }
  return { f, style: el.getAttribute('style') || '' };
}, [sel, action]);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(800);

  console.log('■ メモの Markdown 早見表');
  {
    await page.evaluate(() => switchInnerPane('pane-memo'));
    await page.waitForTimeout(700);
    const h0 = await page.evaluate(() => document.getElementById('memo-cheatsheet-wrap').offsetHeight);
    eq('メモが空なら出ている', h0 > 50, true);
    const hide = await traceReveal(page, '#memo-cheatsheet-wrap', "els.memo.textContent = 'メモを書いた'; updateMemoCheatsheetVisibility();");
    const hs = hide.f.map(x => x.h);
    eq('書くとしまう: 途中の高さを通って縮む', hs.some(h => h > 2 && h < h0 - 2), true);
    eq('濃さも途中を通る', hide.f.some(x => x.o > 0.05 && x.o < 0.95), true);
    eq('しまいきったら隠れて、場所を取らない', [hide.f[hide.f.length - 1].hidden, hs[hs.length - 1]], [true, 0]);
    const show = await traceReveal(page, '#memo-cheatsheet-wrap', "toggleMemoCheatsheet();");
    const hs2 = show.f.map(x => x.h);
    eq('？ボタンで出す: 途中の高さを通って伸び、最後は元の高さ', [hs2.some(h => h > 2 && h < h0 - 2), Math.abs(hs2[hs2.length - 1] - h0) <= 1], [true, true]);
    eq('止まったら style に値を残さない', show.style.replace(/\s/g, ''), '');
    // 何も指定していないときの transition-property は「all」（長さ 0s）なので、長さで見る
    eq('早見表に ease の transition を残していない', await page.evaluate(() => getComputedStyle(document.getElementById('memo-cheatsheet')).transitionDuration.split(',').every(d => parseFloat(d) === 0)), true);
    eq('もう一度押すとしまう（押した回数どおり）', await page.evaluate(async () => { toggleMemoCheatsheet(); await new Promise(r => setTimeout(r, 900)); return document.getElementById('memo-cheatsheet-wrap').hidden; }), true);
  }

  console.log('■ 設定の、モードによって出す・しまう行');
  {
    await page.evaluate(() => { localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio' })); });
    await page.reload();
    await page.waitForTimeout(800);
    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.waitForTimeout(700);
    const r = await page.evaluate(async () => {
      const g = document.getElementById('gemini-only-fields');
      const keep = document.getElementById('keep-recording-group');
      const below = keep.nextElementSibling;
      const h0 = g.offsetHeight, k0 = keep.offsetHeight;
      const opened = { g: !g.hidden, keep: !keep.hidden, gStyle: g.getAttribute('style') || '' };
      document.getElementById('mode-webspeech').click();
      const f = [];
      for (let i = 0; i < 50; i++) { await new Promise(r => requestAnimationFrame(r)); f.push({ g: g.offsetHeight, k: keep.offsetHeight, b: Math.round(below.getBoundingClientRect().top) }); }
      await new Promise(r => setTimeout(r, 300));
      return { h0, k0, opened, f, hidden: [g.hidden, keep.hidden], style: (g.getAttribute('style') || '') + (keep.getAttribute('style') || '') };
    });
    eq('Gemini モードで開いたときは、どちらも出ている（開いた直後は動かさない）', [r.opened.g, r.opened.keep, r.opened.gStyle], [true, true, '']);
    eq('Web Speech に切り替えると、途中の高さを通ってしまう', [r.f.some(x => x.g > 2 && x.g < r.h0 - 2), r.f.some(x => x.k > 2 && x.k < r.k0 - 2)], [true, true]);
    const steps = r.f.slice(1).map((x, i) => Math.abs(x.b - r.f[i].b));
    eq('下の行も途中を通って寄る（最後に余白の分だけ跳ばない）', [r.f.some((x, i) => i > 0 && x.b !== r.f[0].b && x.b !== r.f[r.f.length - 1].b), steps.slice(-15).every(d => d <= 3)], [true, true]);
    eq('しまいきったら隠れて、style に値を残さない', [r.hidden, r.style.replace(/\s/g, '')], [[true, true], '']);
    eq('grid の ease の transition は使っていない', await page.evaluate(() => getComputedStyle(document.getElementById('webspeech-only-fields')).transitionDuration.split(',').every(d => parseFloat(d) === 0)), true);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
