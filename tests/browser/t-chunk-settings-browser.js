// 設定の「音声チャンク」（v0.24.47）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-chunk-settings-browser.js
//
// 「既定値に戻す」ボタンの登録は起動時に走る行なので、実際に押して確かめる（CLAUDE.md）。
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
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('dictation:settings', JSON.stringify({
      inputMode: 'gemini-audio', audioChunkSec: 30, audioSilenceCut: false, audioChunkMaxSec: 45,
      audioMinChunkBytes: 1000, audioBitrate: 128000,
    }));
  });
  await page.goto(URL);
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await page.waitForTimeout(300);

  const form = () => page.evaluate(() => [
    document.getElementById('input-chunk-sec').value,
    document.getElementById('input-silence-cut').checked,
    document.getElementById('input-chunk-max-sec').value,
    document.getElementById('input-min-chunk-bytes').value,
    document.getElementById('input-audio-bitrate').value,
  ]);
  const saved = () => page.evaluate(() => {
    const s = state.settings;
    return [s.audioChunkSec, s.audioSilenceCut, s.audioChunkMaxSec, s.audioMinChunkBytes, s.audioBitrate];
  });

  console.log('■ 名前と並び（やっさんの指定）');
  eq('Web Speech の欄の名前（v0.24.49）', await page.evaluate(() => {
    const t = document.getElementById('settings-modal').textContent;
    return t.includes('Web Speech チャンク長（秒）') && !t.includes('6（既定）') && t.includes('字幕用設定（開発中）');
  }), true);
  eq('見出しと欄の名前', await page.evaluate(() => {
    const t = document.getElementById('settings-modal').textContent;
    return ['音声チャンク', 'チャンク長（秒）', '無音の切れ目で送信', '最長待ち時間（秒）', '音声送信しきい値（バイト）', '音質（kbps）', '既定値に戻す']
      .every((w) => t.includes(w));
  }), true);

  console.log('■ 既定値に戻す');
  eq('押す前は保存した値', await form(), ['30', false, '45', '1000', '128000']);
  await page.click('#btn-chunk-defaults');
  eq('押すと欄が既定値になる', await form(), ['12', true, '20', '400', '64000']);
  eq('保存を押すまでは設定は変わらない', await saved(), [30, false, 45, 1000, 128000]);
  await page.evaluate(() => saveSettingsFromForm());
  await page.waitForTimeout(200);
  eq('保存すると既定値になる', await saved(), [12, true, 20, 400, 64000]);

  console.log('■ ライブ整形のタイミング: 黙るのを待たず、設定した秒数で送る（v0.24.49）');
  {
    // やっさん「無音ではなく設定した秒数で送信するよう変更」。以前は聞き取るたびに掛け直していたので、
    // 話し続けている間はいつまでも送られなかった
    const r = await page.evaluate(async () => {
      state.settings.silenceSec = 1;
      const sent = [];
      const orig = window.flushPendingToGemini;
      window.flushPendingToGemini = () => { sent.push(Date.now()); };
      const t0 = Date.now();
      // 0.2秒ごとに聞き取りが続く（話し続けている）状態を 1.6 秒
      for (let i = 0; i < 8; i++) { resetSilenceTimer(); await new Promise(res => setTimeout(res, 200)); }
      await new Promise(res => setTimeout(res, 300));
      window.flushPendingToGemini = orig;
      return sent.map(x => x - t0);
    });
    eq('話し続けていても1秒前後で1回送る', r.length >= 1 && r[0] >= 900 && r[0] < 1400, true);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
