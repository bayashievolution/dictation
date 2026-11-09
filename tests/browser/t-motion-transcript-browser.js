// 文字起こしの動き（v0.24.60・TODO「動きを SUMADO の仕様書に合わせる」の 1）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-transcript-browser.js
//
// 見ること: 跳んでいたところが、途中の値を通って動くか（いきなり最後の値にならないか）。
// 止まったあとに style へ値が残らないか（保存される文字起こしの HTML を汚さないか）。
// Gemini は page.route で差し替える。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const wait = (page, ms) => page.waitForTimeout(ms);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 640 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  let reply = '';
  let delay = 0;
  await page.route('**/generativelanguage.googleapis.com/**', async r => {
    if (delay) await new Promise(res => setTimeout(res, delay));
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] }, finishReason: reply ? 'STOP' : '' }] }) });
  });
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'AIza-test', aiEnabled: false, inputMode: 'gemini-audio' })));
  await page.reload();
  await wait(page, 800);
  // 画面より長い文字起こしを入れて、一番下に張りつかせる
  await page.evaluate(() => {
    for (let i = 0; i < 12; i++) {
      const p = document.createElement('div'); p.className = 'paragraph refined';
      p.innerHTML = `<div class="p-body">${i}番目の段落です。${'講義の内容が続きます。'.repeat(6)}</div>`;
      els.confirmed.appendChild(p);
    }
    snapshotActiveToSession();
    autoScroll(true, { instant: true });
    state.isRecording = true;
  });
  await wait(page, 300);
  const scrollGap = () => page.evaluate(() => { const p = els.paneTranscriptBody; return Math.round(p.scrollHeight - p.clientHeight - p.scrollTop); });

  console.log('■ 自動スクロールはばねで（いきなり最下部へ飛ばない）');
  {
    reply = '新しく聞き取った文です。'.repeat(12);
    delay = 0;
    const samples = await page.evaluate(async () => {
      const p = els.paneTranscriptBody;
      const out = [];
      sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', null);
      for (let i = 0; i < 10; i++) { await new Promise(r => requestAnimationFrame(r)); out.push(Math.round(p.scrollHeight - p.clientHeight - p.scrollTop)); }
      return out;
    });
    eq('最下部へ近づいていく途中の値がある（1フレームで 0 にならない）', samples.some(v => v > 2), true);
    await wait(page, 900);
    eq('最後は最下部に着く', await scrollGap() <= 1, true);
    eq('自動スクロールの途中に「上へ戻した」と勘違いしていない', await page.evaluate(() => state.userScrolledUp), false);
  }

  console.log('■ 仮の段落が消えるとき（相づちだけ・沈黙だけ）、ふわっと消えて、上が跳ばない');
  {
    reply = '';   // 沈黙だけのチャンク → 仮の段落を消す
    delay = 300;
    const r = await page.evaluate(async () => {
      const done = sendAudioChunkToGemini(new Blob(['x'], { type: 'audio/webm' }), '', { startsAtSilence: true, endsAtSilence: true, durationMs: 12000, hadSpeech: false });
      await new Promise(r => setTimeout(r, 1200));   // 仮の段落が出て、最下部まで流れきる
      const last = Array.from(els.confirmed.children).slice(-2, -1)[0];   // 仮の段落の1つ上
      const before = last.getBoundingClientRect().top;
      await done;
      const ghost = Array.from(document.body.children).find(e => e.getAttribute('aria-hidden') === 'true' && /文字起こし中/.test(e.textContent));
      const afterTop = last.getBoundingClientRect().top;
      const t = last.style.transform;
      await new Promise(r => setTimeout(r, 900));
      return {
        removed: !Array.from(els.confirmed.children).some(e => /文字起こし中/.test(e.textContent)),
        ghostThen: !!ghost,
        ghostGone: !Array.from(document.body.children).some(e => e.getAttribute('aria-hidden') === 'true' && /文字起こし中/.test(e.textContent)),
        jumpedNoMore: Math.abs(afterTop - before) < 1 || /translate3d/.test(t),
        styleLeft: last.getAttribute('style') || '',
        saved: getActiveSession().transcript.includes('文字起こし中'),
      };
    });
    eq('本物の仮の段落はすぐ消える（保存にも入らない）', [r.removed, r.saved], [true, false]);
    eq('写しを置いて、ふわっと消す', r.ghostThen, true);
    eq('写しも最後は消える', r.ghostGone, true);
    eq('上の段落は、前の場所からばねで動く（一瞬で跳ばない）', r.jumpedNoMore, true);
    eq('止まったら style に値を残さない', r.styleLeft, '');
  }

  console.log('■ 段落がまとまる・差し替わるとき、下の段落が跳ばない');
  {
    const r = await page.evaluate(async () => {
      const ps = Array.from(els.confirmed.children);
      const a = ps[ps.length - 4], b = ps[ps.length - 3];
      // まとめる段落を画面の上の端に置く（その下の見えている段落が、詰まって上へずれる形）
      state.userScrolledUp = true;
      els.paneTranscriptBody.scrollTop += a.getBoundingClientRect().top - els.paneTranscriptBody.getBoundingClientRect().top;
      await new Promise(r => setTimeout(r, 100));
      // 画面に見えている段落だけ（画面の外は動かさない。見えないので跳んでも分からず、全部測ると重い）
      const view = els.paneTranscriptBody.getBoundingClientRect();
      const others = ps.filter(x => x !== a && x !== b).filter(x => { const r = x.getBoundingClientRect(); return r.bottom > view.top && r.top < view.bottom; });
      const before = new Map(others.map(x => [x, x.getBoundingClientRect().top]));
      // まとめる（a に b の文字を入れて、b を消す）＝ consolidateShortChunks と同じ形。
      // 一番下に張りついていると、縮んだ分だけスクロールが詰められ、上の段落が下へずれる
      transcriptMorph(() => {
        a.querySelector('.p-body').textContent += b.textContent;
        b.remove();
      });
      const sameSpot = others.every(x => Math.abs(x.getBoundingClientRect().top - before.get(x)) < 1);
      const moving = others.filter(x => /translate3d/.test(x.style.transform)).length;
      await new Promise(r => setTimeout(r, 900));
      return { sameSpot, moving, style: others.map(x => x.getAttribute('style') || '').join('') };
    });
    eq('差し替えた直後は、どの段落も前の場所に見えている', r.sameSpot, true);
    eq('ずれた段落は、そこからばねで動いている', r.moving > 0, true);
    eq('止まったら style に値を残さない', r.style, '');
  }

  console.log('■ 下書き（#interim）の高さもばねで');
  {
    const r = await page.evaluate(async () => {
      els.interim.textContent = '聞き取り中の文です。'.repeat(8);
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
      const mid = els.interim.offsetHeight;
      await new Promise(r => setTimeout(r, 900));
      const full = els.interim.offsetHeight;
      els.interim.textContent = '';
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
      const mid2 = els.interim.offsetHeight;
      await new Promise(r => setTimeout(r, 900));
      return { mid, full, mid2, end: els.interim.offsetHeight, style: els.interim.getAttribute('style') || '' };
    });
    eq('出るとき、途中の高さを通る', r.mid > 0 && r.mid < r.full, true);
    eq('消えるとき、途中の高さを通る', r.mid2 > 0 && r.mid2 < r.full, true);
    eq('空なら高さ 0（前の display:none と同じく場所を取らない）', r.end, 0);
    eq('止まったら style に値を残さない', r.style.replace(/\s/g, ''), '');
  }

  console.log('■ 人がスクロールしたら、ばねの自動スクロールはその場で止まる');
  {
    const r = await page.evaluate(async () => {
      const p = els.paneTranscriptBody;
      for (let i = 0; i < 3; i++) { const x = document.createElement('div'); x.className = 'paragraph'; x.textContent = '追加の段落。'.repeat(20); els.confirmed.appendChild(x); }
      autoScroll();
      await new Promise(r => requestAnimationFrame(r));
      p.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      p.scrollTop -= 300;
      await new Promise(r => setTimeout(r, 600));
      return { up: state.userScrolledUp, moving: transcriptScroll.moving };
    });
    eq('止まって、上へ戻したと分かる', [r.moving, r.up], [false, true]);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
