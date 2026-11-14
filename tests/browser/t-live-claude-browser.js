// 「Claude Code 連携」がオンのとき、ライブ整形と見出し追加が Claude に回り、
// 失敗しても Gemini に回さないことを、本物の Chromium で検査する (v0.24.52)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-live-claude-browser.js
//
// やっさん「文字整形も項目付けもライブ要約もClaudeで　連携がオフになっているならGeminiで」
// 「切替はせずに行こう　これまで通りエラーは出してもらう」「料金はこれ以上高くなるのは避けたい」。
// Gemini と /api/claude（ブラウザ版の中継）は page.route で差し替える。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function open(browser, settings, { claudeFails = false } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const seen = { geminiText: 0, geminiAudio: 0, claude: [] };
  await page.addInitScript((s) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('dictation:settings', JSON.stringify(s));
  }, settings);
  await page.route('**/generativelanguage.googleapis.com/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    const isAudio = JSON.stringify(body).includes('inline_data');
    if (isAudio) seen.geminiAudio++; else seen.geminiText++;
    r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: isAudio ? '今日は評価論の話をします。観点は三つあります。' : '## Geminiの見出し\nGeminiの本文' }] }, finishReason: 'STOP' }] }) });
  });
  await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, invocation: 'claude', features: ['effort', 'timeout', 'session'], auth: { ok: true, loggedIn: true } }) }));
  await page.route('**/api/claude', r => {
    const b = JSON.parse(r.request().postData() || '{}');
    seen.claude.push({ effort: b.effort || '', heading: /見出し/.test(b.prompt || ''), len: (b.prompt || '').length });
    if (claudeFails) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '終了コード 1' }) });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, text: '## Claudeの見出し\nClaudeの本文です。', seconds: 1 }) });
  });
  await page.goto(URL);
  await page.waitForTimeout(800);
  // 状態表示は次のかたまりの「聞き取り中」ですぐ上書きされるので、出したお知らせを記録しておく
  await page.evaluate(() => {
    const orig = window.statusNotice; window.__notices = [];
    window.statusNotice = (m, l, o) => { window.__notices.push(l); return orig(m, l, o); };
  });
  return { ctx, page, seen };
}

// 最初のかたまりを古いことにして、次のかたまりで見出し追加を走らせる（設定の秒数を待つ代わり）
async function runConsolidation(page) {
  await page.evaluate(() => { state.isRecording = true; });
  const chunk = () => page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null));
  await chunk(); await chunk();
  await page.evaluate(() => { document.querySelector('#confirmed .paragraph.short-refined').dataset.shortTs = String(Date.now() - 400000); });
  await chunk();
  await page.waitForTimeout(800);
}

(async () => {
  const browser = await chromium.launch();

  console.log('■ 連携オン: 見出し追加は Claude（音声の文字起こしだけ Gemini）');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', aiEnabled: true, claudeCode: true, midConsolidateSec: 300 });
    await runConsolidation(page);
    eq('音声は Gemini に送った', seen.geminiAudio, 3);
    eq('文字の処理は Gemini に1回も送っていない', seen.geminiText, 0);
    eq('Claude に1回頼んだ（考え込ませない effort low）', seen.claude.map(c => c.effort), ['low']);
    eq('Claude の返事で見出しが付いた', await page.evaluate(() => document.querySelector('#confirmed .paragraph.refined h2')?.textContent), 'Claudeの見出し');
    await ctx.close();
  }

  console.log('■ 連携オン・Claude が失敗: Gemini には回さず、元の文字を残してエラーを出す');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', aiEnabled: true, claudeCode: true }, { claudeFails: true });
    await runConsolidation(page);
    await page.waitForTimeout(7000);   // v0.24.58: Gemini に回さず、Claude で3回試し直してから諦める（2秒おき）
    eq('Claude で 1 + 3 回試した', seen.claude.length, 4);
    eq('文字の処理は Gemini に送っていない（料金を増やさない）', seen.geminiText, 0);
    eq('元の文字は残り、あとで整形し直せる印が付く', await page.evaluate(() => {
      const p = document.querySelector('#confirmed .paragraph.needs-retry');
      return !!p && p.textContent.includes('評価論の話');
    }), true);
    const st = (await page.evaluate(() => window.__notices)).join('|');
    eq('「整形せずに残しました」と出す（「Gemini で処理」とは言わない）', [st.includes('整形せずに残しました'), st.includes('Gemini で処理')], [true, false]);
    await ctx.close();
  }

  console.log('■ 連携オフ: これまでどおり Gemini');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', aiEnabled: true, claudeCode: false });
    await runConsolidation(page);
    eq('Claude には頼んでいない', seen.claude.length, 0);
    eq('見出し追加は Gemini', seen.geminiText, 1);
    eq('Gemini の見出し', await page.evaluate(() => document.querySelector('#confirmed .paragraph.refined h2')?.textContent), 'Geminiの見出し');
    await ctx.close();
  }

  console.log('■ Web Speech モードのライブ整形: 連携オンなら Gemini のキーが無くても Claude で整形する');
  {
    const { ctx, page, seen } = await open(browser, { aiEnabled: true, claudeCode: true, inputMode: 'web-speech' });
    await page.evaluate(() => { appendRawChunk('今日は評価論の話をします。評価の観点は三つあります。'); return flushPendingToGemini(); });
    await page.waitForTimeout(300);
    eq('Claude に1回（effort low）', seen.claude.map(c => c.effort), ['low']);
    eq('Gemini には送っていない', seen.geminiText + seen.geminiAudio, 0);
    eq('整形済みになった', await page.evaluate(() => document.querySelector('#confirmed .paragraph.refined')?.textContent.includes('Claudeの本文')), true);
    await ctx.close();
  }

  console.log('■ 設定の説明');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test' });
    await page.evaluate(() => openSettings());   // 使う AI の表は設定を開いたときに作る
    await page.waitForTimeout(300);
    const t = await page.textContent('#settings-modal');
    // v0.24.88〜92: 説明の文は AI 設定の一言と「使う AI」の表に置き換えた
    eq('Claude Code の説明: 文字起こし・話者判別以外', t.includes('文字起こし・話者判別以外の AI 機能に対応'), true);
    const rows = await page.$$eval('#ai-table-body tr', trs => trs.map(tr => tr.querySelector('th').firstChild.textContent));
    eq('表にライブ整形がある（Claude に回せる）', rows.includes('ライブ整形'), true);
    eq('表の文字起こし・話者判別に Claude の列は無い', await page.$$eval('#ai-table-body tr', trs => trs.filter(tr => ['文字起こし', '話者判別'].includes(tr.querySelector('th').firstChild.textContent))
       .map(tr => tr.querySelector('td[data-col="claude"]') ? 'あり' : 'なし')), ['なし', 'なし']);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
