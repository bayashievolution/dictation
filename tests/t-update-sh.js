// update.sh（ダブルクリックでアプデする .bat から呼ばれる本体）を、
// 本物の git リポジトリを作って実際に走らせて検査する。
//
// 依存なし。git と bash があれば動く（jsdom のような外部パッケージは使わない）。
//
// ■ なぜここをテストするか
//
// このスクリプトは**やっさんの手元の記録を壊しうる唯一の自動処理**。
// 「手で直したファイルがあるのに pull してしまった」は取り返しがつかないので、
// 止まるべきときに本当に止まることを機械で確かめる。
//
// UPDATE.md に書いてある判断（Untracked なら進んでよい／modified なら止まる）と
// 同じ線で止まることも、ここで一致を見る。
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const R = process.env.SRC || __dirname + '/../';
const SCRIPT = path.resolve(R, 'update.sh');

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✕'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`);
  if (!ok) fail++;
};

const git = (dir, ...args) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
               { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function runUpdate(dir) {
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT],
      { env: { ...process.env, DICT_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

// 配布側（origin）と手元を作る。BRANCH は update.sh が見ているものに合わせる
const BRANCH = fs.readFileSync(SCRIPT, 'utf8').match(/BRANCH='([^']+)'/)[1];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
const origin = path.join(root, 'origin');

fs.mkdirSync(origin);
git(origin, 'init', '-q', '-b', BRANCH);
const setVersion = (dir, v) =>
  fs.writeFileSync(path.join(dir, 'manifest.json'), `{\n  "version": "${v}"\n}\n`);
setVersion(origin, '0.1.0');
fs.writeFileSync(path.join(origin, 'app.js'), 'もとの中身\n');
git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'v0.1.0');

const fresh = (name) => {
  const d = path.join(root, name);
  git(root, 'clone', '-q', '--branch', BRANCH, origin, d);
  return d;
};

console.log('■ 配布側に新しい版が出ているとき');
{
  const d = fresh('behind');
  setVersion(origin, '0.2.0');
  git(origin, 'commit', '-qam', 'v0.2.0');
  const r = runUpdate(d);
  check('終了コードは 0', r.code === 0, `code=${r.code}`);
  check('いまの版を先に出す', r.out.includes('いまの版: 0.1.0'));
  check('上がった版を出す', r.out.includes('0.1.0 → 0.2.0 になりました'));
  check('実際にファイルが新しくなっている',
        fs.readFileSync(path.join(d, 'manifest.json'), 'utf8').includes('0.2.0'));
  check('Chrome 側の手順を案内する', r.out.includes('chrome://extensions'));
  check('↻ の案内に新しい版の数字が入る', r.out.includes('0.2.0 になっていれば成功'));
}

console.log('\n■ もう最新のとき');
{
  const d = fresh('current');
  const r = runUpdate(d);
  check('終了コードは 0', r.code === 0, `code=${r.code}`);
  check('「もう最新でした」と言う', r.out.includes('もう最新でした（0.2.0）'));
  check('上がったとは言わない', !r.out.includes('になりました'));
}

console.log('\n■ 手で直したファイルがあるとき（**止まらないといけない**）');
{
  const d = fresh('dirty');
  fs.appendFileSync(path.join(d, 'app.js'), '手で直した\n');
  setVersion(origin, '0.3.0');
  git(origin, 'commit', '-qam', 'v0.3.0');
  const r = runUpdate(d);
  check('終了コードは 1', r.code === 1, `code=${r.code}`);
  check('中断したと言う', r.out.includes('中断しました'));
  check('どのファイルかを出す', r.out.includes('app.js'));
  check('**pull していない**（手で直した中身が残っている）',
        fs.readFileSync(path.join(d, 'app.js'), 'utf8').includes('手で直した'));
  check('版も上げていない',
        fs.readFileSync(path.join(d, 'manifest.json'), 'utf8').includes('0.2.0'));
  check('相談してと言う', r.out.includes('コピーして相談'));
}

console.log('\n■ git が知らないファイルだけのとき（UPDATE.md では「進んでよい形」）');
{
  const d = fresh('untracked');
  fs.mkdirSync(path.join(d, '.claude'));
  fs.writeFileSync(path.join(d, '.claude', 'settings.json'), '{}\n');
  setVersion(origin, '0.4.0');
  git(origin, 'commit', '-qam', 'v0.4.0');
  const r = runUpdate(d);
  check('終了コードは 0（止めない）', r.code === 0, `code=${r.code}`);
  check('最新まで上がる', r.out.includes('→ 0.4.0 になりました'));
  check('知らないファイルは消さない',
        fs.existsSync(path.join(d, '.claude', 'settings.json')));
}

console.log('\n■ 手元で枝分かれしているとき（勝手に混ぜない）');
{
  const d = fresh('diverged');
  fs.appendFileSync(path.join(d, 'app.js'), '手元だけの変更\n');
  git(d, 'commit', '-qam', '手元のコミット');
  setVersion(origin, '0.5.0');
  git(origin, 'commit', '-qam', 'v0.5.0');
  const r = runUpdate(d);
  check('終了コードは 1', r.code === 1, `code=${r.code}`);
  check('枝分かれだと言う', r.out.includes('枝分かれ'));
  check('マージコミットを作っていない',
        git(d, 'log', '--oneline', '-1').includes('手元のコミット'));
}

console.log('\n■ フォルダが無いとき');
{
  const r = runUpdate(path.join(root, 'nowhere'));
  check('終了コードは 1', r.code === 1, `code=${r.code}`);
  check('場所を出して相談を促す', r.out.includes('見つかりません') && r.out.includes('相談'));
}

console.log('\n■ ブランチの取り違えを防げているか');
{
  // main を見ている状態から走らせても、開発ブランチに切り替わること。
  // 「main を pull しても新しくならない」が久しぶりに触るときの一番の罠
  const d = fresh('on-main');
  git(d, 'checkout', '-q', '-b', 'main');
  setVersion(origin, '0.6.0');
  git(origin, 'commit', '-qam', 'v0.6.0');
  const r = runUpdate(d);
  check('終了コードは 0', r.code === 0, `code=${r.code}`);
  check('開発ブランチに移る', git(d, 'branch', '--show-current').trim() === BRANCH);
  check('最新まで上がる', r.out.includes('→ 0.6.0 になりました'));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
process.exit(fail === 0 ? 0 : 1);
