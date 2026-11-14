// メモの貼り付けのオプション（書式ごと／文字だけ・v0.24.98）を、本物の Chromium と本物の Ctrl+V で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-memo-paste-options-browser.js
//
// やっさん「メモに Ctrl+V でコピペした時、スタイルごとペーストされる。Word のように、スタイルごとか文字だけか、貼り付けた後に選べるように」。
// 貼り付けの挙動は推測すると外す（CLAUDE.md・v0.24.2）ので、クリップボードに text/html を本当に入れて Ctrl+V を送る。
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
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(700);
  await page.evaluate(() => switchInnerPane('pane-memo'));
  await page.waitForTimeout(400);
  const setClip = (html, plain) => page.evaluate(async ([html, plain]) => {
    const items = { 'text/plain': new Blob([plain], { type: 'text/plain' }) };
    if (html) items['text/html'] = new Blob([html], { type: 'text/html' });
    await navigator.clipboard.write([new ClipboardItem(items)]);
  }, [html, plain]);
  const memo = () => page.evaluate(() => document.getElementById('memo').innerHTML);
  const chip = () => page.evaluate(() => !document.getElementById('paste-options').hidden);
  const pressed = () => page.$eval('#paste-options [aria-pressed="true"]', b => b.dataset.paste);

  console.log('■ 書式つきの文字を貼る');
  await page.click('#memo');
  await page.keyboard.type('前の行');
  await page.keyboard.press('Enter');
  await setClip('<p style="color:red;font-size:30px"><b>太字の見出し</b></p><p><span style="color:red">赤い字</span></p>', '太字の見出し\n赤い字');
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(700);
  const rich = await memo();
  eq('今までどおり書式ごと入る', /<b>|font-weight|color: ?red/i.test(rich), true);
  eq('貼ったあとに「書式ごと／文字だけ」が出る', [await chip(), await pressed()], [true, 'rich']);
  await page.click('#paste-options [data-paste="plain"]');
  await page.waitForTimeout(300);
  const plain = await memo();
  eq('「文字だけ」で書式が消える', /<b>|font-weight|color: ?red|font-size/i.test(plain), false);
  eq('文字は残る・前の行も残る', ['前の行', '太字の見出し', '赤い字'].every(w => plain.includes(w)), true);
  eq('押したほうが選ばれている', await pressed(), 'plain');
  eq('メモからカーソルが外れていない', await page.evaluate(() => document.activeElement.id), 'memo');
  await page.click('#paste-options [data-paste="rich"]');
  await page.waitForTimeout(300);
  eq('「書式ごと」で元に戻る', await memo(), rich);
  await page.click('#paste-options [data-paste="plain"]');
  await page.waitForTimeout(300);
  await page.keyboard.type('続き');
  await page.waitForTimeout(900);   // 引っ込む動き（ばね）が終わるまで
  eq('打ち始めると引っ込む', await chip(), false);
  eq('打った字は、貼った文字のあとに入る', (await page.evaluate(() => document.getElementById('memo').textContent)).includes('赤い字続き'), true);
  await page.waitForTimeout(2500);   // 打鍵の保存は少し待ってから（デバウンス）
  eq('保存される', await page.evaluate(() => getActiveSession().memo.includes('赤い字続き')), true);

  console.log('\n■ 書式の無い文字を貼る');
  await page.keyboard.press('Enter');
  await setClip(null, 'ただの文字');
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(900);
  eq('選ぶ意味がないので出さない', await chip(), false);
  eq('入る', (await memo()).includes('ただの文字'), true);

  console.log('\n■ 外を触ると引っ込む');
  await setClip('<i>斜め</i>', '斜め');
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(400);
  eq('出る', await chip(), true);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(900);
  eq('外を触ると引っ込む（書式ごとのまま）', [await chip(), (await memo()).includes('<i>斜め</i>')], [false, true]);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
