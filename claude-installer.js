/**
 * claude-installer.js — Claude 連携のインストーラー（.bat）をアプリの中で組み立てる (v0.24.21)
 *
 * やっさんの要望:
 * > start.bat、黒いウインドウが出るし、見た目がちょっとマニアックなので、
 * > 今後リリースすることも考えて、インストール式にしてくれないかな
 * > 連携に関してはソフトの方で管理
 *
 * ■ なぜアプリが組み立てるのか
 *
 * ネイティブメッセージングの登録には「どの拡張から呼んでよいか」（拡張の ID）を書く。
 * ID は入れた場所やブラウザ（Chrome / Edge）で変わり、利用者には分からない。
 * **アプリは自分の ID を知っている**ので、その場で ID を書き込んだインストーラーを作れば、
 * 利用者はダブルクリックするだけで済む。
 *
 * 拡張に `key` を足して ID を固定する案は採らなかった。ID が変わると
 * **拡張の保存場所（localStorage / IndexedDB）ごと変わり、これまでの記録が読めなくなる**。
 *
 * ■ インストーラーがすること（Windows・管理者権限なし）
 *
 *   1. Node.js を探す（ホストは Node で動く）
 *   2. %LOCALAPPDATA%\dictation-helper に claude-host.js / claude-runner.js を書き出す
 *      （中身は base64 で .bat に埋め込み、Windows に最初からある certutil で戻す）
 *   3. ホストを起動する小さな .bat と、登録用の JSON を書く
 *   4. HKCU に登録する（そのブラウザの分だけ）
 *   5. uninstall.bat を置く
 *   6. claude が見つかるか・ログインしているかを確かめ、必要ならその場でサインイン
 *
 * ■ 名前を Claude 専用にしていない理由
 *
 * 字幕オーバーレイも別のネイティブアプリで動いていて、やっさんは将来まとめたいと言っている。
 * 登録名を `com.dictation.helper`、置き場所を `dictation-helper` にしておけば、
 * まとめるときに登録し直さずに機能を足せる。
 *
 * ■ .bat の書き方で気をつけたこと
 *
 * - **括弧のブロックを使わない。** Node が "C:\Program Files (x86)\..." にあると、
 *   展開された ")" がブロックを閉じてしまう。1行ずつ `>>"ファイル" echo …` で書く
 * - 改行は CRLF。chcp 65001 で日本語を出す（login.bat と同じやり方）
 * - 埋め込む base64・JSON に % ^ & < > | ! が入らないことは組み立てるときに確かめる
 */

const DICTATION_HELPER_NAME = 'com.dictation.helper';

/** UTF-8 の文字列を base64 に。ブラウザでも node でも同じ結果になる */
function installerBase64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** そのファイルを書き出す .bat の行（certutil が読める形） */
function installerFileLines(varName, b64) {
  const tmp = `"%${varName}%.b64"`;
  const lines = [`> ${tmp} echo -----BEGIN CERTIFICATE-----`];
  for (let i = 0; i < b64.length; i += 76) lines.push(`>> ${tmp} echo ${b64.slice(i, i + 76)}`);
  lines.push(`>> ${tmp} echo -----END CERTIFICATE-----`);
  lines.push(`certutil -f -decode ${tmp} "%${varName}%" >nul`);
  lines.push('if errorlevel 1 goto fail_write');
  lines.push(`del ${tmp} >nul 2>nul`);
  return lines;
}

/**
 * インストーラーの中身を作る
 *
 * @param {object} o
 * @param {string} o.extensionId  chrome.runtime.id
 * @param {'chrome'|'edge'} o.browser
 * @param {string} o.version      manifest の version
 * @param {string} o.hostSource   claude-host.js の中身
 * @param {string} o.runnerSource claude-runner.js の中身
 * @returns {string} CRLF 区切りの .bat
 */
