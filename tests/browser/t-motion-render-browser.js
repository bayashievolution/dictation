// 描き直したときに、全部が一斉に出直さないか（v0.24.71・TODO「動きを SUMADO の仕様書に合わせる」の 10）を、本物の Chromium で検査する。
//   - 質問の吹き出し: 送るたびに全部の吹き出しが出直していた → 新しいものだけ
//   - 文字起こしの段落: セッションを切り替えると全部の段落が出直していた → 新しい段落だけ
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-render-browser.js
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
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const paras = Array.from({ length: 6 }, (_, i) => `<div class="paragraph refined"><div class="p-body">${i}番目の段落</div></div>`).join('');
    localStorage.setItem('dictation:sessions', JSON.stringify([
      { id: 'A', title: 'A', transcript: paras, memo: '', summary: '', chat: [
        { role: 'user', content: '最初の質問' }, { role: 'assistant', content: '最初の答え', engine: 'gemini' } ] },
      { id: 'B', title: 'B', transcript: paras, memo: '', summary: '', chat: [
        { role: 'user', content: 'Bの質問' }, { role: 'assistant', content: 'Bの答え', engine: 'gemini' } ] },
    ]));
    localStorage.setItem('dictation:activeTab', 'A');
  });
  await page.goto(URL);
  await page.waitForTimeout(900);

  console.log('■ 質問の吹き出し');
  {
    await page.evaluate(() => switchInnerPane('pane-chat'));
    await page.waitForTimeout(600);
    const r = await page.evaluate(async () => {
      const s = getActiveSession();
      s.chat.push({ role: 'user', content: '2つ目の質問' }, { role: 'assistant', content: '', thinking: true });
      renderChat();
      await new Promise(r => requestAnimationFrame(r));
      const ops = Array.from(document.querySelectorAll('#chat-messages .chat-msg')).map(e => +Number(getComputedStyle(e).opacity).toFixed(2));
      const anims = Array.from(document.querySelectorAll('#chat-messages .chat-msg')).map(e => getComputedStyle(e).animationName);
      await new Promise(r => setTimeout(r, 700));
      // 「考え中」が答えに変わる
      s.chat[3] = { role: 'assistant', content: '2つ目の答え', engine: 'claude' };
      renderChat();
      await new Promise(r => requestAnimationFrame(r));
      const msgs = Array.from(document.querySelectorAll('#chat-messages .chat-msg'));
      const after = msgs.map(e => +Number(getComputedStyle(e).opacity).toFixed(2));
      const lastBody = +Number(getComputedStyle(msgs[3].querySelector('.chat-msg-body')).opacity).toFixed(2);
      await new Promise(r => setTimeout(r, 700));
      return { ops, anims, after, lastBody, style: msgs.map(e => e.getAttribute('style') || '').join('') };
    });
    eq('前からある吹き出しは出直さない（濃さ 1 のまま）', [r.ops[0], r.ops[1]], [1, 1]);
    eq('増えた吹き出しだけふわっと（途中の濃さ）', r.ops[2] < 1 && r.ops[3] < 1, true);
    eq('keyframes の動きは使っていない', r.anims.every(a => a === 'none'), true);
    eq('「考え中」が答えに変わったときは、吹き出しは出直さず、中身だけふわっと', [r.after.every(o => o === 1), r.lastBody < 1], [true, true]);
    eq('止まったら style に値を残さない', r.style, '');
  }
  {
    const r = await page.evaluate(async () => {
      switchSession('B');
      await new Promise(r => requestAnimationFrame(r));
      return Array.from(document.querySelectorAll('#chat-messages .chat-msg')).map(e => +Number(getComputedStyle(e).opacity).toFixed(2));
    });
    eq('セッションを切り替えたときは、動かさずにそのまま出す', r.every(o => o === 1), true);
  }

  console.log('■ 文字起こしの段落');
  {
    await page.evaluate(() => switchInnerPane('pane-transcript'));
    await page.waitForTimeout(600);
    const r = await page.evaluate(async () => {
      switchSession('A');
      await new Promise(r => requestAnimationFrame(r));
      const ps = Array.from(document.querySelectorAll('#confirmed .paragraph'));
      const loaded = ps.map(e => ({ o: +Number(getComputedStyle(e).opacity).toFixed(2), a: getComputedStyle(e).animationName }));
      const p = createParagraphEl('新しく聞き取った段落', 'paragraph short-refined');
      els.confirmed.appendChild(p);
      await new Promise(r => requestAnimationFrame(r));
      const added = +Number(getComputedStyle(p).opacity).toFixed(2);
      await new Promise(r => setTimeout(r, 700));
      // 整えた中身に差し替わる
      p.className = 'paragraph refined';
      setParagraphContent(p, '## 見出し\n整えた本文');
      await new Promise(r => requestAnimationFrame(r));
      const replaced = +Number(getComputedStyle(p).opacity).toFixed(2);
      const others = ps.map(e => +Number(getComputedStyle(e).opacity).toFixed(2));
      await new Promise(r => setTimeout(r, 700));
      return { loaded, added, replaced, others, end: +Number(getComputedStyle(p).opacity).toFixed(2), style: p.getAttribute('style') || '' };
    });
    eq('切り替えて描き直したとき、段落は出直さない（濃さ 1・keyframes なし）', r.loaded.every(x => x.o === 1 && x.a === 'none'), true);
    eq('新しい段落だけ、ふわっと出る', r.added < 1, true);
    eq('整えた中身に差し替わったときも、その段落だけふわっと', [r.replaced < 1, r.others.every(o => o === 1)], [true, true]);
    eq('止まったら濃さ 1・style に値を残さない', [r.end, r.style], [1, '']);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
