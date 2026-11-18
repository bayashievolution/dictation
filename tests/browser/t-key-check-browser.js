// Gemini・Groq の API キーの確かめ（v0.24.157）と、「失敗したら Gemini で処理する」の押せる・押せないを、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-key-check-browser.js
//
// やっさんの指定（2026-11-19）: Claude Code には確かめがあるのに Gemini には無い。トークンを使わないなら、ほかと同じタイミングで確かめる。
// Gemini が使えないときは「失敗したら Gemini」を押せなくして赤い字（見本 https://claude.ai/artifact/7AbnKFE8SDoSgXVLb2cVFv ）。
// 前の版（v0.24.156）に当てると落ちる
const { chromium } = require('playwright');
const PAGE = process.env.URL || 'http://127.0.0.1:8765/';
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
    const seen = { gemModels: [], gemGenerate: 0, groqModels: [], groqAudio: 0 };
    await page.addInitScript((s) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('dictation:settings', JSON.stringify(s));
    }, settings);
    await page.route('**/generativelanguage.googleapis.com/**', (r) => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('/models')) {
        const key = u.searchParams.get('key');
        seen.gemModels.push(key);
        if (key === 'GOOD') return r.fulfill({ contentType: 'application/json', body: '{"models":[{"name":"models/x"}]}' });
        return r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid"}}' });
      }
      seen.gemGenerate++;
      r.fulfill({ status: 500, body: '' });
    });
    await page.route('**/api.groq.com/**', (r) => {
      const u = r.request().url();
      if (u.endsWith('/models')) {
        const auth = r.request().headers().authorization || '';
        seen.groqModels.push(auth);
        return auth === 'Bearer gsk_good' ? r.fulfill({ contentType: 'application/json', body: '{"data":[]}' }) : r.fulfill({ status: 401, body: '{"error":{"message":"Invalid API Key"}}' });
      }
      seen.groqAudio++;
      r.fulfill({ status: 500, body: '' });
    });
    await page.goto(PAGE);
    await page.waitForTimeout(1000);
    return { page, seen };
  }
  const status = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); return [e.textContent, e.className.includes('is-ok') ? 'ok' : e.className.includes('is-ng') ? 'ng' : '']; }, id);

  console.log('■ 立ち上げたときに確かめる（モデルの一覧だけ。文字起こし・整形はしない）');
  {
    const { page, seen } = await open({ geminiEnabled: true, apiKey: 'GOOD', groqEnabled: true, groqApiKey: 'gsk_good', claudeCode: false });
    eq('Gemini と Groq に 1 回ずつ（トークンを使う呼び出しはしない）', [seen.gemModels, seen.groqModels.length, seen.gemGenerate, seen.groqAudio], [['GOOD'], 1, 0, 0]);
    await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
    await page.waitForTimeout(500);
    eq('Gemini の下に「キーは有効です」（緑）', await status(page, 'gemini-key-status'), ['キーは有効です', 'ok']);
    eq('Groq の下にも', await status(page, 'groq-key-status'), ['キーは有効です', 'ok']);
    eq('有効と分かっていれば、設定を開いても確かめ直さない', seen.gemModels.length, 1);
    eq('文言（Groq の説明）', (await page.textContent('#input-groq-enabled + span small')).trim(), 'AI 文字起こしに対応。1日あたり8時間まで無料で使用できます。');
    eq('Gemini が使えれば、失敗したら Gemini は押せる', await page.evaluate(() => [els.inputClaudeFallback.disabled, els.inputGroqFallback.disabled, document.querySelector('#groq-fallback-row .fallback-ng').hidden]), [false, false, true]);

    console.log('\n■ キーを入れ直したら確かめる・オフにしたら字を消す');
    await page.fill('#input-api-key', 'BAD');
    eq('打っているあいだは前の結果を出さない', (await status(page, 'gemini-key-status'))[0], '');
    await page.dispatchEvent('#input-api-key', 'change');
    await page.waitForTimeout(400);
    eq('違うキーなら赤い字', await status(page, 'gemini-key-status'), ['API キーが正しくありません', 'ng']);
    eq('失敗したら Gemini の 2 つは押せない・赤い字が出る', await page.evaluate(() => [els.inputClaudeFallback.disabled, els.inputGroqFallback.disabled,
      document.querySelector('#groq-fallback-row .fallback-ng').hidden, document.querySelector('#groq-fallback-row .fallback-ng').textContent]),
      [true, true, false, 'Gemini API が登録されていないか、有効になっていません']);
    await page.evaluate(() => { els.inputGeminiEnabled.checked = false; els.inputGeminiEnabled.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(300);
    eq('Gemini をオフにすると状態の字は消え、押せないまま', [(await status(page, 'gemini-key-status'))[0], await page.evaluate(() => els.inputGroqFallback.disabled)], ['', true]);
    await page.close();
  }

  console.log('\n■ 立ち上げたときにキーが違うと分かったら、Groq・Claude の失敗を Gemini に回さない');
  {
    const { page } = await open({ geminiEnabled: true, apiKey: 'BAD', groqEnabled: true, groqApiKey: 'gsk_bad', claudeCode: true, claudeFallbackGemini: true, groqFallbackGemini: true, groqFallbackV: 2 });
    eq('回さない（設定はオンのまま）', await page.evaluate(() => [groqMayFallBackToGemini(), claudeBridgeFallbackEnabled(), state.settings.groqFallbackGemini]), [false, false, true]);
    await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
    await page.waitForTimeout(500);
    eq('Groq も違うキーなら赤い字', await status(page, 'groq-key-status'), ['API キーが正しくありません', 'ng']);
    await page.evaluate(() => saveSettingsFromForm());
    eq('押せないまま保存しても、覚えている値は消えない', await page.evaluate(() => [state.settings.claudeFallbackGemini, state.settings.groqFallbackGemini]), [true, true]);
    await page.close();
  }

  console.log('\n■ Claude Code の状態の字も同じ色');
  {
    const { page } = await open({ claudeCode: true });
    await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, invocation: 'claude', auth: { ok: true, loggedIn: true } }) }));
    await page.evaluate(() => testClaudeBridge());
    await page.waitForTimeout(300);
    const st = await status(page, 'claude-bridge-status');
    const color = await page.evaluate(() => [getComputedStyle(document.getElementById('claude-bridge-status')).color, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()]);
    const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    eq('使用できます（緑の字）', [st[0].startsWith('使用できます'), st[1], hex(color[0]) === color[1].toLowerCase()], [true, 'ok', true]);
    await page.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
