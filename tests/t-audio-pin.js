// 録音を「残す」（v0.24.103）の判断を、実物の関数のまま検査する。
// 「残す」にしたのに消えるのが、いちばんまずい壊れ方（やっさんの検証用の会議の録音）。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const src = fs.readFileSync(path.join(SRC, 'audio-store.js'), 'utf8');
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const ctx = { Date, Math, Number };
vm.createContext(ctx);
vm.runInContext(src.slice(src.indexOf('const AUDIO_REPASS_BACKSTOP_MS'), src.indexOf('function formatBytes')), ctx);
const E = (o) => ctx.audioRetentionExpired({ now: 10 * 86400000, savedAt: 0, sessionExists: true, ...o });
console.log('■ 「残す」にした録音');
for (const r of ['close', 'repass', '1d', '7d', 'manual', 'off', 'なにか壊れた値']) {
  eq(`${r}: タブを閉じても消さない`, E({ retention: r, sessionExists: false, pinned: true }), false);
}
eq('話者判別が済んでも消さない', E({ retention: 'repass', repassDoneAt: 1, pinned: true }), false);
console.log('\n■ 「残す」でない録音は今までどおり');
eq('タブを閉じたら消す', E({ retention: 'close', sessionExists: false }), true);
eq('保持オフなら消す', E({ retention: 'off' }), true);
eq('7日たったら消す', E({ retention: '7d' }), true);
eq('タブを閉じたら消す（の設定で、タブがあれば）残す', E({ retention: 'close' }), false);
console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
