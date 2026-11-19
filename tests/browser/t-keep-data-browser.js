// 「保持するデータの取り扱い」と、AI の動きへ移した「話者判別機能を有効にする」・話者判別の注意（v0.24.159）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-keep-data-browser.js
//
// やっさんの指定（2026-11-19・見本 https://claude.ai/artifact/33tWLTFoPZRr8ki8Fh6Btz ・ https://claude.ai/artifact/G4JsctL5SsohFH22ZCT8FD ）:
//   「録音の保持」→「保持するデータの取り扱い」（盾の絵）。「話者判別機能を有効にする」は「要約の詳しさ」の下へ。
//   Gemini が無いときは、名前の下にオレンジの一文（押せなくはしない）。話者判別のボタンはオレンジの ⚠、押すと自前の小窓
// 前の版（v0.24.158）に当てると落ちる
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
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
    page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
    const alerts = [];
    page.on('dialog', (d) => { alerts.push(d.message()); d.dismiss(); });
    await page.route(/generativelanguage\.googleapis\.com|api\.groq\.com/, r => r.fulfill({ contentType: 'application/json', body: '{"models":[],"data":[]}' }));
    await page.addInitScript((s) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('dictation:settings', JSON.stringify(s));
    }, settings);
    await page.goto(PAGE);
    await page.waitForTimeout(900);
    return { page, alerts };
  }
  const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.getBoundingClientRect().height > 2; }, sel);

  console.log('■ Gemini が無いとき');
  {
    const { page, alerts } = await open({ inputMode: 'gemini-audio', geminiEnabled: false, apiKey: '', groqEnabled: true, groqApiKey: 'g', autoSummarize: true, audioKeepRecording: true });
    eq('話者判別のボタンはオレンジの ⚠', await page.evaluate(() => [els.btnDiarize.classList.contains('no-ai'), !!els.btnDiarize.querySelector('[data-icon="sm-warn"]')]), [true, true]);
    await page.click('#btn-diarize');
    await page.waitForTimeout(400);
    eq('押すと自前の小窓（ブラウザの確認は出さない）', [alerts.length, await page.evaluate(() => [document.getElementById('confirm-title').textContent, document.getElementById('confirm-ok').textContent, !document.getElementById('confirm-dialog').classList.contains('hidden')])],
      [0, ['話者判別を使用できる AI がありません', 'AI 設定を開く', true]]);
    await page.click('#confirm-ok');
    await page.waitForTimeout(500);
    eq('［AI 設定を開く］で設定が開く', await page.evaluate(() => !els.settingsModal.classList.contains('hidden')), true);
    await page.evaluate(() => expandAllSettingsSections());
    await page.waitForTimeout(600);
    eq('まとまりの名前と絵', await page.evaluate(() => { const g = document.getElementById('keep-recording-group'); return [g.querySelector('.settings-acc-label').textContent, g.querySelector('.settings-acc-icon').dataset.icon]; }), ['保持するデータの取り扱い', 'sm-shield']);
    eq('まとまりの中に見出しの字（音声ファイル・タブ）は無い', await page.evaluate(() => [...document.querySelectorAll('#keep-recording-group .settings-sub-title')].length), 0);
    eq('話者判別のトグルは AI の動きの「要約の詳しさ」のすぐ下', await page.evaluate(() => {
      const t = document.getElementById('keep-toggle-fields');
      return [t.closest('.settings-acc').querySelector('.settings-acc-label').textContent, t.previousElementSibling.id];
    }), ['AI の動き', 'summary-detail-field']);
    eq('名前の下にオレンジの一文（押せなくはしない）', await page.evaluate(() => {
      const ng = document.querySelector('#keep-toggle-fields .keep-ai-ng');
      const c = getComputedStyle(ng).color, o = getComputedStyle(document.documentElement).getPropertyValue('--caution').trim();
      const hex = '#' + c.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
      return [!ng.hidden, ng.textContent, hex === o.toLowerCase(), els.inputKeepRecording.disabled];
    }), [true, 'API キーが登録されていないか、有効になっていません。話者判別には Gemini API のキーが必要です。', true, false]);
    eq('説明の文（ドライブの断りは外した）', await page.evaluate(() => document.querySelector('#keep-toggle-fields .keep-ai-ng').nextElementSibling.textContent), '話者判別機能が有効になり、それに伴い音声ファイルがこの PC の Chrome の中に一時保存されます。');
    await page.close();
  }

  console.log('\n■ Gemini があるとき・Web Speech モード');
  {
    let { page } = await open({ inputMode: 'gemini-audio', geminiEnabled: true, apiKey: 'A', autoSummarize: true });
    eq('ボタンはふだんの絵', await page.evaluate(() => [els.btnDiarize.classList.contains('no-ai'), !!els.btnDiarize.querySelector('[data-icon="users"]')]), [false, true]);
    await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
    await page.waitForTimeout(600);
    eq('オレンジの一文は出ない', await shown(page, '#keep-toggle-fields .keep-ai-ng'), false);
    await page.close();
    ({ page } = await open({ inputMode: 'web-speech', geminiEnabled: true, apiKey: 'A', autoSummarize: true }));
    await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
    await page.waitForTimeout(600);
    eq('Web Speech モードでは話者判別のトグルを出さない（録音が無い）', await shown(page, '#keep-toggle-fields'), false);
    await page.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
