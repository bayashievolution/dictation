// ライブ要約の目次と文字起こしをつなぐ2つ（v0.24.54・やっさん採用の案①②）を、本物の Chromium で検査する。
//   ① 見出し追加のときに、ライブ要約の目次の言葉を候補として渡す（見出しの言葉がそろう）
//   ② 目次の横のボタンで、文字起こしのその話題の場所へ飛ぶ
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-live-toc-jump-browser.js
//
// Claude（/api/claude）と Gemini は page.route で差し替える。実物の Claude が
// 「始まり」の発言を一字一句そのまま抜けるかは見ていない（少しずれても拾えることは純関数のテストで見ている）。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const LIVE_MD = [
  '## 目次', '1. 評価の観点', '2. 妥当性', '3. まとめと宿題（進行中）', '',
  '## 1. 評価の観点', '> 始まり: 「今日は評価論の話をします」', '- 観点は3つ', '',
  '## 2. 妥当性', '> 始まり: 「まず一つ目は妥当性です」', '- 測りたいものを測れているか', '',
  '## 3. まとめと宿題（進行中）', '> 始まり: 「来週までにレポートを出してください」', '- レポート',
].join('\n');

async function open(browser, settings) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 600 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const seen = { prompts: [] };
  await page.route('**/generativelanguage.googleapis.com/**', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '今日は評価論の話をします。' }] }, finishReason: 'STOP' }] }) }));
  await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, invocation: 'claude', features: ['effort', 'timeout', 'session'], auth: { ok: true, loggedIn: true } }) }));
  await page.route('**/api/claude', r => {
    const b = JSON.parse(r.request().postData() || '{}');
    seen.prompts.push(b.prompt || '');
    const isLive = (b.prompt || '').includes('目次付きの要約');
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, text: isLive ? LIVE_MD : '## 評価の観点\nまとめた本文', seconds: 1 }) });
  });
  await page.goto(URL);
  await page.evaluate((s) => localStorage.setItem('dictation:settings', JSON.stringify(s)), settings);
  await page.reload();
  await page.waitForTimeout(800);
  return { ctx, page, seen };
}

// 見出し付きの文字起こしを入れる。「妥当性」には見出しが無く、本文の中にだけある
const fill = (page) => page.evaluate(() => {
  const add = (html) => { const p = document.createElement('div'); p.className = 'paragraph refined'; p.innerHTML = html; document.getElementById('confirmed').appendChild(p); };
  add('<h2>導入</h2><div class="p-body">よろしくお願いします。' + '前置きの話です。'.repeat(40) + '</div>');
  add('<h2>評価の観点</h2><div class="p-body">今日は評価論の話をします。観点は三つあります。' + 'えーと、'.repeat(30) + '</div>');
  add('<div class="p-body">' + '具体例の話です。'.repeat(60) + '</div><div class="p-body" id="target-p">まず一つ目は妥当性です。測りたいものを測れているか。</div>');
  add('<div class="p-body">' + 'さらに続く話です。'.repeat(60) + '</div>');
  snapshotActiveToSession();
});

