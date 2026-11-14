// 設定の「録音の保持」（話者判別）が Gemini モードのときだけ出るかを、本物の Chromium で検査する (v0.24.48)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-keep-recording-browser.js
//
// やっさん「録音の保持は Gemini モードだけよね？ なので Gemini モードの時だけ表示させる」。
// 出し入れは設定を開いたときと、モードを切り替えたときに走るので、実際に押して確かめる。
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
  for (const [mode, want] of [['web-speech', false], ['gemini-audio', true]]) {
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
    await page.addInitScript((m) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: m }));
    }, mode);
    await page.goto(URL);
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.waitForTimeout(300);
    const shown = () => page.evaluate(() => {
      const g = document.getElementById('keep-recording-group');
      return !!g && !g.hidden && g.offsetParent !== null;
    });
    eq(`${mode} で開いたとき: ${want ? '出る' : '出ない'}`, await shown(), want);
    // もう一方のモードに切り替える
    await page.click(want ? '#mode-webspeech' : '#mode-gemini');
    await page.waitForTimeout(800);   // v0.24.74: 高さと濃さをばねで出し入れするので、動き終わってから見る
    eq(`切り替えると: ${want ? '隠れる' : '出る'}`, await shown(), !want);
    await page.close();
  }

  const page = await browser.newPage();
  await page.goto(URL);
  await page.waitForTimeout(600);
  eq('名前（やっさんの指定）', await page.evaluate(() => {
    const t = document.getElementById('keep-recording-group').textContent;
    return ['話者判別機能を有効にする', '音声ファイルの取り扱い', '話者判別処理が終わったら消す（24時間で自動失効）',
            '音声ファイルが残っていれば話者判別をやり直すことができます。'].every((w) => t.includes(w));
  }), true);
  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
