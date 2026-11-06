// Claude 連携のインストール式（v0.24.21）の「配線」を、本物の Chromium で検査する。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node serve.js &
//   node tests/browser/t-claude-install-browser.js
//
// serve.js で配ったページには chrome.runtime が無い（＝ブラウザ版）。拡張として開いたときの
// 動きは、chrome.runtime（id / getManifest / sendNativeMessage）を差し替えて再現する。
// **本物の拡張として読み込んだり、本物のホストを登録したりはしていない**（Windows でしかできない）。
//
// ■ なぜ実機が要るのか
//
// 「インストーラーを保存」の登録と、拡張かブラウザ版かの出し分けは**起動時に走る行**。
// CLAUDE.md の「誰がいつ呼ぶか」の事故（関数の中に紛れ込む）を2回起こしているので、押して確かめる。
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8765/';
const ID = 'abcdefghijklmnopabcdefghijklmnop';

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

async function open(browser, { extension, nativeReply, nativeError, settings } = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  if (extension) {
    await page.addInitScript(([id, reply, err]) => {
      window.__native = [];
      window.chrome = window.chrome || {};
      window.chrome.runtime = {
        id,
        lastError: undefined,
        getManifest: () => ({ version: '9.9.9' }),
        sendNativeMessage(name, msg, cb) {
          window.__native.push([name, msg.type]);
          setTimeout(() => {
            this.lastError = err ? { message: err } : undefined;
            cb(err ? undefined : reply);
            this.lastError = undefined;
          }, 10);
        },
      };
    }, [ID, nativeReply || null, nativeError || '']);
  }
  if (settings) {
    await page.addInitScript((s) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('dictation:settings', JSON.stringify(s));
    }, settings);
  }
  await page.route('**/api/claude/**', r => r.abort());
  await page.route('**/api/claude', r => r.abort());
  await page.goto(URL);
  await page.waitForTimeout(800);
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await page.waitForTimeout(200);
  return { ctx, page };
}

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return !!el && el.offsetParent !== null;
}, sel);

(async () => {
  const browser = await chromium.launch();

  console.log('■ ブラウザ版（localhost）');
  {
    const { ctx, page } = await open(browser);
    eq('インストーラーのボタンは出ない（ウェブページは登録を使えない）', await visible(page, '#btn-claude-install'), false);
    eq('これまでどおり「中継用ファイルを保存」が出る', await visible(page, '#btn-save-bridge-files'), true);
    await ctx.close();
  }

  console.log('■ 拡張として開いたとき');
  {
    const { ctx, page } = await open(browser, { extension: true, nativeError: 'Specified native messaging host not found.' });
    eq('インストーラーのボタンが出る', await visible(page, '#btn-claude-install'), true);
    eq('start.bat 用のボタンは出ない', await visible(page, '#btn-save-bridge-files'), false);

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.click('#btn-claude-install'),
    ]);
    eq('保存されるファイル名', dl.suggestedFilename(), 'dictation-claude-setup.bat');
    const fs = require('fs');
    const bat = fs.readFileSync(await dl.path(), 'utf8');
    eq('中身にこの拡張の ID が入っている', bat.includes(`chrome-extension://${ID}/`), true);
    eq('Chrome の登録先に書く', bat.includes('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dictation.helper'), true);
    eq('版は拡張の manifest から', bat.includes('版: 9.9.9'), true);
    eq('CRLF', bat.includes('\r\n'), true);
    eq('保存したと言う', (await page.textContent('#claude-bridge-status')).startsWith('dictation-claude-setup.bat を保存しました'), true);

    // v0.24.44: 「接続を確認」ボタンは外した。連携をオンにしたときに確かめる
    await page.click('#input-claude-code');
    await page.waitForTimeout(700);
    eq('連携をオンにすると、未インストールと言う（start.bat とは言わない）',
       (await page.textContent('#claude-bridge-status')).startsWith('Claude 連携がインストールされていません'), true);
    eq('インストール式の口に問い合わせている',
       (await page.evaluate(() => window.__native)).some(([n, t]) => n === 'com.dictation.helper' && t === 'health'), true);
    await ctx.close();
  }

  console.log('■ 拡張でインストール済み');
  {
    const { ctx, page } = await open(browser, { extension: true, settings: { claudeCode: true },
      nativeReply: { ok: true, version: '9.9.9', invocation: 'wsl', via: 'native', features: ['effort', 'timeout'], auth: { ok: true, loggedIn: true } } });
    // v0.24.44: 連携がオンなら、立ち上げたときに自動で確かめて横に出す
    await page.waitForTimeout(600);
    eq('使えると言う', await page.textContent('#claude-bridge-status'), '使えます（ログイン済み / wsl / 連携 9.9.9）');
    await ctx.close();
  }

  await browser.close();
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
