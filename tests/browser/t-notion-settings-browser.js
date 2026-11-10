// 設定の「Notion 連携」（v0.24.50）を、本物の Chromium にこのフォルダを**拡張として**読み込んで検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node tests/browser/t-notion-settings-browser.js
//   （serve.js は要らない）
//
// Notion の確認は拡張のページ（chrome-extension://）でしか動かない（ブラウザ版は CORS で届かない）ので、
// 拡張として開く。api.notion.com は context.route で差し替える（本物の Notion には繋がない）。
//
// ■ なぜ実機が要るのか
//
// 「立ち上げたときに自動で確かめる」は起動時に走る行で、最初は loadSettings() より前に書いてしまい、
// 設定が空のまま判断して一度も確かめない状態だった（CLAUDE.md「誰がいつ呼ぶか」）。
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.resolve(__dirname, '../..');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function launch() {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-notion-'));
  const ctx = await chromium.launchPersistentContext(udd, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`],
  });
  const calls = [];
  await ctx.route('https://api.notion.com/**', (r) => {
    const url = r.request().url();
    const auth = r.request().headers()['authorization'] || '';
    calls.push(url.replace('https://api.notion.com/v1', ''));
    if (!auth.includes('ntn_good')) {
      return r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'API token is invalid.' }) });
    }
    if (url.includes('/users/me')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ name: 'やっさんの連携' }) });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [
      { object: 'data_source', id: 'ds1', title: [{ plain_text: '講義ノート' }] },
    ], has_more: false }) });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(sw.url()).host;
  return { ctx, id, calls, udd };
}

async function openApp(ctx, id, settings, calls) {
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.evaluate((s) => { localStorage.setItem('dictation:settings', JSON.stringify(s)); }, settings);
  // 同じブラウザの中では前のケースの設定が残っている。数えるのは、新しい設定で立ち上げ直してから
  if (calls) calls.length = 0;
  await page.reload();
  await page.waitForTimeout(1200);
  return page;
}

const status = (page) => page.evaluate(() => document.getElementById('notion-test-result').textContent.trim());

(async () => {
  const { ctx, id, calls, udd } = await launch();

  console.log('■ 名前と並び（やっさんの指定）');
  {
    const page = await openApp(ctx, id, {});
    const r = await page.evaluate(() => {
      const g = document.getElementById('notion-settings-group');
      return {
        toggle: !!document.getElementById('input-notion-enabled'),
        noTestButton: !document.getElementById('btn-notion-test'),
        text: ['文字起こしや要約など全てのタブをNotionに送信します。', 'Notionコネクション',
               'アップロード時はこの保存先が最初から選ばれた状態で確認ダイアログが出ます。'].every((w) => g.textContent.includes(w)),
        longHintGone: !g.textContent.includes('インテグレーショントークン'),
        // v0.24.94: 「リセット」の字は、名前の左の赤い丸の × に（やっさんの指定）
        forgetChip: !!g.querySelector('#btn-notion-forget.clear-chip'),
      };
    });
    eq('トグルあり・接続テストのボタンなし・文言・長い説明は消えた', r, { toggle: true, noTestButton: true, text: true, longHintGone: true, forgetChip: true });
    await page.close();
  }

  console.log('■ 連携がオンなら、立ち上げたときに自動で確かめて横に出す');
  {
    const page = await openApp(ctx, id, { notionToken: 'ntn_good', notionEnabled: true }, calls);
    eq('設定を開かなくても、横に結果が出ている', await status(page), 'OK: やっさんの連携 — 保存先に使えるデータベース 1 件');
    eq('Notion に問い合わせた', calls.some((c) => c.startsWith('/users/me')), true);
    await page.close();
  }

  console.log('■ 前の版の設定（トグルが無い）: トークンがあればオンで引き継ぎ、確かめる');
  {
    const page = await openApp(ctx, id, { notionToken: 'ntn_good' });
    eq('オン', await page.evaluate(() => state.settings.notionEnabled), true);
    eq('確かめた', (await status(page)).startsWith('OK:'), true);
    await page.close();
  }

  console.log('■ 連携がオフなら確かめず、保存ボタンは押せない');
  {
    const page = await openApp(ctx, id, { notionToken: 'ntn_good', notionEnabled: false }, calls);
    eq('横は空・問い合わせていない', [await status(page), calls.length], ['', 0]);
    await page.evaluate(() => { const p = document.createElement('div'); p.className = 'paragraph'; p.textContent = 'x'; els.confirmed.appendChild(p); updateActionButtons(); });
    eq('上の Notion 保存ボタンは押せない', await page.evaluate(() => els.btnNotionUpload.disabled), true);

    console.log('■ 設定でオンにすると、その場で確かめる');
    await page.evaluate(() => { document.getElementById('btn-settings').click(); expandAllSettingsSections(); });   // v0.24.95 から詳細設定はたたんである
    await page.waitForTimeout(300);
    await page.click('#input-notion-enabled');
    await page.waitForTimeout(800);
    eq('オンにしたその場で結果が出る', (await status(page)).startsWith('OK:'), true);
    await page.evaluate(() => saveSettingsFromForm());
    await page.waitForTimeout(200);
    eq('保存すると保存ボタンが押せる', await page.evaluate(() => els.btnNotionUpload.disabled), false);

    console.log('■ アクセストークンを入れ直したら、確かめ直す');
    await page.evaluate(() => { document.getElementById('btn-settings').click(); expandAllSettingsSections(); });   // v0.24.95 から詳細設定はたたんである
    await page.waitForTimeout(300);
    await page.fill('#input-notion-token', 'ntn_bad');
    await page.evaluate(() => document.getElementById('input-notion-token').dispatchEvent(new Event('change')));
    await page.waitForTimeout(800);
    eq('間違ったトークンだと NG と出る', (await status(page)).startsWith('NG:'), true);

    console.log('■ オフにすると横の表示が消える（確かめている最中でも、あとから戻ってこない）');
    await page.fill('#input-notion-token', 'ntn_good');
    await page.evaluate(() => document.getElementById('input-notion-token').dispatchEvent(new Event('change')));
    await page.click('#input-notion-enabled');   // 確かめている最中にオフ
    await page.waitForTimeout(800);
    eq('空', await status(page), '');
    await page.close();
  }

  await ctx.close();
  fs.rmSync(udd, { recursive: true, force: true });
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
