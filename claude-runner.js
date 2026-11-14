/**
 * claude-runner.js — `claude -p` を呼ぶ部分 (v0.24.21 で serve.js から切り出した)
 *
 * 使うのは2か所:
 *   serve.js       … ブラウザ版（localhost:8765）の /api/claude
 *   claude-host.js … 拡張のネイティブメッセージングのホスト（インストール式）
 *
 * **ここでは標準出力に何も書かない。** ネイティブメッセージングのホストは
 * 標準出力がそのままブラウザとの通信路なので、1文字でも混ざると通信が壊れる。
 * ログは setLogger で渡された関数に出す（serve.js は console、ホストは標準エラー）。
 */
const { spawn } = require('child_process');
const os = require('os');

let log = () => {};
function setLogger(fn) { log = typeof fn === 'function' ? fn : () => {}; }

/* ───────── Claude Code ブリッジ (v0.24.0) ─────────
 *
 * > 持ってる人は Claude のサブスク料金でおさまるならそれがいいよね
 *
 * Gemini は残したまま、**後処理だけ**を利用者自身の Claude Code に回せるようにする。
 * ここはその中継。拡張／ブラウザ版から呼ばれて `claude -p` を叩くだけ。
 *
 * ■ なぜネイティブメッセージングではなく HTTP か
 *
 * この拡張には既に nativeMessaging の口がある（字幕オーバーレイ）が、
 * そのホストの実体はリポジトリの外にあり、登録も OS ごとに要る。
 * serve.js は**すでに動いていて、すでに Node で、すでに child_process を使っている**。
 * 足すのが一番少なく、壊れどころも少ない。
 *
 * ■ claude がどこにあるか分からない問題
 *
 * start.bat は Windows の node で serve.js を動かすが、Claude Code は
 * WSL の中に入っていることもある。聞いて回る代わりに**両方試す**。
 * 一度成功した呼び方は覚えて、次から直接それを使う。
 *
 * ■ 安全側
 *
 * - プロンプトは**標準入力**で渡す。シェルを経由せず、引数にも乗せない。
 *   文字起こしには何が入っているか分からないので、シェルに触れさせない
 * - 127.0.0.1 でしか待ち受けない（server.listen で指定済み）
 * - 長い要約は時間がかかるので待つが、無限には待たない
 */

/** 1行の整形で実測8.2秒。要約は長いので広めに取る */
const CLAUDE_TIMEOUT_MS = 180000;
/** 送れる文字数の上限。これを超えるものは呼び出し側で切ってから来る想定 */
const CLAUDE_MAX_CHARS = 200000;

/** 試す呼び方。先頭から順に試し、成功したものを覚える */
const CLAUDE_CANDIDATES = [
  { cmd: 'claude', args: ['-p'] },
  { cmd: 'wsl', args: ['claude', '-p'] },
];
let claudeInvocation = null;   // 成功した呼び方
const CLAUDE_AUTH_TIMEOUT_MS = 25000;   // auth status はすぐ返るので短め (v0.24.9)


/**
 * claude を1回呼ぶ。プロンプトは標準入力で渡す
 * @returns {Promise<{ok:boolean, text?:string, error?:string, code?:number}>}
 */
/**
 * 呼び出しごとの調整 (v0.24.23)
 *
 * リアルタイム要約で、やっさんの手元の claude -p が **144.8秒かかり、次の回は 180秒で
 * 時間切れになった**（文字起こし 1.8万字 → 2.1万字）。開発環境で同じ長さを測ると
 * 既定 23秒・`--effort low` 14秒・`--model sonnet` 11秒で、中身の差はほとんど無かった。
 * なのでリアルタイム要約だけ、考える量を減らし（effort）、待つ上限を延ばせる（timeoutMs）ようにする。
 * モデルは変えない（どのモデルを使うかは利用者のサブスクの設定に任せる）。
 *
 * どちらも**決めた値だけ**を受け付ける（引数に乗るので、来たものをそのまま渡さない）。
 */
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_TIMEOUT_MIN_MS = 30000;
const CLAUDE_TIMEOUT_MAX_MS = 900000;

