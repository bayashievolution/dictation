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

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
