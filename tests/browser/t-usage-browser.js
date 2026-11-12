// 使用量のカード（v0.24.104）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-usage-browser.js
//
// 見ること: 本当に Gemini・Groq を呼んだときに数えられる（呼ぶ道に入っているか ── CLAUDE.md「誰がいつ呼ぶか」）／
// 設定のいちばん下にカードが出て、数字が入る
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
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.route('**/generativelanguage.googleapis.com/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({
    candidates: [{ content: { parts: [{ text: '文字です。' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 480 }] },
  }) }));
  await page.route('**/api.groq.com/**', r => r.fulfill({ contentType: 'application/json',
    // 拡張（host_permissions あり）なら x-ratelimit-* を読める。ここはブラウザ版のページなので、読めるように expose を付けて同じ状況にする
    // （本物の Groq がブラウザ版に見せているかは未確認。見せていなければ、ブラウザ版では「返事の残り」の行が出ないだけ）
    headers: { 'x-ratelimit-remaining-requests': '1999', 'x-ratelimit-limit-requests': '2000', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-remaining-requests, x-ratelimit-limit-requests' },
    body: JSON.stringify({ text: 'ウィスパー', segments: [{ text: 'ウィスパー', no_speech_prob: 0, avg_logprob: -0.1 }] }) }));
  await page.goto(URL);
  await page.evaluate(() => { localStorage.removeItem('dictation:usage'); localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', transcribeEngine: 'gemini', aiEnabled: false })); });
  await page.reload();
  await page.waitForTimeout(700);

  // 本体の道で 1 回ずつ呼ぶ（Gemini で文字起こし → Groq で文字起こし）
  await page.evaluate(() => sendAudioChunkToGemini(new Blob(['x'.repeat(2000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 15000 }));
  await page.waitForTimeout(300);
  await page.evaluate(() => { state.settings.transcribeEngine = 'groq'; return sendAudioChunkToGemini(new Blob(['x'.repeat(2000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 15000 }); });
  await page.waitForTimeout(300);
  const u = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:usage')));
  const mk = Object.keys(u.gemini)[0];
  eq('Gemini の文字起こしが今月に数えられる', [u.gemini[mk].audio, u.gemini[mk].text, u.gemini[mk].output, Object.keys(u.gemini[mk].byFeature)], [480, 520, 20, ['transcribe']]);
  eq('Groq は 15 秒・1 回と数える', [u.groq.daySec, u.groq.dayReq, u.groq.hourSec], [15, 1, 15]);
  eq('Groq の返事の残りも覚える', u.groq.headers['x-ratelimit-remaining-requests'], '1999');

  await page.evaluate(() => openSettings());
  await page.waitForTimeout(500);
  eq('カードは設定のいちばん下（詳細設定の下）', await page.evaluate(() => {
    const t = [...document.querySelectorAll('#settings-modal .settings-section > .field-group-title')].map(n => n.textContent.trim());
    return t.slice(-2);
  }), ['詳細設定', '使用量']);
  const text = await page.textContent('#usage-card');
  eq('Gemini のトークン数と料金の目安が出る', [text.includes('1,020'), text.includes('料金の目安')], [true, true]);
  // v0.24.111: 3 つの輪（上に 1 つ・下に 2 つ）。輪は残りで、使うほど減る
  const rings = await page.$$eval('#usage-card .usage-ring', ns => ns.map(n => ({ label: n.querySelector('.ring-label').textContent, val: n.querySelector('.ring-val').textContent, rem: Number(n.dataset.rem), big: n.classList.contains('big'), top: Math.round(n.getBoundingClientRect().top) })));
  eq('輪は 3 つ（今日の音声が上・下に 2 つ）', rings.map(r => r.label), ['今日の音声', 'この1時間の音声', '今日の回数']);
  eq('3 つとも同じ大きさ（v0.24.114）', await page.$$eval('#usage-card .usage-ring svg', ns => new Set(ns.map(n => Math.round(n.getBoundingClientRect().width))).size), 1);
  eq('上に 1 つ、下に 2 つ（下の 2 つは同じ高さ）', [rings[0].top < rings[1].top, rings[1].top === rings[2].top], [true, true]);
  eq('残り（1,999 回・15 秒使った分だけ減る）', [rings[2].val, rings[0].rem], ['1,999回', Number((1 - 15 / 28800).toFixed(4))]);
  await page.waitForTimeout(1500);
  eq('輪は残りの長さまで減る', await page.evaluate(() => { const a = document.querySelector('#usage-card .usage-ring:nth-of-type(1) .ring-rem'); return Number(a.style.strokeDashoffset) > 0; }), true);
  eq('Groq の返事の残りは出さない（v0.24.140・輪の数と並んで迷うため）', text.includes('Groq の返事では'), false);
  eq('一番下は「このアプリから送ったデータを集計しています。」（v0.24.139）', text.includes('このアプリから送ったデータを集計しています。'), true);

  console.log('\n■ 押すと月別のグラフ（v0.24.114 で長押しから押すだけに）');
  await page.evaluate(() => {
    const u = JSON.parse(localStorage.getItem('dictation:usage'));
    const d = new Date(); d.setMonth(d.getMonth() - 1);
    const pk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    u.gemini[pk] = { calls: 9, text: 50000, audio: 30000, output: 20000, byFeature: {} };
    localStorage.setItem('dictation:usage', JSON.stringify(u));
    renderUsageCard();
  });
  await page.evaluate(() => document.getElementById('usage-gemini-total').scrollIntoView({ block: 'center' }));
  await page.click('#usage-gemini-total');
  await page.waitForTimeout(500);
  eq('押すと出る', await page.evaluate(() => document.getElementById('usage-chart').hidden), false);
  const cols = await page.$$eval('.usage-chart-col', ns => ns.map(n => ({ m: n.querySelector('.usage-chart-m').textContent, cur: n.classList.contains('current'), h: parseFloat(n.querySelector('.usage-chart-bar > span').style.height) })));
  eq('今月が右端で強調', cols[cols.length - 1].cur, true);
  eq('最近 6 か月だけ（v0.24.116・12 本は詰まりすぎ）', cols.length, 6);
  eq('先月の棒が一番高い（100,000 > 1,020）', cols[cols.length - 2].h, 100);
  await page.click('#usage-gemini-total');
  await page.waitForTimeout(600);
  eq('もう一度押すと閉じる', await page.evaluate(() => document.getElementById('usage-chart').hidden), true);
  await page.click('#usage-gemini-total');
  await page.waitForTimeout(500);
  await page.click('#settings-modal .modal-header h2');   // 設定の中の、グラフの外（暗い背景を押すと設定ごと閉じる）
  await page.waitForTimeout(600);
  eq('外を触ると閉じる', await page.evaluate(() => document.getElementById('usage-chart').hidden), true);

  console.log('\n■ 記録が 1 つも無くても 6 本（v0.24.116。前は 12 本並んでいた）');
  const saved = await page.evaluate(() => localStorage.getItem('dictation:usage'));
  await page.evaluate(() => { localStorage.setItem('dictation:usage', '{}'); renderUsageCard(); openUsageChart(); });
  await page.waitForTimeout(400);
  eq('記録なしでも 6 本', await page.$$eval('.usage-chart-col', ns => ns.length), 6);
  await page.evaluate((v) => { closeUsageChart(); localStorage.setItem('dictation:usage', v); renderUsageCard(); }, saved);
  await page.waitForTimeout(500);

  console.log('\n■ リセット（v0.24.110）');
  await page.click('#btn-usage-reset');
  await page.waitForTimeout(400);
  eq('警告の小窓（赤いボタン）', [await page.textContent('#confirm-title'), await page.evaluate(() => document.getElementById('confirm-ok').classList.contains('btn-danger'))], ['Gemini のトークンの記録をリセットしますか？', true]);
  await page.click('#confirm-cancel');
  await page.waitForTimeout(400);
  eq('キャンセルなら消えない', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('dictation:usage')).gemini).length), 2);
  await page.click('#btn-usage-reset');
  await page.waitForTimeout(400);
  await page.click('#confirm-ok');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:usage')));
  eq('Gemini の記録は消え、Groq の数は残る', [after.gemini, after.groq.daySec], [undefined, 15]);
  eq('カードは 0 に', (await page.textContent('#usage-gemini-total')).startsWith('0'), true);

  console.log('\n■ Groq のリセット（v0.24.112・Gemini とは別）');
  await page.evaluate(() => { const u = JSON.parse(localStorage.getItem('dictation:usage')); u.gemini = { '2026-01': { calls: 1, text: 5, audio: 0, output: 0, byFeature: {} } }; localStorage.setItem('dictation:usage', JSON.stringify(u)); renderUsageCard(); });
  await page.click('#btn-usage-reset-groq');
  await page.waitForTimeout(400);
  eq('警告に「残りが実際より多く見える」と書く', [await page.textContent('#confirm-title'), (await page.textContent('#confirm-message')).includes('実際より多く見えます')], ['Groq の使用量をリセットしますか？', true]);
  await page.click('#confirm-ok');
  await page.waitForTimeout(400);
  const g2 = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:usage')));
  eq('Groq の数だけ消え、Gemini は残る', [g2.groq, !!g2.gemini], [undefined, true]);
  eq('輪は満タンに', await page.$eval('#usage-card .usage-ring', n => n.dataset.rem), '1.0000');

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