function claudeRunOptions(opts) {
  const o = opts || {};
  const effort = CLAUDE_EFFORTS.has(o.effort) ? o.effort : null;
  const t = Number(o.timeoutMs);
  const timeoutMs = Number.isFinite(t) && t > 0
    ? Math.max(CLAUDE_TIMEOUT_MIN_MS, Math.min(CLAUDE_TIMEOUT_MAX_MS, Math.round(t)))
    : CLAUDE_TIMEOUT_MS;
  return { effort, timeoutMs };
}

/** -p の直後に足す引数 */
function claudeExtraArgs({ effort }) {
  return effort ? ['--effort', effort] : [];
}

function runClaudeOnce({ cmd, args }, prompt, opts) {
  const { effort, timeoutMs } = claudeRunOptions(opts);
  const full = [];
  for (const a of args) { full.push(a); if (a === '-p') full.push(...claudeExtraArgs({ effort })); }
  return new Promise((resolve) => {
    let child;
    try {
      // shell:false（既定）。プロンプトは引数に乗せないので、
      // 文字起こしの中身がシェルに解釈されることはない。
      //
      // cwd を一時ディレクトリにするのは **v0.24.0 の通し確認で踏んだため**。
      // プロジェクトの中で実行すると Claude Code が CLAUDE.md を読み、
      // そこに書いてある申し送り（「セッションの最初にアップデート手順を案内する」）に
      // 従ってしまった。要約を頼んだのに
      // 「最後のコミットは今日なので、アップデート手順の案内は不要です」が
      // 先頭に混ざった。**要約に関係ない文が本文に入る**のは明確な事故なので、
      // 何も置いていない場所で動かす
      child = spawn(cmd, full, { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });
    } catch (e) {
      resolve({ ok: false, error: e.message, spawnFailed: true });
      return;
    }
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `${timeoutMs / 1000}秒待っても返事がありませんでした` });
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      // ENOENT = その呼び方では見つからない。次の候補を試す合図
      finish({ ok: false, error: e.message, spawnFailed: e.code === 'ENOENT' });
    });
    // v0.24.21: 文字コードを先に決めておく。Buffer のまま += すると、
    // 64KB ごとの切れ目で日本語の1文字が割れて「�」になる（実測: 15万字で2か所）
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) finish({ ok: true, text: out.trim() });
      else finish({ ok: false, code, error: (err.trim() || out.trim() || `終了コード ${code}`).slice(0, 500) });
    });

    // v0.24.21: claude が入力を読む前に終わる（ログイン切れで即失敗する等）と、
    // 書き込みが EPIPE になり、**拾わないとプロセスごと落ちる**（serve.js なら
    // サーバーが止まり、拡張のホストなら返事が返らない）。結果は close で拾うので捨ててよい
    child.stdin.on('error', () => {});
    try { child.stdin.end(prompt); } catch (e) { /* close で拾う */ }
  });
}

/**
 * ログインしているかを見る (v0.24.9)
 *
 * やっさんの指摘:
 * > で失敗して、どこでログインしたらいいか分からない
 * > 設定の時点でログインしてないと動かないようにしたほうがいい
 *
 * `claude auth status --json` は非対話ですぐ返る。返りは
 *   { "loggedIn": true, "authMethod": "oauth_token", ... }
 * 実際に切れているときは要約を頑張って回してから 8〜10 秒待って失敗するので、
 * **設定を入れる時点で見る**のが正しい。
 */
function checkClaudeAuthOnce({ cmd, args }) {
  return new Promise((resolve) => {
    // args は ['-p'] または ['claude','-p']。-p を外して auth status に差し替える
    const full = [...args.filter((a) => a !== '-p'), 'auth', 'status', '--json'];
    let child;
    try {
      child = spawn(cmd, full, { stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
    } catch (e) {
      resolve({ ok: false, error: e.message, spawnFailed: true });
      return;
    }
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: 'ログイン状態を確かめられませんでした（時間切れ）' });
    }, CLAUDE_AUTH_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.message, spawnFailed: e.code === 'ENOENT' });
    });
    // v0.24.21: 文字コードを先に決めておく。Buffer のまま += すると、
    // 64KB ごとの切れ目で日本語の1文字が割れて「�」になる（実測: 15万字で2か所）
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data = null;
      try { data = JSON.parse(out.trim()); } catch { /* 下で拾う */ }
      if (data && typeof data.loggedIn === 'boolean') {
        finish({ ok: true, loggedIn: data.loggedIn, authMethod: data.authMethod || null });
        return;
      }
      // JSON でない→ 古い claude か、呼び方が違う。断定しない
      finish({
        ok: false,
        error: (err.trim() || out.trim() || `終了コード ${code}`).slice(0, 300),
      });
    });
  });
}

