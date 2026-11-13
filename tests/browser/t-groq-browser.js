// 聞き取りを Groq の Whisper にしたとき（v0.24.83）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-groq-browser.js
//
// Gemini と Groq は page.route で差し替える。sendAudioChunkToGemini を直接呼ぶ（録音そのものは始めない）。
// 見ること:
//   - Groq を選ぶと音声は Groq だけに行き、Gemini には音声を送らない（料金を減らすのが目的なので、ここが崩れると意味がない）
//   - 句読点の無い Groq の文字をライブ整形に通す（Gemini に行くのは文字だけ）
//   - Groq で失敗したら Gemini で文字にする／Gemini のキーも無ければ失敗と正直に出す
//   - 設定画面で選べて、保存され、右上の印が (Groq) になる（登録が関数の中に入っていないか ── CLAUDE.md「誰がいつ呼ぶか」）
//   - 比較ページで入れた Groq のキーを引き継ぐ
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function open(browser, settings, { groq, extraStorage } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const calls = { gemini: [], groq: 0 };
  await page.route('**/generativelanguage.googleapis.com/**', async r => {
    const body = JSON.parse(r.request().postData());
    const audio = body.contents[0].parts.some(p => p.inline_data);
    calls.gemini.push(audio ? 'audio' : 'text');
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      candidates: [{ content: { parts: [{ text: audio ? 'ジェミニが聞いた文。' : '整形した文です。今日はよろしくお願いします。' }] }, finishReason: 'STOP' }],
    }) });
  });
  await page.route('**/api.groq.com/**', async r => {
    calls.groq++;
    const g = groq || { status: 200, body: { text: '整形前の文です今日はよろしくお願いします', segments: [
      { text: '整形前の文です今日はよろしくお願いします', no_speech_prob: 0.01, avg_logprob: -0.2 },
      { text: 'ご視聴ありがとうございました', no_speech_prob: 0.95, avg_logprob: -1.5 },
    ] } };
    await r.fulfill({ status: g.status, contentType: 'application/json', body: JSON.stringify(g.body) });
  });
  await page.goto(URL);
  await page.evaluate(([s, extra]) => {
    localStorage.setItem('dictation:settings', JSON.stringify(s));
    for (const [k, v] of Object.entries(extra || {})) localStorage.setItem(k, v);
  }, [settings, extraStorage]);
  await page.reload();
  await page.evaluate(() => state.sessions.forEach((x) => { delete x.opts; }));   // v0.24.143: 設定の値に従わせる（タブのオン・オフは t-tab-opts-browser.js）
  await page.waitForTimeout(600);
  return { ctx, page, calls };
}

async function sendOne(page) {
  await page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'.repeat(2000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 15000 }));
  await page.waitForTimeout(300);
  // v0.24.133: 過程の印（ph-draft など）は演出のあいだだけ付くので、比べるときは外す（過程は tests/browser/t-confirm-fx-browser.js で見る）
  return page.evaluate(() => Array.from(document.querySelectorAll('#confirmed .paragraph')).map(p => ({ cls: p.className.replace(/ ph-(?:draft|proc)/g, ''), text: p.textContent.trim() })));
}

