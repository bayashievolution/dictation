// 質問ペインの吹き出しの名前を、本物の Chromium で質問を送って検査する (v0.24.17)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-chat-engine-browser.js
//
// Gemini と Claude の中継（/api/claude）はどちらも page.route で差し替える。
// 本物には繋がない（API キーもログインも要らない）。
//
// ■ なぜ実機でも見るのか
//
// 純関数（tests/t-chat-engine.js）は「名前の決め方」しか見ない。吹き出しを描くのは
// renderChatInto で、そこが記録した engine を本当に読むかはページを動かさないと分からない
// （CLAUDE.md「誰がいつ呼ぶかは純関数のテストでは見つからない」）。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function ask(browser, { useClaudeBridge, claudeWorks }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.route('**/generativelanguage.googleapis.com/**', r => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini の答え' }] }, finishReason: 'STOP' }] }),
  }));
  await page.route('**/api/claude/health', r => r.fulfill({
    contentType: 'application/json', body: JSON.stringify({ ok: true, claude: true, loggedIn: true }),
  }));
  await page.route('**/api/claude', r => r.fulfill(claudeWorks
    ? { contentType: 'application/json', body: JSON.stringify({ ok: true, text: 'Claude の答え', seconds: 1 }) }
    : { status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '一時的な失敗' }) }));
  await page.goto(URL);
  await page.evaluate((s) => localStorage.setItem('dictation:settings', JSON.stringify(s)),
    { apiKey: 'AIza-test', useClaudeBridge });
  await page.reload();
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.inner-tab')).find(b => b.textContent.indexOf('質問') >= 0);
    if (t) t.click();
  });
  await page.waitForTimeout(200);
  await page.fill('#chat-input', 'まとめて');
  await page.click('#btn-chat-send');
  await page.waitForFunction(() => !document.querySelector('#chat-messages .chat-msg.thinking'), null, { timeout: 5000 });
  const r = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('#chat-messages .chat-msg.assistant')).pop();
    return a ? { who: a.querySelector('.chat-msg-header').textContent, body: a.querySelector('.chat-msg-body').textContent.trim() } : null;
  });
  await ctx.close();
  return r;
}

(async () => {
  const browser = await chromium.launch();

  console.log('■ Claude 連携オフ');
  eq('吹き出しは Gemini', await ask(browser, { useClaudeBridge: false }), { who: 'Gemini', body: 'Gemini の答え' });

  console.log('■ Claude 連携オンで Claude が答えた');
  eq('吹き出しは Claude', await ask(browser, { useClaudeBridge: true, claudeWorks: true }), { who: 'Claude', body: 'Claude の答え' });

  console.log('■ Claude 連携オンだが失敗して Gemini に戻った');
  eq('吹き出しは Gemini（設定ではなく実際に答えたほう）',
     await ask(browser, { useClaudeBridge: true, claudeWorks: false }), { who: 'Gemini', body: 'Gemini の答え' });

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
