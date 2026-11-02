// claude-host.js（拡張のネイティブメッセージングのホスト）を、本物の node で起動して
// Chrome と同じ形（4バイトの長さ＋JSON）でやり取りして検査する (v0.24.21)。
//
// 依存なし。claude は偽物（PATH の先頭に置いたシェルスクリプト）に差し替える。
// 本物の Chrome / Edge から起動されることは、ここでは見ていない（Windows でしか確かめられない）。
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');

const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const HOST = path.join(SRC, 'claude-host.js');

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

if (!fs.existsSync(HOST)) { console.log('✕ claude-host.js がない'); process.exit(1); }

// 偽の claude。-p なら標準入力を「答え:」付きで返す。auth status なら JSON。
// FAKE_FAIL があれば認証エラーで落ちる
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeclaude-'));
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = "auth" ]; then echo '{"loggedIn": true, "authMethod": "oauth_token"}'; exit 0; fi
if [ -n "$FAKE_FAIL" ]; then echo "Failed to authenticate: OAuth session expired" >&2; exit 1; fi
if [ -n "$OLD_CLAUDE" ] && [ "$2" = "--effort" ]; then echo "error: unknown option '--effort'" >&2; exit 1; fi
if [ -n "$ECHO_ARGS" ]; then echo "ARGS:$*"; cat >/dev/null; exit 0; fi
printf '答え:'; cat
`, { mode: 0o755 });

function frame(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0);
  return Buffer.concat([h, b]);
}

/** ホストを起動して1通送り、返事を1通読む。Chrome の sendNativeMessage と同じ */
function ask(msg, env = {}, raw = null) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOST], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = Buffer.alloc(0);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.on('close', (code) => {
      if (out.length < 4) return resolve({ code, raw: out.toString() });
      const len = out.readUInt32LE(0);
      const rest = out.length - 4 - len;
      let reply = null;
      try { reply = JSON.parse(out.subarray(4, 4 + len).toString('utf8')); } catch {}
      resolve({ code, reply, extraBytes: rest });
    });
    child.stdin.end(raw || frame(msg));
  });
}

(async () => {
  console.log('■ health');
  {
    const r = await ask({ type: 'health' });
    eq('返事は1通だけで、余計なバイトが無い（標準出力に何も混ざらない）', r.extraBytes, 0);
    eq('ok と ログイン状態', [r.reply.ok, r.reply.auth.loggedIn, r.reply.invocation, r.reply.via], [true, true, 'claude', 'native']);
    eq('版はリポジトリの manifest.json と同じ', r.reply.version,
       JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8')).version);
    eq('返したら終わる（終了コード 0）', r.code, 0);
  }

  console.log('\n■ run');
  {
    const r = await ask({ type: 'run', prompt: '要約して\n「引用」と \\ と 日本語' });
    eq('プロンプトは標準入力でそのまま渡る（記号も改行も）', [r.reply.ok, r.reply.text], [true, '答え:要約して\n「引用」と \\ と 日本語']);
    eq('かかった秒数を返す', typeof r.reply.seconds, 'number');
  }
  {
    const r = await ask({ type: 'run', prompt: 'x' }, { FAKE_FAIL: '1' });
    eq('claude が失敗したら理由を返す（アプリ側でログイン切れと分かる文言）',
       [r.reply.ok, /OAuth session expired/.test(r.reply.error)], [false, true]);
  }
  {
    const big = 'あ'.repeat(150000);   // 450KB。Chrome → ホストは 64MB まで
    const r = await ask({ type: 'run', prompt: big });
    eq('長い文字起こしも1通で受け取れる（返事が途中で切れない）', [r.reply.ok, r.reply.text.length], [true, 3 + 150000]);
    // v0.24.21 で見つけた穴: claude の出力を Buffer のまま繋ぐと 64KB の切れ目で文字が割れた
    eq('日本語が切れ目で化けない（「�」が無い）', r.reply.text.indexOf('\uFFFD'), -1);
  }

  console.log('\n■ リアルタイム要約の調整（v0.24.23）');
  {
    const r = await ask({ type: 'run', prompt: 'x', effort: 'low', timeoutMs: 600000 }, { ECHO_ARGS: '1' });
    eq('effort は -p の直後に --effort として渡る', r.reply.text, 'ARGS:-p --effort low');
  }
  {
    const r = await ask({ type: 'run', prompt: 'x' }, { ECHO_ARGS: '1' });
    eq('調整なしなら付けない（要約・質問はこれまでどおり）', r.reply.text, 'ARGS:-p');
  }
  {
    const r = await ask({ type: 'run', prompt: 'x', effort: 'low; rm -rf /' }, { ECHO_ARGS: '1' });
    eq('決めた値以外は渡さない', r.reply.text, 'ARGS:-p');
  }
  {
    const r = await ask({ type: 'run', prompt: 'こんにちは', effort: 'low' }, { OLD_CLAUDE: '1' });
    eq('--effort を知らない古い claude なら、付けずに呼び直す', [r.reply.ok, r.reply.text], [true, '答え:こんにちは']);
  }
  {
    const r = await ask({ type: 'health' });
    eq('health は分かる調整を返す（アプリが入れ直しを促す目印）', r.reply.features, ['effort', 'timeout']);
  }
  {
    const { claudeRunOptions } = require(path.join(SRC, 'claude-runner.js'));
    eq('待つ上限: 指定なしは 180秒', claudeRunOptions({}).timeoutMs, 180000);
    eq('待つ上限: 600秒はそのまま', claudeRunOptions({ timeoutMs: 600000 }).timeoutMs, 600000);
    eq('待つ上限: 短すぎ・長すぎは丸める', [claudeRunOptions({ timeoutMs: 1 }).timeoutMs, claudeRunOptions({ timeoutMs: 1e9 }).timeoutMs], [30000, 900000]);
  }

  console.log('\n■ おかしな依頼');
  {
    const r = await ask({ type: 'run', prompt: '   ' });
    eq('空のプロンプトは claude を呼ばずに断る', [r.reply.ok, r.reply.error], [false, 'prompt が空です']);
  }
  {
    const r = await ask({ type: 'nope' });
    eq('知らない依頼は断る', r.reply.ok, false);
  }
  {
    const b = Buffer.from('{こわれた', 'utf8');
    const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0);
    const r = await ask(null, {}, Buffer.concat([h, b]));
    eq('JSON でなければ断る（落ちない）', [r.reply && r.reply.ok, r.code], [false, 0]);
  }

  fs.rmSync(bin, { recursive: true, force: true });
  console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
  process.exit(fail ? 1 : 0);
})();
