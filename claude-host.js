/**
 * claude-host.js — 拡張から `claude -p` を呼ぶためのネイティブメッセージングのホスト (v0.24.21)
 *
 * やっさんの要望:
 * > start.bat、黒いウインドウが出るし、見た目がちょっとマニアックなので、
 * > 今後リリースすることも考えて、インストール式にしてくれないかな
 * > 連携に関してはソフトの方で管理
 *
 * ■ しくみ
 *
 * Chrome / Edge は、登録されたプログラムを**拡張が呼んだときだけ**起動し、
 * 標準入出力でやり取りする（ネイティブメッセージング）。窓は出ない。
 * 1回の依頼ごとに起動され、返事をしたら終わる（sendNativeMessage）。
 * サーバーを立ち上げっぱなしにする必要が無いので、start.bat も要らない。
 *
 * v0.24.0 のときは「登録が要るので手間が減らない」として採らなかった。
 * その登録を**アプリが作るインストーラー**に任せることで、手間を1回のダブルクリックにした
 * （インストーラーは claude-installer.js が組み立てる）。
 *
 * ■ 通信の形（Chrome の決まり）
 *
 *   [長さ 4バイト・リトルエンディアン][UTF-8 の JSON]
 *
 * 受け取るもの:
 *   { type: 'health' }            → { ok:true, version, invocation, auth }
 *   { type: 'run', prompt: '…' } → { ok:true, text, seconds } / { ok:false, error }
 *   { type: 'run', session: true, id, … } → 会話を切らずに呼ぶ (v0.24.53)。返事に同じ id を付ける
 *
 * v0.24.53: ライブ整形は connectNative（つなぎっぱなしの口）で呼ばれる。その間ホストは
 * 終わらず、claude も立ったまま次の依頼を待つ（claude-runner.js の runClaudeSession）。
 * 口が閉じられたら claude も閉じて終わる。
 *
 * **標準出力には返事以外を1バイトも書かない。** 混ざると Chrome 側で
 * 「Error when communicating with the native messaging host」になる。
 * ログは標準エラーへ（Chrome は捨てる）。
 */
const fs = require('fs');
const path = require('path');
const runner = require('./claude-runner.js');

/** インストーラーが版を書き込む。リポジトリの中で動かすときは manifest.json を読む */
const BAKED_VERSION = '';

/** ホスト → ブラウザは 1MB まで（Chrome の上限）。少し余裕を見る */
const MAX_REPLY_BYTES = 1000 * 1000;

function hostVersion() {
  if (BAKED_VERSION) return BAKED_VERSION;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')).version || '?';
  } catch { return '?'; }
}

runner.setLogger((msg) => { try { process.stderr.write(msg + '\n'); } catch {} });

function send(obj) {
  let json = JSON.stringify(obj);
  let buf = Buffer.from(json, 'utf8');
  if (buf.length > MAX_REPLY_BYTES) {
    // 返事が大きすぎると Chrome がホストごと切る。黙って切れるより、理由を返す
    json = JSON.stringify({ ok: false, error: `返事が大きすぎます（${buf.length}バイト）` });
    buf = Buffer.from(json, 'utf8');
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([head, buf]));
}

async function handle(msg) {
  const type = msg && msg.type;
  if (type === 'health') {
    const auth = await runner.checkClaudeAuth();
    // features: この版のホストが分かる依頼の調整。アプリは無ければ「入れ直して」と言う (v0.24.23)
    return { ok: true, version: hostVersion(), invocation: runner.claudeInvocationName(), auth, via: 'native',
             features: ['effort', 'timeout', 'session'] };
  }
  if (type === 'run') {
    const prompt = String((msg && msg.prompt) || '');
    if (!prompt.trim()) return { ok: false, error: 'prompt が空です' };
    if (prompt.length > runner.CLAUDE_MAX_CHARS) {
      return { ok: false, error: `長すぎます（${prompt.length}字 / 上限${runner.CLAUDE_MAX_CHARS}字）` };
    }
    const started = Date.now();
    // v0.24.23: リアルタイム要約は考える量を減らし、長く待つ（claude-runner.js の claudeRunOptions）
    const opts = { effort: msg.effort, timeoutMs: msg.timeoutMs };
    const r = msg.session ? await runner.runClaudeSession(prompt, opts) : await runner.runClaude(prompt, opts);
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    return r.ok ? { ok: true, text: r.text, seconds } : { ok: false, error: r.error, seconds };
  }
  return { ok: false, error: `知らない依頼です: ${type}` };
}

/**
 * インストーラーから直接呼ぶときの口 (v0.24.21)
 *
 *   node claude-host.js --check  … claude が見つかるか・ログインしているかを人に読める形で出す
 *                                  終了コード 0=使える 2=ログインしていない 3=claude が見つからない
 *   node claude-host.js --login  … サインインする（ブラウザが開く）
 *
 * この2つはブラウザからは呼ばれない（ブラウザは引数に拡張の origin を渡すだけ）。
 */
async function cli(arg) {
  if (arg === '--check') {
    const a = await runner.checkClaudeAuth();
    if (a.ok && a.loggedIn) {
      process.stdout.write(`  ○ Claude Code が見つかりました（${runner.claudeInvocationName()}・ログイン済み）\n`);
      return 0;
    }
    if (a.ok && !a.loggedIn) {
      process.stdout.write(`  △ Claude Code は見つかりましたが、ログインしていません\n`);
      return 2;
    }
    process.stdout.write(`  × Claude Code が見つかりません\n    ${String(a.error || '').slice(0, 200)}\n`);
    return 3;
  }
  if (arg === '--login') {
    const r = await runner.claudeAuthLogin();
    return r.ok ? 0 : 1;
  }
  return 1;
}

const cliArg = process.argv.slice(2).find((a) => a === '--check' || a === '--login');
if (cliArg) {
  cli(cliArg).then((code) => { process.exitCode = code; });
} else {
  listen();
}

/** 標準入力から1通ずつ取り出す。sendNativeMessage なら1通だけ来て、閉じられる */
function listen() {
let pending = Buffer.alloc(0);
let busy = Promise.resolve();
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const body = pending.subarray(4, 4 + len).toString('utf8');
    pending = pending.subarray(4 + len);
    busy = busy.then(async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { send({ ok: false, error: '依頼を読めませんでした' }); return; }
      // つなぎっぱなしの口では、どの依頼への返事かを id で示す (v0.24.53)
      const tag = (r) => (msg && msg.id != null ? { ...r, id: msg.id } : r);
      try { send(tag(await handle(msg))); } catch (e) { send(tag({ ok: false, error: String((e && e.message) || e) })); }
    });
  }
});
// ブラウザが入力を閉じたら、走っている依頼を終えてから自然に終わる。
// process.exit() は呼ばない。**呼ぶと書きかけの返事が捨てられる**
// （実測: 45万バイトの返事が 14万バイトで切れた）。開いている口が無くなれば node は勝手に終わる
// v0.24.53: 立たせておいた claude も閉じる。閉じないと子プロセスが残り、node も終われない
process.stdin.on('end', () => { busy.then(() => { runner.closeClaudeSessions(); process.exitCode = 0; }); });
}
