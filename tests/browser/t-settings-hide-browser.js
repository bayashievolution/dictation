// 設定の行の出し入れ（v0.24.158）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-settings-hide-browser.js
//
// やっさんの指定（2026-11-19）: 決まりは「いまの設定で意味がない項目は隠す・動かせる AI が無い機能はオレンジの注意」。
//   7. 「Notion 連携」がオフなら、下（トークン・保存先・自動保存など）は隠す
//   8. 「Web Speech の字も整形に渡す」は、効くとき（ライブ整形・AI で聞き取る・聞き取りが Groq・リアルタイム表示）だけ出す
// 前の版（v0.24.157）に当てると落ちる
const { chromium } = require('playwright');
const PAGE = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

(async () => {
  const browser = await chromium.launch();
  async function open(settings) {
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
    page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
    await page.route(/generativelanguage\.googleapis\.com|api\.groq\.com|api\.notion\.com/, r => r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }));
    await page.addInitScript((s) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('dictation:settings', JSON.stringify(s));
    }, settings);
    await page.goto(PAGE);
    await page.waitForTimeout(800);
    await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
    await page.waitForTimeout(700);
    return page;
  }
  const shown = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return !!e && !e.hidden && e.getBoundingClientRect().height > 4; }, id);

  console.log('■ 7. Notion 連携がオフなら下を隠す');
  {
    const page = await open({ notionEnabled: false, notionToken: 'ntn_x' });
    eq('オフなら、トークン・自動保存は見えない', [await shown(page, 'input-notion-token'), await shown(page, 'input-notion-auto-save')], [false, false]);
    await page.evaluate(() => document.getElementById('input-notion-enabled').scrollIntoView({ block: 'center' }));
    await page.click('#input-notion-enabled');
    await page.waitForTimeout(800);
    eq('オンにすると出る', [await shown(page, 'input-notion-token'), await shown(page, 'input-notion-auto-save')], [true, true]);
    await page.close();
  }

  console.log('\n■ 8. Web Speech の字も整形に渡す: 効くときだけ');
  {
    const base = { aiEnabled: true, geminiEnabled: true, apiKey: 'A', groqEnabled: true, groqApiKey: 'g', transcribeEngine: 'groq', geminiLiveDisplay: true };
    let page = await open({ ...base, inputMode: 'web-speech' });
    eq('Web Speech モードでは出さない', await shown(page, 'refine-with-ws-field'), false);
    await page.close();
    page = await open({ ...base, inputMode: 'gemini-audio' });
    eq('AI で聞き取る・Groq・リアルタイム表示なら出す', await shown(page, 'refine-with-ws-field'), true);
    await page.evaluate(() => { els.inputGeminiLiveDisplay.checked = false; els.inputGeminiLiveDisplay.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(700);
    eq('リアルタイム表示を切ると隠す', await shown(page, 'refine-with-ws-field'), false);
    await page.close();
    page = await open({ ...base, inputMode: 'gemini-audio', transcribeEngine: 'gemini' });
    eq('聞き取りが Gemini なら出さない', await shown(page, 'refine-with-ws-field'), false);
    await page.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
