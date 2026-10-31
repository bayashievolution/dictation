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
    eq('押す前は「未確認」', (await status(page)).startsWith('未確認'), true);
    await page.evaluate(() => { document.getElementById('btn-settings').click(); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { document.getElementById('btn-claude-bridge-test').click(); });
    await page.waitForTimeout(1200);
    const t = await status(page);
    // v0.24.9: 中継が生きているだけでは「使えます」と言わない。
    // ログインしていることまで確かめてから言う
    eq('使えると出る', /使えます/.test(t), true);
    eq('ログイン済みだと言う', /ログイン済み/.test(t), true);
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

  console.log('\n■ Gemini に戻したときの文言が、状態表示に収まるか');
  // 状態表示は max-width: 360px で、超えると**末尾から**…で切れる。
  // 「start.bat を起動」のような**どうすればいいか**が末尾にあるので、
  // 切れると一番大事なところから消える。文字数では測れないのでここで見る
  {
    const { ctx, page } = await open(browser);
    const REASONS = [
      ['サーバーが動いていない', 'Claude Code の中継に繋がりません（start.bat でサーバーを起動してください）'],
      ['claude が入っていない', 'claude を実行できませんでした'],
      ['時間切れ', '180秒待っても返事がありませんでした'],
      ['長すぎる', '長すぎます（250000字 / 上限200000字）'],
      ['知らないエラー（短い）', '終了コード 1'],
      ['理由が空', ''],
    ];
    for (const [label, err] of REASONS) {
      const r = await page.evaluate((e) => {
        const msg = claudeBridgeFallbackMessage(e);
        setStatus('error', msg);
        const el = els.status;
        return { msg, 切れ: el.scrollWidth > el.clientWidth + 1, 幅: Math.round(el.scrollWidth) };
      }, err);
      eq(`${label}（${r.幅}px）: ${r.msg}`, r.切れ, false);
    }
    await ctx.close();
  }

  console.log('\n■ 生の理由を画面に流さない (v0.24.7)');
  // 一度は理由をそのまま文言に入れたが、やっさんから
  // 「ログを画面にずっと出すのはちょっとね　押したらエラーの詳細が出るとか」。
  // 文言は短く、詳細は押したときだけ。
  {
    const { ctx, page } = await open(browser);
    const LONG = 'Error: Invalid API key \u00b7 Please run /login\n    at Object.<anonymous> (/usr/lib/cli.js:1:2345)';
    const r = await page.evaluate((e) => {
      const msg = claudeBridgeFallbackMessage(e);
      const el = els.status;
      setStatus('error', msg);
      return { msg, 切れ: el.scrollWidth > el.clientWidth + 1 };
    }, LONG);
    eq('生の理由を文言に入れない', r.msg.includes('Invalid API key'), false);
    eq('パスや行番号を出さない', /cli\.js|at Object/.test(r.msg), false);
    eq('切れない長さに収まる', r.切れ, false);
    eq('Gemini に戻したことは言う', r.msg.includes('Gemini で処理'), true);
    await ctx.close();
  }

  console.log('\n■ detail を渡さなければ今までどおり（41か所の呼び出しを変えていない）');
  {
    const { ctx, page } = await open(browser);
    eq('title は label と同じになる',
       await page.evaluate(() => {
         setStatus('idle', '停止');
         return els.status.title;
       }), '停止');
    await ctx.close();
  }

  console.log('\n■ 設定でオンにしたその場でログインを見る (v0.24.9)');
  // やっさんの指摘「設定の時点でログインしてないと動かないようにしたほうがいい」。
  // オンにできてしまうと、次に録音を止めて要約を回して初めて失敗する
  //
  // v0.24.10: 戻すのは**使えないとはっきり分かっているときだけ**。
  // やっさん報告「オフにしたらオンにできない　トグルが動かないよう」——
  // 古い serve.js が走っているだけでもチェックを戻していたので、
  // **何も壊れていないのに永久にオンにできない**状態になっていた
  const TOGGLE = [
    ['ログインしていない（戻す）', { ok: true, invocation: 'claude', auth: { ok: true, loggedIn: false } },
     false, 'login.bat'],
    ['ログイン済み', { ok: true, invocation: 'claude', auth: { ok: true, loggedIn: true } },
     true, '使えます'],
    ['古い serve.js（戻さない）', { ok: true, invocation: 'claude' },
     true, 'start.bat を一度閉じて'],
    ['claude を確かめられない（戻さない）', { ok: true, auth: { ok: false, error: 'spawn claude ENOENT' } },
     true, '確かめられません'],
  ];
  for (const [label, body, wantChecked, wantText] of TOGGLE) {
    const { ctx, page } = await open(browser);
    await page.route('**/api/claude/health', (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    }));
    await page.evaluate(() => { document.getElementById('btn-settings').click(); });
    await page.waitForTimeout(250);
    // dispatchEvent ではなく**本物のクリック**で操作する。
    // やっさんが踏んだのは実際に指で押したときの振る舞い
    await page.click('#input-claude-bridge');
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => ({
      checked: document.getElementById('input-claude-bridge').checked,
      text: document.getElementById('claude-bridge-status').textContent,
    }));
    eq(`${label} → チェック`, r.checked, wantChecked);
    eq(`${label} → 理由を出す`, r.text.includes(wantText), true);
    // オフ→オンをもう一度やって、同じ結果になるか（関じ込められないか）
    await page.click('#input-claude-bridge');
    await page.waitForTimeout(300);
    await page.click('#input-claude-bridge');
    await page.waitForTimeout(900);
    eq(`${label} → オフ→オンし直せる`,
       await page.evaluate(() => document.getElementById('input-claude-bridge').checked), wantChecked);
    await ctx.close();
  }

  console.log('\n■ ログイン切れのあと、確実に失敗する呼び出しを繰り返さない (v0.24.9)');
  // やっさん報告「これ2回連続で出るのがなんか気になる」。
  // 録音を止めると要約とタイトルを続けて回すので、2回目も必ず失敗していた
  {
    const { ctx, page } = await open(browser, { useClaudeBridge: true });
    let posts = 0;
    await page.route('**/api/claude', (r) => {
      posts++;
      return r.fulfill({
        status: 502, contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'Failed to authenticate: OAuth session expired and could not be refreshed' }),
      });
    });
    const body = { contents: [{ role: 'user', parts: [{ text: '要約して' }] }] };
    const r1 = await page.evaluate((b) => _tryClaudeBridge(b, 'summary'), body);
    const r2 = await page.evaluate((b) => _tryClaudeBridge(b, 'title'), body);
    eq('1回目は Gemini に落ちる', r1, null);
    eq('2回目も Gemini に落ちる', r2, null);
    eq('中継を叩くのは1回だけ', posts, 1);
    eq('駄目な理由を覚えている',
       await page.evaluate(() => claudeBridgeBrokenReason().includes('OAuth')), true);
    // ただし**黙っては戻さない**。画面には出ている
    eq('2回目も画面には出す',
       await page.evaluate(() => els.status.textContent.includes('ログインが切れている')), true);
    // 設定を入れ直したらもう一度試す
    await page.evaluate(() => claudeBridgeSetEnabled(true));
    eq('入れ直したら覚えを消す',
       await page.evaluate(() => claudeBridgeBrokenReason()), '');
    await ctx.close();
  }

  console.log('\n■ 中継用ファイルをアプリから出せるか (v0.24.12)');
  // やっさんの要望「start.bat とか login.bat とかはアプリの中に組み込めないの？
  // ゆくゆく公開することを考えると、含んでいてほしいかな」。
  // 拡張からプログラムは起動できないが、**ファイルを渡すことはできる**
  {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { console.log('✕ ページで例外: ' + e.message); fail++; });
    const got = [];
    page.on('download', (d) => got.push(d.suggestedFilename()));
    await page.goto(URL);
    await page.waitForTimeout(800);
    await page.evaluate(() => { document.getElementById('btn-settings').click(); });
    await page.waitForTimeout(250);
    await page.evaluate(() => { document.getElementById('btn-save-bridge-files').click(); });
    await page.waitForTimeout(3000);
    eq('3つとも保存される', got.sort(), ['login.bat', 'serve.js', 'start.bat']);
    eq('同じフォルダに置くことを言う',
       (await status(page)).includes('同じフォルダ'), true);
    eq('記号がそのまま出ていない', (await status(page)).includes('**'), false);
    await ctx.close();
  }

  console.log('\n■ 設定の並び (v0.24.12)');
  // やっさんの要望「設定メニューの Claude code 連携メニューは、
  // 録音停止時に AI 要約・・・の下に移動してほしい」
  {
    const { ctx, page } = await open(browser);
    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.field-group-title')).map((h) => h.textContent.trim()));
    const gemini = order.indexOf('Gemini API');
    const claude = order.indexOf('Claude Code 連携');
    eq('Claude 連携は Gemini API のあと', claude > gemini && gemini >= 0, true);
    eq('録音停止時の要約設定よりあとにある',
       await page.evaluate(() => {
         const box = document.getElementById('input-auto-summarize');
         const head = Array.from(document.querySelectorAll('.field-group-title'))
           .find((h) => h.textContent.trim() === 'Claude Code 連携');
         // 文書順で box のあとに head があるか
         return !!(box.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING);
       }), true);
    await ctx.close();
  }

  await browser.close();
  console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
  process.exit(fail === 0 ? 0 : 1);
})();
