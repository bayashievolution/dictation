// 設定の「詳細設定」のまとまり（v0.24.95・設定の見本の 4 段目）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-settings-acc-browser.js
//
// 見ること: 最初はたたんである／見出しを押すと高さが途中を通って開く（一瞬で出ない）／もう一度押すと閉じる／
// 登録がページの読み込みで効いている（CLAUDE.md「誰がいつ呼ぶか」）／中の設定は今までどおり保存される
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
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', autoStopSec: 120 })));
  await page.reload();
  await page.waitForTimeout(700);
  await page.evaluate(() => openSettings());
  await page.waitForTimeout(400);

  const labels = await page.$$eval('#settings-modal .settings-acc-label', ns => ns.map(n => n.textContent));
  eq('まとまりの並び', labels, ['音声入力', '録音の保持（話者判別）', 'AI の動き', '停止条件', '表示', 'Notion 連携', 'そのほか']);
  eq('最初は全部たたんである', await page.$$eval('#settings-modal .settings-acc-body', ns => ns.every(n => n.hidden)), true);
  eq('見出しに SUMADO の線の絵', await page.$$eval('#settings-modal .settings-acc-icon', ns => ns.map(n => n.dataset.icon)),
     ['sm-mic', 'sm-user', 'sm-sparkle', 'sm-clock', 'sm-frame', 'sm-folder', 'sm-apps']);

  // 停止条件をひらく。毎フレーム高さを測る
  const heights = await page.evaluate(async () => {
    const g = [...document.querySelectorAll('.settings-acc')].find(x => x.textContent.includes('停止条件'));
    g.scrollIntoView({ block: 'center' });
    const body = g.querySelector('.settings-acc-body');
    g.querySelector('.settings-acc-head').click();
    const h = [];
    for (let i = 0; i < 40; i++) { await new Promise(r => requestAnimationFrame(r)); h.push(body.hidden ? 0 : body.getBoundingClientRect().height); }
    return h;
  });
  const end = heights[heights.length - 1];
  eq('押すと開く（中身の高さまで）', end > 40, true);
  eq('途中の高さを通る（一瞬で出ない）', heights.some(x => x > 2 && x < end - 2), true);
  eq('矢印の向きが変わる（aria-expanded）', await page.evaluate(() => [...document.querySelectorAll('.settings-acc')].find(x => x.textContent.includes('停止条件')).querySelector('.settings-acc-head').getAttribute('aria-expanded')), 'true');
  eq('中の欄が触れる', await page.isVisible('#input-auto-stop-sec'), true);
  await page.fill('#input-auto-stop-sec', '240');
  await page.click('#btn-settings-save');
  await page.waitForTimeout(300);
  eq('中の設定は今までどおり保存される', await page.evaluate(() => state.settings.autoStopSec), 240);

  await page.evaluate(() => openSettings());
  await page.waitForTimeout(300);
  await page.evaluate(() => [...document.querySelectorAll('.settings-acc')].find(x => x.textContent.includes('停止条件')).querySelector('.settings-acc-head').click());
  await page.waitForTimeout(900);
  eq('もう一度押すと閉じる', await page.evaluate(() => [...document.querySelectorAll('.settings-acc')].find(x => x.textContent.includes('停止条件')).querySelector('.settings-acc-body').hidden), true);

  eq('そのほかに SUMADO・検証用・字幕・診断ログ', await page.$$eval('#settings-other-group .settings-sub-title', ns => ns.map(n => n.textContent)), ['SUMADO', '検証用（開発中）', '字幕用設定（開発中）', '診断ログ']);
  // v0.24.107: 比較ページを新しいタブで開く（やっさんの検証用・一般公開のときに消す）
  await page.evaluate(() => [...document.querySelectorAll('.settings-acc')].find(x => x.id === 'settings-other-group').querySelector('.settings-acc-head').click());
  await page.waitForTimeout(800);
  const [popup] = await Promise.all([page.context().waitForEvent('page'), page.click('#btn-open-stt-compare')]);
  await popup.waitForLoadState();
  eq('「文字起こし比較ページを開く」で比較ページが新しいタブで開く', [popup.url().endsWith('/stt-compare.html'), await popup.title()], [true, '文字起こし比較 — dictation']);
  await popup.close();
  await page.check('#mode-webspeech');
  await page.waitForTimeout(800);
  eq('Web Speech にすると「録音の保持」のまとまりは隠れる（今までどおり）', await page.evaluate(() => document.getElementById('keep-recording-group').hidden), true);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
