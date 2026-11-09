// 使い方ガイド（右上の ?）を、本物の Chromium で本体を読み込んで最後まで進める（v0.24.97 で今の画面に合わせて書き直した）。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-onboarding-browser.js
//
// 見ること: 古い言葉が残っていない／ライブ要約のタブが無いときはその手順を飛ばす／最後まで進めて閉じられる
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function walk(browser, settings) {
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.evaluate(s => localStorage.setItem('dictation:settings', JSON.stringify(s)), settings);
  await page.reload();
  await page.waitForTimeout(700);
  await page.click('#btn-onboarding');
  await page.waitForTimeout(500);
  const titles = [], texts = [];
  for (let i = 0; i < 20; i++) {
    titles.push(await page.textContent('#onboarding-title'));
    texts.push(await page.textContent('#onboarding-text'));
    const last = (await page.textContent('#onboarding-next-btn')).trim() === '完了';
    await page.click('#onboarding-next-btn');
    await page.waitForTimeout(450);
    if (last) break;
  }
  await page.waitForTimeout(500);
  const closed = await page.evaluate(() => document.getElementById('onboarding').classList.contains('hidden'));
  await page.close();
  return { titles, texts, closed };
}

(async () => {
  const browser = await chromium.launch();
  const off = await walk(browser, { liveSummary: false });
  eq('ライブ要約がオフなら 8 つ（ライブ要約の手順は飛ばす）', off.titles, ['録音', '文字起こし', 'メモ', '要約', '質問', 'クイック質問', '設定', '字幕設定（開発中）']);
  eq('最後まで進めると閉じる', off.closed, true);
  const all = off.texts.join('\n');
  eq('古い言葉が残っていない', ['Gemini Audio', 'AI機能', '低/中/高', 'Gemini に質問', 'Gemini が段落', '**'].filter(w => all.includes(w)), []);
  const on = await walk(browser, { liveSummary: true, claudeCode: true });
  eq('ライブ要約がオンなら、要約の前にライブ要約', on.titles.slice(3, 5), ['ライブ要約', '要約']);
  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
