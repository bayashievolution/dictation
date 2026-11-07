// 処理中の印（ボタンのアニメーション・要約の欄を暗くする）がタブごとに独立しているか、
// 処理の途中でタブを切り替えても結果が元のタブに入るかを、本物の Chromium で検査する (v0.24.27)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-busy-per-tab-browser.js
//
// Gemini はわざと遅らせて返す（page.route）。その間にタブを切り替える。
//
// ■ なぜ実機が要るのか
//
// やっさん「要約を生成ボタンを押すと、アニメーションがタブをまたいでも動いてる。タブで独立して動くよね？」。
// ボタンと要約の欄は全タブで1つなので、「誰がいつ印を付け外しするか」の問題で、ページを動かさないと分からない。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function open(browser, reply) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  page.on('dialog', d => d.accept());   // 全体整形の確認
  await page.route('**/generativelanguage.googleapis.com/**', async r => {
    await new Promise(res => setTimeout(res, 1500));
    r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] }, finishReason: 'STOP' }] }) });
  }).catch(() => {});
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'AIza-test', aiEnabled: true }));
    const T = '<div class="paragraph">今日は評価論の話をします。評価の観点は三つあります。</div>';
    localStorage.setItem('dictation:sessions', JSON.stringify([
      { id: 'A', title: 'A', transcript: T, memo: '', summary: '', chat: [] },
      { id: 'B', title: 'B', transcript: '<div class="paragraph">別の講義です。</div>', memo: '', summary: '<p>Bの要約</p>', chat: [] },
    ]));
    localStorage.setItem('dictation:activeTab', 'A');
  });
  await page.goto(URL);
  await page.waitForTimeout(800);
  return { ctx, page };
}

const marks = (page) => page.evaluate(() => ({
  firing: els.btnSummaryCombo.classList.contains('firing'),
  dim: els.summary.classList.contains('generating'),
}));

(async () => {
  const browser = await chromium.launch();

  console.log('■ 要約を作っている途中でタブを切り替える');
  {
    const { ctx, page } = await open(browser, '## 概要\n- Aの要約');
    await page.evaluate(() => { switchInnerPane('pane-summary'); generateSummary({ silent: true }); });
    await page.waitForTimeout(300);
    eq('A: ボタンが動き、要約の欄は暗い', await marks(page), { firing: true, dim: true });
    await page.evaluate(() => switchSession('B'));
    await page.waitForTimeout(300);
    eq('B に移ると印は消える（B では何も動いていない）', await marks(page), { firing: false, dim: false });
    eq('B の要約は B のまま', (await page.textContent('#summary')).trim(), 'Bの要約');
    await page.evaluate(() => switchSession('A'));
    await page.waitForTimeout(200);
    eq('A に戻るとまだ動いている', await marks(page), { firing: true, dim: true });
    await page.waitForTimeout(1800);
    eq('終わったら印は消える', await marks(page), { firing: false, dim: false });
    eq('結果は A に入る', (await page.textContent('#summary')).includes('Aの要約'), true);
    await ctx.close();
  }

  console.log('■ 別のタブの要約は、待たずに作れる');
  {
    const { ctx, page } = await open(browser, '## 概要\n- 要約');
    await page.evaluate(() => { generateSummary({ silent: true, sessionId: 'A' }); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { switchSession('B'); generateSummary({ silent: true }); });
    await page.waitForTimeout(200);
    await page.waitForTimeout(2000);
    // B にはもともと「Bの要約」が入っているので、新しく作られた見出し（概要）で見る
    eq('両方とも新しく作られた（B は A が終わるのを待たない）',
       await page.evaluate(() => state.sessions.map(s => s.summary.includes('概要'))), [true, true]);
    await ctx.close();
  }

  console.log('■ 全体整形の途中でタブを切り替える');
  {
    const { ctx, page } = await open(browser, '## 評価論\n今日は評価論の話です。観点は三つ。');
    await page.evaluate(() => { els.btnRefineTranscript.click(); });
    await page.waitForTimeout(300);
    eq('A: 全体整形のボタンが動いている', await page.evaluate(() => els.btnRefineTranscript.classList.contains('firing')), true);
    await page.evaluate(() => switchSession('B'));
    await page.waitForTimeout(300);
    eq('B に移ると印は消える', await page.evaluate(() => els.btnRefineTranscript.classList.contains('firing')), false);
    await page.waitForTimeout(1800);
    eq('B の文字起こしは B のまま', (await page.textContent('#confirmed')).trim(), '別の講義です。');
    await page.evaluate(() => switchSession('A'));
    await page.waitForTimeout(300);
    const a = await page.textContent('#confirmed');
    eq('A に戻ると整形結果が入っている（「整形中…」のまま残っていない）', [a.includes('観点は三つ'), a.includes('全体整形中')], [true, false]);
    await ctx.close();
  }

  console.log('■ 全体整形の途中で別のタブに移り、終わる前に戻ってくる');
  {
    const { ctx, page } = await open(browser, '## 評価論\n今日は評価論の話です。観点は三つ。');
    await page.evaluate(() => { els.btnRefineTranscript.click(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => switchSession('B'));
    await page.waitForTimeout(300);
    await page.evaluate(() => switchSession('A'));
    await page.waitForTimeout(200);
    eq('戻ったら印がまた付く', await page.evaluate(() => els.btnRefineTranscript.classList.contains('firing')), true);
    await page.waitForTimeout(1600);
    const a = await page.textContent('#confirmed');
    eq('画面の「整形中…」に結果が入る', [a.includes('観点は三つ'), a.includes('全体整形中')], [true, false]);
    eq('保存にも入る', await page.evaluate(() => state.sessions.find(x => x.id === 'A').transcript.includes('観点は三つ')), true);
    eq('印（data-refine-id）は残さない', await page.evaluate(() => state.sessions.find(x => x.id === 'A').transcript.includes('data-refine-id')), false);
    await ctx.close();
  }

  console.log('■ 録音中に別のタブを保存するときは、録音中の確認を出さない');
  {
    // やっさん「これ他のタブを録音中は関係ないよね？ 全てクラウドに保存するときだけでいいよね？」
    const { ctx, page } = await open(browser, 'x');
    const dialogs = [];
    page.removeAllListeners('dialog');
    page.on('dialog', d => { dialogs.push(d.message().split('\n')[0]); d.dismiss(); });
    await page.evaluate(() => { state.isRecording = true; state.recordingSessionId = 'A'; });
    const onlyB = await page.evaluate(() => ensureTranscriptSettled(state.sessions.filter(x => x.id === 'B')));
    eq('B だけ保存 → 聞かずに進む', [onlyB, dialogs.length], [true, 0]);
    const all = await page.evaluate(() => ensureTranscriptSettled(state.sessions));
    eq('録音中の A を含む（全部まとめて）→ 聞く', [all, dialogs], [false, ['録音中です。']]);
    await page.evaluate(() => { state.isRecording = false; state.recordingSessionId = null; });
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