/** 覚えた呼び方を使い、無ければ順に試す（ログイン確認版） */
async function checkClaudeAuth() {
  const order = claudeInvocation ? [claudeInvocation] : CLAUDE_CANDIDATES;
  let last = null;
  for (const inv of order) {
    const r = await checkClaudeAuthOnce(inv);
    if (r.ok) {
      // ここで呼び方が分かるので覚えておく。
      // 本番の要約を回す前に決まるので、最初の1回が遅くならない
      if (!claudeInvocation) {
        claudeInvocation = inv;
        log(`[claude] 呼び方が決まりました: ${inv.cmd} ${inv.args.join(' ')}`);
      }
      return r;
    }
    last = r;
    if (!r.spawnFailed) break;   // 見つからない以外は呼び方の問題ではない
  }
  return last || { ok: false, error: 'claude を実行できませんでした' };
}

/** 覚えた呼び方を使い、無ければ順に試す */
async function runClaude(prompt, opts) {
  const order = claudeInvocation
    ? [claudeInvocation]
    : CLAUDE_CANDIDATES;
  let last = null;
  for (const inv of order) {
    let r = await runClaudeOnce(inv, prompt, opts);
    // --effort を知らない古い claude なら、付けずにもう一度（速さより、動くことを優先）
    if (!r.ok && !r.spawnFailed && opts && opts.effort && /unknown option|unrecognized|--effort/i.test(r.error || '')) {
      log('[claude] --effort が使えない版だったので、付けずに呼び直します');
      r = await runClaudeOnce(inv, prompt, { ...opts, effort: null });
    }
    if (r.ok) {
      if (!claudeInvocation) {
        claudeInvocation = inv;
        log(`[claude] 呼び方が決まりました: ${inv.cmd} ${inv.args.join(' ')}`);
      }
      return r;
    }
    last = r;
    // 見つからない以外の失敗（認証エラー等）は、呼び方の問題ではないので次を試さない
    if (!r.spawnFailed) break;
  }
  return last || { ok: false, error: 'claude を実行できませんでした' };
}


/**
 * Claude Code にサインインする (v0.24.21)
 *
 * インストーラーから呼ぶ。login.bat と同じことを、呼び方の探し方（Windows 側 → WSL 側）
 * を共有したうえでやる。サインインはブラウザが開く対話なので、入出力はそのまま渡す。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function claudeAuthLogin() {
  const order = claudeInvocation ? [claudeInvocation] : CLAUDE_CANDIDATES;
  let last = null;
  for (const inv of order) {
    const args = [...inv.args.filter((a) => a !== '-p'), 'auth', 'login'];
    const r = await new Promise((resolve) => {
      let child;
      try { child = spawn(inv.cmd, args, { stdio: 'inherit', cwd: os.tmpdir() }); }
      catch (e) { resolve({ ok: false, error: e.message, spawnFailed: true }); return; }
      child.on('error', (e) => resolve({ ok: false, error: e.message, spawnFailed: e.code === 'ENOENT' }));
      child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `終了コード ${code}` }));
    });
    if (r.ok) return r;
    last = r;
    if (!r.spawnFailed) break;
  }
  return last || { ok: false, error: 'claude を実行できませんでした' };
}

/* ───────── セッションを切らずに使う (v0.24.53) ─────────
 *
 * やっさん「セッションを切らずに」「1〜2秒でも縮むなら進めてほしい」。
 * ライブ整形は録音中に数十秒ごとに呼ぶので、毎回 `claude -p` を起動し直す時間が効く。
 *
 * `claude -p --input-format stream-json --output-format stream-json --verbose` は、
 * 標準入力に1行ずつ依頼を書くと、同じ会話のまま次々に答える。
 * **この環境での実測**（effort low・1200字の整形依頼）:
 *   起動し直す  6.3 / 6.5 / 15.9 秒
 *   切らずに    5.1 → 以降 3.5〜4.4 秒（16回続けても遅くならない。16回とも、その回の中身を正しく返した）
 *   毎回 /clear 6.8 / 4.6 / 4.3 / 7.2 / 6.4 秒（会話は消えるが、速さもほぼ消える）
 *   先に起動しておく（6秒置いてから最初の依頼） 5.2 秒（置かないのと同じ。速くなるのは2回目から）
 * なので、会話は消さずに続け、**30回か8万字ごとに起動し直す**（会話が長くなりすぎないように）。
 *
 * 同じ会話なので前の回の依頼も Claude には見えている。依頼は毎回それだけで完結する形
 * （整形の指示＋文脈＋新しいチャンク）なので、取り違えは上の実測では起きていない。
 *
 * 依頼は1本ずつ順に流す（同時に書くと返事の対応が取れなくなる）。
 * 古い claude で stream-json が使えなければ、そのホストの間は起動し直す方式に戻す。
 */
