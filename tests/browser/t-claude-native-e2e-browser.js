// 本物の Chromium にこのフォルダを**拡張として**読み込み、本物のネイティブメッセージングの
// ホスト（claude-host.js）を登録して、拡張 → ホスト → claude を端から端まで通す (v0.24.21)。
//
// ■ これは `sh tests/run.sh` では走らない（tests/t-*.js の形にしていない）
//
//   npm i -D playwright && npx playwright install chromium
//   node tests/browser/t-claude-native-e2e-browser.js
//   （serve.js は要らない。動いていても構わない）
//
// claude は偽物（PATH の先頭のシェルスクリプト）。登録は **Linux の**ユーザー単位の場所
// （<user-data-dir>/NativeMessagingHosts/）に置く。**Windows のレジストリ登録や、
// インストーラー（.bat）そのものはここでは確かめていない。** 見ているのは
//   - Chromium が実際にホストを起動し、通信の形（4バイト＋JSON）が噛み合うか
//   - 登録名 com.dictation.helper と allowed_origins の書き方で通るか
//   - Chromium が返す本物のエラー文言を、claude-bridge.js が正しく見分けるか
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.resolve(__dirname, '../..');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

(async () => {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-udd-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'),
    "#!/bin/sh\nif [ \"$1\" = auth ]; then echo '{\"loggedIn\": true}'; exit 0; fi\nprintf 'E2E:'; cat\n", { mode: 0o755 });

  // 拡張はヘッドレスの新しい形でないと読み込まれない
  const ctx = await chromium.launchPersistentContext(udd, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`],
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(sw.url()).host;

  const hostSh = path.join(bin, 'dictation-helper.sh');
  fs.writeFileSync(hostSh, `#!/bin/sh\nexec "${process.execPath}" "${REPO}/claude-host.js" "$@"\n`, { mode: 0o755 });
  const regDir = path.join(udd, 'NativeMessagingHosts');
  fs.mkdirSync(regDir, { recursive: true });
  const regFile = path.join(regDir, 'com.dictation.helper.json');
  const manifest = { name: 'com.dictation.helper', description: 'dictation helper (Claude Code bridge)',
                     path: hostSh, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] };
  fs.writeFileSync(regFile, JSON.stringify(manifest));

  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('✕ ページで例外: ' + e.message); fail++; });
  await page.goto(`chrome-extension://${id}/index.html`);
  await page.waitForTimeout(1000);

  console.log('■ 登録済み');
  const r = await page.evaluate(async () => ({
    native: claudeNativeAvailable(),
    h: await claudeBridgeHealth(),
    run: await claudeBridgeRun('こんにちは「テスト」\n2行目 \\ "引用"'),
  }));
  eq('拡張として開いている', r.native, true);
  eq('「接続を確認」がホストまで届く', [r.h.ok, r.h.via, r.h.auth && r.h.auth.loggedIn], [true, 'native', true]);
  eq('ホストの版は manifest.json と同じ', r.h.version,
     JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).version);
  eq('要約などの依頼が claude まで届いて返る（日本語・改行・記号そのまま）',
     [r.run.ok, r.run.via, r.run.text], [true, 'native', 'E2E:こんにちは「テスト」\n2行目 \\ "引用"']);

  console.log('■ 登録が無い');
  fs.unlinkSync(regFile);
  const r2 = await page.evaluate(async () => claudeBridgeRun('x'));
  // serve.js が動いていれば中継に回る。動いていなければ「インストールされていません」
  eq('「未インストール」と見分けている（中継に回るか、インストールを案内する）',
     r2.via === 'http' || /インストールされていません/.test(r2.error || ''), true);

  console.log('■ 別の拡張用の登録');
  fs.writeFileSync(regFile, JSON.stringify({ ...manifest, allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'] }));
  const r3 = await page.evaluate(async () => claudeBridgeRun('x'));
  eq('入れ直してと言う（Chromium の本物の文言を見分けている）', [r3.ok, /入れ直して/.test(r3.error || '')], [false, true]);

  await ctx.close();
  fs.rmSync(udd, { recursive: true, force: true });
  fs.rmSync(bin, { recursive: true, force: true });
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\n✓ すべて通過');
  process.exit(fail ? 1 : 0);
})();
