// 設定の「使う AI」の表（v0.24.92）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-ai-table-browser.js
//
// やっさんの案（設定の見本の 3 段目）。見ること:
//   - オンにした AI だけ選べる（保存前の欄の値で判断）・7 個セットは一緒に変わる・ライブ要約と話者判別は選べない（1 つしか無い）
//   - 選んでいた AI を切ったら、無料で済むほうへ移る（覚えた好みは消さない）
//   - AI で聞き取るのに文字起こしの AI が無いと、モードの下に注意書き
//   - 保存すると、7 個セットを Gemini にしたときは連携の振り分けが止まる（料金の向きが変わるので、ここが本当に効いているか）
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function open(browser, settings) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.route('**/api/claude/**', r => r.abort());
  await page.route('**/api/claude', r => r.abort());
  await page.goto(URL);
  await page.evaluate(s => localStorage.setItem('dictation:settings', JSON.stringify(s)), settings);
  await page.reload();
  await page.waitForTimeout(700);
  await page.evaluate(() => openSettings());
  await page.waitForTimeout(400);
  return { ctx, page };
}
const checked = page => page.$$eval('.ai-pick[aria-checked="true"]', bs => bs.map(b => b.dataset.k + ':' + b.dataset.a));
const disabled = (page, k, a) => page.$eval(`.ai-pick[data-k="${k}"][data-a="${a}"]`, b => b.disabled);

(async () => {
  const browser = await chromium.launch();
  const all = { inputMode: 'gemini-audio', apiKey: 'AIza', groqApiKey: 'gsk', claudeCode: true };

  console.log('■ 全部オン（やっさんのいまの設定）');
  {
    const { ctx, page } = await open(browser, all);
    eq('無料で済むほうが選ばれている（文字起こし Groq・ライブ整形〜質問 Claude・話者判別 Gemini）', await checked(page),
       ['stt:groq', ...Array(7).fill('post:claude'), 'dia:gemini']);
    eq('見出しは「使用するAI」・説明はやっさんの一文だけ・セットの札は無い（v0.24.93）',
       [await page.textContent('#ai-table-group .field-group-title'), await page.$$eval('#ai-table-group .field-hint', n => n.map(x => x.textContent)), await page.$$eval('#ai-table-group .ai-table-tag', n => n.length)],
       ['使用するAI', ['用途に合わせて使用するAIを選択することができます。'], 0]);
    eq('ライブ要約も Gemini を選べる（v0.24.93）', await disabled(page, 'post', 'gemini'), false);
    eq('話者判別は押せない（1 つしか無い）', await disabled(page, 'dia', 'gemini'), true);
    await page.click('.ai-pick[data-k="post"][data-a="gemini"] >> nth=5');   // 「要約」の行の Gemini
    eq('ライブ整形〜質問は一緒に Gemini へ（ライブ要約も）', (await checked(page)).filter(x => x.startsWith('post')), Array(7).fill('post:gemini'));
    await page.click('#btn-settings-save');
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ post: state.settings.postEngine, bridge: claudeBridgeIsEnabled(), live: paneAiName('pane-live'), sum: paneAiName('pane-summary') }));
    eq('保存すると Gemini・連携の振り分けは止まる・ライブ要約も Gemini', r, { post: 'gemini', bridge: false, live: 'Gemini', sum: 'Gemini' });
    await ctx.close();
  }

  console.log('\n■ ライブ要約を Gemini で作る（v0.24.93 やっさん「Gemini API は全てできるように」）');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
    const seen = { gemini: [], claude: 0 };
    await page.route('**/generativelanguage.googleapis.com/**', r => {
      seen.gemini.push(JSON.parse(r.request().postData()).contents[0].parts[0].text);
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '## 目次\n1. 評価の観点\n\n## 評価の観点\n- 三つある' }] }, finishReason: 'STOP' }] }) });
    });
    await page.route('**/api/claude**', r => { seen.claude++; r.abort(); });
    await page.goto(URL);
    await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'AIza', claudeCode: false, liveSummary: true, inputMode: 'web-speech', aiEnabled: false })));
    await page.reload();
    await page.waitForTimeout(700);
    eq('Claude が無くてもライブ要約のタブが出る', await page.evaluate(() => !!document.querySelector('.inner-tab[data-pane="pane-live"]')), true);
    await page.evaluate(() => {
      const p = document.createElement('div'); p.className = 'paragraph';
      p.textContent = '今日は評価論の話をします。評価の観点は三つあります。'.repeat(10);
      document.getElementById('confirmed').appendChild(p); snapshotActiveToSession();
    });
    const ok = await page.evaluate(() => runLiveSummary({ sessionId: state.activeId, manual: true }));
    eq('Gemini で作れる', [ok, seen.gemini.length, seen.claude], [true, 1, 0]);
    eq('頼む文面は Claude と同じ（目次付き）', seen.gemini[0].includes('目次付きの要約'), true);
    eq('ライブ要約タブに入る', (await page.textContent('#live-summary')).includes('評価の観点'), true);
    await ctx.close();
  }

  console.log('\n■ 選んでいた AI を切ったら');
  {
    const { ctx, page } = await open(browser, all);
    await page.uncheck('#input-groq-enabled');
    await page.waitForTimeout(300);
    eq('Groq を切ると文字起こしは Gemini へ移る', (await checked(page))[0], 'stt:gemini');
    eq('Groq の列は選べない', await disabled(page, 'stt', 'groq'), true);
    await page.check('#input-groq-enabled');
    await page.waitForTimeout(300);
    eq('戻すと Groq に戻る（好みは覚えている）', (await checked(page))[0], 'stt:groq');
    await page.fill('#input-groq-key', '');
    await page.waitForTimeout(200);
    eq('キーを消しても選べなくなる', await disabled(page, 'stt', 'groq'), true);
    await ctx.close();
  }

  console.log('\n■ 文字起こしに使える AI が無い');
  {
    const { ctx, page } = await open(browser, { inputMode: 'gemini-audio', claudeCode: false });
    await page.waitForTimeout(500);
    eq('モードの下に注意書き', await page.isVisible('#stt-ai-caution'), true);
    eq('注意書きの文', (await page.textContent('#stt-ai-caution')).replace(/\s+/g, ''),
       'APIキーが登録されていないか、有効になっていません文字起こしにはGeminiAPIかGroqWhisperのキーが要ります');
    await page.check('#mode-webspeech');
    await page.waitForTimeout(700);
    eq('Web Speech にすると注意書きは消える', await page.evaluate(() => document.getElementById('stt-ai-caution').hidden), true);
    eq('文字起こしの行は選べない（Web Speech）', [await disabled(page, 'stt', 'gemini'), await disabled(page, 'stt', 'groq')], [true, true]);
    await ctx.close();
  }

  console.log('\n■ 前の版の設定（連携オン・7 個セットの選択なし）');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza', claudeCode: true });
    eq('連携の振り分けは今までどおりオン', await page.evaluate(() => claudeBridgeIsEnabled()), true);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
