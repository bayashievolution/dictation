// ペインから AI に渡す文字列を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-plain-text-browser.js
//
// ■ なぜ実機が要るのか (v0.24.3)
//
// `innerText` は**画面に出ている見た目**を返す。要素が描画されていないと
// `textContent` に落ちて改行が消える。この「描画されているか」は
// JS からは offsetParent くらいでしか見えず、張りぼてでは再現できない。
//
// 実機で測った結果（v0.24.3 で直す前）:
//   メモタブを開いている  → "第3回 評価論\nルーブリック要確認\n来週までに提出"
//   質問タブを開いている  → "第3回 評価論ルーブリック要確認来週までに提出"
//
// 質問するときに開いているのは必ず質問タブなので、**質問ペインに渡すメモと
// 要約はこれまでずっと一塊で渡っていた**。箇条書きの項目同士が繋がって
// 「評価論ルーブリック要確認」のような**言っていない語**ができてしまう。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const MEMO_HTML = '<h2>第3回 評価論</h2><ul><li>ルーブリック要確認</li>'
  + '<li>来週までに提出<ul><li>様式はA4</li></ul></li></ul>'
  + '<div class="task-item"><input type="checkbox" checked><span>資料DL</span></div>'
  + '<blockquote>観点は三つ</blockquote><div>板書の写真</div>';
const MEMO_WANT = '第3回 評価論\nルーブリック要確認\n来週までに提出\n様式はA4\n資料DL\n観点は三つ\n板書の写真';

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(800);

  console.log('■ メモ: どのタブを開いていても同じ文字列になる');
  await page.evaluate((h) => { document.getElementById('memo').innerHTML = h; }, MEMO_HTML);
  for (const tab of ['文字起こし', 'メモ', '要約', '質問']) {
    const r = await page.evaluate((t) => {
      const btn = Array.from(document.querySelectorAll('.inner-tab')).find(b => b.textContent.indexOf(t) >= 0);
      if (btn) btn.click();
      return { 描画: !!document.getElementById('memo').offsetParent, text: getMemoText() };
    }, tab);
    eq(`${tab} タブを開いているとき（メモの描画=${r.描画}）`, r.text, MEMO_WANT);
  }

  console.log('\n■ 他のセッションから読む経路（htmlToPlain）も同じ');
  eq('htmlToPlain', await page.evaluate((h) => htmlToPlain(h), MEMO_HTML), MEMO_WANT);

  console.log('\n■ 要約ペインも同じ（質問ペインに渡している）');
  await page.evaluate(() => {
    document.getElementById('summary').innerHTML = '<h2>概要</h2><p>評価の話</p><ul><li>観点は三つ</li><li>段階を置く</li></ul>';
    const btn = Array.from(document.querySelectorAll('.inner-tab')).find(b => b.textContent.indexOf('質問') >= 0);
    if (btn) btn.click();
  });
  eq('質問タブを開いたまま要約を読む',
     await page.evaluate(() => getSummaryText()),
     '概要\n評価の話\n観点は三つ\n段階を置く');

  console.log('\n■ 文字起こしを壊していないか');
  // 録音+整形でできる .paragraph 構造。1つの .paragraph に h2 + .p-body が複数並ぶ
  // 形は v0.17.4 で直したところ（2つ目以降の本文が黙って消えていた）
  await page.evaluate(() => {
    document.getElementById('confirmed').innerHTML =
      '<div class="paragraph"><h2>導入</h2><div class="p-body">まず前提を確認します。</div>'
      + '<div class="p-body">次に手順を見ます。</div></div>'
      + '<div class="paragraph"><h2>本題</h2><div class="p-body">評価は三つの観点です。</div></div>';
  });
  eq('見出し付き段落（2つ目の本文も残る）',
     await page.evaluate(() => getConfirmedText()),
     '## 導入\n\nまず前提を確認します。\n\n次に手順を見ます。\n\n## 本題\n\n評価は三つの観点です。');

  // 整形していない／貼り付けただけの文字起こし（.paragraph が無い）
  await page.evaluate(() => {
    document.getElementById('confirmed').innerHTML = '<div>いちぎょう</div><div>にぎょう</div>';
  });
  eq('整形前の文字起こしでも行が残る',
     await page.evaluate(() => getConfirmedText()),
     'いちぎょう\nにぎょう');

  console.log('\n■ 空のときは空（ボタンの出し分けに使っている）');
  await page.evaluate(() => {
    document.getElementById('memo').innerHTML = '<div><br></div>';
    document.getElementById('confirmed').innerHTML = '';
  });
  eq('空行だけのメモは空扱い', await page.evaluate(() => getMemoText()), '');
  eq('空の文字起こしは空扱い', await page.evaluate(() => getConfirmedText()), '');

  await browser.close();
  console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
  process.exit(fail === 0 ? 0 : 1);
})();
