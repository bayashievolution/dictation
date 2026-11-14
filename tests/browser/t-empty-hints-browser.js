// タブが空のときの案内と、AI が無いときの注意のしるし（v0.24.89）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-empty-hints-browser.js
//
// やっさん「AI 設定がされていない時、タブのアイコンを注意マークに」「タブ内の文字も整えて（アイコンやシンボルでビジュアルよく）」。
// 見ること: 使える AI が無いタブだけ注意のしるしになる／案内は一言＋受け持つ AI の札／「AI 設定を開く」で設定が開く／
// 古い文（「設定 → AI機能」）が残っていない／設定を変えて保存すると、しるしと札が変わる（起動時と保存時の両方で呼ばれているか）
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
  return { ctx, page };
}
const warnTabs = page => page.$$eval('.inner-tab.needs-ai', ns => ns.map(n => n.dataset.pane));
const hint = (page, id) => page.evaluate(id => {
  const el = document.getElementById(id);
  return { text: el.querySelector('.empty-text')?.textContent || '', sub: el.querySelector('.empty-sub')?.textContent || '', chip: el.querySelector('.empty-chip')?.textContent || '',
           warn: el.classList.contains('needs-ai'), button: !!el.querySelector('.empty-open-ai'), svg: !!el.querySelector('.empty-icon svg') };
}, id);

(async () => {
  const browser = await chromium.launch();

  console.log('■ AI がひとつも無い（AI で聞き取る・連携オフ）');
  {
    const { ctx, page } = await open(browser, { inputMode: 'gemini-audio', claudeCode: false });
    eq('文字起こし・要約・質問のタブが注意のしるし', (await warnTabs(page)).sort(), ['pane-chat', 'pane-summary', 'pane-transcript']);
    eq('しるしは SUMADO の注意の絵', await page.$eval('.inner-tab.needs-ai .inner-tab-icon', n => n.dataset.icon), 'sm-warn');
    const h = await hint(page, 'empty-hint');
    eq('文字起こしの案内は注意と「AI 設定を開く」（v0.24.91 の文言）', [h.warn, h.text, h.sub, h.button],
       [true, 'API キーが登録されていないか、有効になっていません', '文字起こしには Gemini API か Groq Whisper のキーが要ります', true]);
    eq('要約の案内', [(await hint(page, 'summary-empty')).text, (await hint(page, 'summary-empty')).sub],
       ['API キーが登録されていないか、有効になっていません', '要約には Gemini API のキーか Claude Code が要ります']);
    eq('質問の案内', (await hint(page, 'chat-empty')).sub, '質問には Gemini API のキーか Claude Code が要ります');
    await page.click('#empty-hint .empty-open-ai');
    await page.waitForTimeout(400);
    eq('「AI 設定を開く」で設定が開く', await page.evaluate(() => !document.getElementById('settings-modal').classList.contains('hidden')), true);
    // 設定で Gemini をオンにしてキーを入れ、保存すると、しるしが消える
    await page.check('#input-gemini-enabled');
    await page.waitForTimeout(600);
    await page.fill('#input-api-key', 'AIza-test');
    await page.click('#btn-settings-save');
    await page.waitForTimeout(400);
    eq('保存するとしるしが消える', await warnTabs(page), []);
    eq('案内の札は受け持つ AI', (await hint(page, 'empty-hint')).chip, '聞き取り・Gemini');
    await ctx.close();
  }

  console.log('\n■ いまのやっさんの設定（Groq・Claude・Gemini）');
  {
    const { ctx, page } = await open(browser, { inputMode: 'gemini-audio', transcribeEngine: 'groq', groqApiKey: 'g', apiKey: 'A', claudeCode: true, liveSummary: true, liveSummaryMin: 15, autoSummarize: true });
    eq('しるしは無い', await warnTabs(page), []);
    const t = await hint(page, 'empty-hint');
    eq('文字起こし', [t.text, t.chip, t.svg], ['録音を始めると、ここに文字が出ます', '聞き取り・Groq Whisper', true]);
    eq('ライブ要約は設定の間隔を言う・古い文が無い', [(await hint(page, 'live-summary-empty')).text, (await page.textContent('#live-summary-empty')).includes('AI機能')],
       ['録音中、15分ごとに目次つきの要約ができます', false]);
    eq('要約', [(await hint(page, 'summary-empty')).text, (await hint(page, 'summary-empty')).chip], ['録音を止めると、ここに要約ができます', '要約・Claude Code']);
    eq('質問', (await hint(page, 'chat-empty')).text, '文字起こし・メモ・要約について質問できます');
    await ctx.close();
  }

  console.log('\n■ キーはあるのにトグルを切っている');
  {
    const { ctx, page } = await open(browser, { inputMode: 'gemini-audio', apiKey: 'AIza', geminiEnabled: false, claudeCode: false });
    eq('切っているときも同じ一文（登録されていないか、有効になっていません）', (await hint(page, 'empty-hint')).text, 'API キーが登録されていないか、有効になっていません');
    await ctx.close();
  }

  console.log('\n■ Web Speech なら文字起こしに AI は要らない');
  {
    const { ctx, page } = await open(browser, { inputMode: 'web-speech', claudeCode: false });
    eq('文字起こしにはしるしが付かない', (await warnTabs(page)).includes('pane-transcript'), false);
    eq('札は Web Speech', (await hint(page, 'empty-hint')).chip, '聞き取り・Web Speech');
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
