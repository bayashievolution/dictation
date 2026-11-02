/**
 * dictation — ローカルHTTPサーバー
 * localhost で配信することで Chrome がマイク許可を永続化できる（file:// だと毎回聞かれる）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
// v0.24.21: claude を呼ぶ部分は claude-runner.js に切り出した（拡張のホストと共有する）
const {
  CLAUDE_MAX_CHARS, runClaude, checkClaudeAuth, claudeInvocationName, setLogger,
} = require('./claude-runner.js');
setLogger((msg) => console.log('  ' + msg));

const PORT = 8765;
const ROOT = __dirname;

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
      invocation: claudeInvocationName(),
      version: SERVER_VERSION,
      auth,
      features: ['effort', 'timeout'],   // v0.24.23
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
  // v0.24.23: リアルタイム要約は考える量を減らし、長く待つ（claude-runner.js の claudeRunOptions）
  const r = await runClaude(prompt, { effort: payload.effort, timeoutMs: payload.timeoutMs });
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
