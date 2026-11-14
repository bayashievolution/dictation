// motion.js（SUMADO のばねを写したもの・v0.24.59）を、実物のまま検査する。
// 値と計算が SUMADO の extension/js/spring.js と同じであること、ばねの性質（行き過ぎる・行き過ぎない）を見る。
// 毎フレームの動き（requestAnimationFrame）は tests/browser/ で見る。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const file = path.join(SRC, 'motion.js');
if (!fs.existsSync(file)) { console.log('✕ motion.js が無い'); process.exit(1); }
const ctx = { Math, Object, Array, Set, WeakMap, Map, Promise, globalThis: null };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const M = ctx.Motion;

console.log('■ 値は SUMADO の仕様書 2.1 と同じ');
eq('app', M.SPRINGS.app, { response: 0.42, dampingFraction: 0.86 });
eq('page', M.SPRINGS.page, { response: 0.38, dampingFraction: 0.92 });
eq('press', M.SPRINGS.press, { response: 0.22, dampingFraction: 0.7 });
eq('sheet', M.SPRINGS.sheet, { response: 0.36, dampingFraction: 0.9 });
eq('fade', M.SPRINGS.fade, { response: 0.3, dampingFraction: 1 });
eq('ポップアップ（少し行き過ぎてぽん）', [M.MOTION.pop, M.MOTION.popFrom, M.MOTION.alertFrom], [{ response: 0.36, dampingFraction: 0.6 }, 0.5, 1.15]);

console.log('\n■ ばねの性質');
const run = (cfg, from, to, sec = 2) => {
  const s = new M.Spring1D(from); s.configure(cfg); s.target = to;
  let max = -Infinity, min = Infinity;
  for (let t = 0; t < sec; t += 1 / 60) { s.step(1 / 60); max = Math.max(max, s.value); min = Math.min(min, s.value); }
  return { end: s.value, max, min, rest: s.atRest(0.001) };
};
{
  const r = run(M.SPRINGS.fade, 0, 1);
  eq('fade は行き過ぎない（1 を超えない）', r.max <= 1.0001, true);
  eq('止まる', Math.abs(r.end - 1) < 0.001, true);
}
{
  const r = run(M.MOTION.pop, 0.5, 1);
  eq('ポップアップは少し行き過ぎる（1 を超える）', r.max > 1.02, true);
  eq('最後は 1 に収まる', Math.abs(r.end - 1) < 0.001, true);
}
{
  const r = run(M.SPRINGS.sheet, 0, 100, 0.2);
  eq('0.2 秒でだいたい近くまで来る（遅すぎない）', r.end > 60, true);
}
{
  // dt が大きくても（タブが裏にいた等）細かく分けて計算するので暴れない
  const s = new M.Spring1D(0); s.configure(M.SPRINGS.app); s.target = 1;
  s.step(0.064);
  eq('大きな dt でも発散しない', s.value > 0 && s.value < 1.5, true);
}

console.log('\n■ 保存する HTML から、ばねの途中の値を取り除く（v0.24.70）');
{
  const st = M.stripMotionStyles;
  eq('ばねが書いた transform だけなら style ごと消す',
     st('<div class="paragraph" style="transform: translate3d(0px, -47px, 0px) scale(1, 1);">a</div>'), '<div class="paragraph">a</div>');
  eq('opacity も消す', st('<div style="opacity: 0.400;">a</div>'), '<div>a</div>');
  eq('ほかの style は残す（メモの画像の幅や位置）',
     st('<img style="width: 120px; transform: translate3d(1px, 2px, 0px) scale(1, 1); left: 3px;">'), '<img style="width: 120px; left: 3px;">');
  const plain = '<div style="width: 120px">a</div><p>opacity: 0.5; は本文</p>';
  eq('取り除くものが無ければ、文字列をまったく変えない（同じ参照）', st(plain) === plain, true);
  eq('本文に書かれた「opacity: 0.5;」は消さない', st('<p>opacity: 0.5;</p><div style="opacity: 0.1;">x</div>'), '<p>opacity: 0.5;</p><div>x</div>');
  eq('空・style なしはそのまま', [st(''), st('<p>a</p>')], ['', '<p>a</p>']);
}

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
