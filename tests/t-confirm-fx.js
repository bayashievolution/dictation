// 確定の演出（v0.24.119・confirm-fx.js）の純関数
//   - fxDiffMarks: 仮の字から変わった字だけに印が付く（「直ったところが光る」で使う）
//   - stripFxSpans: 演出の途中で保存しても、1 文字ずつの包みが残らない（残ると開き直したときに薄いまま）
//   - fxStyle: 終わり（p=1）ではどの見せ方も濃さ 1・ぼかし 0・光 0 に戻る
const fs = require('fs'), vm = require('vm');
const SRC = process.env.SRC || __dirname + '/../';
let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
if (!fs.existsSync(SRC + 'confirm-fx.js')) { console.log('✕ confirm-fx.js が無い'); process.exit(1); }
const ctx = { console, Math, Array, Uint16Array, JSON };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC + 'confirm-fx.js', 'utf8'), ctx);
const F = ctx.ConfirmFx;

const marked = (o, n) => { const m = F.fxDiffMarks(o, n); return Array.from(n).filter((_, i) => m[i]).join(''); };
eq('句読点を足しただけなら、句読点だけ光る', marked('今日は火事の話です', '今日は、火事の話です。'), '、。');
eq('聞き違いを直したところが光る', marked('かていかしつで火事', '家庭科室で火事'), '家庭科室');
eq('同じなら何も光らない', marked('同じです', '同じです'), '');
eq('仮の字が無ければ全部', marked('', 'あいう'), 'あいう');
eq('長すぎるときは計算せずに全部（固まらない）', F.fxDiffMarks('あ'.repeat(1000), 'い'.repeat(500)).every(Boolean), true);
eq('絵文字などのサロゲートも 1 文字', F.fxDiffMarks('', '𠮷野').length, 2);

eq('包みを外す', F.stripFxSpans('<div class="p-body">今日は<span class="fxc" style="opacity: 0.3;">、</span>火事<span class="fxc" style="opacity:0">。</span></div>'), '<div class="p-body">今日は、火事。</div>');
eq('&amp; のような字も残る', F.stripFxSpans('<span class="fxc" style="opacity: 0;">&amp;</span>'), '&amp;');
eq('包みが無ければそのまま', F.stripFxSpans('<p>そのまま</p>'), '<p>そのまま</p>');

for (const m of ['fade', 'type', 'blur', 'diff']) {
  const st = F.fxStyle(m, 1, 9, 10);
  const ok = st.opacity === 1 && (!st.filter || /blur\(0\.00px\)/.test(st.filter)) && (!st.backgroundColor || / 0\.0%/.test(st.backgroundColor));
  eq(`${m}: 終わりは元の見た目`, ok, true);
}
eq('一文字ずつ: 途中では頭のほうが濃い', F.fxStyle('type', 0.5, 0, 20).opacity > F.fxStyle('type', 0.5, 19, 20).opacity, true);
eq('選べるのは なし＋4 つ', F.CONFIRM_FX.map((o) => o.value), ['none', 'fade', 'type', 'blur', 'diff']);

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
