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
    body: JSON.stringify({ ok: true, invocation: 'claude', features: ['effort', 'timeout'], auth: { ok: true, loggedIn: true } }) }));
  await page.goto(URL);
  await page.waitForTimeout(800);
  return { ctx, page, seen };
}

const form = (page) => page.evaluate(() => {
  const g = (id) => { const e = document.getElementById(id); return { checked: e.checked, disabled: e.disabled }; };
  return {
    code: g('input-claude-code'), live: g('input-live-summary'), route: g('input-claude-bridge'),
    liveNote: !document.getElementById('live-summary-note').hidden,
    routeNote: !document.getElementById('claude-route-note').hidden,
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

  console.log('■ 「Claude Code」がオフなら、ライブ要約と「一部を Claude Code で処理する」は押せない');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', claudeCode: false, useClaudeBridge: true, liveSummary: true });
    await openSettings(page);
    eq('押せず、理由が出る（前の値はオンでも、オフに見せる）', await form(page), {
      code: { checked: false, disabled: false },
      live: { checked: false, disabled: true }, route: { checked: false, disabled: true },
      liveNote: true, routeNote: true,
    });
    eq('振り分けは効いていない', await page.evaluate(() => claudeBridgeIsEnabled()), false);
    eq('ライブ要約のタブも出ない', await page.evaluate(() => !!document.querySelector('.inner-tab[data-pane="pane-live"]')), false);
    await clickCode(page);
    eq('オンにすると押せて、前の値（オン）に戻る', await form(page), {
      code: { checked: true, disabled: false },
      live: { checked: true, disabled: false }, route: { checked: true, disabled: false },
      liveNote: false, routeNote: false,
    });
    await ctx.close();
  }

  console.log('■ ライブ要約は「Claude Code」だけで動く（「一部を Claude Code で処理する」はオフでよい）');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', claudeCode: true, useClaudeBridge: false, liveSummary: true });
    eq('ライブ要約は使える', await page.evaluate(() => liveSummaryActive()), true);
    eq('要約などは Gemini のまま', await page.evaluate(() => claudeBridgeIsEnabled()), false);
    await ctx.close();
  }

  console.log('■ 「Claude Code」をオフにして保存しても、ほかの選択は覚えている');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', claudeCode: true, useClaudeBridge: true, liveSummary: true });
    await openSettings(page);
    await clickCode(page);   // オフに
    await page.evaluate(() => saveSettingsFromForm());
    await page.waitForTimeout(200);
    eq('保存された値', await page.evaluate(() => [state.settings.claudeCode, state.settings.useClaudeBridge, state.settings.liveSummary]), [false, true, true]);
    eq('オフの間は振り分けもライブ要約も止まる', await page.evaluate(() => [claudeBridgeIsEnabled(), liveSummaryActive()]), [false, false]);
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
