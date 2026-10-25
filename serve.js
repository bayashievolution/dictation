/**
 * dictation — ローカルHTTPサーバー
 * localhost で配信することで Chrome がマイク許可を永続化できる（file:// だと毎回聞かれる）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const os = require('os');

const PORT = 8765;
const ROOT = __dirname;

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
 * いま動いているサーバーの版 (v0.24.11)
 *
 * **ファイルの版ではなく、走っているプロセスの版**。
 * update.bat はファイルを入れ替えるが、走っている node は入れ替わらない。
 * やっさんが実際にここで詰まった（最小化された古い窓が生きていた）ので、
 * 起動時に出し、health でも返す。
 */
function readVersion() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
    return m.version || '?';
  } catch { return '?'; }
}
const SERVER_VERSION = readVersion();

/**
 * claude を1回呼ぶ。プロンプトは標準入力で渡す
 * @returns {Promise<{ok:boolean, text?:string, error?:string, code?:number}>}
 */
function runClaudeOnce({ cmd, args }, prompt) {
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
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });
    } catch (e) {
      resolve({ ok: false, error: e.message, spawnFailed: true });
      return;
    }
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `${CLAUDE_TIMEOUT_MS / 1000}秒待っても返事がありませんでした` });
    }, CLAUDE_TIMEOUT_MS);

    child.on('error', (e) => {
      clearTimeout(timer);
      // ENOENT = その呼び方では見つからない。次の候補を試す合図
      finish({ ok: false, error: e.message, spawnFailed: e.code === 'ENOENT' });
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) finish({ ok: true, text: out.trim() });
      else finish({ ok: false, code, error: (err.trim() || out.trim() || `終了コード ${code}`).slice(0, 500) });
    });

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
        console.log(`  [claude] 呼び方が決まりました: ${inv.cmd} ${inv.args.join(' ')}`);
      }
      return r;
    }
    last = r;
    if (!r.spawnFailed) break;   // 見つからない以外は呼び方の問題ではない
  }
  return last || { ok: false, error: 'claude を実行できませんでした' };
}

/** 覚えた呼び方を使い、無ければ順に試す */
async function runClaude(prompt) {
  const order = claudeInvocation
    ? [claudeInvocation]
    : CLAUDE_CANDIDATES;
  let last = null;
  for (const inv of order) {
    const r = await runClaudeOnce(inv, prompt);
    if (r.ok) {
      if (!claudeInvocation) {
        claudeInvocation = inv;
        console.log(`  [claude] 呼び方が決まりました: ${inv.cmd} ${inv.args.join(' ')}`);
      }
      return r;
    }
    last = r;
    // 見つからない以外の失敗（認証エラー等）は、呼び方の問題ではないので次を試さない
    if (!r.spawnFailed) break;
  }
  return last || { ok: false, error: 'claude を実行できませんでした' };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 拡張（chrome-extension://…）からも呼べるようにする。
    // 127.0.0.1 でしか待ち受けていないので、外から届くことはない
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('送られてきた内容が大きすぎます')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** /api/claude を処理する。扱ったら true */
async function handleClaudeApi(req, res, urlPath) {
  if (!urlPath.startsWith('/api/claude')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    });
    res.end();
    return true;
  }

  // 使える状態かを聞く。
  // v0.24.9 までは claude を起動しない軽い確認だったが、それだと
  // ログインが切れていても「動いています」と言ってしまう。
  // `claude auth status` は要約（8〜10秒）と違ってすぐ返るので、そこまで見る
  if (urlPath === '/api/claude/health') {
    // v0.24.9: 生きているかだけでなく**ログインしているか**も返す。
    // 前は「中継は動いています」とだけ出ていたので、ログインが切れていても
    // 緱色で「動いています」と出てしまっていた（やっさんがこれで詰まった）
    const auth = await checkClaudeAuth();
    sendJson(res, 200, {
      ok: true,
      invocation: claudeInvocation ? claudeInvocation.cmd : null,
      version: SERVER_VERSION,
      auth,
    });
    return true;
  }

  if (urlPath !== '/api/claude' || req.method !== 'POST') {
    sendJson(res, 404, { ok: false, error: 'そのような口はありません' });
    return true;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req, CLAUDE_MAX_CHARS * 2));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
    return true;
  }
  const prompt = String(payload && payload.prompt || '');
  if (!prompt.trim()) { sendJson(res, 400, { ok: false, error: 'prompt が空です' }); return true; }
  if (prompt.length > CLAUDE_MAX_CHARS) {
    sendJson(res, 400, { ok: false, error: `長すぎます（${prompt.length}字 / 上限${CLAUDE_MAX_CHARS}字）` });
    return true;
  }

  const started = Date.now();
  const r = await runClaude(prompt);
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  if (r.ok) {
    console.log(`  [claude] ${prompt.length}字 → ${r.text.length}字 (${sec}秒)`);
    sendJson(res, 200, { ok: true, text: r.text, seconds: Number(sec) });
  } else {
    console.warn(`  [claude] 失敗 (${sec}秒): ${r.error}`);
    sendJson(res, 502, { ok: false, error: r.error });
  }
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    // v0.24.0: Claude Code ブリッジ。ファイル配信より先に見る
    if (await handleClaudeApi(req, res, urlPath)) return;
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, urlPath);
    const normalizedRoot = path.resolve(ROOT);
    const normalizedFile = path.resolve(filePath);
    if (!normalizedFile.startsWith(normalizedRoot)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end('Server error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`  版: ${SERVER_VERSION}`);
  console.log('');
  console.log(`  dictation サーバー起動: ${url}`);
  console.log('  Chrome が自動で開きます。手動で開く場合は上のURLへ。');
  console.log('  停止するにはこのウィンドウを閉じてください。');
  console.log('');
  exec(`start "" "${url}"`);
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} が既に使われています。別のdictationが動いているかも。`);
    console.error(`既に開いているなら http://localhost:${PORT}/ をブラウザで開いてください。`);
  } else {
    console.error('サーバー起動エラー:', e.message);
  }
  process.exit(1);
});
