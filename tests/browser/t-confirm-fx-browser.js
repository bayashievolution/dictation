// 確定の演出（v0.24.119）を、本物の Chromium で本体を読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   node serve.js &
//   NODE_PATH=/opt/node22/lib/node_modules node tests/browser/t-confirm-fx-browser.js
//
// 見ること:
//   - 本当の道（sendAudioChunkToGemini → Groq → 整形）で、仮の字が入れ替わるときに演出がかかる（呼ぶ道に入っているか）
//   - 演出が終わると包み（span.fxc）が残らない／途中で保存しても包みが保存されない
//   - 「なし」なら包まない
//   - 設定の「表示」に選ぶ欄と見本があり、選ぶと見本が動く（起動時の登録が関数の中に入っていないか ── CLAUDE.md）
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
  await page.route('**/api.groq.com/**', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ text: '今日は家庭科室で火事が起きたらどうなるか考えてみます', segments: [{ text: '今日は家庭科室で火事が起きたらどうなるか考えてみます', no_speech_prob: 0, avg_logprob: -0.1 }] }) }));
  await page.route('**/generativelanguage.googleapis.com/**', async r => {
    await new Promise(res => setTimeout(res, 900));   // 整形は少しあとに返る（Groq の字の演出が見えるように）
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '今日は、家庭科室で火事が起きたらどうなるかを考えてみます。' }] }, finishReason: 'STOP' }] }) });
  });
  await page.goto(URL);
  const setMode = (m) => page.evaluate((m) => {
    localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', transcribeEngine: 'groq', aiEnabled: true, confirmEffect: m }));
  }, m);

  for (const mode of ['type', 'diff', 'fade', 'blur']) {
    console.log(`\n■ ${mode}`);
    await setMode(mode);
    await page.reload();
    await page.waitForTimeout(700);
    await page.evaluate(() => { window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), 'えーと今日はかていかしつで火事が', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
    // Groq の字に入れ替わった直後: 包みがあり、薄い字がある
    await page.waitForFunction(() => document.querySelector('#confirmed .paragraph .fxc'), null, { timeout: 4000 }).catch(() => {});
    const mid = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('#confirmed .fxc')];
      return { n: spans.length, faint: spans.some((s) => Number(getComputedStyle(s).opacity) < 0.99 || s.style.backgroundColor || s.style.filter), saved: savableHtml(els.confirmed.innerHTML).includes('fxc') };
    });
    eq('Groq の字に入れ替わるときに演出がかかる', [mid.n > 0, mid.faint], [true, true]);
    eq('途中で保存しても包みは保存されない', mid.saved, false);
    await page.evaluate(() => window.__p);
    if (mode === 'diff') {
      // 整形の字に入れ替わった直後は、足された句読点などだけが包まれる
      const marked = await page.evaluate(() => [...document.querySelectorAll('#confirmed .fxc')].map((s) => s.textContent).join(''));
      eq('整形の入れ替えでは、変わった字だけ光る（全部ではない）', marked.length > 0 && marked.length < 10, true);
    }
    await page.waitForTimeout(2200);
    const end = await page.evaluate(() => ({ n: document.querySelectorAll('#confirmed .fxc').length, text: document.querySelector('#confirmed .paragraph').textContent, cls: document.querySelector('#confirmed .paragraph').className }));
    eq('終わると包みが残らず、整形の字になる', [end.n, end.text, end.cls], [0, '今日は、家庭科室で火事が起きたらどうなるかを考えてみます。', 'paragraph short-refined']);
  }

  console.log('\n■ なし');
  await setMode('none');
  await page.reload();
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), '仮の字です', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
  let seen = 0;
  for (let i = 0; i < 20; i++) { seen += await page.evaluate(() => document.querySelectorAll('#confirmed .fxc').length); await page.waitForTimeout(100); }
  await page.evaluate(() => window.__p);
  eq('「なし」なら包まない', seen, 0);

  console.log('\n■ 下書き（v0.24.120）');
  await page.evaluate(() => { state.settings.draftEffect = 'fade'; });
  await page.evaluate(() => { ConfirmFx.renderDraft(els.interim, '今日は', 'fade'); ConfirmFx.renderDraft(els.interim, '今日は家庭', 'fade'); });
  eq('増えた字だけ足す（前の字は包み直さない）', await page.evaluate(() => [...els.interim.children].map((c) => c.textContent)), ['今日は', '家庭']);
  await page.evaluate(() => ConfirmFx.renderDraft(els.interim, '今日は火事', 'fade'));
  eq('言い直したらそこから足し直す', await page.evaluate(() => [els.interim.textContent, [...els.interim.children].map((c) => c.textContent)]), ['今日は火事', ['今日は', '火事']]);
  eq('アニメーションの曲線はばね（linear()）', await page.evaluate(() => getComputedStyle(els.interim.lastElementChild).animationTimingFunction.startsWith('linear(')), true);
  await page.evaluate(() => ConfirmFx.renderDraft(els.interim, '', 'fade'));
  eq('空にすると空', await page.evaluate(() => els.interim.innerHTML), '');
  eq('スタイルの既定はイタリック', await page.evaluate(() => { els.interim.textContent = 'x'; return getComputedStyle(els.interim).fontStyle; }), 'italic');

  console.log('\n■ 設定（v0.24.120 の並び）');
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(600);
  eq('並び: 文字起こしエフェクト・Web Speech の下書き（エフェクト・スタイル）・AI 整形・プレビュー・既定値に戻す', await page.evaluate(() => {
    const body = document.getElementById('fx-preview').closest('.settings-acc-body');
    const out = [];
    let on = false;
    for (const n of body.children) {
      const t = (n.querySelector(':scope > .field-label') || n).textContent.trim();
      if (t === '文字起こしエフェクト') on = true;
      if (on) out.push(n.tagName === 'DIV' && n.querySelector('#btn-display-defaults') ? '既定値に戻す' : t.split('\n')[0]);
    }
    return out;
  }), ['文字起こしエフェクト', 'Web Speech の下書き', 'エフェクト', 'スタイル', 'AI 整形', 'プレビュー', '既定値に戻す']);
  eq('エフェクトの選択肢', await page.$$eval('#input-draft-fx option', (o) => o.map((x) => x.textContent)), ['なし', 'フェードイン', 'ぼかしから', '光ってから落ち着く']);
  eq('スタイルの選択肢', await page.$$eval('#input-draft-style option', (o) => o.map((x) => x.textContent)), ['なし', 'イタリック', '下線']);
  eq('AI 整形の選択肢', await page.$$eval('#input-confirm-fx option', (o) => o.map((x) => x.textContent)), ['なし', 'ふわっと', '一文字ずつ流れる', 'ぼかしが晴れる', '直ったところが光る']);
  eq('「確定の演出」の字は無い', await page.evaluate(() => document.getElementById('settings-modal').textContent.includes('確定の演出')), false);
  await page.evaluate(() => document.getElementById('fx-preview').scrollIntoView({ block: 'center' }));
  await page.selectOption('#input-draft-style', 'underline');
  await page.selectOption('#input-confirm-fx', 'type');
  await page.waitForTimeout(800);
  const pv = await page.evaluate(() => { const d = document.querySelector('#fx-preview .draft-text'); return d && { spans: d.children.length, deco: getComputedStyle(d).textDecorationLine, style: getComputedStyle(d).fontStyle }; });
  eq('プレビューが見えると下書きが流れ出す（欄の値＝下線で）', pv && [pv.spans > 0, pv.deco, pv.style], [true, 'underline', 'normal']);
  await page.waitForFunction(() => document.querySelector('#fx-preview .paragraph.provisional'), null, { timeout: 8000 }).catch(() => {});
  eq('仮の段落になる', await page.evaluate(() => !!document.querySelector('#fx-preview .paragraph.provisional')), true);
  await page.waitForFunction(() => document.querySelector('#fx-preview .fxc'), null, { timeout: 4000 }).catch(() => {});
  eq('AI 整形の字に、選んだ見せ方で入れ替わる', await page.evaluate(() => document.querySelectorAll('#fx-preview .fxc').length > 10), true);
  eq('本番のスタイルは保存するまで変わらない', await page.evaluate(() => document.documentElement.dataset.draftStyle), 'italic');
  await page.evaluate(() => saveSettingsFromForm());
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:settings')));
  eq('保存すると設定に入る', [st.confirmEffect, st.draftStyle, st.draftEffect], ['type', 'underline', 'fade']);
  eq('保存すると本番のスタイルも下線に', await page.evaluate(() => document.documentElement.dataset.draftStyle), 'underline');
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(400);
  await page.click('#btn-display-defaults');
  eq('既定値に戻す', [await page.inputValue('#input-draft-fx'), await page.inputValue('#input-draft-style'), await page.inputValue('#input-confirm-fx')], ['fade', 'italic', 'fade']);

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
