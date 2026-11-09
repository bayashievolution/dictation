// 設定の中で、唐突に出る・消えるものが無いか（v0.24.77）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-motion-settings-browser.js
//
// やっさん「設定モーダルの中 ClaudeCode連携をオンにして現れるメニューが唐突に出る　唐突に出る動きを徹底的にほかにないか調べてみて」。
//   - 「Claude Codeでの処理に失敗したらGemini APIで処理する」の行（連携をオンにすると出る）
//   - 「上の Claude Code 連携をオンにすると選べます」の断り書き（連携をオフにすると出る）
//   - 連携・Notion の横の状態（字の長さで折り返して、行の高さが変わる）
//   - スイッチのつまみ（ease で滑っていた）
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
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.route('**/api/claude/health', r => r.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ok: true, invocation: 'claude', version: '0.24.77', features: ['effort', 'timeout', 'session'], auth: { ok: true, loggedIn: true } }) }));
  await page.goto(URL);
  await page.evaluate(() => localStorage.setItem('dictation:settings', JSON.stringify({ apiKey: 'AIza-test', claudeCode: false })));
  await page.reload();
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await page.waitForTimeout(700);
  await page.evaluate(() => document.getElementById('input-claude-code').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);

  // 連携のトグルを押したあと、出る行・消える断り書き・その下の行の位置を毎フレーム取る
  const flip = () => page.evaluate(async () => {
    const row = document.getElementById('claude-fallback-row');
    const note = document.getElementById('live-summary-note');
    const below = document.getElementById('input-ai-enabled').closest('label');
    // v0.24.88: 連携をオンにすると、上の「AI 設定」でも連携のボタンがばねで出る。この行の動きだけを見るため、同じまとまりの見出しからの距離で測る
    const head = below.closest('.field-group').querySelector('.field-group-title');
    const h = (e) => (e.hidden ? 0 : e.offsetHeight);
    const f = [];
    document.getElementById('input-claude-code').click();
    for (let i = 0; i < 50; i++) {
      await new Promise(r => requestAnimationFrame(r));
      f.push({ row: h(row), note: h(note), below: Math.round(below.getBoundingClientRect().top - head.getBoundingClientRect().top), ro: Number(getComputedStyle(row).opacity) });
    }
    return { f, rowHidden: row.hidden, noteHidden: note.hidden, style: (row.getAttribute('style') || '') + (note.getAttribute('style') || '') };
  });

  console.log('■ Claude Code 連携をオンにする');
  {
    const r = await flip();
    const rows = r.f.map(x => x.row), end = rows[rows.length - 1];
    eq('「失敗したら Gemini で処理する」の行は、途中の高さを通って出る（一瞬で出ない）', [rows[0] < end, rows.some(x => x > 1 && x < end - 1)], [true, true]);
    eq('濃さも途中を通る', r.f.some(x => x.ro > 0.05 && x.ro < 0.95), true);
    const steps = r.f.slice(1).map((x, i) => Math.abs(x.below - r.f[i].below));
    eq('下の「ライブ整形」の行もすっと動き、どこかで大きく跳ばない（余白の分も含めて）', [Math.max(...steps) <= 12, steps.slice(-15).every(d => d <= 2)], [true, true]);
    eq('出きったら style に値を残さない', [r.rowHidden, r.style.replace(/\s/g, '')], [false, '']);
  }

  console.log('■ Claude Code 連携をオフにする');
  {
    const r = await flip();
    const notes = r.f.map(x => x.note), rows = r.f.map(x => x.row);
    eq('行は、途中の高さを通ってしまう', rows.some(x => x > 1 && x < rows[0] - 1), true);
    eq('「オンにすると選べます」の断り書きは、途中の高さを通って出る', notes.some(x => x > 1 && x < notes[notes.length - 1] - 1), true);
    const steps = r.f.slice(1).map((x, i) => Math.abs(x.below - r.f[i].below));
    eq('下の行もすっと動き、最後に跳ばない', steps.slice(-15).every(d => d <= 2), true);
    eq('しまいきったら隠れる', [r.rowHidden, r.noteHidden], [true, false]);
  }

  console.log('■ 設定を開いた直後は、動かさずにその状態');
  {
    const r = await page.evaluate(async () => {
      saveSettingsFromForm();
      await new Promise(r => setTimeout(r, 700));
      document.getElementById('btn-settings').click();
      await new Promise(r => requestAnimationFrame(r));
      const row = document.getElementById('claude-fallback-row');
      return { hidden: row.hidden, style: row.getAttribute('style') || '' };
    });
    eq('連携オフのまま開いたら、行は隠れたまま（伸び縮みしない）', [r.hidden, r.style], [true, '']);
  }

  console.log('■ 連携の横の状態が長くなって折り返すとき');
  {
    const r = await page.evaluate(async () => {
      const st = document.getElementById('claude-bridge-status');
      const row = st.closest('.field');
      st.textContent = '確認中…';
      await new Promise(r => setTimeout(r, 700));
      const h0 = row.offsetHeight;
      st.textContent = '使えます（ログイン済み / claude / 連携 0.24.77）。連携が古い版です。ライブ整形・ライブ要約を速くするため、「連携アプリをダウンロード」から入れ直してください';
      await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
      const mid = row.offsetHeight;
      await new Promise(r => setTimeout(r, 900));
      return { h0, mid, h1: row.offsetHeight, style: row.style.height };
    });
    eq('行の高さが途中を通って伸びる（一瞬で伸びない）', [r.h1 > r.h0, r.mid > r.h0 && r.mid < r.h1], [true, true]);
    eq('止まったら高さを書き込んだままにしない', r.style, '');
  }

  console.log('■ スイッチのつまみ');
  {
    // 1 つ目が transform（位置）、2 つ目が background（色。色の移り変わりは動きではないので ease のまま）
    const t = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById('input-claude-code'), '::before'); return [cs.transitionProperty, cs.transitionTimingFunction]; });
    eq('位置（transform）は ease ではなく、ばね（SPRINGS.press を解いた linear()）で動く', [t[0].split(',')[0].trim(), t[1].startsWith('linear(')], ['transform', true]);
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
