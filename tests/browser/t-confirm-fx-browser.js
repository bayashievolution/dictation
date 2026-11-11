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
    localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', transcribeEngine: 'groq', aiEnabled: true, confirmEffect: m, heardEffect: m, commitEffect: m }));   // v0.24.128: 段階ごとに分かれたので、確かめる見せ方を全部の段階にそろえる
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

  console.log('\n■ 設定（v0.24.128: 4 つの段階ごとにエフェクトとスタイル）');
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(600);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.fx-stage')].map((r) => {
    const sels = [...r.querySelectorAll('select')];
    const a = sels[0].getBoundingClientRect(), b = sels[1].getBoundingClientRect();
    return { name: r.querySelector('.field-label').textContent.trim(), ids: sels.map((x) => x.id), oneLine: Math.round(a.top) === Math.round(b.top) && a.right <= b.left,
      fx: [...sels[0].options].map((o) => o.textContent), st: [...sels[1].options].map((o) => o.textContent) };
  }));
  eq('段階の並び', rows.map((r) => r.name), ['WebSpeech下書き', 'WebSpeech確定', 'AI聞き取り', 'AI整形']);
  eq('エフェクトとスタイルを横に並べて 1 行に', rows.map((r) => r.oneLine), [true, true, true, true]);
  eq('下書きのエフェクト', rows[0].fx, ['なし', 'フェードイン', 'ブラー', 'グロー']);
  eq('確定・聞き取り・整形のエフェクト', rows.slice(1).map((r) => r.fx), Array(3).fill(['なし', 'フェードイン', 'ブラー', 'タイプライター', 'アップデートグロー']));
  eq('スタイルは 4 つとも同じ選択肢', rows.map((r) => r.st), Array(4).fill(['なし', '下線', 'イタリック', 'ボールド']));
  eq('はじめの値は前の見た目と同じ（下書き・確定・聞き取りはイタリック、整形の字はふつう）', await page.evaluate(() => { const d = DEFAULT_SETTINGS; return [d.draftEffect, d.draftStyle, d.commitEffect, d.commitStyle, d.heardEffect, d.heardStyle, d.confirmEffect, d.refineStyle]; }),
    ['fade', 'italic', 'none', 'italic', 'fade', 'italic', 'fade', 'none']);

  console.log('\n■ プレビュー: 4 つの段階を順に、欄の値のスタイルで');
  await page.evaluate(() => document.getElementById('fx-preview').scrollIntoView({ block: 'center' }));
  await page.selectOption('#input-draft-style', 'underline');
  await page.selectOption('#input-commit-style', 'bold');
  await page.selectOption('#input-heard-style', 'none');
  await page.selectOption('#input-heard-fx', 'diff');
  await page.selectOption('#input-confirm-fx', 'type');
  await page.waitForTimeout(700);
  eq('下書き: 下線', await page.evaluate(() => { const d = document.querySelector('#fx-preview .draft-text'); return d && getComputedStyle(d).textDecorationLine; }), 'underline');
  await page.waitForFunction(() => document.querySelector('#fx-preview .paragraph.provisional:not(.heard)'), null, { timeout: 8000 }).catch(() => {});
  eq('確定: ボールド（下線は付かない）', await page.evaluate(() => { const b = document.querySelector('#fx-preview .paragraph.provisional .p-body'); const c = getComputedStyle(b); return [c.fontWeight, c.textDecorationLine]; }), ['700', 'none']);
  await page.waitForFunction(() => document.querySelector('#fx-preview .paragraph.heard'), null, { timeout: 4000 }).catch(() => {});
  const heard = await page.evaluate(() => { const b = document.querySelector('#fx-preview .paragraph.heard .p-body'); const c = getComputedStyle(b); return { w: c.fontWeight, d: c.textDecorationLine, glow: [...document.querySelectorAll('#fx-preview .fxc')].map((s) => s.textContent).join('') }; });
  eq('聞き取り: スタイルなし・足された句読点だけ光る（アップデートグロー）', [heard.w, heard.d, heard.glow], ['400', 'none', '、。']);
  await page.waitForFunction(() => document.querySelector('#fx-preview .paragraph.short-refined'), null, { timeout: 4000 }).catch(() => {});
  eq('整形: タイプライターで出る', await page.evaluate(() => document.querySelectorAll('#fx-preview .fxc').length > 10), true);
  eq('本番のスタイルは保存するまで変わらない', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--st-commit-fw').trim()), 'normal');
  await page.evaluate(() => saveSettingsFromForm());
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:settings')));
  eq('保存すると設定に入る', [st.draftStyle, st.commitStyle, st.heardStyle, st.heardEffect, st.confirmEffect], ['underline', 'bold', 'none', 'diff', 'type']);
  eq('保存すると本番のスタイルも変わる', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--st-commit-fw').trim()), '700');
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(400);
  await page.click('#btn-display-defaults');
  eq('既定値に戻す', await page.evaluate(() => ['input-draft-style', 'input-commit-style', 'input-heard-fx', 'input-confirm-fx'].map((id) => document.getElementById(id).value)), ['italic', 'italic', 'fade', 'fade']);

  console.log('\n■ 本当の道: 段階ごとのスタイル（Groq の字は AI聞き取り、整形した字は AI整形）');
  await page.evaluate(() => { closeSettings && closeSettings(); state.settings.heardStyle = 'underline'; state.settings.refineStyle = 'none'; state.settings.commitStyle = 'italic'; applyStageStyles(); els.confirmed.innerHTML = '';
    window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), 'えーと今日は', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
  eq('区切った直後は WebSpeech確定（イタリック）', await page.evaluate(() => getComputedStyle(document.querySelector('#confirmed .paragraph .p-body')).fontStyle), 'italic');
  await page.waitForFunction(() => document.querySelector('#confirmed .paragraph.heard'), null, { timeout: 4000 }).catch(() => {});
  eq('Groq の字は AI聞き取り（下線・イタリックでない）', await page.evaluate(() => { const c = getComputedStyle(document.querySelector('#confirmed .paragraph.heard .p-body')); return [c.textDecorationLine, c.fontStyle]; }), ['underline', 'normal']);
  await page.evaluate(() => window.__p);
  eq('整形した字は AI整形（下線なし）', await page.evaluate(() => getComputedStyle(document.querySelector('#confirmed .paragraph.short-refined .p-body')).textDecorationLine), 'none');

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