(async () => {
  const browser = await chromium.launch();
  const base = { inputMode: 'gemini-audio', transcribeEngine: 'groq', groqApiKey: 'gsk_test', apiKey: 'AIza-test' };

  console.log('■ 整形なし（AI機能オフ）');
  {
    const { ctx, page, calls } = await open(browser, { ...base, aiEnabled: false });
    const paras = await sendOne(page);
    eq('Groq の文字がそのまま出る（雑音から作った文は落とす）', paras.map(p => p.text), ['整形前の文です今日はよろしくお願いします']);
    eq('Gemini には何も送らない', calls.gemini, []);
    eq('Groq に 1 回', calls.groq, 1);
    await ctx.close();
  }

  console.log('\n■ 整形あり（Claude 連携なし → 文字だけ Gemini で整形）');
  {
    const { ctx, page, calls } = await open(browser, { ...base, aiEnabled: true });
    const paras = await sendOne(page);
    eq('整形した文が出る', paras.map(p => p.text), ['整形した文です。今日はよろしくお願いします。']);
    eq('見出し追加にまとめられる印（short-refined）が付く', paras.map(p => p.cls), ['paragraph short-refined']);
    eq('Gemini に行くのは文字だけ（音声は送らない）', calls.gemini, ['text']);
    await ctx.close();
  }

  console.log('\n■ Groq で失敗したら');
  {
    const { ctx, page, calls } = await open(browser, { ...base, aiEnabled: false }, { groq: { status: 500, body: { error: 'down' } } });
    const paras = await sendOne(page);
    eq('Gemini のキーがあれば Gemini で文字にする', paras.map(p => p.text), ['ジェミニが聞いた文。']);
    eq('Gemini に音声を 1 回', calls.gemini, ['audio']);
    await ctx.close();
  }
  {
    const { ctx, page, calls } = await open(browser, { ...base, apiKey: '', aiEnabled: false }, { groq: { status: 401, body: { error: 'bad key' } } });
    const paras = await sendOne(page);
    eq('Gemini のキーも無ければ、失敗と出す（黙って消さない）', paras.map(p => p.cls + ' | ' + p.text.slice(0, 14)), ['paragraph needs-retry | [文字起こし失敗: Groq']);
    eq('Gemini には送らない', calls.gemini, []);
    await ctx.close();
  }

  console.log('\n■ 聞き取りを Gemini にしているとき（今までどおり）');
  {
    const { ctx, page, calls } = await open(browser, { ...base, transcribeEngine: 'gemini', aiEnabled: false });
    const paras = await sendOne(page);
    eq('Gemini が文字にする', paras.map(p => p.text), ['ジェミニが聞いた文。']);
    eq('Groq には送らない', calls.groq, 0);
    await ctx.close();
  }

  console.log('\n■ 設定画面');
  {
    const { ctx, page } = await open(browser, { inputMode: 'gemini-audio', apiKey: 'AIza-test' },
      { extraStorage: { 'dictation:sttCompare': JSON.stringify({ 'groq-key': 'gsk_from_compare' }) } });
    await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });   // v0.24.95: 詳細設定はたたんである
    await page.waitForTimeout(300);
    // v0.24.92: 「聞き取る AI」は使う AI の表へ。既定は無料で済む Groq（キーを引き継いだので選べる）
    const picked = (k) => page.$eval(`.ai-pick[data-k="${k}"][aria-checked="true"]`, b => b.dataset.a).catch(() => null);
    eq('表の文字起こしは、最初から Groq', await picked('stt'), 'groq');
    // v0.24.87: デバイスなどは下の「音声入力」へ移した。AI で聞き取るときだけ出て、Web Speech にすると隠れる
    eq('一番上の見出しは「文字起こしのモード」', await page.evaluate(() => document.querySelector('#settings-modal .field-group-title').textContent), '文字起こしのモード');
    eq('AI で聞き取るなら、下の「音声入力」にデバイスの欄が出ている', await page.isVisible('#voice-input-group #input-audio-device'), true);
    await page.check('#mode-webspeech');
    await page.waitForTimeout(800);
    eq('Web Speech にするとデバイスの欄は隠れる', await page.evaluate(() => document.getElementById('gemini-only-input-fields').hidden), true);
    eq('Web Speech のチャンク長が出る', await page.isVisible('#input-webspeech-commit-sec'), true);
    await page.check('#mode-gemini');
    await page.waitForTimeout(800);
    eq('AI で聞き取るに戻すとデバイスの欄が戻る', await page.isVisible('#input-audio-device'), true);
    // v0.24.88: キーの欄は AI 設定のトグルの下。キーを引き継いだので Groq はオンで始まり、欄は出ている
    eq('見出しの 2 つ目は「AI 設定」', await page.evaluate(() => document.querySelectorAll('#settings-modal .field-group-title')[1].textContent), 'AI 設定');
    eq('キーを引き継いだので Groq Whisper はオン', await page.isChecked('#input-groq-enabled'), true);
    eq('Gemini API もキーがあるのでオン', await page.isChecked('#input-gemini-enabled'), true);
    eq('オンなので Groq のキーの欄が出ている', await page.isVisible('#input-groq-key'), true);
    eq('比較ページで入れたキーを引き継いでいる', await page.inputValue('#input-groq-key'), 'gsk_from_compare');
    await page.uncheck('#input-groq-enabled');
    await page.waitForTimeout(800);
    eq('Groq を切るとキーの欄は隠れる', await page.evaluate(() => document.getElementById('groq-key-fields').hidden), true);
    await page.check('#input-groq-enabled');
    await page.waitForTimeout(800);
    eq('Claude Code がオフなら連携のボタンは隠れている', await page.evaluate(() => document.getElementById('claude-code-fields').hidden), true);
    await page.click('.ai-pick[data-k="stt"][data-a="gemini"]');
    eq('表で Gemini を押すと Gemini', await picked('stt'), 'gemini');
    await page.click('.ai-pick[data-k="stt"][data-a="groq"]');
    await page.click('#btn-settings-save');
    await page.waitForTimeout(200);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:settings')));
    eq('保存される', [saved.transcribeEngine, saved.groqApiKey], ['groq', 'gsk_from_compare']);
    eq('右上の印は (Groq)', await page.evaluate(() => recordingLabel()), '聞き取り中 (Groq)');
    await page.reload();
    await page.evaluate(() => state.sessions.forEach((x) => { delete x.opts; }));   // v0.24.143: 設定の値に従わせる（タブのオン・オフは t-tab-opts-browser.js）
    await page.waitForTimeout(500);
    await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });   // v0.24.95: 詳細設定はたたんである
    await page.waitForTimeout(300);
    eq('開き直しても表は Groq', await page.$eval('.ai-pick[data-k="stt"][aria-checked="true"]', b => b.dataset.a), 'groq');
    eq('開き直したとき、キーの欄は出ている', await page.isVisible('#input-groq-key'), true);
    await ctx.close();
  }

  console.log('\n■ AI 設定のトグルを切ったら、キーが残っていても使わない（v0.24.88）');
  {
    const { ctx, page, calls } = await open(browser, { ...base, groqEnabled: false, aiEnabled: false });
    const paras = await sendOne(page);
    eq('Groq を切っていれば Groq には送らない', calls.groq, 0);
    eq('代わりに Gemini が聞く', paras.map(p => p.text), ['ジェミニが聞いた文。']);
    eq('右上の印も (Gemini)', await page.evaluate(() => recordingLabel()), '聞き取り中 (Gemini)');
    await ctx.close();
  }
  {
    // v0.24.92: 表で Gemini を選んでいても、Gemini を切っていて Groq が使えるなら Groq に回る（選んでいた AI を切ったら、もう一方へ）
    const { ctx, page, calls } = await open(browser, { ...base, transcribeEngine: 'gemini', geminiEnabled: false, aiEnabled: false });
    const paras = await sendOne(page);
    eq('Gemini を切っていれば Gemini には送らない', calls.gemini, []);
    eq('Groq が使えるので Groq に回る', [calls.groq, paras.map(p => p.cls)], [1, ['paragraph short-refined']]);
    await ctx.close();
  }
  {
    const { ctx, page, calls } = await open(browser, { ...base, geminiEnabled: false, groqEnabled: false, aiEnabled: false });
    const paras = await sendOne(page);
    eq('どちらも切っていれば、どちらにも送らない', [calls.gemini, calls.groq], [[], 0]);
    eq('失敗と正直に出す', paras.map(p => p.cls), ['paragraph needs-retry']);
    await ctx.close();
  }
  {
    // 前の版の設定（トグルが無い）: キーがあるものはオンで始まる
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test' });
    eq('前の設定でキーがあれば Gemini API はオン', await page.evaluate(() => [state.settings.geminiEnabled, state.settings.groqEnabled]), [true, false]);
    await ctx.close();
  }

  {
    // v0.24.127: 無音のかたまりで「ご視聴ありがとうございました」（話していない確率は低め）。実機 2026-11-11
    const silenceGroq = { status: 200, body: { text: 'ご視聴ありがとうございました', segments: [{ text: 'ご視聴ありがとうございました', no_speech_prob: 0.1, avg_logprob: -0.4 }] } };
    const { ctx, page } = await open(browser, { ...base, aiEnabled: false }, { groq: silenceGroq });
    await page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'.repeat(2000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 15000, hadSpeech: false }));
    await page.waitForTimeout(500);
    const paras = await page.evaluate(() => Array.from(document.querySelectorAll('#confirmed .paragraph')).map(p => p.textContent.trim()));
    eq('無音（大きい音なし）のかたまりの決まり文句は出さない', paras.some(t => t.includes('ご視聴')), false);
    await page.evaluate(() => { els.confirmed.innerHTML = ''; });
    await page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'.repeat(2000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 15000, hadSpeech: true }));
    await page.waitForTimeout(500);
    eq('大きい音があり、確率も低いなら残す（本当に言ったかもしれない）', await page.evaluate(() => els.confirmed.textContent.includes('ご視聴ありがとうございました')), true);
    await ctx.close();
  }

  console.log('\n■ Web Speech の字も整形に渡す（v0.24.144・やっさんの案）');
  for (const on of [true, false]) {
    const { ctx, page } = await open(browser, { ...base, aiEnabled: true, refineWithWebSpeech: on });
    const sent = [];
    await page.route('**/generativelanguage.googleapis.com/**', async (r) => { sent.push(r.request().postData() || ''); await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '整形した文です。' }] }, finishReason: 'STOP' }] }) }); });
    await page.evaluate(() => state.sessions.forEach((x) => { delete x.opts; }));
    await page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'.repeat(2000)], { type: 'audio/webm' }), 'ウェブスピーチが聞いた文です今日は', { startsAtSilence: true, endsAtSilence: true, durationMs: 15000 }));
    await page.waitForTimeout(300);
    eq(on ? 'オン: 整形に Web Speech の字も渡す' : 'オフ: 渡さない（前と同じ）', sent.some((b) => b.includes('ウェブスピーチが聞いた文')), on);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
