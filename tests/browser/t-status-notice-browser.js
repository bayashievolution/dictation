// 状態表示の「お知らせ」を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-status-notice-browser.js
//
// ■ なぜ実機が要るのか (v0.24.7)
//
// やっさんの要望:
// > このメッセージ長くてずっと出てるので、そのへんの表示にもこだわりたい
// > ダイナミックアイランドみたいなアニメーションで出て、しばらくしたら消える
// > ログを画面にずっとだすのはちょっとね　押したらエラーの詳細が出るとか
//
// 「出て、しばらくして消える」「押したら開く」「開いている間は消えない」は、
// どれも時間とクリックが絡むので、関数を単体で呼んでも確かめられない。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const snap = (page) => page.evaluate(() => {
  const el = els.status;
  const box = document.querySelector('.status-detail');
  return {
    文言: el.textContent,
    お知らせ中: el.classList.contains('error'),
    押せる: el.classList.contains('has-detail'),
    開いている: !!box,
    詳細: box ? box.textContent : null,
  };
});

async function open(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(URL);
  await page.waitForTimeout(800);
  return { ctx, page };
}

const DETAIL = 'Claude Code に回せませんでした（summary）\n\nError: Invalid API key · Please run /login';

(async () => {
  const browser = await chromium.launch();

  console.log('■ 出て、しばらくしたら消える');
  {
    const { ctx, page } = await open(browser);
    eq('最初は状態だけ', (await snap(page)).文言, '待機中');
    await page.evaluate((d) => statusNotice('error', 'Gemini で処理しました', { detail: d, ms: 1200 }), DETAIL);
    await page.waitForTimeout(150);
    const t1 = await snap(page);
    eq('お知らせが出る', { 文言: t1.文言, お知らせ中: t1.お知らせ中 },
       { 文言: 'Gemini で処理しました', お知らせ中: true });
    // v0.24.8: アニメーションは外した。停止・録音中と同じ出かたに揃える
    eq('動かない（他の表示と揃える）',
       await page.evaluate(() => {
         const c = els.status.className;
         return c.includes('is-entering') || c.includes('is-leaving');
       }), false);
    await page.waitForTimeout(500);
    eq('まだ出ている（0.65秒）', (await snap(page)).文言, 'Gemini で処理しました');
    await page.waitForTimeout(1300);
    const t2 = await snap(page);
    eq('しばらくしたら状態に戻る', { 文言: t2.文言, お知らせ中: t2.お知らせ中, 押せる: t2.押せる },
       { 文言: '停止', お知らせ中: false, 押せる: false });
    await ctx.close();
  }

  console.log('\n■ 押すと詳細が出る（画面に流しっぱなしにしない）');
  {
    const { ctx, page } = await open(browser);
    await page.evaluate((d) => statusNotice('error', 'Gemini で処理しました', { detail: d, ms: 1000 }), DETAIL);
    await page.waitForTimeout(150);
    eq('押せる印が付く', (await snap(page)).押せる, true);
    eq('長い理由は文言に出さない', (await snap(page)).文言.includes('Invalid API key'), false);
    await page.evaluate(() => els.status.click());
    await page.waitForTimeout(250);
    const o = await snap(page);
    eq('詳細が開く', o.開いている, true);
    eq('全文が読める', o.詳細.includes('Invalid API key') && o.詳細.includes('/login'), true);
    eq('診断ログの場所を添える', o.詳細.includes('診断ログ'), true);

    // ここが肝。読んでいる最中に消えると意味がない
    await page.waitForTimeout(1800);
    eq('開いている間は消えない', (await snap(page)).開いている, true);

    await page.evaluate(() => els.status.click());
    await page.waitForTimeout(400);
    const c = await snap(page);
    eq('もう一度押すと閉じて、状態に戻る', { 開いている: c.開いている, 文言: c.文言 },
       { 開いている: false, 文言: '停止' });
    await ctx.close();
  }

  console.log('\n■ 外を押しても閉じる');
  {
    const { ctx, page } = await open(browser);
    await page.evaluate((d) => statusNotice('error', '失敗', { detail: d, ms: 60000 }), DETAIL);
    await page.waitForTimeout(120);
    await page.evaluate(() => els.status.click());
    await page.waitForTimeout(200);
    eq('開いた', (await snap(page)).開いている, true);
    await page.evaluate(() => document.body.click());
    await page.waitForTimeout(400);
    eq('閉じて状態に戻る', (await snap(page)).文言, '停止');
    await ctx.close();
  }

  console.log('\n■ 詳細が無いお知らせは押せない（押せそうに見せない）');
  {
    const { ctx, page } = await open(browser);
    await page.evaluate(() => statusNotice('error', '詳細なし', { ms: 800 }));
    await page.waitForTimeout(120);
    eq('押せる印を付けない', (await snap(page)).押せる, false);
    await page.evaluate(() => els.status.click());
    await page.waitForTimeout(200);
    eq('押しても何も開かない', (await snap(page)).開いている, false);
    await ctx.close();
  }

  console.log('\n■ 状態（録音中など）は動かさない・消さない');
  // 動くのはお知らせだけ。録音中ずっと跳ねていたら気が散る
  {
    const { ctx, page } = await open(browser);
    await page.evaluate(() => { state.isRecording = true; state.settings.inputMode = 'gemini-audio'; restoreStatus(); });
    await page.waitForTimeout(100);
    eq('状態はそのまま出る', (await snap(page)).文言, '聞き取り中 (Gemini)');
    await page.waitForTimeout(1500);
    eq('時間が経っても消えない', (await snap(page)).文言, '聞き取り中 (Gemini)');
    await ctx.close();
  }

  console.log('\n■ お知らせのあと、録音中なら録音中に戻る（停止に戻さない）');
  {
    const { ctx, page } = await open(browser);
    await page.evaluate(() => { state.isRecording = true; state.settings.inputMode = 'gemini-audio'; });
    await page.evaluate(() => statusNotice('error', '一時的な失敗', { ms: 600 }));
    await page.waitForTimeout(1400);
    eq('録音中の表示に戻る', (await snap(page)).文言, '聞き取り中 (Gemini)');
    await ctx.close();
  }

  console.log('\n■ 同じお知らせが立て続けに来ても、出し直さない (v0.24.8)');
  // やっさん報告「claude のエラーが2回出る　１回目でて自動で閉じてまた出る」。
  // 録音を止めると要約とタイトルを続けて回すので、同じ文言が2回来る
  {
    const { ctx, page } = await open(browser);
    const seen = [];
    await page.evaluate(() => {
      window.__shown = [];
      const orig = window.setStatus;
      window.setStatus = (m, l, d) => { window.__shown.push(l); return orig(m, l, d); };
    });
    // 1回目の期限ぎりぎり（1.2秒のうち 1.0 秒時点）に2回目を出す。
    // 延びなければ 1.2 秒で消え、延びれば 2.2 秒まで残る。
    // 1.6 秒時点で見れば、どちらかは前後 0.4 秒の余裕をもって分かる
    const t0 = Date.now();
    await page.evaluate(() => statusNotice('error', '同じ失敗', { detail: 'A', ms: 1200 }));
    await page.waitForTimeout(1000 - (Date.now() - t0));
    await page.evaluate(() => statusNotice('error', '同じ失敗', { detail: 'A', ms: 1200 }));
    seen.push(...await page.evaluate(() => window.__shown));
    eq('2回目は出し直さない', seen.filter(x => x === '同じ失敗').length, 1);
    eq('ただし表示は続いている', (await snap(page)).文言, '同じ失敗');
    await page.waitForTimeout(Math.max(0, 1600 - (Date.now() - t0)));
    eq('2回目で時間が延びる（1.6秒時点）', (await snap(page)).文言, '同じ失敗');
    await page.waitForTimeout(Math.max(0, 2700 - (Date.now() - t0)));
    eq('その後は消える（2.7秒時点）', (await snap(page)).文言, '停止');

    // 違う文言ならちゃんと入れ替わる
    await page.evaluate(() => statusNotice('error', 'ひとつめ', { ms: 2000 }));
    await page.waitForTimeout(120);
    await page.evaluate(() => statusNotice('error', 'ふたつめ', { ms: 2000 }));
    await page.waitForTimeout(120);
    eq('違う内容は入れ替わる', (await snap(page)).文言, 'ふたつめ');
    await ctx.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
  process.exit(fail === 0 ? 0 : 1);
})();
