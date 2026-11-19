// 文字起こし比較ページ（stt-compare.html）を本物の Chromium で読み込み、最後まで通す (2026-11-09)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-stt-compare-browser.js
//
// Gemini と Groq は page.route で差し替える。音声は 45 秒の WAV をその場で作って渡す
// （0〜14 秒・16〜31 秒・33〜45 秒に音、そのあいだは無音）。
// 見ること: 起動時の登録が効いているか（CLAUDE.md「誰がいつ呼ぶか」）、
// 本体と同じ Gemini の指示で送っているか、Groq に要るものを送っているか、429 で待って試し直すか、前処理が落ちないか。
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const URL = (process.env.URL || 'http://127.0.0.1:8765/') + 'stt-compare.html';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

function makeWav() {
  const sr = 16000, n = sr * 45;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const on = (t < 14) || (t >= 16 && t < 31) || (t >= 33);
    const v = on ? 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) : 0;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sttc-')), 'test.wav');
  fs.writeFileSync(f, buf);
  return f;
}

async function runOnce(browser, { preprocess }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const gem = [], groq = [];
  let groq429 = preprocess === 'none' ? 1 : 0;   // 1 回目だけ「回数の上限」を返す
  await page.route('**/generativelanguage.googleapis.com/**', async r => { if (r.request().method() === 'GET' && /\/models(\?|$)/.test(r.request().url())) return r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }); /* v0.24.157: キーの確かめ（モデルの一覧） */
    gem.push(JSON.parse(r.request().postData()));
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      candidates: [{ content: { parts: [{ text: `ジェミニ${gem.length}` }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 480 }] },
    }) });
  });
  await page.route('**/api.groq.com/**', async r => { if (r.request().method() === 'GET' && /\/models(\?|$)/.test(r.request().url())) return r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }); /* v0.24.157: キーの確かめ（モデルの一覧） */
    const req = r.request();
    if (groq429-- > 0) {
      await r.fulfill({ status: 429, headers: { 'retry-after': '1' }, body: 'rate limited' });
      return;
    }
    groq.push({ auth: req.headers()['authorization'], body: req.postDataBuffer().toString('latin1') });
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      text: `ウィスパー${groq.length}`,
      segments: [{ text: 'ご視聴ありがとうございました', no_speech_prob: 0.9, avg_logprob: -1.5, compression_ratio: 1 }],
    }) });
  });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'AIza-test' })));
  await page.reload();

  eq(`[${preprocess}] 本体のキーを見つける`, await page.textContent('#gemini-key-state'), '本体の設定のキーを使います');
  await page.fill('#groq-key', 'gsk_test');
  await page.selectOption('#preprocess', preprocess);
  await page.fill('#ctx-terms', 'ルーブリック');
  await page.dispatchEvent('#ctx-terms', 'change');
  await page.setInputFiles('#file', makeWav());
  await page.waitForFunction(() => !document.getElementById('btn-run').disabled, null, { timeout: 10000 });
  eq(`[${preprocess}] 区切りの予定`, await page.textContent('#plan'), '3 個に区切って送ります（音声 45 秒）');

  await page.click('#btn-run');
  await page.waitForFunction(() => /終わりました/.test(document.getElementById('summary').textContent), null, { timeout: 60000 });

  const cols = await page.$$eval('.chunk', bs => bs.map(b => Array.from(b.querySelectorAll('.col .text')).map(n => n.textContent)));
  eq(`[${preprocess}] 3 個の結果が並ぶ`, cols, [['ジェミニ1', 'ウィスパー1'], ['ジェミニ2', 'ウィスパー2'], ['ジェミニ3', 'ウィスパー3']]);
  const heads = await page.$$eval('.chunk-head span:first-child', ns => ns.map(n => n.textContent.split('（')[0]));
  eq(`[${preprocess}] 無音のところで切っている`, heads, ['0:00–0:15', '0:15–0:32', '0:32–0:45']);
  eq(`[${preprocess}] 怪しい部分に印`, (await page.$$('.warn')).length >= 3, true);

  // Gemini: 本体と同じ指示（transcribeAudioWithGemini）で、WAV を送っている
  const sys = gem[0].system_instruction.parts[0].text;
  eq(`[${preprocess}] Gemini の指示は本体のもの`, sys.includes('キーボードを打つ音') && sys.includes('[不明瞭]'), true);
  eq(`[${preprocess}] 前後が無音なら「断片」と言わない`, sys.includes('前後とも無音の切れ目'), true);
  eq(`[${preprocess}] WAV で送る`, gem[0].contents[0].parts[1].inline_data.mime_type, 'audio/wav');
  eq(`[${preprocess}] 語彙を渡す`, gem[0].contents[0].parts[0].text.includes('ルーブリック'), true);
  eq(`[${preprocess}] 2 個目には直前の文脈`, gem[1].contents[0].parts[0].text.includes('ジェミニ1'), true);

  // Groq
  eq(`[${preprocess}] Groq の鍵`, groq[0].auth, 'Bearer gsk_test');
  const b = groq[0].body;
  eq(`[${preprocess}] Groq に model / language / verbose_json`,
    [/whisper-large-v3/.test(b), /name="language"\r\n\r\nja/.test(b), /verbose_json/.test(b)], [true, true, true]);
  eq(`[${preprocess}] 2 個目の prompt に直前の文`, groq[1].body.includes(Buffer.from('ウィスパー1').toString('latin1')), true);
  eq(`[${preprocess}] 3 回とも届いた（429 のあと試し直した）`, groq.length, 3);

  const sum = await page.textContent('#summary');
  eq(`[${preprocess}] Gemini のトークンを数える`, sum.includes('入力 3000 トークン（うち音声 1440）'), true);

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#btn-copy');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  eq(`[${preprocess}] 結果をコピーできる`, clip.includes('[Groq') && clip.includes('ジェミニ3'), true);

  // 設定は次に開いたときも残る（本体の設定には書かない）
  await page.reload();
  eq(`[${preprocess}] Groq の鍵が残る`, await page.inputValue('#groq-key'), 'gsk_test');
  const settings = await page.evaluate(() => localStorage.getItem('dictation:settings'));
  eq(`[${preprocess}] 本体の設定は書き換えない`, settings, JSON.stringify({ apiKey: 'AIza-test' }));
  await ctx.close();
}