function buildClaudeInstaller({ extensionId, browser, version, hostSource, runnerSource }) {
  if (!/^[a-p]{32}$/.test(String(extensionId || ''))) {
    throw new Error('拡張の ID が読めません（拡張として開いていないかもしれません）');
  }
  const isEdge = browser === 'edge';
  const browserName = isEdge ? 'Edge' : 'Chrome';
  const regKey = isEdge
    ? `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${DICTATION_HELPER_NAME}`
    : `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${DICTATION_HELPER_NAME}`;
  const manifestFile = isEdge ? 'manifest-edge.json' : 'manifest-chrome.json';
  const safeVersion = String(version || '').replace(/[^0-9.]/g, '');

  // 版をホストに書き込む（インストール先には manifest.json が無いので）
  const host = String(hostSource).replace("const BAKED_VERSION = '';", `const BAKED_VERSION = '${safeVersion}';`);

  const L = [];
  const add = (...xs) => L.push(...xs);
  add(
    '@echo off',
    'chcp 65001 >nul',
    'setlocal EnableExtensions DisableDelayedExpansion',
    `title dictation - Claude 連携のインストール（${browserName}）`,
    'REM このファイルは dictation アプリが作りました。',
    `REM 拡張の ID: ${extensionId} / 版: ${safeVersion}`,
    'REM cmd.exe は UNC パスを作業フォルダにできないので、一時フォルダへ移る（login.bat と同じ）',
    'cd /d "%TEMP%"',
    'echo.',
    `echo  dictation の Claude 連携をインストールします（${browserName} 用）`,
    'echo  管理者の権限は要りません。終わったら、この窓は閉じてかまいません。',
    'echo.',
    '',
    'REM ── 1. Node.js を探す ──',
    'set "NODE="',
    'for /f "delims=" %%n in (\'where node 2^>nul\') do if not defined NODE set "NODE=%%n"',
    'if not defined NODE goto fail_node',
    'echo  ○ Node.js: %NODE%',
    '',
    'REM ── 2. 置き場所 ──',
    'set "DIR=%LOCALAPPDATA%\\dictation-helper"',
    'if not exist "%DIR%" mkdir "%DIR%"',
    'if not exist "%DIR%" goto fail_write',
    'set "HOSTJS=%DIR%\\claude-host.js"',
    'set "RUNNERJS=%DIR%\\claude-runner.js"',
    '',
    'REM ── 3. 中身を書き出す ──',
    ...installerFileLines('HOSTJS', installerBase64(host)),
    ...installerFileLines('RUNNERJS', installerBase64(runnerSource)),
    '',
    'REM ブラウザが起動する入口。Node の場所はインストールした時点のものを書き込む',
    '> "%DIR%\\dictation-helper.bat" echo @echo off',
    '>> "%DIR%\\dictation-helper.bat" echo "%NODE%" "%%~dp0claude-host.js" %%*',
    '',
    'REM ── 4. 登録用の JSON（パスの \\ は JSON では \\\\ にする）──',
    'set "JDIR=%DIR:\\=\\\\%"',
    `> "%DIR%\\${manifestFile}" echo {`,
    `>> "%DIR%\\${manifestFile}" echo   "name": "${DICTATION_HELPER_NAME}",`,
    `>> "%DIR%\\${manifestFile}" echo   "description": "dictation helper (Claude Code bridge)",`,
    `>> "%DIR%\\${manifestFile}" echo   "path": "%JDIR%\\\\dictation-helper.bat",`,
    `>> "%DIR%\\${manifestFile}" echo   "type": "stdio",`,
    `>> "%DIR%\\${manifestFile}" echo   "allowed_origins": ["chrome-extension://${extensionId}/"]`,
    `>> "%DIR%\\${manifestFile}" echo }`,
    '',
    `REM ── 5. ${browserName} に登録する（自分のユーザーの分だけ）──`,
    `reg add "${regKey}" /ve /t REG_SZ /d "%DIR%\\${manifestFile}" /f >nul`,
    'if errorlevel 1 goto fail_reg',
    `echo  ○ ${browserName} に登録しました`,
    '',
    'REM ── 6. 外すとき用 ──',
    '> "%DIR%\\uninstall.bat" echo @echo off',
    '>> "%DIR%\\uninstall.bat" echo chcp 65001 ^>nul',
    `>> "%DIR%\\uninstall.bat" echo reg delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${DICTATION_HELPER_NAME}" /f ^>nul 2^>nul`,
    `>> "%DIR%\\uninstall.bat" echo reg delete "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${DICTATION_HELPER_NAME}" /f ^>nul 2^>nul`,
    '>> "%DIR%\\uninstall.bat" echo echo  dictation の Claude 連携を外しました。このフォルダは消してかまいません。',
    '>> "%DIR%\\uninstall.bat" echo pause ^>nul',
    '',
    'REM ── 7. claude を確かめる ──',
    'echo.',
    'echo  Claude Code を確かめています（数秒かかります）...',
    '"%NODE%" "%HOSTJS%" --check',
    'if errorlevel 3 goto no_claude',
    'if errorlevel 2 goto need_login',
    'if errorlevel 1 goto check_failed',
    'goto done',
    '',
    ':check_failed',
    'echo.',
    'echo  Claude Code を確かめられませんでした（登録は済んでいます）。',
    'echo  アプリの「接続を確認」を押すと、理由が出ます。',
    'goto end',
    '',
    ':need_login',
    'echo.',
    'choice /c YN /m "  いまサインインしますか（ブラウザが開きます）"',
    'if errorlevel 2 goto done_login_later',
    '"%NODE%" "%HOSTJS%" --login',
    'goto done',
    '',
    ':no_claude',
    'echo.',
    'echo  Claude Code（ターミナル版）が見つかりませんでした。',
    'echo  入れてから、このファイルをもう一度ダブルクリックしてください。',
    'echo  （登録は済んでいるので、入れたあとはアプリの「接続を確認」だけでも大丈夫です）',
    'goto end',
    '',
    ':done_login_later',
    'echo.',
    'echo  あとでサインインするときは、このファイルをもう一度ダブルクリックしてください。',
    'goto end',
    '',
    ':done',
    'echo.',
    'echo  ----------------------------------------',
    'echo   インストールできました。',
    `echo   ${browserName} の dictation に戻って、設定の`,
    'echo   「接続を確認」を押してください。',
    'echo  ----------------------------------------',
    'goto end',
    '',
    ':fail_node',
    'echo  × Node.js が見つかりませんでした。',
    'echo    https://nodejs.org から入れてから、もう一度ダブルクリックしてください。',
    'goto end',
    '',
    ':fail_write',
    'echo  × ファイルを書き出せませんでした: %DIR%',
    'goto end',
    '',
    ':fail_reg',
    `echo  × ${browserName} への登録に失敗しました。`,
    'goto end',
    '',
    ':end',
    'echo.',
    'echo  何かキーを押すと閉じます',
    'pause >nul',
    'endlocal',
  );

  // 埋め込んだ値に cmd が特別扱いする記号が混ざっていないか（混ざると .bat が壊れる）
  for (const line of L) {
    if (/^>>? "%\w+%\.b64" echo /.test(line) && /[%^&<>|!()]/.test(line.replace(/^>>? "%\w+%\.b64" echo /, ''))) {
      throw new Error('埋め込みに使えない文字が入りました: ' + line.slice(0, 40));
    }
  }
  return L.join('\r\n') + '\r\n';
}

/** いま開いているブラウザ。Edge か、それ以外（Chrome 扱い） */
function detectInstallerBrowser(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : {});
  const brands = (n.userAgentData && n.userAgentData.brands) || [];
  if (brands.some((b) => /Edge/i.test(b.brand))) return 'edge';
  if (/\bEdg\//.test(n.userAgent || '')) return 'edge';
  return 'chrome';
}

if (typeof module !== 'undefined') {
  module.exports = { buildClaudeInstaller, detectInstallerBrowser, installerBase64, DICTATION_HELPER_NAME };
}
