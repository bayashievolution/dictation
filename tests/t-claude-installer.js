// アプリが組み立てる Claude 連携のインストーラー（.bat）を検査する (v0.24.21)。
//
// 依存なし。**.bat を Windows で実際に走らせてはいない**（この環境は Linux）。
// ここで見るのは、組み立てた中身が
//   - 埋め込んだファイルを certutil の形でそのまま戻せるか（base64 の行を集めて戻してみる）
//   - 登録用の JSON が、cmd が echo したあとの形で JSON として読めるか
//   - 拡張の ID・ブラウザごとの登録先・版が正しく入っているか
//   - cmd を壊す書き方（括弧のブロック、LF だけの改行）をしていないか
// までで、certutil・reg・choice が本当にそう動くかは Windows で確かめるしかない。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

const ctx = { TextEncoder, btoa, module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(SRC, 'claude-installer.js'), 'utf8'), ctx);
const { buildClaudeInstaller, detectInstallerBrowser } = ctx.module.exports;

const hostSource = fs.readFileSync(path.join(SRC, 'claude-host.js'), 'utf8');
const runnerSource = fs.readFileSync(path.join(SRC, 'claude-runner.js'), 'utf8');
const ID = 'abcdefghijklmnopabcdefghijklmnop';
const make = (browser) => buildClaudeInstaller({ extensionId: ID, browser, version: '0.24.21', hostSource, runnerSource });

/** certutil -decode と同じことを、.bat の echo 行から再現する */
function extractFile(bat, varName) {
  const tag = `"%${varName}%.b64" echo `;
  const lines = bat.split('\r\n').filter((l) => l.includes(tag)).map((l) => l.slice(l.indexOf(tag) + tag.length));
  const body = lines.filter((l) => !/^-----/.test(l)).join('');
  return Buffer.from(body, 'base64').toString('utf8');
}

/** 登録用 JSON を、cmd が echo したあとの形にする（%JDIR% は \ を \\ にした置き場所） */
function extractManifest(bat, file) {
  const dir = 'C:\\Users\\やっさん\\AppData\\Local\\dictation-helper';
  const tag = `"%DIR%\\${file}" echo `;
  return bat.split('\r\n').filter((l) => l.includes(tag))
    .map((l) => l.slice(l.indexOf(tag) + tag.length).replace('%JDIR%', dir.replace(/\\/g, '\\\\')))
    .join('\n');
}

console.log('■ 形');
{
  const bat = make('chrome');
  eq('改行はすべて CRLF（LF だけの行が無い）', /[^\r]\n/.test(bat), false);
  eq('chcp 65001 で日本語を出す', bat.split('\r\n')[1], 'chcp 65001 >nul');
  eq('括弧のブロックを使っていない（Program Files (x86) で壊れるため）',
     bat.split('\r\n').some((l) => /^\s*(if|for)\b.*\($/i.test(l) || /^\s*\)\s*$/.test(l)), false);
  eq('拡張の ID が入る', bat.includes(`chrome-extension://${ID}/`), true);
}

console.log('\n■ 埋め込んだファイルが元に戻る');
{
  const bat = make('chrome');
  const host = extractFile(bat, 'HOSTJS');
  eq('claude-runner.js はそのまま', extractFile(bat, 'RUNNERJS'), runnerSource);
  eq('claude-host.js は版だけ書き込まれて、ほかはそのまま',
     host, hostSource.replace("const BAKED_VERSION = '';", "const BAKED_VERSION = '0.24.21';"));
  eq('版の書き込み先がホストに残っている（消えると版を書き込めない）', hostSource.includes("const BAKED_VERSION = '';"), true);
}

console.log('\n■ 登録用の JSON');
for (const [browser, file, key] of [
  ['chrome', 'manifest-chrome.json', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.dictation.helper'],
  ['edge', 'manifest-edge.json', 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.dictation.helper'],
]) {
  const bat = make(browser);
  let m = null;
  try { m = JSON.parse(extractManifest(bat, file)); } catch (e) { console.log('    ' + e.message); }
  eq(`${browser}: echo したあとの形が JSON として読める`, !!m, true);
  if (m) {
    eq(`${browser}: 中身`, m, {
      name: 'com.dictation.helper',
      description: 'dictation helper (Claude Code bridge)',
      path: 'C:\\Users\\やっさん\\AppData\\Local\\dictation-helper\\dictation-helper.bat',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${ID}/`],
    });
  }
  eq(`${browser}: そのブラウザの登録先だけに書く`, bat.includes(`reg add "${key}"`), true);
  eq(`${browser}: もう片方には書かない`,
     bat.split('\r\n').filter((l) => l.startsWith('reg add')).length, 1);
}

console.log('\n■ 入口の .bat');
{
  const bat = make('chrome');
  const lines = bat.split('\r\n').filter((l) => l.includes('"%DIR%\\dictation-helper.bat" echo'));
  eq('Node の場所を書き込み、隣の claude-host.js を起動する（%% は % として書かれる）',
     lines.map((l) => l.replace(/^.*?echo /, '')), ['@echo off', '"%NODE%" "%%~dp0claude-host.js" %%*']);
}

console.log('\n■ おかしな ID は断る');
{
  let err = '';
  try { buildClaudeInstaller({ extensionId: '', browser: 'chrome', version: '1', hostSource, runnerSource }); }
  catch (e) { err = e.message; }
  eq('ID が無ければ作らない（拡張として開いていない＝ブラウザ版など）', /ID/.test(err), true);
  err = '';
  try { buildClaudeInstaller({ extensionId: 'abc"&del', browser: 'chrome', version: '1', hostSource, runnerSource }); }
  catch (e) { err = e.message; }
  eq('ID に記号が混ざっていたら作らない（.bat に書き込むので）', /ID/.test(err), true);
}

console.log('\n■ ブラウザの見分け');
eq('Edge（userAgentData）', detectInstallerBrowser({ userAgentData: { brands: [{ brand: 'Microsoft Edge' }] }, userAgent: '' }), 'edge');
eq('Edge（userAgent の Edg/）', detectInstallerBrowser({ userAgent: 'Mozilla/5.0 Chrome/156 Safari/537.36 Edg/156.0' }), 'edge');
eq('Chrome', detectInstallerBrowser({ userAgentData: { brands: [{ brand: 'Google Chrome' }] }, userAgent: 'Chrome/156' }), 'chrome');

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