(async () => {
  const browser = await chromium.launch();

  console.log('■ ② 目次から文字起こしへ飛ぶ');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', claudeCode: true, liveSummary: true, liveSummaryMin: 1 });
    await fill(page);
    await page.evaluate(() => runLiveSummary({ sessionId: state.activeId, manual: true }));
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({
      text: document.getElementById('live-summary').textContent,
      quotes: Array.from(document.querySelectorAll('#live-summary .live-summary-toc li')).map(li => li.dataset.lsQuote || ''),
      buttons: document.querySelectorAll('#live-summary .live-summary-toc li .ls-goto').length,
      title: document.querySelector('#live-summary .ls-goto')?.title,
    }));
    eq('「始まり」の行は画面に出ない', r.text.includes('始まり'), false);
    eq('目次の各項目に始まりの発言を覚えている', r.quotes, ['今日は評価論の話をします', 'まず一つ目は妥当性です', '来週までにレポートを出してください']);
    eq('各項目に「文字起こしで見る」ボタン', [r.buttons, r.title], [3, '文字起こしで見る']);
    eq('ボタンの分、目次の文字は変わらない（次の回に Claude へ渡す前回の要約に混ざらない）',
       await page.evaluate(() => elementToPlainText(document.getElementById('live-summary')).includes('文字起こしで見る')), false);

    await page.evaluate(() => switchInnerPane('pane-live'));
    await page.waitForTimeout(500);
    await page.click('#live-summary .live-summary-toc li:nth-child(2) .ls-goto');
    await page.waitForTimeout(1200);
    const g = await page.evaluate(() => {
      const t = document.getElementById('target-p').getBoundingClientRect();
      return { pane: state.activePane, top: Math.round(t.top), visible: t.top >= 0 && t.top < window.innerHeight };
    });
    eq('見出しの無い話題（妥当性）でも、始まりの発言の段落へ飛ぶ', [g.pane, g.visible], ['pane-transcript', true]);

    await page.evaluate(() => switchInnerPane('pane-live'));
    await page.waitForTimeout(500);
    await page.click('#live-summary .live-summary-toc li:nth-child(1) .ls-goto');
    await page.waitForTimeout(1200);
    eq('見出しのある話題は、その見出しへ', await page.evaluate(() => {
      const h = Array.from(document.querySelectorAll('#confirmed h2')).find(x => x.textContent === '評価の観点').getBoundingClientRect();
      return h.top >= 0 && h.top < window.innerHeight;
    }), true);
    eq('飛んだ印は文字起こしに残らない（保存される HTML を汚さない）', await page.evaluate(() => /ls-flash|style=/.test(document.getElementById('confirmed').innerHTML)), false);

    await page.evaluate(() => switchInnerPane('pane-live'));
    await page.waitForTimeout(500);
    await page.click('#live-summary .live-summary-toc li:nth-child(3) .ls-goto');
    await page.waitForTimeout(400);
    const notices = await page.evaluate(() => document.getElementById('status-indicator').textContent);
    eq('文字起こしに無い話題は、飛ばずに「見つけられませんでした」と言う', [await page.evaluate(() => state.activePane), notices.includes('見つけられませんでした')], ['pane-live', true]);

    console.log('■ 目次の項目そのものを押したときは、これまでどおり要約の中の節へ');
    await page.click('#live-summary .live-summary-toc li:nth-child(2)', { position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);
    eq('タブは変わらない', await page.evaluate(() => state.activePane), 'pane-live');

    console.log('■ 前の版で作ったライブ要約（ボタン無し）にも、開くとボタンが付く');
    await page.evaluate(() => {
      const s = state.sessions.find(x => x.id === state.activeId);
      s.liveSummary = s.liveSummary.replace(/<button[^>]*class="ls-goto"[\s\S]*?<\/button>/g, '');
      persistSessions();
    });
    await page.reload();
    await page.waitForTimeout(800);
    eq('ボタンが付く', await page.evaluate(() => document.querySelectorAll('#live-summary .ls-goto').length), 3);
    await ctx.close();
  }

  console.log('■ ① 見出し追加のときに、ライブ要約の目次の言葉を候補として渡す');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', claudeCode: true, liveSummary: true, aiEnabled: true, midConsolidateSec: 300 });
    await fill(page);
    await page.evaluate(() => runLiveSummary({ sessionId: state.activeId, manual: true }));
    await page.waitForTimeout(300);
    seen.prompts.length = 0;
    await page.evaluate(async () => {
      state.isRecording = true;
      for (let i = 0; i < 2; i++) await sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null);
      document.querySelector('#confirmed .paragraph.short-refined').dataset.shortTs = String(Date.now() - 400000);
      await sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null);
    });
    await page.waitForTimeout(800);
    const p = seen.prompts.find(x => x.includes('【新しい生チャンク')) || '';
    eq('見出し追加の依頼に、目次の見出しが（番号・進行中を外して）入る',
       ['【見出しの候補（ライブ要約の目次）】', '- 評価の観点', '- 妥当性', '- まとめと宿題'].every(w => p.includes(w)) && !p.includes('進行中'), true);
    eq('ライブ要約に「文字起こしの見出しに合わせる」と頼んでいる（逆向きにもそろえる）',
       await page.evaluate(() => buildLiveSummaryPrompt({ transcript: 'x' }).includes('文字起こしの「## 」で始まる行')), true);
    await ctx.close();
  }
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', claudeCode: true, liveSummary: false, aiEnabled: true });
    await page.evaluate(async () => {
      state.isRecording = true;
      for (let i = 0; i < 2; i++) await sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null);
      document.querySelector('#confirmed .paragraph.short-refined').dataset.shortTs = String(Date.now() - 400000);
      await sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null);
    });
    await page.waitForTimeout(800);
    const p = seen.prompts.find(x => x.includes('【新しい生チャンク')) || '';
    eq('ライブ要約を使っていなければ、候補は付けない', [!!p, p.includes('見出しの候補')], [true, false]);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
