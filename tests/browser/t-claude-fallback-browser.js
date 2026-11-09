// 設定「Claude Codeでの処理に失敗したらGemini APIで処理する」（v0.24.58）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-claude-fallback-browser.js
//
// やっさん「Claude Code 連携のライブ整形の上にトグルを付けてほしい。Claude Code 連携をオンにした時だけ出るように」
// 「オフの時は3回リトライする」「3回リトライの度にタイムアウトをちょっと伸ばす」「内容の量に合わせて待ち時間を決めているの？」。
// Claude（/api/claude）と Gemini は page.route で差し替える。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function open(browser, settings, claudeError = '') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const seen = { gemini: 0, claude: [] };
  await page.route('**/generativelanguage.googleapis.com/**', r => {
    seen.gemini++;
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '## 概要\n- Gemini の要約' }] }, finishReason: 'STOP' }] }) });
  });
  await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, invocation: 'claude', features: ['effort', 'timeout', 'session'], auth: { ok: true, loggedIn: true } }) }));
  await page.route('**/api/claude', r => {
    const b = JSON.parse(r.request().postData() || '{}');
    seen.claude.push({ timeoutMs: b.timeoutMs, len: (b.prompt || '').length });
    if (claudeError) return r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: claudeError }) });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, text: '## 概要\n- Claude の要約', seconds: 1 }) });
  });
  await page.goto(URL);
  await page.evaluate((s) => localStorage.setItem('dictation:settings', JSON.stringify(s)), settings);
  await page.reload();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.alert = () => {};
    window.__notices = [];
    const o = window.statusNotice;
    window.statusNotice = (m, l, x) => { window.__notices.push(l); return o(m, l, x); };
  });
  return { ctx, page, seen };
}

const summarize = (page, chars) => page.evaluate(async (n) => {
  const p = document.createElement('div'); p.className = 'paragraph';
  p.textContent = 'あ'.repeat(n);
  document.getElementById('confirmed').appendChild(p);
  snapshotActiveToSession();
  await generateSummary({ silent: true });
  return document.getElementById('summary').textContent;
}, chars);

(async () => {
  const browser = await chromium.launch();

  console.log('■ 設定欄: Claude Code 連携がオンのときだけ、ライブ整形の上に出る');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', claudeCode: false });
    await page.evaluate(() => document.getElementById('btn-settings').click());
    await page.waitForTimeout(300);
    const vis = () => page.evaluate(() => { const e = document.getElementById('claude-fallback-row'); return !!e && e.offsetParent !== null; });
    eq('連携オフなら出ない', await vis(), false);
    await page.click('#input-claude-code');
    await page.waitForTimeout(600);
    eq('連携をオンにするとその場で出る', await vis(), true);
    eq('文言', (await page.textContent('#claude-fallback-row')).trim(), 'Claude Codeでの処理に失敗したらGemini APIで処理する');
    eq('ライブ整形のすぐ上', await page.evaluate(() => document.getElementById('claude-fallback-row').nextElementSibling.contains(document.getElementById('input-ai-enabled'))), true);
    eq('既定はオフ（料金を増やさないほう）', await page.evaluate(() => document.getElementById('input-claude-fallback').checked), false);
    await page.click('#input-claude-fallback');
    await page.evaluate(() => saveSettingsFromForm());
    eq('保存できて、すぐ効く', await page.evaluate(() => [state.settings.claudeFallbackGemini, claudeBridgeFallbackEnabled()]), [true, true]);
    await page.reload();
    await page.waitForTimeout(800);
    eq('立ち上げ直しても効いている', await page.evaluate(() => claudeBridgeFallbackEnabled()), true);
    await ctx.close();
  }

  console.log('■ オフ: Claude で失敗したら Gemini に回さず、3回試し直す（待ち時間を少しずつ延ばす）');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', claudeCode: true, claudeFallbackGemini: false }, '300秒待っても返事がありませんでした');
    const text = await summarize(page, 18000);
    eq('Claude に 1 + 3 回頼んだ', seen.claude.length, 4);
    eq('待ち時間は量で決め（1.8万字 → 約300秒）、試し直すたびに 25% 延ばす',
       seen.claude.map(c => c.timeoutMs), [0, 1, 2, 3].map(a => Math.round(seen.claude[0].timeoutMs * (1 + 0.25 * a))));
    eq('1回目は量で決めた長さ（決め打ちの 180秒ではない）', [seen.claude[0].timeoutMs >= 300000, seen.claude[0].timeoutMs <= 320000], [true, true]);
    eq('Gemini には回していない', seen.gemini, 0);
    eq('要約は作られない', text.includes('要約'), false);
    eq('「要約できませんでした」と言う（「Gemini で処理」とは言わない）',
       await page.evaluate(() => [window.__notices.some(n => n.includes('要約できませんでした')), window.__notices.some(n => n.includes('Gemini で処理'))]), [true, false]);
    await ctx.close();
  }
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', claudeCode: true }, 'Failed to authenticate: OAuth session expired');
    await summarize(page, 500);
    eq('ログイン切れは試し直さない（何度やっても同じ）', [seen.claude.length, seen.gemini], [1, 0]);
    await ctx.close();
  }
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', claudeCode: true });
    const text = await summarize(page, 500);
    eq('成功すれば1回だけ', [seen.claude.length, text.includes('Claude の要約')], [1, true]);
    await ctx.close();
  }

  console.log('■ オン: 失敗したらその場で Gemini（試し直さない）');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', claudeCode: true, claudeFallbackGemini: true }, '180秒待っても返事がありませんでした');
    const text = await summarize(page, 500);
    eq('Claude は1回だけ、Gemini で要約した', [seen.claude.length, seen.gemini, text.includes('Gemini の要約')], [1, 1, true]);
    await ctx.close();
  }
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', aiEnabled: true, claudeCode: true, claudeFallbackGemini: true, inputMode: 'web-speech' }, '終了コード 1');
    await page.evaluate(() => { appendRawChunk('今日は評価論の話をします。評価の観点は三つあります。'); return flushPendingToGemini(); });
    await page.waitForTimeout(300);
    eq('ライブ整形もオンなら Gemini に回る', [seen.claude.length, seen.gemini], [1, 1]);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
