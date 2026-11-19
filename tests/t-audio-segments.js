// 保管した録音のかけらを区間ごとにまとめる（audio-store.js の groupAudioSegments・v0.24.163）
// やっさん 2026-11-19: 比較ページで流すと、会議の始まりと終わりの会話が 2 重に重なって聞こえた。
// 同じタブで録音を止めてまた始めると、2 回目のかけらも「区間 0 の 0 番・1 番…」で保管され、番号の順に並べると交互に混ざっていた
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const src = fs.readFileSync(path.join(SRC, 'audio-store.js'), 'utf8');
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const ctx = { Math, Number, Map, Array };
vm.createContext(ctx);
const start = src.indexOf('function groupAudioSegments');
vm.runInContext(src.slice(start, src.indexOf('/** そのセッションの音声を消す', start)), ctx);
const g = (rows) => ctx.groupAudioSegments(rows).map((x) => ({ seg: x.seg, parts: x.parts }));

console.log('■ 1 回の録音');
eq('区間の中は番号の順', g([{ seg: 0, seq: 1, blob: 'b', savedAt: 2 }, { seg: 0, seq: 0, blob: 'a', savedAt: 1 }, { seg: 0, seq: 2, blob: 'c', savedAt: 3 }]), [{ seg: 0, parts: ['a', 'b', 'c'] }]);
eq('約 10 分ごとの区間は分ける', g([{ seg: 0, seq: 0, blob: 'a', savedAt: 1 }, { seg: 1, seq: 0, blob: 'x', savedAt: 5 }, { seg: 0, seq: 1, blob: 'b', savedAt: 2 }]), [{ seg: 0, parts: ['a', 'b'] }, { seg: 1, parts: ['x'] }]);

console.log('\n■ 同じタブで止めて、また録音した（どちらも区間 0 の 0 番から）');
const rows = [
  { seg: 0, seq: 0, blob: '1回目-0', savedAt: 100 }, { seg: 0, seq: 1, blob: '1回目-1', savedAt: 101 }, { seg: 0, seq: 2, blob: '1回目-2', savedAt: 102 },
  { seg: 0, seq: 0, blob: '2回目-0', savedAt: 500 }, { seg: 0, seq: 1, blob: '2回目-1', savedAt: 501 },
];
eq('交互に混ぜず、録音ごとに別の区間にする（時刻の順）', g(rows), [{ seg: 0, parts: ['1回目-0', '1回目-1', '1回目-2'] }, { seg: 1, parts: ['2回目-0', '2回目-1'] }]);
eq('並びが崩れて届いても同じ', g(rows.slice().reverse()), [{ seg: 0, parts: ['1回目-0', '1回目-1', '1回目-2'] }, { seg: 1, parts: ['2回目-0', '2回目-1'] }]);

console.log('\n■ 時刻の無い古いレコード');
eq('番号の順だけで並べる（前と同じ）', g([{ seq: 1, blob: 'b' }, { seq: 0, blob: 'a' }]), [{ seg: 0, parts: ['a', 'b'] }]);
console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