// Groq に届かないとき「Failed to fetch」だけで終わらせず、どうすればいいかを出す（2026-11-09 やっさんの実機）
async function unreachable(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.route('**/api.groq.com/**', r => r.abort('failed'));
  await page.goto(URL);
  await page.fill('#groq-key', 'gsk_test');
  await page.uncheck('#use-gemini');
  await page.setInputFiles('#file', makeWav());
  await page.waitForFunction(() => !document.getElementById('btn-run').disabled, null, { timeout: 10000 });
  await page.fill('#len-min', '0.2'); await page.dispatchEvent('#len-min', 'change');
  await page.click('#btn-run');
  await page.waitForFunction(() => /終わりました/.test(document.getElementById('summary').textContent), null, { timeout: 30000 });
  const msg = await page.textContent('.col .text');
  eq('[届かない] ブラウザ版なら拡張の住所で開くよう案内', /Failed to fetch.*chrome-extension:/.test(msg), true);
  await ctx.close();
}

// v0.24.147: Muse Voice Transcribe（Meta）と、話者付きの比較（Muse と Gemini のいまの話者判別）
async function muse(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  const sent = [];
  await page.route('**/api.meta.ai/**', async r => {
    const req = r.request();
    const body = req.postDataBuffer().toString('latin1');
    const m = body.match(/name="request"[\s\S]*?\r\n\r\n(\{[\s\S]*?\})\r\n/);
    const request = m ? JSON.parse(Buffer.from(m[1], 'latin1').toString('utf8')) : null;
    sent.push({ url: req.url(), auth: req.headers()['authorization'], request, hasAudio: /name="audio"; filename="chunk\.wav"/.test(body) && /RIFF/.test(body) });
    const diar = request && request.mode === 'DIARIZATION';
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify(diar
      ? { sessionId: 's1', transcript: 'こんにちは。はい、どうぞ。', audioDurationMs: 45000, turns: [{ speaker: 'A', transcript: 'こんにちは。', startMs: 0 }, { speaker: 'B', transcript: 'はい、どうぞ。', startMs: 16000 }] }
      : { sessionId: 's2', transcript: `ミューズ${sent.length}`, audioDurationMs: 14000 }) });
  });
  // Gemini: 話者判別は ファイルを上げる → 待つ → 話者付きで頼む → 消す（本体の diarizeSegmentWithGemini と同じ道）
  await page.route('**/generativelanguage.googleapis.com/**', async r => { if (r.request().method() === 'GET' && /\/models(\?|$)/.test(r.request().url())) return r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }); /* v0.24.157: キーの確かめ（モデルの一覧） */
    const url = r.request().url(), method = r.request().method();
    if (/upload\//.test(url)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ file: { name: 'files/abc', uri: 'https://x/files/abc', mimeType: 'audio/wav', state: 'ACTIVE' } }) });
    if (method === 'GET' && /files\/abc/.test(url)) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ name: 'files/abc', state: 'ACTIVE' }) });
    if (method === 'DELETE') return r.fulfill({ contentType: 'application/json', body: '{}' });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ speakers: [{ label: '話者A' }], turns: [{ speaker: '話者A', text: 'ジェミニが聞いた文。' }] }) }] }, finishReason: 'STOP' }] }) });
  });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'AIza-test' })));
  await page.reload();
  await page.uncheck('#use-gemini'); await page.uncheck('#use-groq');
  await page.check('#use-muse'); await page.check('#use-diarize');
  await page.fill('#muse-key', 'meta-test');
  await page.fill('#ctx-terms', 'ルーブリック、形成的評価'); await page.dispatchEvent('#ctx-terms', 'change');
  await page.setInputFiles('#file', makeWav());
  await page.waitForFunction(() => !document.getElementById('btn-run').disabled, null, { timeout: 10000 });
  await page.click('#btn-run');
  await page.waitForFunction(() => /終わりました/.test(document.getElementById('summary').textContent), null, { timeout: 60000 });
  const chunkReq = sent.filter(x => x.request && x.request.mode === 'PUSH_TO_TALK');
  const diarReq = sent.filter(x => x.request && x.request.mode === 'DIARIZATION');
  eq('[Muse] 区切りごとに送る（3 個）・キーは Bearer・WAV を audio の部品で', [chunkReq.length, chunkReq.every(x => x.auth === 'Bearer meta-test' && x.hasAudio)], [3, true]);
  eq('[Muse] 送る設定（モデル・WAV・日本語・よく出る語）', chunkReq[0].request, { mode: 'PUSH_TO_TALK', model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', languageBias: ['japanese'], keywords: ['ルーブリック', '形成的評価'] });
  const museTexts = await page.$$eval('.chunk .col .text', ns => ns.map(n => n.textContent));
  eq('[Muse] 区切りの列に Muse の字（3 個）', [museTexts.length, museTexts.every(t => /^ミューズ\d$/.test(t))], [3, true]);
  eq('[話者付き] Muse には範囲をまとめて 1 回（DIARIZATION）', diarReq.length, 1);
  const cols = await page.$$eval('#diarize-cols .col', ns => ns.map(n => [n.querySelector('.who span').textContent, n.querySelector('.text').textContent]));
  eq('[話者付き] Muse と Gemini を左右に並べる', cols.map(c => c[0]), ['Muse（Meta）', 'Gemini（いまの話者判別）']);
  eq('[話者付き] 話者ごとの行', cols.map(c => c[1]), ['A: こんにちは。\nB: はい、どうぞ。', '話者A: ジェミニが聞いた文。']);
  await page.evaluate(() => { window.__copied = ''; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; });
  await page.click('#btn-copy');
  const copied = await page.evaluate(() => window.__copied);
  eq('[コピー] Muse と話者付きの結果も入る', [copied.includes('[Muse '), copied.includes('# 話者付きの比較'), copied.includes('B: はい、どうぞ。')], [true, true, true]);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await unreachable(browser);
    await muse(browser);
    for (const preprocess of ['none', 'comp', 'comp-norm']) await runOnce(browser, { preprocess });
  } finally { await browser.close(); }
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