const SESSION_MAX_TURNS = 30;
const SESSION_MAX_CHARS = 80000;
/** しばらく使わなければ閉じる（録音していない間に claude を立たせっぱなしにしない） */
const SESSION_IDLE_MS = 10 * 60 * 1000;

/** stream-json の1行から「答え」を取り出す。答えの行でなければ null（テストできる形で置く） */
function parseSessionLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || o.type !== 'result') return null;
  const text = typeof o.result === 'string' ? o.result.trim() : '';
  if (o.is_error || (o.subtype && o.subtype !== 'success')) {
    return { ok: false, error: (text || o.subtype || 'Claude がエラーを返しました').slice(0, 500) };
  }
  if (!text) return { ok: false, error: 'Claude の返事が空でした' };
  return { ok: true, text };
}

/** 依頼1件を stream-json の1行にする */
function sessionMessageLine(prompt) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: String(prompt) } }) + '\n';
}

function sessionArgs(args, effort) {
  const full = [];
  for (const a of args) {
    full.push(a);
    if (a === '-p') full.push(...claudeExtraArgs({ effort }),
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose');
  }
  return full;
}

class ClaudeSession {
  constructor(inv, effort, spawnFn = spawn) {
    this.inv = inv; this.effort = effort; this.spawnFn = spawnFn;
    this.child = null; this.turns = 0; this.chars = 0;
    this.queue = Promise.resolve();
    this.waiter = null; this.idleTimer = null; this.err = '';
  }

  ask(prompt, timeoutMs) {
    const run = this.queue.then(() => this._ask(prompt, timeoutMs));
    this.queue = run.catch(() => {});
    return run;
  }

  close() {
    clearTimeout(this.idleTimer);
    const c = this.child;
    this.child = null;
    if (!c) return;
    // 入力を閉じれば claude は自分で終わる。WSL 越しだと kill が中まで届かないことがあるので先に閉じる
    try { c.stdin.end(); } catch {}
    setTimeout(() => { try { c.kill(); } catch {} }, 3000).unref?.();
  }

  _start() {
    this.turns = 0; this.chars = 0; this.err = '';
    let child;
    try {
      child = this.spawnFn(this.inv.cmd, sessionArgs(this.inv.args, this.effort),
        { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });   // cwd の理由は runClaudeOnce と同じ（CLAUDE.md を読ませない）
    } catch (e) {
      return { ok: false, error: e.message, spawnFailed: true };
    }
    this.child = child;
    let buf = '';
    child.stdout.setEncoding('utf8');   // 日本語が 64KB の切れ目で割れないように（runClaudeOnce と同じ）
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const r = parseSessionLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        // 捨てた古い claude（時間切れ・起動し直し）が遅れて返した答えを、次の依頼の答えにしない
        if (r && this.waiter && this.child === child) { const w = this.waiter; this.waiter = null; w(r); }
      }
    });
    child.stderr.on('data', (d) => { this.err = (this.err + d).slice(-2000); });
    child.stdin.on('error', () => {});   // 先に終わっていたら EPIPE。結果は close で拾う
    const gone = (r) => {
      if (this.child !== child) return;   // もう捨てた古いほう
      this.child = null;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(r); }
    };
    child.on('error', (e) => gone({ ok: false, error: e.message, spawnFailed: e.code === 'ENOENT' }));
    child.on('close', (code) => gone({ ok: false, code,
      error: (this.err.trim() || `claude が終了しました（終了コード ${code}）`).slice(0, 500) }));
    return null;
  }

  async _ask(prompt, timeoutMs) {
    clearTimeout(this.idleTimer);
    if (this.child && (this.turns >= SESSION_MAX_TURNS || this.chars >= SESSION_MAX_CHARS)) {
      log(`[claude] 会話が長くなったので起動し直します（${this.turns}回・${this.chars}字）`);
      this.close();
    }
    let fresh = false;
    if (!this.child) {
      const bad = this._start();
      if (bad) return bad;
      fresh = true;
    }
    const child = this.child;
    const r = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        // 途中の会話がどうなっているか分からないので、捨てて次は起動し直す
        this.close();
        resolve({ ok: false, error: `${timeoutMs / 1000}秒待っても返事がありませんでした` });
      }, timeoutMs);
      this.waiter = (x) => { clearTimeout(timer); resolve(x); };
      try { child.stdin.write(sessionMessageLine(prompt)); } catch { /* close で拾う */ }
    });
    if (r.ok) { this.turns++; this.chars += String(prompt).length; }
    r.fresh = fresh;
    if (this.child) {
      this.idleTimer = setTimeout(() => this.close(), SESSION_IDLE_MS);
      this.idleTimer.unref?.();
    }
    return r;
  }
}

