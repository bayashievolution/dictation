// 設定の「AI機能」（v0.24.39）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-settings-ai-browser.js
//
// やっさん「オフにすると…ってあるけど、下に録音停止時に…のトグルがあるよね。
// これは関係ないということ？ 独立させてほしい」＋並べ替えと、Claude Code のトグルを2つに分けたこと。
// Gemini と /api/claude は page.route で差し替え、Web Speech は偽物、マイクは Chromium の偽デバイス。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function open(browser, settings) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const seen = { gemini: [] };
  await page.addInitScript((s) => {
    class FakeRec extends EventTarget { start() {} stop() {} abort() {} }
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('dictation:settings', JSON.stringify(s));
  }, settings);
  await page.route('**/generativelanguage.googleapis.com/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    seen.gemini.push(JSON.stringify(body).slice(0, 4000));
    r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '## 概要\n- 要約の中身' }] }, finishReason: 'STOP' }] }) });
  });
  await page.route('**/api/claude/**', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, invocation: 'claude', features: ['effort', 'timeout', 'session'], auth: { ok: true, loggedIn: true } }) }));
  await page.goto(URL);
  await page.waitForTimeout(800);
  return { ctx, page, seen };
}

const form = (page) => page.evaluate(() => {
  const g = (id) => { const e = document.getElementById(id); return { checked: e.checked, disabled: e.disabled }; };
  return {
    code: g('input-claude-code'), live: g('input-live-summary'),
    liveNote: !document.getElementById('live-summary-note').hidden,
  };
});
const openSettings = async (page) => { await page.evaluate(() => document.getElementById('btn-settings').click()); await page.waitForTimeout(250); };
const clickCode = async (page) => { await page.click('#input-claude-code'); await page.waitForTimeout(700); };

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

  console.log('■ ライブ整形をオフにしても、録音停止時の要約は作られる（独立）');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', inputMode: 'web-speech', aiEnabled: false, autoSummarize: true });
    await page.evaluate(() => startRecording());
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const p = document.createElement('div'); p.className = 'paragraph';
      p.textContent = '今日は評価論の話をします。評価の観点は三つあります。'.repeat(5);
      document.getElementById('confirmed').appendChild(p);
      snapshotActiveToSession();
    });
    await page.evaluate(() => stopRecording());
    await page.waitForTimeout(2500);
    eq('要約ができた', (await page.textContent('#summary')).includes('要約の中身'), true);
    eq('タイトルも頼んだ（Gemini に2回以上）', seen.gemini.length >= 2, true);
    await ctx.close();
  }
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', inputMode: 'web-speech', aiEnabled: true, autoSummarize: false });
    await page.evaluate(() => startRecording());
    await page.waitForTimeout(300);
    await page.evaluate(() => { const p = document.createElement('div'); p.className = 'paragraph'; p.textContent = 'x'.repeat(300); document.getElementById('confirmed').appendChild(p); snapshotActiveToSession(); });
    await page.evaluate(() => stopRecording());
    await page.waitForTimeout(2000);
    eq('要約・タイトル生成をオフなら作らない（ライブ整形がオンでも）', (await page.textContent('#summary')).includes('要約の中身'), false);
    void seen;
    await ctx.close();
  }

  // v0.24.44: 「一部を Claude Code で処理する」は画面から外し、「Claude Code 連携」と同時に有効
  console.log('■ 「一部を Claude Code で処理する」は出さない');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test' });
    await openSettings(page);
    eq('トグルが無い', await page.evaluate(() => !document.getElementById('input-claude-bridge')), true);
    eq('「接続を確認」ボタンも無い（状態はトグルの横に自動で出す）', await page.evaluate(() => !document.getElementById('btn-claude-bridge-test')), true);
    await ctx.close();
  }

  console.log('■ 「Claude Code 連携」がオフなら、ライブ要約は押せず、要約などは Gemini');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', claudeCode: false, liveSummary: true });
    await openSettings(page);
    eq('ライブ要約は押せず、理由が出る（前の値はオンでも、オフに見せる）', await form(page), {
      code: { checked: false, disabled: false }, live: { checked: false, disabled: true }, liveNote: true,
    });
    eq('振り分けは効いていない', await page.evaluate(() => claudeBridgeIsEnabled()), false);
    eq('横の状態は空（立ち上げても確かめない）', (await page.textContent('#claude-bridge-status')).trim(), '');
    eq('ライブ要約のタブも出ない', await page.evaluate(() => !!document.querySelector('.inner-tab[data-pane="pane-live"]')), false);
    await clickCode(page);
    eq('オンにすると押せて、前の値（オン）に戻る', await form(page), {
      code: { checked: true, disabled: false }, live: { checked: true, disabled: false }, liveNote: false,
    });
    eq('オンにしたその場で接続を確かめて横に出す', (await page.textContent('#claude-bridge-status')).includes('使えます'), true);
    await page.evaluate(() => saveSettingsFromForm());
    await page.waitForTimeout(200);
    eq('保存すると、要約なども Claude に回る（連携と同時に有効）', await page.evaluate(() => [claudeBridgeIsEnabled(), state.settings.useClaudeBridge]), [true, true]);
    await ctx.close();
  }

  console.log('■ 「Claude Code 連携」がオンなら、立ち上げたときに自動で確かめる');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', claudeCode: true });
    await page.waitForTimeout(500);
    eq('設定を開かなくても、横に状態が出ている', (await page.textContent('#claude-bridge-status')).includes('使えます'), true);
    eq('要約なども Claude に回る', await page.evaluate(() => claudeBridgeIsEnabled()), true);
    await openSettings(page);
    await clickCode(page);   // オフに
    eq('オフにすると横の状態は消える', (await page.textContent('#claude-bridge-status')).trim(), '');
    await page.evaluate(() => saveSettingsFromForm());
    await page.waitForTimeout(200);
    eq('保存した値（ライブ要約の選択は覚えている）', await page.evaluate(() => [state.settings.claudeCode, state.settings.useClaudeBridge, claudeBridgeIsEnabled(), liveSummaryActive()]), [false, false, false, false]);
    await ctx.close();
  }

  console.log('■ 前の版の設定からの引き継ぎ');
  for (const [label, s, want] of [
    ['Claude に任せていた → Claude Code もオン', { useClaudeBridge: true }, true],
    ['ライブ要約だけオン → Claude Code もオン', { liveSummary: true }, true],
    ['どちらも使っていない → オフ', {}, false],
  ]) {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', ...s });
    eq(label, await page.evaluate(() => state.settings.claudeCode), want);
    await ctx.close();
  }

  console.log('■ 「ライブ整形」の下にあった、矛盾する断り書きは消えた');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test' });
    eq('「オフにすると、録音停止時の自動要約・タイトル付けも止まります」が無い',
       (await page.textContent('#settings-modal')).includes('自動要約・タイトル付けも止まります'), false);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
