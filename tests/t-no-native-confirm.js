// 本体（app.js）でブラウザの confirm() を使っていないかを見る（v0.24.117 で全部を自前の小窓 confirmDialog にした）。
// ブラウザの小窓は動きを付けられず、見た目もディクテーションと違う（UI・UX 仕様の 5 章）。
// confirmDialog の中の、小窓が無いときの逃げ道（window.confirm）だけは許す
const fs = require('fs'), path = require('path');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const s = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
const lines = s.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /(^|[^\w.])confirm\(/.test(l) && !/^\s*\/\//.test(l));
const ok = lines.length === 0;
console.log(`${ok ? '✓' : '✕'} app.js にブラウザの confirm() が無い` + (ok ? '' : '\n    ' + lines.map(([n, l]) => `${n}: ${l.trim().slice(0, 80)}`).join('\n    ')));
console.log(ok ? '\nすべて通過' : '\n✕ 1 件失敗');
process.exit(ok ? 0 : 1);
