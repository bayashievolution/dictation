// Notion 保存の進み具合を出す小窓（v0.24.33）を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-notion-float-browser.js
//
// やっさん「notion に追記しているとき、バックグラウンドで作業できるようにしてほしい。
// モーダルをもう少し小さく、アプリ内で動かせるようにすると、録音中のタブで作業ができるかも」。
//
// 本物の Notion には繋がない（ブラウザ版からは CORS で届かない）。保存の本体ではなく、
// 小窓を開く・動かす・閉じる関数を直接呼び、**その間にほかの操作ができるか**を見る。
// ドラッグの登録は起動時に走る行なので、実際につかんで動かす（CLAUDE.md）。
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
  const ctx = await browser.newContext({ viewport: { width: 520, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('dictation:sessions', JSON.stringify([
      { id: 'A', title: '講義A', transcript: '<div class="paragraph">A</div>', memo: '', summary: '', chat: [] },
      { id: 'B', title: '講義B（録音中のつもり）', transcript: '', memo: '', summary: '', chat: [] },
    ]));
    localStorage.setItem('dictation:activeTab', 'A');
  });
  await page.goto(URL);
  await page.waitForTimeout(800);

  console.log('■ 開いても、後ろの操作を止めない');
  await page.evaluate(() => notionProgressOpen('Notion に追記中…', { cancellable: false }));
  await page.waitForTimeout(200);
  const box = await page.locator('#notion-progress').boundingBox();
  eq('右下に小さく出る（幅 320px 以下・下半分）', [box.width <= 320, box.y > 820 / 2], [true, true]);
  eq('後ろを暗くする幕が無い', await page.evaluate(() => !document.querySelector('#notion-progress .modal-backdrop')), true);
  // 開いたまま、別のタブに移ってメモを打つ
  await page.evaluate(() => switchSession('B'));
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.inner-tab')).find(b => b.textContent.indexOf('メモ') >= 0);
    if (t) t.click();
  });
  await page.waitForTimeout(200);
  await page.click('#memo');
  await page.keyboard.type('保存中でも打てる');
  eq('別のタブでメモを打てる', (await page.textContent('#memo')).includes('保存中でも打てる'), true);
  eq('小窓は出たまま', await page.evaluate(() => !els.notionProgress.classList.contains('hidden')), true);

  console.log('■ ヘッダーをつかんで動かせる（起動時の登録が効いている）');
  const h = await page.locator('.notion-float-header').boundingBox();
  await page.mouse.move(h.x + 40, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 10, h.y + h.height / 2 - 200, { steps: 8 });   // つかんだ点から上へ200・左へ30
  await page.mouse.up();
  const moved = await page.locator('#notion-progress').boundingBox();
  const h1 = await page.locator('.notion-float-header').boundingBox();
  // つかむ直前のヘッダーの位置（h）と比べる。開いたときの位置（box）とは、その後の操作で
  // 小窓の高さが変わる（下を基準に置いているので上端も動く）ので比べない
  eq('上へ 200px・左へ 30px 動く', [Math.round(h.y - h1.y), Math.round(h.x - h1.x)], [200, 30]);

  console.log('■ 次に開いたときも同じ場所');
  await page.evaluate(() => notionProgressClose());
  await page.evaluate(() => notionProgressOpen('Notion に保存中…', { cancellable: true }));
  await page.waitForTimeout(200);
  const again = await page.locator('#notion-progress').boundingBox();
  eq('動かした場所に出る', [Math.round(again.x), Math.round(again.y)], [Math.round(moved.x), Math.round(moved.y)]);

  console.log('■ 画面の外へは出ない');
  const h2 = await page.locator('.notion-float-header').boundingBox();
  await page.mouse.move(h2.x + 40, h2.y + 10);
  await page.mouse.down();
  await page.mouse.move(h2.x + 900, h2.y + 900, { steps: 8 });
  await page.mouse.up();
  const out = await page.locator('#notion-progress').boundingBox();
  eq('右下の端で止まる', [out.x + out.width <= 520, out.y + out.height <= 820], [true, true]);

  console.log('■ 終わったあとの「閉じる／残す」もこの小窓で押せる');
  await page.evaluate(() => {
    notionFinish({ results: [{ session: state.sessions.find(x => x.id === 'A'), ok: true }], cancelled: false, remaining: 0, verb: '追記' });
  });
  await page.waitForTimeout(150);
  eq('完了と聞き方', [await page.textContent('#notion-progress-title'), (await page.textContent('#notion-progress-body')).includes('タブを閉じますか')],
     ['Notion への追記が完了しました', true]);
  await page.click('#btn-notion-keep-tabs');
  await page.waitForTimeout(150);
  eq('「残す」で小窓が消える', await page.evaluate(() => els.notionProgress.classList.contains('hidden')), true);
  eq('タブは残っている', await page.evaluate(() => state.sessions.map(x => x.id)), ['A', 'B']);

  console.log('■ 何も書き足していなければ、これまでどおり閉じるかを聞く（開いているタブでも）');
  {
    const r = await page.evaluate(() => {
      switchSession('A');
      snapshotActiveToSession();
      const A = state.sessions.find(x => x.id === 'A');
      const sentSig = sessionContentSig(A);
      notionProgressOpen('Notion に保存中…', { cancellable: false });
      notionFinish({ results: [{ session: A, ok: true, sentSig }], cancelled: false, remaining: 0, verb: '保存' });
      return { closeShown: !els.btnNotionCloseTabs.hidden, body: els.notionProgressBody.textContent };
    });
    eq('閉じるボタンが出る（画面と保存の行き来で「変わった」と誤って判定しない）', r.closeShown, true);
    eq('書き足しの断りは出ない', r.body.includes('書き足され'), false);
    await page.evaluate(() => notionProgressClose());
  }

  console.log('■ 保存中に書き足したタブは、「閉じる」で消さない');
  {
    const r = await page.evaluate(() => {
      const A = state.sessions.find(x => x.id === 'A');
      const sentSig = sessionContentSig(A);
      // 保存中に、開いているタブ（A）のメモに書き足した（実際と同じく画面に書く）
      els.memo.insertAdjacentHTML('beforeend', '<div>保存中に書き足した</div>');
      notionProgressOpen('Notion に保存中…', { cancellable: false });
      notionFinish({ results: [{ session: A, ok: true, sentSig }], cancelled: false, remaining: 0, verb: '保存' });
      return {
        body: els.notionProgressBody.textContent,
        closeShown: !els.btnNotionCloseTabs.hidden,
        mark: A.notionUploadedAt,
      };
    });
    eq('閉じるかどうかを聞かない（閉じるボタンを出さない）', r.closeShown, false);
    eq('書き足したので残すと言う', r.body.includes('書き足されたので、閉じずに残します'), true);
    eq('アップ済みの印も外す（最新は上がっていない）', r.mark, null);
    await page.evaluate(() => notionProgressClose());
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
