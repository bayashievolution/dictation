// 設定画面の見た目が見本（docs/設定の見本.html）どおりかを、本物の Chromium で測る（v0.24.99〜101）。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-settings-look-browser.js
//
// やっさん「トグルが左のままの項目がある。見本のとおりに」。見ること: 設定と文脈の小窓のトグルは全部右端／
// 数字・選ぶ欄は名前の右／見出しに線の絵／中身は角の丸い箱
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
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', claudeCode: true, audioKeepRecording: true })));
  await page.reload();
  await page.waitForTimeout(600);
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(800);

  // 見えているトグルが、行の右端にあるか（行の右端から 4px 以内）
  const leftToggles = await page.evaluate(() => [...document.querySelectorAll('#settings-modal .field-row > input[type="checkbox"]')]
    .filter(cb => cb.offsetParent !== null)
    .filter(cb => { const row = cb.parentElement.getBoundingClientRect(), r = cb.getBoundingClientRect(); return row.right - r.right > 4; })
    .map(cb => cb.id || cb.parentElement.textContent.trim().slice(0, 20)));
  eq('設定のトグルは全部右端', leftToggles, []);
  const n = await page.evaluate(() => [...document.querySelectorAll('#settings-modal .field-row > input[type="checkbox"]')].filter(cb => cb.offsetParent !== null).length);
  eq('見えているトグルを数えた（0 個で通っていない）', n >= 10, true);
  // v0.24.101: トグルは、名前と説明をあわせたまとまりの上下まんなか（やっさんの指定）
  const offCenter = await page.evaluate(() => [...document.querySelectorAll('#settings-modal .field-row > input[type="checkbox"]')]
    .filter(cb => cb.offsetParent !== null)
    .filter(cb => { const row = cb.parentElement.getBoundingClientRect(), r = cb.getBoundingClientRect(); return Math.abs((row.top + row.bottom) / 2 - (r.top + r.bottom) / 2) > 2; })
    .map(cb => cb.id));
  eq('トグルは行の上下まんなか', offCenter, []);
  eq('説明のあるトグルは、説明も同じ行の中（話者判別・ライブ要約など）', await page.evaluate(() => ['input-keep-recording', 'input-live-summary', 'input-ai-enabled', 'input-silence-cut']
    .map(id => !!document.getElementById(id).parentElement.querySelector('span > .field-hint'))), [true, true, true, true]);

  const numLeft = await page.evaluate(() => [...document.querySelectorAll('#settings-modal .settings-acc-body label.field > .number-stepper')]
    .filter(x => x.offsetParent !== null)
    .filter(x => { const lab = x.parentElement.querySelector('.field-label').getBoundingClientRect(), r = x.getBoundingClientRect(); return !(r.left >= lab.right - 1 && Math.abs(r.top - lab.top) < 30); })
    .map(x => x.parentElement.querySelector('.field-label').textContent));
  eq('数字の欄は名前の右', numLeft, []);
  eq('見出しに線の絵', await page.$$eval('#settings-modal .settings-section > .field-group-title .section-icon', ns => ns.map(n => n.dataset.icon)), ['sm-mic', 'sm-sparkle', 'sm-tick', 'sm-gear']);
  eq('中身は角の丸い箱', await page.$$eval('#settings-modal .settings-box', ns => ns.length >= 4 && ns.every(n => getComputedStyle(n).borderRadius === '12px')), true);

  await page.evaluate(() => { closeSettings(); openContextModal(); });
  await page.waitForTimeout(600);
  eq('文脈の小窓のトグルも右端', await page.evaluate(() => {
    const cb = document.getElementById('input-context-default'); const row = cb.parentElement.getBoundingClientRect(), r = cb.getBoundingClientRect();
    return row.right - r.right <= 4;
  }), true);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
