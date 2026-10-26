// メモの箇条書きで、項目の頭の Backspace が「その場所で ・ だけを消す」かを、
// 本物の Chromium に本物のキーを送って検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-memo-list-backspace-browser.js
//
// 旧版に当てるときは、旧版を別のポートで配って URL で差し替える:
//
//   git archive <旧コミット> | tar -x -C /tmp/old
//   (cd /tmp/old && python3 -m http.server 8766 &)
//   URL=http://127.0.0.1:8766/ node tests/browser/t-memo-list-backspace-browser.js
//
// ■ なぜ実機が要るのか (v0.24.16)
//
// やっさん報告「・で箇条書き → Tab で子を作る → 一番最後の子で Backspace を押すと、
// 親と一番上の子の間に1行空行が入る。本当は一番最後の子の ・ が消えてほしい」。
// 原因は、何番目の項目でも行をリストの**頭**に出していたこと。Tab で入れ子を作ったとき
// どういう DOM になるか（親の li の中に ul が入る）は、実際に打たないと確かめられない。
// 「字下げが子の位置のまま」も見た目の座標で測る。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function openMemo(browser) {
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
  return { ctx, page };
}

const html = (page) => page.evaluate(() =>
  document.getElementById('memo').innerHTML.replace(/ style="padding-left: \d+px;"/g, ' [字下げ]'));

/** 文字列を含む最も内側の要素の、文字の左端（見た目の x） */
const textX = (page, text) => page.evaluate((t) => {
  const walker = document.createTreeWalker(document.getElementById('memo'), NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const i = n.data.indexOf(t);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
    return Math.round(r.getBoundingClientRect().left);
  }
  return null;
}, text);

/** ・親 / Tab で 子1, 子2 を作る（最後に空の子が1つ残る） */
async function parentWithChildren(page, children = ['子1', '子2']) {
  await page.keyboard.type('・親');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  for (const c of children) {
    await page.keyboard.type(c);
    await page.keyboard.press('Enter');
  }
}

(async () => {
  const browser = await chromium.launch();

  console.log('■ 入れ子の最後の（空の）子で Backspace');
  {
    const { ctx, page } = await openMemo(browser);
    await parentWithChildren(page);
    eq('作った形', await html(page), '<ul><li>親<ul><li>子1</li><li>子2</li><li><br></li></ul></li></ul>');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    await page.keyboard.type('X');
    eq('・ だけ消え、行は子2の下に残る（親と子1の間に空行が入らない）', await html(page),
       '<ul><li>親<ul><li>子1</li><li>子2</li></ul><div [字下げ]>X</div></li></ul>');
    eq('字下げは子の位置のまま（X と 子2 の文字の左端が揃う）',
       await textX(page, 'X'), await textX(page, '子2'));
    await ctx.close();
  }

  console.log('■ 入れ子の途中の子の頭で Backspace');
  {
    const { ctx, page } = await openMemo(browser);
    await parentWithChildren(page, ['子1', '子2', '子3']);
    await page.keyboard.press('Backspace');            // 空の子を消す（上のケースと同じ処理）
    await page.keyboard.press('Control+z');            // …は取り消して、子2の頭へ移る
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const li = Array.from(document.querySelectorAll('#memo li')).find(l => l.firstChild && l.firstChild.data === '子2');
      const r = document.createRange(); r.setStart(li.firstChild, 0); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    const h = await html(page);
    eq('子2 だけ ・ が消え、子1 と 子3 はリストのまま（その場所で分かれる）',
       h.replace('<li><br></li>', ''),
       '<ul><li>親<ul><li>子1</li></ul><div [字下げ]>子2</div><ul><li>子3</li></ul></li></ul>');
    eq('字下げは子の位置のまま', await textX(page, '子2'), await textX(page, '子1'));
    await ctx.close();
  }

  console.log('■ 入れ子でない箇条書きの最後の（空の）項目で Backspace');
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('・a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    await page.keyboard.type('X');
    eq('行はリストの下に出る（頭に飛ばない）', await html(page), '<ul><li>a</li><li>b</li></ul><div>X</div>');
    await ctx.close();
  }

  console.log('■ 先頭の項目で Backspace はこれまでどおりリストの上に出る');
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('・a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.evaluate(() => {
      const li = document.querySelector('#memo li');
      const r = document.createRange(); r.setStart(li.firstChild, 0); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    eq('a がリストの上の普通の行になる', await html(page), '<div>a</div><ul><li>b</li></ul>');
    await ctx.close();
  }

  // 番号を外した b は数えない（Word / Google ドキュメントと同じ）。Enter で空の項目を
  // 抜けたときの分け方（start = 元の start + 上に残った項目数）とも揃う
  console.log('■ 番号付きリストを途中で分けたら、後ろの番号が続きから始まる');
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('1. a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c');
    const isOl = await page.evaluate(() => !!document.querySelector('#memo ol'));
    if (!isOl) {
      console.log('  （「1. 」で番号付きリストにならない版なので飛ばす）');
    } else {
      await page.evaluate(() => {
        const li = document.querySelectorAll('#memo li')[1];
        const r = document.createRange(); r.setStart(li.firstChild, 0); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(150);
      eq('b が普通の行になり、c は 2 から始まる（1 に戻らない）', await html(page),
         '<ol><li>a</li></ol><div>b</div><ol start="2"><li>c</li></ol>');
    }
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
