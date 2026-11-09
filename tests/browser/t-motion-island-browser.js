// 右上の状態の札を、SUMADO のダイナミックアイランドのように動かす（v0.24.69・TODO「動きを SUMADO の仕様書に合わせる」の 13）。
// 本物の Chromium で、毎フレームの幅・高さ・字の濃さを見る。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-island-browser.js
//
// 手本は SUMADO の「にゅっと出る・しまう」型（仕様書 2.3）:
//   出るとき「点 → 縦に伸びる → 横に伸びる」、中身は形ができてからふわっと。
//   大きさが変わるときは、伸びるなら横が先・縦が遅れて。中身は先にさっと消え、形ができてからふわっと出る。
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
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  // 立ち上がりを最初のフレームから記録する
  await page.addInitScript(() => {
    window.__frames = [];
    const rec = () => {
      const s = document.getElementById('status-indicator');
      const t = s && s.querySelector('.status-text');
      if (s) window.__frames.push({ w: s.getBoundingClientRect().width, h: s.getBoundingClientRect().height, to: t ? Number(getComputedStyle(t).opacity) : 1,
                                    island: s.classList.contains('island'), op: Number(getComputedStyle(s).opacity) });
      if (window.__frames.length < 120) requestAnimationFrame(rec);
    };
    requestAnimationFrame(rec);
  });
  await page.goto(URL);
  await page.waitForTimeout(1500);

  console.log('■ 立ち上がったとき（点 → 縦 → 横、字は形ができてから）');
  {
    const all = await page.evaluate(() => window.__frames);
    // アイランドになる前（スクリプトが動く前）の札は、隠してある（読み込んだ直後に一瞬大きく出ないように）
    eq('アイランドになる前の札は見えない', all.filter(x => !x.island).every(x => x.op === 0), true);
    const f = all.filter(x => x.island && x.w > 0);
    const end = f[f.length - 1];
    const firstTallIdx = f.findIndex(x => x.h > end.h * 0.8);
    const firstWideIdx = f.findIndex(x => x.w > end.w * 0.8);
    eq('はじめは点（幅も高さも小さい）', f[0].w < 12 && f[0].h < 12, true);
    eq('縦が先に伸び、横はあとから', firstTallIdx >= 0 && firstWideIdx > firstTallIdx, true);
    eq('縦に伸びているあいだ、横は細いまま', f[firstTallIdx].w < end.w * 0.5, true);
    eq('字は、形が広がってからふわっと出る（細いうちは見えない）', f.filter(x => x.w < end.w * 0.5).every(x => x.to < 0.05), true);
    eq('最後は字が見えている', end.to > 0.99, true);
    eq('字は「待機中」のまま読める（textContent）', await page.evaluate(() => els.status.textContent), '待機中');
  }

  console.log('■ 字が変わるとき（いまの字が先に消え、形は横が先・縦が遅れて、新しい字は形ができてから）');
  {
    const r = await page.evaluate(async () => {
      const s = els.status, t = s.querySelector('.status-text');
      const w0 = s.getBoundingClientRect().width;
      setStatus('listening', '要約生成中（Claude）');
      const immediate = s.textContent;
      await Promise.resolve();
      // v0.24.82: 古い字は札の ::before（data-old-text）で消える。濃さは --old-o
      const before = () => getComputedStyle(s, '::before');
      const oldTextShown = s.dataset.oldText;
      const frames = [];
      for (let i = 0; i < 60; i++) {
        await new Promise(r => requestAnimationFrame(r));
        frames.push({ w: s.getBoundingClientRect().width, to: Number(getComputedStyle(t).opacity), go: s.dataset.oldText ? Number(before().opacity) : 0 });
      }
      await new Promise(r => setTimeout(r, 400));
      const keepW = s.style.width; s.style.width = '';
      const natural = s.getBoundingClientRect().width; s.style.width = keepW;
      return { w0, immediate, oldTextShown, frames, end: s.getBoundingClientRect().width, natural, gone: !s.dataset.oldText, tc: s.textContent };
    });
    const f = r.frames;
    eq('字はすぐ入れ替わる（「同じお知らせか」の判定が古い字を読まない）', r.immediate, '要約生成中（Claude）');
    eq('古い字は札の中（::before）で消える。札の textContent には混ざらない', [r.oldTextShown, r.tc], ['待機中', '要約生成中（Claude）']);
    eq('古い字は先にさっと消える（新しい字が出はじめる前に、ほぼ消えている）', f.findIndex(x => x.go < 0.1) < f.findIndex(x => x.to > 0.3), true);
    eq('幅は途中を通って伸びる', f.some(x => x.w > r.w0 + 2 && x.w < r.end - 2), true);
    eq('最後は新しい字の大きさ', Math.abs(r.end - r.natural) < 1.5, true);
    eq('古い字は消え終わったら外れる', r.gone, true);
  }
  // v0.24.82: やっさん報告「閉じるときに、文字が枠を飛び出して右にすっ飛んでいく」（聞き取り中 → 停止のように縮むとき）。
  // 古い字を、入れ替えたあとの新しい字の場所に置いていて右にずれ、さらに札の外に置いていたので、札が縮むと右へ流れていった
  console.log('■ 縮むとき、古い字はもとの場所のまま、札の中で消える');
  {
    const r = await page.evaluate(async () => {
      const s = els.status, t = s.querySelector('.status-text');
      setStatus('listening', '聞き取り中 (Gemini)');
      await new Promise(r => setTimeout(r, 1000));
      const oldRight = t.getBoundingClientRect().right;
      const right0 = s.getBoundingClientRect().right;
      setStatus('idle', '停止');
      await Promise.resolve();
      const z = parseFloat(document.documentElement.style.zoom) || 1;
      const placed = s.getBoundingClientRect().right - parseFloat(s.style.getPropertyValue('--old-right')) * z;
      const rights = [];
      for (let i = 0; i < 20; i++) { await new Promise(r => requestAnimationFrame(r)); rights.push(s.getBoundingClientRect().right); }
      return { oldRight, placed, right0, rights, clip: getComputedStyle(s).overflow };
    });
    eq('古い字は、入れ替える前にあった場所に置かれる（右にずれない）', Math.abs(r.placed - r.oldRight) < 1, true);
    eq('札の右の端は動かない（古い字は右の端から置いてあるので、一緒に流れない）', r.rights.every(x => Math.abs(x - r.right0) < 1), true);
    eq('札の外にはみ出したところは切れる（札の中で消える）', r.clip, 'hidden');
  }
  {
    const r = await page.evaluate(async () => {
      const s = els.status;
      const w0 = s.getBoundingClientRect().width;
      setStatus('idle', '停止');
      const frames = [];
      for (let i = 0; i < 60; i++) { await new Promise(r => requestAnimationFrame(r)); frames.push(s.getBoundingClientRect().width); }
      const keepW = s.style.width; s.style.width = '';
      const natural = s.getBoundingClientRect().width; s.style.width = keepW;
      return { w0, frames, natural };
    });
    eq('縮むときは、一瞬行き過ぎて（新しい大きさより細くなって）戻る', Math.min(...r.frames) < r.natural - 0.5, true);
    eq('最後は新しい字の大きさ', Math.abs(r.frames[r.frames.length - 1] - r.natural) < 1, true);
  }

  console.log('■ 押すと詳細が出るお知らせ（右に › が付いて広がる）');
  {
    const r = await page.evaluate(async () => {
      statusNotice('error', 'Gemini で処理しました', { detail: '理由', ms: 60000 });
      await new Promise(r => setTimeout(r, 900));
      const s = els.status;
      const keepW = s.style.width; s.style.width = '';
      const natural = s.getBoundingClientRect().width; s.style.width = keepW;
      const arrow = getComputedStyle(s, '::after').content;
      return { w: s.getBoundingClientRect().width, natural, arrow, hasDetail: s.classList.contains('has-detail'), island: s.classList.contains('island') };
    });
    eq('› の分も含めた大きさ（クラスを付けたあとで測っている）', [r.hasDetail, Math.abs(r.w - r.natural) < 1.5, r.arrow.includes('›')], [true, true, true]);
    eq('setStatus のたびに class を書き直しても、アイランドの印は残る', r.island, true);
  }

  console.log('■ 見た目はディクテーションのまま');
  {
    const r = await page.evaluate(async () => {
      setStatus('idle', '停止');
      await new Promise(r => setTimeout(r, 900));
      const s = els.status;
      const cs = getComputedStyle(s);
      return { radius: parseFloat(cs.borderRadius) >= s.getBoundingClientRect().height / 2 - 0.5, fontSize: cs.fontSize, transition: cs.transitionProperty };
    });
    eq('カプセルの形のまま', r.radius, true);
    eq('字の大きさは 12px のまま', r.fontSize, '12px');
    eq('CSS の transition で大きさを動かしていない', /width|height|all/.test(r.transition), false);
  }

  // v0.24.76: やっさん報告（画像つき）「消えるときに文字が大きくなる」「表示しているとき、左右のマージンがなくなっている」。
  // 画面の拡大率（設定の 90% など）が 1 でないと、測った見た目の px と style に書く px がずれていた。
  // 消えていく古い字の写しは、Chrome が font（まとめた書き方）を空で返すので 16px になっていた
  console.log('■ 画面の拡大率が 90% のとき');
  {
    const p2 = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await p2.goto(URL);
    await p2.evaluate(() => { const s = JSON.parse(localStorage.getItem('dictation:settings') || '{}'); s.appZoom = 90; localStorage.setItem('dictation:settings', JSON.stringify(s)); });
    await p2.reload();
    await p2.waitForTimeout(1500);
    const r = await p2.evaluate(async () => {
      const s = els.status, t = s.querySelector('.status-text');
      setStatus('listening', '要約生成中（Claude）');
      await Promise.resolve();
      const b = getComputedStyle(s, '::before');
      const ghost = s.dataset.oldText ? { fs: b.fontSize, pad: b.paddingLeft, dx: 0 } : null;
      await new Promise(r => setTimeout(r, 1200));
      const tr = t.getBoundingClientRect(), sr = s.getBoundingClientRect();
      return { zoom: document.documentElement.style.zoom, ghost, fs: getComputedStyle(t).fontSize,
               cut: t.scrollWidth > t.clientWidth + 0.5, inside: tr.left >= sr.left - 0.5 && tr.right <= sr.right + 0.5,
               padL: getComputedStyle(t).paddingLeft };
    });
    eq('拡大率 90% で開いている', r.zoom, '0.9');
    eq('消えていく古い字は、札の字と同じ大きさ・同じ余白・同じ場所', [r.ghost && r.ghost.fs, r.ghost && r.ghost.pad, r.ghost && r.ghost.dx < 1], [r.fs, r.padL, true]);
    eq('出ている字は切れず、左右の余白も札の中に入っている', [r.cut, r.inside], [false, true]);
    await p2.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
