// メモに画像を貼ったあとの編集（Enter・Backspace・戻す／やり直す・表示倍率）を、
// 本物の Chromium に本物のキーとマウスを送って検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-memo-image-edit-browser.js
//
// 旧版に当てるときは、旧版を別のポートで配って URL で差し替える:
//
//   git archive <旧コミット> | tar -x -C /tmp/old
//   (cd /tmp/old && python3 -m http.server 8766 &)
//   URL=http://127.0.0.1:8766/ node tests/browser/t-memo-image-edit-browser.js
//
// ■ なぜ実機が要るのか (v0.24.15)
//
// やっさん報告:
// > ペーストして画像の右にカーソルを移動して改行したら画像が消えた
// > 元に戻そうとしたら、画像を入れる前の文字が消えてしまって
// > やり直そうとしたらやり直し機能が無くて困った
// > 緑の調整枠と画像がずれたり、画像をデリートで消した後も枠だけのこったり
// > 拡大率を90%にしてることも原因の一つかも
//
// 原因は5つあり、どれも「ブラウザが実際にどう振る舞うか」に依存している:
//   1. 画像だけの箇条書きを、文字が無いので「空の行」とみなして Enter で消していた
//   2. メモの中の Ctrl+Z はブラウザ自身の取り消しで、スクリプトの書き換えを知らない
//   3. 画像の操作が「操作後」の状態を取り消し用に積んでいた
//   4. html に CSS zoom がかかると getBoundingClientRect は拡大後の px を返す
//   5. 枠はスクロールとリサイズにしか追随していなかった
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const near = (label, got, want, tol = 1.5) => {
  const ok = Array.isArray(want)
    ? want.every((w, i) => Math.abs(got[i] - w) <= tol)
    : Math.abs(got - want) <= tol;
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}（±${tol}）`));
  if (!ok) fail++;
};

async function openMemo(browser, { zoom = 100 } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.inner-tab')).find(b => b.textContent.indexOf('メモ') >= 0);
    if (t) t.click();
  });
  if (zoom !== 100) await page.evaluate((z) => applyAppZoom(z), zoom);
  await page.waitForTimeout(300);
  await page.click('#memo');
  return { ctx, page };
}

/** 本物の貼り付けと同じ経路（handleMemoPaste）で 120x80 の PNG を貼る */
const paste = async (page) => {
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    const g = c.getContext('2d'); g.fillStyle = 'red'; g.fillRect(0, 0, 120, 80);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'a.png', { type: 'image/png' }));
    document.getElementById('memo').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
};

/** 画像を <IMG> に潰したメモの中身（blob: の URL や id は毎回変わるので比べない） */
const memo = (page) => page.evaluate(() =>
  document.getElementById('memo').innerHTML.replace(/<img[^>]*>/g, '<IMG>'));

/** 画像が実際に描けているか（死んだ blob: だと naturalWidth が 0） */
const imgLoaded = (page) => page.evaluate(async () => {
  const i = document.querySelector('#memo img');
  if (!i) return null;
  for (let k = 0; k < 20 && !(i.complete && i.naturalWidth); k++) await new Promise(r => setTimeout(r, 50));
  return i.naturalWidth;
});

const rects = (page) => page.evaluate(() => {
  const f = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const box = document.getElementById('img-handles');
  return { img: f(document.querySelector('#memo img')), box: box && !box.hidden ? f(box) : null };
});

/** 「前の文」の下に、画像だけの箇条書きを作る */
async function bulletWithImage(page) {
  await page.keyboard.type('前の文');
  await page.keyboard.press('Enter');
  await page.keyboard.type('・あ');
  await page.waitForTimeout(100);
  await page.keyboard.press('Backspace');
  await paste(page);
}

(async () => {
  const browser = await chromium.launch();

  console.log('■ 画像だけの箇条書きで Enter を押しても画像が消えない');
  {
    const { ctx, page } = await openMemo(browser);
    await bulletWithImage(page);
    eq('貼った直後', await memo(page), '<div>前の文</div><ul><li><IMG><br></li></ul>');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    eq('Enter で次の項目ができ、画像は残る', await memo(page),
       '<div>前の文</div><ul><li><IMG><br></li><li><br></li></ul>');
    // 本当に空の項目なら、これまでどおりリストを抜ける
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    eq('空の項目で Enter はリストを抜ける（従来どおり）', await memo(page),
       '<div>前の文</div><ul><li><IMG><br></li></ul><div><br></div>');
    await ctx.close();
  }

  console.log('■ Ctrl+Z / Ctrl+Y がアプリの「戻す／やり直す」になる');
  {
    const { ctx, page } = await openMemo(browser);
    await bulletWithImage(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    eq('1回目: 改行だけ戻る', await memo(page), '<div>前の文</div><ul><li><IMG><br></li></ul>');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    eq('2回目: 画像だけ戻る（前の文は残る）', await memo(page), '<div>前の文</div><ul><li><br></li></ul>');
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(300);
    eq('Ctrl+Y で画像が戻る', await memo(page), '<div>前の文</div><ul><li><IMG><br></li></ul>');
    eq('戻ってきた画像が表示できる（死んだ blob: でない）', await imgLoaded(page), 120);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(300);
    eq('Ctrl+Shift+Z でもやり直せる', await memo(page),
       '<div>前の文</div><ul><li><IMG><br></li><li><br></li></ul>');
    await ctx.close();
  }

  console.log('■ 打っていた文字が、画像を戻したときに巻き添えにならない');
  {
    const { ctx, page } = await openMemo(browser);
    // 2秒待たずに貼る（打ちかけが確定していない状態）
    await page.keyboard.type('あいうえお');
    await paste(page);
    await page.click('[data-pane-undo="pane-memo"]');
    await page.waitForTimeout(300);
    eq('戻すボタン1回で画像だけ消え、あいうえお は残る', await memo(page), '<div>あいうえお</div>');
    await page.click('[data-pane-redo="pane-memo"]');
    await page.waitForTimeout(300);
    eq('やり直すボタンで画像が戻る', await memo(page), '<div>あいうえお<IMG></div>');
    eq('その画像が表示できる', await imgLoaded(page), 120);
    await ctx.close();
  }

  console.log('■ 打鍵の取り消しで戻しても画像が壊れない');
  {
    const { ctx, page } = await openMemo(browser);
    await paste(page);
    await page.keyboard.press('End');
    await page.keyboard.type('かきくけこ');
    await page.waitForTimeout(2300);   // 2秒待ちで打鍵が確定する
    await page.click('[data-pane-undo="pane-memo"]');
    await page.waitForTimeout(300);
    eq('打った文字だけ戻る', (await memo(page)).indexOf('かきくけこ'), -1);
    eq('画像は表示できる', await imgLoaded(page), 120);
    await ctx.close();
  }

  console.log('■ 行頭の Backspace で箇条書きを普通の行に戻しても、画像と太字が残る');
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('・あ');
    await page.waitForTimeout(100);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+b');
    await page.keyboard.type('太');
    await page.keyboard.press('Control+b');
    await paste(page);
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    const h = await memo(page);
    if (process.env.DEBUG) console.log(h);
    eq('リストではなくなる', h.indexOf('<li>'), -1);
    eq('画像が残る', h.indexOf('<IMG>') >= 0, true);
    // カーソルが太字の中にあるので、画像も <b> の中に入る（それで正しい）
    eq('太字が残る', /<(b|strong)>太/.test(h), true);
    await ctx.close();
  }

  for (const zoom of [90, 125]) {
    console.log(`■ 表示倍率 ${zoom}% でも枠が画像に重なる`);
    const { ctx, page } = await openMemo(browser, { zoom });
    for (let i = 0; i < 4; i++) { await page.keyboard.type('行' + i); await page.keyboard.press('Enter'); }
    await paste(page);
    const b = await page.locator('#memo img').boundingBox();
    await page.mouse.click(b.x + 10, b.y + 10);
    let r = await rects(page);
    near('選んだとき枠と画像が一致', r.box, r.img);

    // 角を右へ 50px 引く → 見た目の幅も 50px 増える
    const se = await page.locator('.img-handle-se').boundingBox();
    await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
    await page.mouse.down();
    await page.mouse.move(se.x + se.width / 2 + 25, se.y + se.height / 2);
    await page.mouse.move(se.x + se.width / 2 + 50, se.y + se.height / 2);
    await page.mouse.up();
    r = await rects(page);
    near('角を 50px 引くと見た目の幅も 50px 増える', r.img[2], b.width + 50);
    near('サイズを変えたあとも枠と画像が一致', r.box, r.img);

    // 前面にしてから 100px 動かす
    await page.click('#memo img', { button: 'right' });
    await page.click('text=前面にする');
    await page.waitForTimeout(150);
    r = await rects(page);
    near('前面にしても見えている場所から動かない', r.img.slice(0, 2), b ? [b.x, b.y] : null);
    const before = r.img;
    await page.mouse.move(before[0] + 20, before[1] + 20);
    await page.mouse.down();
    await page.mouse.move(before[0] + 70, before[1] + 20);
    await page.mouse.move(before[0] + 120, before[1] + 20);
    await page.mouse.up();
    r = await rects(page);
    near('マウスを 100px 動かすと画像も 100px 動く', r.img[0] - before[0], 100);
    near('動かしたあとも枠と画像が一致', r.box, r.img);
    await ctx.close();
  }

  console.log('■ キーで画像を消したら枠も消える');
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('あ');
    await paste(page);
    const b = await page.locator('#memo img').boundingBox();
    await page.mouse.click(b.x + 10, b.y + 10);
    eq('枠が出ている', (await rects(page)).box !== null, true);
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    eq('画像が消えた', await page.evaluate(() => document.querySelectorAll('#memo img').length), 0);
    eq('枠も消えた', await page.evaluate(() => document.getElementById('img-handles').hidden), true);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
