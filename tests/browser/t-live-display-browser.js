// Gemini モードのリアルタイム表示（Web Speech 並走）を、本物の Chromium で検査する (v0.24.19)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-live-display-browser.js
//
// マイクは Chromium の偽デバイス（--use-fake-device-for-media-stream）、
// Web Speech は偽物に差し替える（ヘッドレスでは本物が動かないうえ、
// 「何を渡して start したか」を見たいので）。Gemini への送信は page.route で塞ぐ。
//
// ■ 何を見ているか
//
// やっさん報告「リアルタイム文字表示が動いてない（Gemini と並走の）」。Meet の講義を
// 仮想マイクで録っていて、Web Speech は Chrome の既定のマイクしか聞かないので、
// 並走は無音を聞いていたと見ている（**実機では未確認**）。v0.24.18 までは
//   - 設定で選んだマイクを並走に渡していなかった
//   - 並走のエラーを console にしか出さず、止まっても誰も気づけなかった
// ここでは「選んだマイクを渡すか」「渡せなかったら既定に戻るか」
// 「止まったら一言出るか」を見る。**本物の Chrome がトラックを受け付けるかは見ていない**。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function record(browser, { useDevice = false, throwOnTrack = false, inputMode = 'gemini-audio' } = {}) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.addInitScript((throwOnTrack) => {
    window.__starts = [];
    window.__recs = [];
    // EventTarget を継ぐのは、v0.24.20 から addEventListener で進み具合を数えるため
    class FakeRec extends EventTarget {
      constructor() { super(); window.__recs.push(this); }
      start(...a) {
        const t = a[0];
        window.__starts.push(a.length === 0 ? 'none'
          : (t && typeof MediaStreamTrack !== 'undefined' && t instanceof MediaStreamTrack) ? 'track:' + t.kind : 'other');
        if (throwOnTrack && a.length) throw new DOMException('track not supported', 'InvalidStateError');
      }
      stop() {}
      abort() {}
    }
    window.SpeechRecognition = FakeRec;
    window.webkitSpeechRecognition = FakeRec;
  }, throwOnTrack);
  await page.route('**/generativelanguage.googleapis.com/**', r => r.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'こんにちは' }] }, finishReason: 'STOP' }] }),
  }));
  await page.goto(URL);
  await page.evaluate((s) => localStorage.setItem('dictation:settings', JSON.stringify(s)),
    { apiKey: 'AIza-test', inputMode, geminiLiveDisplay: true, aiEnabled: false });
  await page.reload();
  await page.waitForTimeout(800);
  if (useDevice) {
    // 偽マイクの deviceId は読み込みのたびに変わるので、読み込んだあとで取って設定に入れる
    const deviceId = await page.evaluate(async () => {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()));
      const d = (await navigator.mediaDevices.enumerateDevices()).find(x => x.kind === 'audioinput' && x.deviceId && x.deviceId !== 'default');
      if (d) state.settings.audioDeviceId = d.deviceId;
      return d ? d.deviceId : '';
    });
    if (!deviceId) { console.log('✕ 偽マイクの deviceId が取れない'); fail++; }
  }
  await page.evaluate(() => startRecording());
  await page.waitForTimeout(500);
  return { ctx, page };
}

