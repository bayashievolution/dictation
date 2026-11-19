// メモの Markdown ショートカットを、本物の Chromium に本物のキー入力と
// 本物の Ctrl+V を送って検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
// playwright と Chromium が要るため。入れかたと走らせかた:
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-memo-markdown-browser.js
//
// ■ なぜ実機が要るのか (v0.24.2)
//
// 「貼り付け以降 ・ が箇条書きにならない」の原因は、Chrome がクリップボードの
// text/html を <div><p>行</p><p>行</p></div> という入れ子で挿入することだった。
// この入れ子の作られ方は仕様書には書いておらず、実際に貼ってみないと分からない。
// text/plain だけのときや <ul> を貼ったときは形が変わって壊れない。
// つまり**ブラウザに本当に貼らせない限り、この種の不具合は見つけられない**。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function openMemo(browser) {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
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

const html = (page) => page.evaluate(() => document.getElementById('memo').innerHTML);

async function paste(page, { text, htmlFlavor }) {
  await page.evaluate(async ([t, h]) => {
    const parts = { 'text/plain': new Blob([t], { type: 'text/plain' }) };
    if (h) parts['text/html'] = new Blob([h], { type: 'text/html' });
    await navigator.clipboard.write([new ClipboardItem(parts)]);
  }, [text, htmlFlavor || null]);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(250);
}

(async () => {
  const browser = await chromium.launch();

  // ── 貼り付けを挟んでも ・ が箇条書きになるか（v0.24.2 で直したところ）
  console.log('■ 貼り付けのあとに手で打った ・ が箇条書きになるか');
  const PASTES = [
    ['text/html あり（Chrome が <p> の入れ子を作る）',
     '見出しのようなもの\n・りんご\nばなな', '<p>見出しのようなもの</p><p>・りんご</p><p>ばなな</p>'],
    ['text/plain だけ', '見出しのようなもの\n・りんご\nばなな', null],
    ['マークダウンの - リスト', '- りんご\n- ばなな', '<ul><li>りんご</li><li>ばなな</li></ul>'],
    ['1行だけ', 'ひとこと', '<p>ひとこと</p>'],
    ['span で包まれた行（Notion や Docs からの貼り付けに近い形）',
     'あいう\nえおか', '<div><span style="color:#111">あいう</span></div><div><span style="color:#111">えおか</span></div>'],
  ];
  for (const [label, text, htmlFlavor] of PASTES) {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('メモの続き');
    await page.keyboard.press('Enter');
    await paste(page, { text, htmlFlavor });
    await page.keyboard.press('Enter');
    await page.keyboard.type('・ぶどう');
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
    await page.keyboard.type('・もも');
    await page.waitForTimeout(120);
    const got = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#memo li')).map(li => li.textContent);
      return { budo: items.indexOf('ぶどう') >= 0, momo: items.indexOf('もも') >= 0 };
    });
    eq(label, got, { budo: true, momo: true });
    await ctx.close();
  }

  // ── 行の途中に貼ったあと、次の行で箇条書きにできるか
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('前後ではさむ');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    await paste(page, { text: '差し込み', htmlFlavor: '<p>差し込み</p>' });
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('・ぶどう');
    await page.waitForTimeout(150);
    eq('行の途中に貼ったあとでも箇条書きになる',
       await page.evaluate(() => Array.from(document.querySelectorAll('#memo li')).map(li => li.textContent)),
       ['ぶどう']);
    await ctx.close();
  }

  // ── 貼り付けなしの素の挙動。ここが変わっていないことが大事
  console.log('\n■ 貼り付けなし（従来の挙動を変えていないか）');
  const CASES = [
    ['・ で箇条書き（2行目の ・ も飲み込む）',
     ['・いちご', '・みかん'], '<ul><li>いちご</li><li>みかん</li></ul>'],
    ['- で箇条書き', ['- いちご'], '<ul><li>いちご</li></ul>'],
    ['1. で番号リスト', ['1. いちご'], '<ol><li>いちご</li></ol>'],
    ['## で見出し', ['## 章タイトル'], '<h2>章タイトル</h2>'],
    ['> で引用', ['> ひとこと'], '<blockquote>ひとこと</blockquote>'],
    ['--- で区切り線', ['---'], '<hr>'],
    ['- 単独では箇条書きにしない', ['-'], '<div>-</div>'],
    ['・ 単独では箇条書きにしない', ['・'], '<div>・</div>'],
  ];
  for (const [label, lines, want] of CASES) {
    const { ctx, page } = await openMemo(browser);
    for (let i = 0; i < lines.length; i++) {
      await page.keyboard.type(lines[i]);
      await page.waitForTimeout(120);
      if (i < lines.length - 1) await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(120);
    eq(label, (await html(page)).replace(/<div><br><\/div>$/, ''), want);
    await ctx.close();
  }

  // ── チェックボックス
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('[ ] やること');
    await page.waitForTimeout(200);
    const h = await html(page);
    eq('[ ] でチェックボックス',
       { 枠: /class="task-item"/.test(h), 箱: /<input type="checkbox"/.test(h), 文字: h.indexOf('やること') >= 0 },
       { 枠: true, 箱: true, 文字: true });
    await ctx.close();
  }

  // ── Shift+Enter の改行を潰していないか
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('うえ');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('した');
    await page.waitForTimeout(150);
    eq('Shift+Enter はブロックを割らず <br> のまま', (await html(page)).indexOf('<br>') >= 0, true);
    await ctx.close();
  }

  // ── Tab のインデント（リスト外）
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('ふつうの行');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    eq('Tab で padding-left が付く', /padding-left:\s*24px/.test(await html(page)), true);
    await ctx.close();
  }

  // ── Backspace でブロック解除
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('## 章タイトル');
    await page.waitForTimeout(150);
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    eq('見出しの行頭 Backspace で div に戻る', await html(page), '<div>章タイトル</div>');
    await ctx.close();
  }

  // ── 表を貼ったとき。これは v0.24.2 でも**直っていない**ことを書き残すテスト。
  //
  // 貼った表の <td> の中にキャレットが入ると、Enter を押しても同じ td の中に
  // <br> が入るだけで行が分かれないため、箇条書きにできない。表はそもそも
  // 入れるつもりのない要素（軽量・シンプルの方針）なので対応していない。
  // ただし**落ちてはいけない**ので、文字が消えず例外も出ないことをここで押さえる。
  // 直したときはこの期待値を書き換える。
  console.log('\n■ 未対応と分かっている範囲（落ちないことだけ確かめる）');
  {
    const { ctx, page } = await openMemo(browser);
    await page.keyboard.type('メモの続き');
    await page.keyboard.press('Enter');
    await paste(page, { text: 'あ\tい', htmlFlavor: '<table><tr><td>あ</td><td>い</td></tr></table>' });
    await page.keyboard.press('Enter');
    await page.keyboard.type('・ぶどう');
    await page.waitForTimeout(200);
    const h = await html(page);
    eq('貼った表の中では箇条書きにならない（未対応・文字は消えない）',
       { 文字: h.indexOf('ぶどう') >= 0, li: /<li>/.test(h) },
       { 文字: true, li: false });
    await ctx.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
  process.exit(fail === 0 ? 0 : 1);
})();
