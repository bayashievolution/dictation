// 小さなメニューの出入り（TODO「動きを SUMADO の仕様書に合わせる」の 4・6）を、本物の Chromium で検査する。
//   v0.24.63: 左下の辞書メニュー
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-popup-browser.js
//
// 仕様書 2.2: メニューは押したところの小さい大きさから、少し行き過ぎてぽんと出る。濃さはすぐ。
// しまうときは行き過ぎない。下から出たものは、下へ戻って消える。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

/** 開く・閉じるを毎フレーム記録する。open / close はページの中で呼ぶ式 */
async function trace(page, el, open, close) {
  return page.evaluate(async ([sel, open, close]) => {
    const el = document.querySelector(sel);
    const m = () => { const t = new DOMMatrix(getComputedStyle(el).transform); return { s: +t.a.toFixed(3), y: +t.f.toFixed(1), o: +Number(getComputedStyle(el).opacity).toFixed(3) }; };
    eval(open);
    const opening = [];
    for (let i = 0; i < 40; i++) { await new Promise(r => requestAnimationFrame(r)); opening.push(m()); }
    const styleOpen = el.getAttribute('style') || '';
    eval(close);
    const hiddenRightAway = el.hidden;
    const closing = [];
    for (let i = 0; i < 40; i++) { await new Promise(r => requestAnimationFrame(r)); closing.push({ ...m(), h: el.hidden }); }
    return { opening, styleOpen, hiddenRightAway, closing, endHidden: el.hidden, styleEnd: el.getAttribute('style') || '' };
  }, [el, open, close]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(800);

  console.log('■ 辞書メニュー（左下の札から上に出る）');
  {
    const r = await trace(page, '#dict-menu', "document.getElementById('dict-toggle').click()", "document.body.click()");
    eq('小さいところから出る', r.opening[0].s < 0.8, true);
    eq('少し行き過ぎて（1 を超える）、1 に収まる', [Math.max(...r.opening.map(x => x.s)) > 1.01, Math.abs(r.opening[r.opening.length - 1].s - 1) < 0.002], [true, true]);
    eq('下のほうから上がってくる', r.opening[0].y > 2, true);
    eq('濃さはすぐ（3 フレーム目には半分以上）', r.opening[2].o > 0.5, true);
    eq('出きったら style に値を残さない', r.styleOpen, '');
    eq('外を押して閉じても、すぐには消えない（下へ戻りながら薄くなる）', [r.hiddenRightAway, r.closing.some(x => !x.h && x.o > 0.05 && x.o < 0.95 && x.y > 0.5)], [false, true]);
    eq('しまうときは行き過ぎない（1 を超えない）', r.closing.every(x => x.s <= 1.0001), true);
    eq('最後は隠れて、style に値を残さない', [r.endHidden, r.styleEnd], [true, '']);
  }
  {
    const r = await page.evaluate(async () => {
      const t = document.getElementById('dict-toggle');
      t.click();
      await new Promise(r => setTimeout(r, 400));
      t.click();   // 閉じる
      await new Promise(r => requestAnimationFrame(r));
      t.click();   // 閉じる途中でもう一度押す → 出し直す（閉じたと勘違いしない）
      await new Promise(r => setTimeout(r, 900));
      const open = !document.getElementById('dict-menu').hidden;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise(r => setTimeout(r, 900));
      return { open, closed: document.getElementById('dict-menu').hidden };
    });
    eq('しまう途中で押し直したら、出し直す', r.open, true);
    eq('Esc でも閉じる', r.closed, true);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
