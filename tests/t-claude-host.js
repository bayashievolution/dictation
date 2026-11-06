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
case "$*" in *stream-json*) exec "${process.execPath}" "$(dirname "$0")/fake-session.js" "$@";; esac
if [ -n "$ECHO_ARGS" ]; then echo "ARGS:$*"; cat >/dev/null; exit 0; fi
printf '答え:'; cat
`, { mode: 0o755 });
// v0.24.53: 会話を切らずに使うとき（stream-json）の偽物。1行受け取るたびに、何回目か・自分の pid を付けて返す。
// OLD_STREAM なら stream-json を知らない古い claude のふり。CRASH と書かれた依頼では答えずに落ちる
fs.writeFileSync(path.join(bin, 'fake-session.js'), `
if (process.env.OLD_STREAM) { process.stderr.write("error: unknown option '--input-format'\\n"); process.exit(1); }
let n = 0, buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const c = JSON.parse(line).message.content;
    if (c.includes('CRASH')) process.exit(3);
    n++;
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      result: '会話' + n + '@' + process.pid + ':' + c + (process.argv.includes('low') ? ':low' : '') }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`);

/**
 * ホストを起動したまま何通も送る (v0.24.53)。Chrome の connectNative と同じ。
 * 1通送って返事を待ち、次を送る。最後に入力を閉じて、ホストが終わるのを待つ
 */
function converse(msgs, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOST], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = Buffer.alloc(0), waiter = null;
    const replies = [];
    child.stdout.on('data', (d) => {
      out = Buffer.concat([out, d]);
      while (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) {
        const len = out.readUInt32LE(0);
        replies.push(JSON.parse(out.subarray(4, 4 + len).toString('utf8')));
        out = out.subarray(4 + len);
        if (waiter) { const w = waiter; waiter = null; w(); }
      }
    });
    const t0 = Date.now();
    let endedAt = 0;
    child.on('close', (code) => resolve({ replies, code, closeMs: Date.now() - endedAt, totalMs: Date.now() - t0 }));
    (async () => {
      for (const m of msgs) {
        const want = replies.length + 1;
        child.stdin.write(frame(m));
        if (replies.length < want) await new Promise((r) => { waiter = r; });
      }
      endedAt = Date.now();
      child.stdin.end();
    })();
  });
}

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
    eq('health は分かる調整を返す（アプリが入れ直しを促す目印）', r.reply.features, ['effort', 'timeout', 'session']);
  }
  {
    const { claudeRunOptions } = require(path.join(SRC, 'claude-runner.js'));
    eq('待つ上限: 指定なしは 180秒', claudeRunOptions({}).timeoutMs, 180000);
    eq('待つ上限: 600秒はそのまま', claudeRunOptions({ timeoutMs: 600000 }).timeoutMs, 600000);
    eq('待つ上限: 短すぎ・長すぎは丸める', [claudeRunOptions({ timeoutMs: 1 }).timeoutMs, claudeRunOptions({ timeoutMs: 1e9 }).timeoutMs], [30000, 900000]);
  }

  console.log('\n■ 会話を切らずに使う（v0.24.53）');
  {
    const run = (prompt, id) => ({ type: 'run', prompt, session: true, effort: 'low', timeoutMs: 60000, id });
    const r = await converse([run('一', 1), run('二', 2), run('三', 3), { type: 'run', prompt: '要約', id: 4 }]);
    const t = r.replies.map((x) => x.text);
    eq('返事に依頼と同じ id が付く', r.replies.map((x) => x.id), [1, 2, 3, 4]);
    eq('1回目は呼び方を決めるため、毎回起動する方式で呼ぶ', t[0], '答え:一');
    const m2 = /^会話1@(\d+):二:low$/.exec(t[1] || ''), m3 = /^会話2@(\d+):三:low$/.exec(t[2] || '');
    eq('2回目からは同じ claude に続けて送る（会話の何回目か・同じ pid）', [!!m2, !!m3, m2 && m3 && m2[1] === m3[1]], [true, true, true]);
    eq('session の付いていない依頼（要約など）はこれまでどおり毎回起動', t[3], '答え:要約');
    eq('入力を閉じたら、立たせておいた claude も閉じてホストが終わる', [r.code, r.closeMs < 3000], [0, true]);
    let alive = true;
    try { process.kill(Number(m2 && m2[1]), 0); } catch { alive = false; }
    eq('claude（偽物）のプロセスも残っていない', alive, false);
  }
  {
    const run = (prompt, id) => ({ type: 'run', prompt, session: true, id });
    const r = await converse([run('一', 1), run('二', 2), run('CRASH', 3), run('四', 4)]);
    const t = r.replies.map((x) => x.text || x.error);
    eq('途中で claude が落ちたら、その依頼は失敗として返す', r.replies[2].ok, false);
    const a = /@(\d+):/.exec(t[1] || ''), b = /^会話1@(\d+):四$/.exec(t[3] || '');
    eq('次の依頼では起動し直して続ける（別の pid の1回目）', [!!b, a && b && a[1] !== b[1]], [true, true]);
  }
  {
    const run = (prompt, id) => ({ type: 'run', prompt, session: true, id });
    const r = await converse([run('一', 1), run('二', 2), run('三', 3)], { OLD_STREAM: '1' });
    eq('stream-json を知らない古い claude なら、毎回起動する方式に戻して答える',
       r.replies.map((x) => x.text), ['答え:一', '答え:二', '答え:三']);
  }
  {
    const { SESSION_MAX_TURNS } = require(path.join(SRC, 'claude-runner.js'));
    const msgs = [];
    for (let i = 0; i <= SESSION_MAX_TURNS + 1; i++) msgs.push({ type: 'run', prompt: 'q' + i, session: true, id: i });
    const r = await converse(msgs);
    const pids = r.replies.slice(1).map((x) => (/@(\d+):/.exec(x.text || '') || [])[1]);
    eq(`${SESSION_MAX_TURNS}回ごとに起動し直す（会話が長くなりすぎないように）`,
       [new Set(pids.slice(0, SESSION_MAX_TURNS)).size, pids[SESSION_MAX_TURNS] !== pids[0], /^会話1@/.test(r.replies[SESSION_MAX_TURNS + 1].text)],
       [1, true, true]);
  }
  {
    const r = await ask({ type: 'health' });
    eq('health は session を知っていると返す（古い連携には入れ直しを促す）', r.reply.features.includes('session'), true);
  }
  {
    const { parseSessionLine } = require(path.join(SRC, 'claude-runner.js'));
    eq('答えの行', parseSessionLine('{"type":"result","subtype":"success","is_error":false,"result":" 本文 "}'), { ok: true, text: '本文' });
    eq('答え以外の行は無視', [parseSessionLine('{"type":"system"}'), parseSessionLine('こわれた')], [null, null]);
    eq('エラーの答え（ログイン切れなど）は理由を返す',
       parseSessionLine('{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate"}'),
       { ok: false, error: 'Failed to authenticate' });
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
