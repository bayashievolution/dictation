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
    localStorage.setItem('dictation:settings', JSON.stringify({ inputMode: 'gemini-audio', apiKey: 'A', groqApiKey: 'g', transcribeEngine: 'groq', aiEnabled: true, confirmEffect: m, procEffect: m }));   // v0.24.133: 過程ごとに分かれたので、確かめる見せ方を処理と確定にそろえる
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
  eq('下書きのスタイルの既定は下線（v0.24.133・IME のように）', await page.evaluate(() => { els.interim.textContent = 'x'; return getComputedStyle(els.interim).textDecorationLine; }), 'underline');

  console.log('\n■ 設定（v0.24.133: 下書き・処理・確定の 3 つの過程）');
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(600);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.fx-stage')].map((r) => {
    // v0.24.135: 左がスタイル、右がエフェクト。名前の下に説明（小さい字）
    const sels = [...r.querySelectorAll('select')];
    const a = sels[0].getBoundingClientRect(), b = sels[1].getBoundingClientRect();
    const label = r.querySelector('.field-label');
    return { name: label.firstChild.textContent.trim(), hint: label.querySelector('.field-hint').textContent.trim(),
      oneLine: Math.round(a.top) === Math.round(b.top) && a.right <= b.left, order: sels.map((x) => /style/.test(x.id) ? 'style' : 'fx'),
      fx: [...sels[1].options].map((o) => o.textContent), st: [...sels[0].options].map((o) => o.textContent) };
  }));
  eq('過程の並び', rows.map((r) => r.name), ['下書き', '処理', '確定']);
  eq('説明（v0.24.135）', rows.map((r) => r.hint), ['初めに表示される文字のスタイル・演出', '処理過程で表示される文字のスタイル・演出', '確定時に表示される文字のスタイル・演出']);
  eq('スタイル（左）とエフェクト（右）を横に並べて 1 行に', rows.map((r) => [r.oneLine, r.order.join('/')]), Array(3).fill([true, 'style/fx']));
  eq('下書きのエフェクト', rows[0].fx, ['なし', 'フェードイン', 'ブラー', 'グロー']);
  eq('処理・確定のエフェクト', rows.slice(1).map((r) => r.fx), Array(2).fill(['なし', 'フェードイン', 'ブラー', 'タイプライター', 'アップデートグロー']));
  eq('スタイルは 3 つとも同じ選択肢', rows.map((r) => r.st), Array(3).fill(['なし', '下線', 'イタリック', 'ボールド']));
  eq('はじめの値（IME のように 下書き・処理は下線、確定はなし）', await page.evaluate(() => { const d = DEFAULT_SETTINGS; return [d.draftEffect, d.draftStyle, d.procEffect, d.procStyle, d.confirmEffect, d.finalStyle]; }),
    ['glow', 'underline', 'diff', 'underline', 'diff', 'none']);   // v0.24.141: 下書きの演出の既定はグロー

  console.log('\n■ プレビュー: 設定の欄で道が変わる（本番と同じ割り当て）');
  const steps = () => page.evaluate(() => fxPreviewSteps().map((x) => x.phase + ':' + (x.text.includes('、') ? (x.text.startsWith('えーと') ? 'Groq' : '整形') : 'WebSpeech')));
  eq('AI で聞き取る（Groq）＋ライブ整形オン: 処理 WebSpeech確定 → 処理 Groq → 確定 整形', await steps(), ['proc:WebSpeech', 'proc:Groq', 'final:整形']);
  await page.evaluate(() => { const b = document.getElementById('input-ai-enabled'); b.checked = false; b.dispatchEvent(new Event('change')); });
  eq('ライブ整形オフ: 処理 WebSpeech確定 → 確定 Groq', await steps(), ['proc:WebSpeech', 'final:Groq']);
  await page.evaluate(() => { const r = document.getElementById('mode-webspeech'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  eq('Web Speech だけ（整形オフ）: 確定 WebSpeech確定', await steps(), ['final:WebSpeech']);
  await page.evaluate(() => { const b = document.getElementById('input-ai-enabled'); b.checked = true; b.dispatchEvent(new Event('change')); });
  eq('Web Speech＋ライブ整形オン: 処理 WebSpeech確定 → 確定 整形', await steps(), ['proc:WebSpeech', 'final:整形']);
  await page.evaluate(() => { const r = document.getElementById('mode-gemini'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.evaluate(() => { const b = document.getElementById('input-gemini-live-display'); b.checked = false; b.dispatchEvent(new Event('change')); });
  eq('AI で聞き取る・Web Speech を並走させない＋整形オン: （文字起こし中…）→ 下書き Groq → 確定 整形', await page.evaluate(() => fxPreviewSteps().map((x) => x.phase)), ['wait', 'draft', 'final']);
  await page.evaluate(() => { const b = document.getElementById('input-ai-enabled'); b.checked = false; b.dispatchEvent(new Event('change')); });
  eq('並走させない＋整形オフ: （文字起こし中…）→ Groq が下書き＝確定（下書きの演出のあと確定の演出）', await page.evaluate(() => fxPreviewSteps().map((x) => x.phase)), ['wait', 'draftfinal']);
  await page.evaluate(() => { for (const id of ['input-gemini-live-display', 'input-ai-enabled']) { const b = document.getElementById(id); b.checked = true; b.dispatchEvent(new Event('change')); } });

  await page.evaluate(() => document.getElementById('fx-preview').scrollIntoView({ block: 'center' }));
  await page.selectOption('#input-draft-style', 'underline');
  await page.selectOption('#input-proc-style', 'bold');
  await page.selectOption('#input-proc-fx', 'diff');
  await page.selectOption('#input-confirm-fx', 'type');
  await page.selectOption('#input-final-style', 'italic');
  await page.waitForTimeout(700);
  eq('下書き: 下線', await page.evaluate(() => { const d = document.querySelector('#fx-preview .draft-text'); return d && getComputedStyle(d).textDecorationLine; }), 'underline');
  await page.waitForFunction(() => document.querySelector('#fx-preview .paragraph.ph-proc'), null, { timeout: 8000 }).catch(() => {});
  eq('処理: ボールド（下線は付かない）', await page.evaluate(() => { const c = getComputedStyle(document.querySelector('#fx-preview .paragraph .p-body')); return [c.fontWeight, c.textDecorationLine]; }), ['700', 'none']);
  await page.waitForFunction(() => document.querySelector('#fx-preview .paragraph.heard'), null, { timeout: 4000 }).catch(() => {});
  eq('処理（Groq の字）: 足された句読点だけ光る（アップデートグロー）', await page.evaluate(() => [...document.querySelectorAll('#fx-preview .fxc')].map((x) => x.textContent).join('')), '、。');
  await page.waitForFunction(() => document.querySelector('#fx-preview .paragraph.short-refined'), null, { timeout: 4000 }).catch(() => {});
  eq('確定: タイプライターで出て、イタリック', await page.evaluate(() => [document.querySelectorAll('#fx-preview .fxc').length > 10, getComputedStyle(document.querySelector('#fx-preview .paragraph .p-body')).fontStyle]), [true, 'italic']);
  eq('本番のスタイルは保存するまで変わらない', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--st-proc-fw').trim()), 'normal');
  await page.evaluate(() => saveSettingsFromForm());
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('dictation:settings')));
  eq('保存すると設定に入る', [st.draftStyle, st.procStyle, st.procEffect, st.confirmEffect, st.finalStyle], ['underline', 'bold', 'diff', 'type', 'italic']);
  eq('保存すると本番のスタイルも変わる', await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--st-proc-fw').trim()), '700');
  await page.evaluate(() => { openSettings(); expandAllSettingsSections(); });
  await page.waitForTimeout(400);
  await page.click('#btn-display-defaults');
  eq('既定値に戻す', await page.evaluate(() => ['input-draft-fx', 'input-draft-style', 'input-proc-style', 'input-proc-fx', 'input-confirm-fx', 'input-final-style'].map((id) => document.getElementById(id).value)), ['glow', 'underline', 'underline', 'diff', 'diff', 'none']);
  console.log('\n■ プレビューの再生・停止のボタン（v0.24.136・やっさん「プレビューが止まっていることがある」）');
  const btn = () => page.evaluate(() => { const b = document.getElementById('btn-fx-preview'); const r = b.getBoundingClientRect(), box = document.getElementById('fx-preview').getBoundingClientRect(); return { t: b.textContent, topLeft: r.left - box.left < 20 && r.top - box.top < 20 }; });
  await page.evaluate(() => document.getElementById('fx-preview').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(800);
  eq('見えると再生して、ボタンは「プレビュー ■」（枠の左上）', await btn(), { t: 'プレビュー ■', topLeft: true });
  await page.click('#btn-fx-preview');
  await page.waitForTimeout(300);
  const frozen = await page.evaluate(() => document.querySelector('#fx-preview .fx-preview-stage').innerHTML);
  await page.waitForTimeout(1500);
  eq('押すと止まり「プレビュー ▶」', [(await btn()).t, await page.evaluate(() => document.querySelector('#fx-preview .fx-preview-stage').innerHTML) === frozen], ['プレビュー ▶', true]);
  await page.waitForTimeout(1200);
  eq('止めたら、勝手には動き出さない', (await btn()).t, 'プレビュー ▶');
  await page.click('#btn-fx-preview');
  await page.waitForTimeout(300);
  eq('もう一度押すと再生', (await btn()).t, 'プレビュー ■');
  // 前の不具合: 表示のまとまりをたたんで開き直すと、前の字が残っていて二度と動かなかった
  await page.evaluate(() => { const h = document.getElementById('fx-preview').closest('.settings-acc').querySelector('.settings-acc-head'); h.click(); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const h = document.getElementById('fx-preview').closest('.settings-acc').querySelector('.settings-acc-head'); h.click(); });
  await page.waitForTimeout(1500);
  eq('たたんで開き直しても、また再生する', (await btn()).t, 'プレビュー ■');
  await page.click('#btn-fx-preview');
  await page.selectOption('#input-proc-fx', 'fade');
  await page.waitForTimeout(300);
  eq('止めていても、選ぶ欄を変えたら再生する', (await btn()).t, 'プレビュー ■');
  await page.evaluate(() => closeSettings());

  console.log('\n■ 本当の道（AI で聞き取る・Groq・整形オン）: Web Speech の字と Groq の字は処理、整形した字は確定');
  await page.evaluate(() => { state.settings.procStyle = 'underline'; state.settings.finalStyle = 'none'; applyStageStyles(); els.confirmed.innerHTML = '';
    window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), 'えーと今日は', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
  const deco = () => page.evaluate(() => getComputedStyle(document.querySelector('#confirmed .paragraph .p-body')).textDecorationLine);
  eq('区切った直後（Web Speech の字）は処理＝下線', await deco(), 'underline');
  await page.waitForFunction(() => document.querySelector('#confirmed .paragraph.heard'), null, { timeout: 4000 }).catch(() => {});
  eq('Groq の字も処理＝下線', await deco(), 'underline');
  await page.evaluate(() => window.__p);
  eq('整形した字は確定＝下線なし', await deco(), 'none');

  console.log('\n■ 本当の道（ライブ整形オフ）: Groq の字が確定');
  await page.evaluate(() => { state.sessions.forEach((x) => { delete x.opts; }); state.settings.aiEnabled = false; els.confirmed.innerHTML = '';
    window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), 'えーと今日は', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
  eq('区切った直後は処理＝下線', await deco(), 'underline');
  await page.evaluate(() => window.__p);
  eq('Groq の字は確定＝下線なし（ph-proc が外れる）', [await deco(), await page.evaluate(() => document.querySelector('#confirmed .paragraph').classList.contains('ph-proc'))], ['none', false]);

  console.log('\n■ 本当の道（Web Speech を並走させない・整形オン）: 「（文字起こし中…）」は過程の見た目なし、Groq の字は下書き、整形した字は確定');
  await page.evaluate(() => { state.sessions.forEach((x) => { delete x.opts; }); state.settings.aiEnabled = true; state.settings.draftStyle = 'italic'; applyStageStyles(); els.confirmed.innerHTML = '';
    window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
  eq('（文字起こし中…）には過程の見た目を付けない', await page.evaluate(() => [...document.querySelector('#confirmed .paragraph').classList].filter((c) => c.startsWith('ph-'))), []);
  await page.waitForFunction(() => document.querySelector('#confirmed .paragraph.heard'), null, { timeout: 4000 }).catch(() => {});
  const look = () => page.evaluate(() => { const p = document.querySelector('#confirmed .paragraph'); const c = getComputedStyle(p.querySelector('.p-body')); return [[...p.classList].filter((x) => x.startsWith('ph-')).join(''), c.fontStyle, c.textDecorationLine]; });
  eq('Groq の字は下書き（イタリック）', await look(), ['ph-draft', 'italic', 'none']);
  eq('途中で保存しても、過程の印は保存されない', await page.evaluate(() => savableHtml(els.confirmed.innerHTML).includes('ph-')), false);
  await page.evaluate(() => window.__p);
  eq('整形した字は確定（ふつう）', await look(), ['', 'normal', 'none']);

  console.log('\n■ 本当の道（Web Speech を並走させない・整形オフ）: Groq の字が下書き＝確定。下書きの演出のあと確定の演出');
  await page.evaluate(() => { state.sessions.forEach((x) => { delete x.opts; }); state.settings.aiEnabled = false; state.settings.draftEffect = 'fade'; state.settings.confirmEffect = 'type'; els.confirmed.innerHTML = '';
    window.__p = sendAudioChunkToGemini(new Blob(['x'.repeat(3000)], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000 }); });
  await page.evaluate(() => window.__p);
  eq('出た直後は下書き（イタリック）', await look(), ['ph-draft', 'italic', 'none']);
  await page.waitForFunction(() => !document.querySelector('#confirmed .paragraph.ph-draft'), null, { timeout: 4000 }).catch(() => {});
  eq('下書きの演出が終わると確定（ふつう）', await look(), ['', 'normal', 'none']);
  eq('続けて確定の演出（タイプライター）', await page.evaluate(() => document.querySelectorAll('#confirmed .fxc').length > 5), true);
  await page.waitForTimeout(2000);
  await page.evaluate(() => { state.settings.draftStyle = 'underline'; applyStageStyles(); });

  console.log('\n■ 本当の道（Web Speech だけ）: 整形が続かなければ確定、続くなら処理');
  await page.evaluate(() => { state.settings.inputMode = 'web-speech'; state.sessions.forEach((x) => { delete x.opts; }); state.settings.aiEnabled = false; els.confirmed.innerHTML = ''; appendRawChunk('今日は晴れです'); });
  eq('整形オフ: 確定した段落は確定＝下線なし', await deco(), 'none');
  await page.evaluate(() => { state.sessions.forEach((x) => { delete x.opts; }); state.settings.aiEnabled = true; els.confirmed.innerHTML = ''; appendRawChunk('今日は晴れですね本当にいい天気です'); });
  eq('整形オン: 確定した段落は処理＝下線', await deco(), 'underline');
  await page.waitForTimeout(1500);
  eq('整形した字は確定＝下線なし', await deco(), 'none');

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
