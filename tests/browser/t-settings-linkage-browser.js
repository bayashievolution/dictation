// 設定どうしの連動（v0.24.156）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-settings-linkage-browser.js
//
// 2026-11-19 の点検で見つけたもの:
//   1. Claude Code だけ（Gemini なし）だと、表では Claude なのに要約・全体整形・質問などが「Gemini API キーが未設定です」で止まる
//   2. 「Groq に失敗したら Gemini」をオンのまま Gemini を切ると、Groq の失敗が黙って消える（小窓も出ない）
//   3. 「Claude に失敗したら Gemini」は Gemini が使えなくても効き、空のキーで送って「Gemini で処理」と出す
//   5. ライブ要約を開いたまま Claude Code を切って保存すると、タブは消えるのに画面が残る
// 前の版（v0.24.155）に当てると落ちる
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
  async function open(settings) {
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
    const seen = { gemini: 0, claude: 0, alerts: [] };
    page.on('dialog', (d) => { seen.alerts.push(d.message()); d.dismiss(); });
    await page.addInitScript((s) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('dictation:settings', JSON.stringify(s));
    }, settings);
    await page.route('**/generativelanguage.googleapis.com/**', (r) => { if (r.request().method() === 'GET') return r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }); /* v0.24.157: キーの確かめ（モデルの一覧） */ seen.gemini++; r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":{"message":"API key not valid"}}' }); });
    await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ ok: true, invocation: 'claude', features: ['effort', 'timeout', 'session'], auth: { ok: true, loggedIn: true } }) }));
    await page.route('**/api/claude', (r) => { seen.claude++; r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, text: 'Claude の答え', seconds: 1 }) }); });
    await page.goto(URL);
    await page.waitForTimeout(900);
    return { page, seen };
  }

  console.log('■ 1. Claude Code だけ（Gemini なし）でも後処理が動く');
  {
    const { page, seen } = await open({ inputMode: 'web-speech', geminiEnabled: false, apiKey: '', claudeCode: true, postEngine: 'claude', aiEnabled: true });
    await page.evaluate(async () => {
      appendRawChunk('今日は評価の観点について三つ話します。');
      snapshotActiveToSession();
      await generateSummary({ silent: false });
    });
    await page.waitForTimeout(500);
    eq('要約は Claude に回り、「キーが未設定」で止まらない', [seen.claude > 0, seen.alerts.length, seen.gemini], [true, 0, 0]);
    eq('設定は開かない', await page.evaluate(() => els.settingsModal.classList.contains('hidden')), true);
    eq('Web Speech のライブ整形も回る扱い', await page.evaluate(() => webSpeechFinalWillBeRefined()), true);
    await page.close();
  }
  {
    const { page, seen } = await open({ inputMode: 'web-speech', geminiEnabled: false, apiKey: '', claudeCode: false });
    await page.evaluate(async () => { appendRawChunk('中身'); snapshotActiveToSession(); await generateSummary({ silent: false }); });
    await page.waitForTimeout(300);
    eq('どちらも無ければ、使える AI が無いと知らせる', [seen.alerts.length === 1 && /Gemini API か Claude Code/.test(seen.alerts[0])], [true]);
    await page.close();
  }

  console.log('\n■ 2. Groq に失敗したら Gemini: 設定はオンでも Gemini が使えなければ小窓で聞く');
  {
    const { page } = await open({ inputMode: 'gemini-audio', geminiEnabled: false, apiKey: '', groqEnabled: true, groqApiKey: 'g', groqFallbackGemini: true, groqFallbackV: 2 });
    const r = await page.evaluate(() => { const a = groqMayFallBackToGemini(); groqFailurePrompt(); return [a, !document.getElementById('groq-fail-dialog').classList.contains('hidden')]; });
    eq('Gemini には回さず、小窓を出す', r, [false, true]);
    await page.close();
  }

  console.log('\n■ 3. Claude に失敗したら Gemini: Gemini が使えなければ効かない（3 回試し直す）');
  {
    const { page } = await open({ geminiEnabled: false, apiKey: '', claudeCode: true, claudeFallbackGemini: true });
    eq('Gemini のキーが無いと、回す旗は立たない', await page.evaluate(() => claudeBridgeFallbackEnabled()), false);
    await page.close();
    const p2 = await open({ geminiEnabled: true, apiKey: 'A', claudeCode: true, claudeFallbackGemini: true });
    eq('キーがあれば立つ', await p2.page.evaluate(() => claudeBridgeFallbackEnabled()), true);
    await p2.page.close();
  }

  console.log('\n■ 5. ライブ要約を開いたまま Claude Code を切って保存');
  {
    const { page } = await open({ geminiEnabled: false, apiKey: '', claudeCode: true, postEngine: 'claude', liveSummary: true });
    await page.evaluate(() => { switchInnerPane('pane-live'); });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => state.activePane);
    await page.evaluate(() => { openSettings(); els.inputClaudeCode.checked = false; saveSettingsFromForm(); });
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => [state.activePane, paneVisible('pane-live')]);
    eq('ライブ要約を開いていた', before, 'pane-live');
    eq('保存したら、見えない画面に残らず要約へ移る', after, ['pane-summary', false]);
    await page.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