const starts = (page) => page.evaluate(() => window.__starts.slice());
const status = (page) => page.evaluate(() => document.getElementById('status-indicator').textContent);
const fire = (page, type, ev) => page.evaluate(([type, ev]) => {
  const rec = window.__recs[window.__recs.length - 1];
  if (rec && rec[type]) rec[type](ev);
}, [type, ev]);

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });

  console.log('■ 既定のマイクのときは、これまでどおり何も渡さない');
  {
    const { ctx, page } = await record(browser);
    eq('start() は引数なし', await starts(page), ['none']);
    await ctx.close();
  }

  console.log('■ 設定でマイクを選んでいたら、そのマイクを並走にも渡す');
  {
    const { ctx, page } = await record(browser, { useDevice: true });
    eq('start(音声トラック)', await starts(page), ['track:audio']);
    await ctx.close();
  }

  console.log('■ トラックを渡す形を Chrome が受け付けなければ、既定のマイクで始め直す');
  {
    const { ctx, page } = await record(browser, { useDevice: true, throwOnTrack: true });
    eq('トラック → 失敗 → 引数なし', await starts(page), ['track:audio', 'none']);
    await ctx.close();
  }

  console.log('■ トラックで始めたあと audio-capture が出たら、次は既定のマイクで聞き直す');
  {
    const { ctx, page } = await record(browser, { useDevice: true });
    await fire(page, 'onerror', { error: 'audio-capture' });
    await fire(page, 'onend', {});
    eq('再開は引数なし', await starts(page), ['track:audio', 'none']);
    eq('止まったとは言わない（聞き直しているので）', (await status(page)).indexOf('止まりました'), -1);
    await ctx.close();
  }

  console.log('■ 待っても直らないエラーなら、画面に出して再開をやめる');
  {
    const { ctx, page } = await record(browser);
    await fire(page, 'onerror', { error: 'not-allowed' });
    eq('画面に一言出る', (await status(page)).indexOf('リアルタイム表示が止まりました') >= 0, true);
    await fire(page, 'onend', {});
    eq('失敗→再開を繰り返さない', await starts(page), ['none']);
    await ctx.close();
  }

  console.log('■ 沈黙だけなら何も出さない（no-speech はふつうの沈黙）');
  {
    const { ctx, page } = await record(browser);
    await fire(page, 'onerror', { error: 'no-speech' });
    await fire(page, 'onend', {});
    eq('黙って再開する', await starts(page), ['none', 'none']);
    eq('画面には出さない', (await status(page)).indexOf('リアルタイム表示') , -1);
    await ctx.close();
  }

  console.log('■ Gemini には文字が出ているのに並走が黙っていたら、1回だけ知らせる');
  {
    const { ctx, page } = await record(browser, { useDevice: true });
    await page.evaluate(() => { for (let i = 0; i < 3; i++) maybeWarnLiveSilent(); });
    const s = await status(page);
    eq('「文字が来ていません」が出る', s.indexOf('リアルタイム表示に文字が来ていません') >= 0, true);
    await ctx.close();
  }
  {
    const { ctx, page } = await record(browser, { useDevice: true });
    await fire(page, 'onresult', { resultIndex: 0, results: [Object.assign([{ transcript: 'こん' }], { isFinal: false })] });
    await page.evaluate(() => { for (let i = 0; i < 3; i++) maybeWarnLiveSilent(); });
    eq('並走から文字が来ていれば出さない', (await status(page)).indexOf('文字が来ていません'), -1);
    eq('並走の文字は画面に出ている', await page.evaluate(() => document.getElementById('interim').textContent), 'こん');
    await ctx.close();
  }

  console.log('■ 録音を止めたら、音声認識がどこまで進んだかを1行残す（v0.24.20）');
  {
    // やっさんの実機: 並走は「開始」だけで、エラーも文字も無かった。どこで止まっているか見えない
    const { ctx, page } = await record(browser);
    await page.evaluate(() => {
      const rec = window.__recs[window.__recs.length - 1];
      rec.dispatchEvent(new Event('audiostart'));
      rec.dispatchEvent(new Event('audiostart'));
      rec.dispatchEvent(new Event('soundstart'));
      const err = new Event('error'); err.error = 'no-speech'; rec.dispatchEvent(err);
      const err2 = new Event('error'); err2.error = 'network'; rec.dispatchEvent(err2);
    });
    await page.evaluate(() => stopRecording());
    await page.waitForTimeout(300);
    const line = await page.evaluate(() => (diagLog.entries.map(e => e.msg).find(m => m.startsWith('リアルタイム表示のまとめ')) || ''));
    eq('まとめの行が残る', line,
       'リアルタイム表示のまとめ: 音を取り始めた2回 音を検知1回 声と判断0回 結果0回 / 無音で終了1回 区切り0回 / エラー network×1');
    await ctx.close();
  }

  console.log('■ Web Speech モードでも同じまとめを残す');
  {
    const { ctx, page } = await record(browser, { inputMode: 'web-speech' });
    await page.evaluate(() => {
      const rec = window.__recs[window.__recs.length - 1];
      rec.dispatchEvent(new Event('audiostart'));
    });
    await page.evaluate(() => stopRecording());
    await page.waitForTimeout(300);
    const line = await page.evaluate(() => (diagLog.entries.map(e => e.msg).find(m => m.startsWith('音声認識（Web Speech）のまとめ')) || ''));
    eq('まとめの行が残る', line.startsWith('音声認識（Web Speech）のまとめ: 音を取り始めた1回 音を検知0回'), true);
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