const sessions = new Map();   // effort ごとに1本
let sessionUnsupported = false;

/**
 * 会話を切らずに claude を呼ぶ (v0.24.53)
 * 呼び方がまだ決まっていなければ、まず起動し直す方式で1回呼んで決める
 */
async function runClaudeSession(prompt, opts) {
  const { effort, timeoutMs } = claudeRunOptions(opts);
  if (sessionUnsupported || !claudeInvocation) return runClaude(prompt, opts);
  const key = `${claudeInvocation.cmd}|${effort || ''}`;
  let s = sessions.get(key);
  if (!s) { s = new ClaudeSession(claudeInvocation, effort); sessions.set(key, s); }
  const r = await s.ask(prompt, timeoutMs);
  if (r.ok) return { ok: true, text: r.text, session: true };
  // 起動した直後の1回目で落ちた＝この claude は stream-json か --effort を知らない、かもしれない。
  // ログイン切れ・時間切れはどちらの方式でも同じなので、戻さずそのまま返す
  // 答えの行（is_error 付き）が返ってきたなら stream-json は通じている。戻すのは「答えずに終わった」ときだけ
  if (r.fresh && (r.spawnFailed || 'code' in r) && !/authenticat|OAuth|unauthorized|401/i.test(r.error || '')) {
    log(`[claude] 会話を切らずに使えなかったので、毎回起動する方式に戻します: ${r.error}`);
    sessionUnsupported = true;
    s.close(); sessions.delete(key);
    return runClaude(prompt, opts);
  }
  return r;
}

/** 開いている会話を全部閉じる（ホストが終わるとき） */
function closeClaudeSessions() {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

/** いま覚えている呼び方（health で返す） */
function claudeInvocationName() { return claudeInvocation ? claudeInvocation.cmd : null; }

module.exports = {
  CLAUDE_MAX_CHARS, CLAUDE_TIMEOUT_MS, claudeRunOptions,
  runClaude, checkClaudeAuth, claudeAuthLogin, claudeInvocationName, setLogger,
  runClaudeSession, closeClaudeSessions, ClaudeSession, parseSessionLine, sessionMessageLine, sessionArgs,
  SESSION_MAX_TURNS, SESSION_MAX_CHARS,
};
