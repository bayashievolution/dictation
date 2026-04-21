/**
 * dictation — ローカルHTTPサーバー
 * localhost で配信することで Chrome がマイク許可を永続化できる（file:// だと毎回聞かれる）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8765;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
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
