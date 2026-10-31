// メモに貼った画像のドラッグを、本物の Chromium に本物のマウス操作を送って検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-memo-image-drag-browser.js
//
// 旧版に当てるときは、旧版を別のポートで配って URL で差し替える:
//
//   git archive <旧コミット> | tar -x -C /tmp/old
//   (cd /tmp/old && python3 -m http.server 8766 &)
//   URL=http://127.0.0.1:8766/ node tests/browser/t-memo-image-drag-browser.js
//
// ■ なぜ実機が要るのか (v0.24.14)
//
// やっさん報告「画像をドラッグすると Chrome のタブで画像が開かれる」。
// v0.24.13 までは「行内」の画像を**標準のドラッグに任せていた**。標準のドラッグには
// text/uri-list で画像の blob: URL が乗り、編集できる場所の外に落ちると Chrome は
// それをリンクとして開く。**dragstart が起きるかどうかは、本物のマウス操作を
// 送らないと分からない**（合成した pointer イベントでは標準のドラッグは始まらない）。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

/** メモを開き「一行目／二行目＋画像」の状態を作る */
async function openWithImage(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.inner-tab')).find(b => b.textContent.indexOf('メモ') >= 0);
    if (t) t.click();
  });
  await page.waitForTimeout(300);
  await page.click('#memo');
  await page.keyboard.type('一行目');
  await page.keyboard.press('Enter');
  await page.keyboard.type('二行目');
  // 本物の貼り付けと同じ経路（handleMemoPaste）を通す。中身は赤い 120x80 の PNG
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    const g = c.getContext('2d'); g.fillStyle = 'red'; g.fillRect(0, 0, 120, 80);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'a.png', { type: 'image/png' }));
    document.getElementById('memo').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(600);
  // 標準のドラッグが始まったかを数える
  await page.evaluate(() => {
    window._dragstarts = 0;
    document.addEventListener('dragstart', (e) => { if (!e.defaultPrevented) window._dragstarts++; });
  });
  return { ctx, page };
}

/** 本物のマウスで (x,y) へ引いていく */
async function dragTo(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / 10, from.y + (to.y - from.y) * i / 10);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
}

const lines = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#memo > div')).map(d => ({
  text: d.textContent,
  imgs: d.querySelectorAll('img').length,
})));

(async () => {
  const browser = await chromium.launch();

  console.log('■ 行内の画像を1行目の頭へ引く');
  {
    const { ctx, page } = await openWithImage(browser);
    const img = await page.locator('#memo img').boundingBox();
    const first = await page.locator('#memo > div').first().boundingBox();
    await dragTo(page, { x: img.x + 30, y: img.y + 30 }, { x: first.x + 1, y: first.y + first.height / 2 });

    eq('標準のドラッグ（URL を運ぶもの）が始まらない', await page.evaluate(() => window._dragstarts), 0);
    eq('タブが増えていない', ctx.pages().length, 1);
    eq('画像が1行目へ移り、2行目から消えている', await lines(page), [
      { text: '一行目', imgs: 1 },
      { text: '二行目', imgs: 0 },
    ]);
    eq('画像は複製されず1枚のまま', await page.evaluate(() => document.querySelectorAll('#memo img').length), 1);
    eq('保管庫の ID が残っている（残らないと次に開いたとき画像が消える）',
       await page.evaluate(() => /^im_/.test(document.querySelector('#memo img').dataset.imgId || '')), true);
    eq('1行目の文字の前に入る', await page.evaluate(() => document.querySelector('#memo > div').innerHTML.startsWith('<img')), true);
    eq('保存にも反映される', await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('dictation:sessions') || '[]');
      const memo = (Array.isArray(s) ? s : (s.sessions || [])).map(x => x.memo || '').join('');
      return memo.indexOf('<div><img') >= 0;
    }), true);
    eq('薄くした表示が戻っている', await page.evaluate(() => document.querySelector('#memo img').classList.contains('memo-img-dragging')), false);
    await ctx.close();
  }

  console.log('■ クリックだけなら動かない（枠が出るだけ）');
  {
    const { ctx, page } = await openWithImage(browser);
    const before = await lines(page);
    const img = await page.locator('#memo img').boundingBox();
    // 閾値（4px）未満の手ぶれ
    await dragTo(page, { x: img.x + 30, y: img.y + 30 }, { x: img.x + 32, y: img.y + 31 });
    eq('位置が変わらない', await lines(page), before);
    eq('選択枠が出ている', await page.evaluate(() => {
      const b = document.getElementById('img-handles'); return !!b && !b.hidden;
    }), true);
    await ctx.close();
  }

  console.log('■ メモの外で離したら動かさない');
  {
    const { ctx, page } = await openWithImage(browser);
    const before = await lines(page);
    const img = await page.locator('#memo img').boundingBox();
    await dragTo(page, { x: img.x + 30, y: img.y + 30 }, { x: 5, y: 5 });
    eq('標準のドラッグが始まらない', await page.evaluate(() => window._dragstarts), 0);
    eq('タブが増えていない', ctx.pages().length, 1);
    eq('位置が変わらない', await lines(page), before);
    await ctx.close();
  }

  console.log('■ 「前面」にした画像はこれまでどおり座標で動く');
  {
    const { ctx, page } = await openWithImage(browser);
    await page.click('#memo img', { button: 'right' });
    await page.click('text=前面にする');
    await page.waitForTimeout(200);
    const left0 = await page.evaluate(() => parseFloat(document.querySelector('#memo img').style.left));
    const img = await page.locator('#memo img').boundingBox();
    await dragTo(page, { x: img.x + 30, y: img.y + 30 }, { x: img.x + 130, y: img.y + 30 });
    eq('標準のドラッグが始まらない', await page.evaluate(() => window._dragstarts), 0);
    eq('右へ 100px 動く', await page.evaluate(() => parseFloat(document.querySelector('#memo img').style.left)) - left0, 100);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
