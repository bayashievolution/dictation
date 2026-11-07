// Gemini のトークン節約（v0.24.55）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-gemini-saving-browser.js
//
// やっさん「Geminiのトークン節約を工夫してほしい」。Gemini と /api/claude は page.route で差し替え、
// **Gemini に実際に送られた中身**を見る。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function open(browser, settings) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const seen = { audio: [], text: [], claude: [] };
  await page.route('**/generativelanguage.googleapis.com/**', r => {
    const body = JSON.parse(r.request().postData() || '{}');
    const parts = (body.contents || []).flatMap(c => c.parts || []);
    const isAudio = parts.some(p => p.inline_data);
    const promptText = parts.map(p => p.text || '').join('') + ((body.system_instruction || {}).parts || []).map(p => p.text).join('');
    (isAudio ? seen.audio : seen.text).push(promptText);
    const isContext = JSON.stringify(body).includes('用語');
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      candidates: [{ content: { parts: [{ text: isContext ? '{"terms":["ルーブリック"],"topicPath":["評価"],"flow":"x"}' : '今日は評価論の話をします。' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: isAudio ? 900 : 300, candidatesTokenCount: 50,
        promptTokensDetails: isAudio ? [{ modality: 'TEXT', tokenCount: 420 }, { modality: 'AUDIO', tokenCount: 480 }] : [{ modality: 'TEXT', tokenCount: 300 }] },
    }) });
  });
  await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, invocation: 'claude', features: ['effort', 'timeout', 'session'], auth: { ok: true, loggedIn: true } }) }));
  await page.route('**/api/claude', r => {
    const b = JSON.parse(r.request().postData() || '{}');
    seen.claude.push(b);
    const isContext = (b.prompt || '').includes('用語');
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, seconds: 1,
      text: isContext ? '```json\n{"terms":["ルーブリック","妥当性"],"topicPath":["評価","観点"],"flow":"観点の話に移った"}\n```' : '整えた本文です。' }) });
  });
  await page.goto(URL);
  await page.evaluate((s) => localStorage.setItem('dictation:settings', JSON.stringify(s)), settings);
  await page.reload();
  await page.waitForTimeout(800);
  return { ctx, page, seen };
}

// 5分ぶんをまとめた大きな段落（数千字）が直前にある状態
const seedBig = (page) => page.evaluate(() => {
  const p = document.createElement('div'); p.className = 'paragraph refined';
  p.innerHTML = '<h2>評価の観点</h2><div class="p-body">' + '観点は三つあります。妥当性と信頼性と実行可能性です。'.repeat(120) + '最後の一文です。</div>';
  document.getElementById('confirmed').appendChild(p);
  snapshotActiveToSession();
});

(async () => {
  const browser = await chromium.launch();

  console.log('■ 音声のかたまりごとに送る「直前の文脈」を短くする');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', aiEnabled: true, inputMode: 'gemini-audio' });
    await seedBig(page);
    await page.evaluate(() => { state.isRecording = true; return sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null); });
    const t = seen.audio[0] || '';
    const hint = (t.split('【直前の文脈（表記の参考のみ。ここから話を続けて書かないこと）】')[1] || '').split('【次の音声')[0].trim();
    eq('直前の文脈は300字以内（前は直近3段落をそのまま＝この例では3000字超）', [hint.length > 0, hint.length <= 300], [true, true]);
    eq('いちばん新しいところを残す', hint.endsWith('最後の一文です。'), true);
    await ctx.close();
  }

  console.log('■ 連携オン: 文脈の自動抽出も Claude（Gemini の文字の処理は0回）');
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', aiEnabled: true, claudeCode: true });
    await seedBig(page);
    await page.evaluate(() => refreshAutoContext({ force: true }));
    await page.waitForTimeout(300);
    eq('Gemini には送っていない', seen.text.length, 0);
    const c = seen.claude.find(b => (b.prompt || '').includes('用語'));
    eq('Claude に頼んだ（考え込ませず、同じ会話で）', c ? [c.effort, c.session] : null, ['low', true]);
    eq('返事（コードフェンス付きの JSON）を読んで文脈に入れた', await page.evaluate(() => getActiveSession().autoContext.terms), ['ルーブリック', '妥当性']);
    await ctx.close();
  }
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', aiEnabled: true, claudeCode: true });
    await page.unroute('**/api/claude');
    await page.route('**/api/claude', r => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '終了コード 1' }) }));
    await seedBig(page);
    await page.evaluate(() => refreshAutoContext({ force: true }));
    await page.waitForTimeout(300);
    eq('Claude が失敗しても Gemini には回さない', seen.text.length, 0);
    await ctx.close();
  }
  {
    const { ctx, page, seen } = await open(browser, { apiKey: 'AIza-test', aiEnabled: true, claudeCode: false });
    await seedBig(page);
    await page.evaluate(() => refreshAutoContext({ force: true }));
    await page.waitForTimeout(300);
    eq('連携オフならこれまでどおり Gemini', [seen.text.length, seen.claude.length], [1, 0]);
    await ctx.close();
  }

  console.log('■ 止めたときに、録音中の Gemini の使用量を診断ログへ');
  {
    const { ctx, page } = await open(browser, { apiKey: 'AIza-test', aiEnabled: false, autoSummarize: false, inputMode: 'web-speech' });
    await page.evaluate(async () => {
      class FakeRec extends EventTarget { start() {} stop() {} abort() {} }
      window.SpeechRecognition = FakeRec; window.webkitSpeechRecognition = FakeRec;
      await startRecording();
      // 録音中に音声を2かたまり送ったことにする
      await transcribeAudioWithGemini({ apiKey: 'AIza-test', audioBlob: new Blob(['x'], { type: 'audio/webm' }) });
      await transcribeAudioWithGemini({ apiKey: 'AIza-test', audioBlob: new Blob(['x'], { type: 'audio/webm' }) });
      stopRecording();
    });
    await page.waitForTimeout(1500);
    const line = await page.evaluate(() => (diagLog.entries.map(e => e.msg).find(m => m.includes('Gemini の使用量')) || ''));
    eq('文字起こしの回数と音声のトークンが出る', line.includes('文字起こし 2回 入力 1,800（うち音声 960） / 出力 100'), true);
    eq('料金には換算しない（言い切れないので）', /円|\$/.test(line), false);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
