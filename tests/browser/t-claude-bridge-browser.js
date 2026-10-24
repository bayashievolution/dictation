// Claude Code 連携の「配線」を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-claude-bridge-browser.js
//
// ■ なぜ実機が要るのか (v0.24.5)
//
// やっさん報告「接続を確認 を押しても何も起こらない」。原因は**3行が
// runDiarization() の中に紛れ込んでいた**ことで、起動時に走るはずの
//
//   sweepStoredImages();        v0.22.0 から
//   applyClaudeBridgeSetting(); v0.24.0 から
//   「接続を確認」の click 登録  v0.24.0 から
//
// が、話者判別を最後まで通したときにしか走っていなかった。
//
// **純関数のテストでは絶対に見つからない。** claude-bridge.js 側の純関数
// （tests/t-claude-bridge.js・35件）は全部通っていた。壊れていたのは
// 「誰がいつその関数を呼ぶか」のほうで、それはページを読み込まないと分からない。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const SETTINGS_KEY = 'dictation:settings';

async function open(browser, { useClaudeBridge = false, blockHealth = false } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  // 設定を先に置いてから読み込む（起動時に読まれるかを見たいので）
  await page.goto(URL);
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)),
                      [SETTINGS_KEY, { useClaudeBridge }]);
  if (blockHealth) await page.route('**/api/claude/health', r => r.abort());
  await page.reload();
  await page.waitForTimeout(900);
  return { ctx, page };
}

const status = (page) => page.evaluate(() => document.getElementById('claude-bridge-status').textContent);

(async () => {
  const browser = await chromium.launch();

  console.log('■ 「接続を確認」を押したときに文言が変わるか');
  {
    const { ctx, page } = await open(browser);
    eq('押す前は「未確認」', await status(page), '未確認');
    await page.evaluate(() => { document.getElementById('btn-settings').click(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { document.getElementById('btn-claude-bridge-test').click(); });
    await page.waitForTimeout(1200);
    const t = await status(page);
    eq('中継が動いていると出る', /中継は動いています/.test(t), true);
    eq('色が付く（is-ok）',
       await page.evaluate(() => document.getElementById('claude-bridge-status').className.includes('is-ok')), true);
    await ctx.close();
  }

  console.log('\n■ 中継に繋がらないときは、そう言う（黙らない）');
  {
    const { ctx, page } = await open(browser, { blockHealth: true });
    await page.evaluate(() => { document.getElementById('btn-settings').click(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { document.getElementById('btn-claude-bridge-test').click(); });
    await page.waitForTimeout(1500);
    const t = await status(page);
    eq('繋がらないと出る', /繋がりません/.test(t), true);
    eq('start.bat を案内する', /start\.bat/.test(t), true);
    eq('色が付く（is-ng）',
       await page.evaluate(() => document.getElementById('claude-bridge-status').className.includes('is-ng')), true);
    await ctx.close();
  }

  console.log('\n■ 保存した設定が、起動しただけで claude-bridge.js に渡るか');
  // ここが本丸。設定画面を開かなくても、読み込んだ時点で有効になっていないといけない
  {
    const { ctx, page } = await open(browser, { useClaudeBridge: true });
    eq('連携オンで保存 → 起動時点で有効',
       await page.evaluate(() => claudeBridgeIsEnabled()), true);
    // チェックボックスは openSettings() で埋める作りなので、開いてから見る
    await page.evaluate(() => { document.getElementById('btn-settings').click(); });
    await page.waitForTimeout(300);
    eq('設定を開けばチェックボックスにも入っている',
       await page.evaluate(() => document.getElementById('input-claude-bridge').checked), true);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, { useClaudeBridge: false });
    eq('連携オフで保存 → 起動時点で無効',
       await page.evaluate(() => claudeBridgeIsEnabled()), false);
    await ctx.close();
  }

  console.log('\n■ 起動時に走るべき掃除が走っているか');
  {
    const { ctx, page } = await open(browser);
    // sweepStoredImages() は非同期。走ってさえいれば IndexedDB を開く
    eq('画像の保管庫が開かれている（掃除が走った印）',
       await page.evaluate(async () => {
         const dbs = await indexedDB.databases();
         return dbs.some(d => /image/i.test(d.name || ''));
       }), true);
    await ctx.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
  process.exit(fail === 0 ? 0 : 1);
})();
