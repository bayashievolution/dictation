// メモの「いまの行」の判定を、実物の関数のまま検査する。
//
// v0.24.2 で直したところ。貼り付けで入れ子ができると、以前は #memo の
// 直下の子（= 貼り付けた全文を含む外側の塊）が「いまの行」として返り、
// ^・ の判定が二度と当たらなくなっていた。
//
// jsdom は使わない（node_modules は .gitignore なので、入れた時点で
// このテストが走らなくなる）。nodeType / tagName / parentNode だけの
// 軽い張りぼてで足りる。
// ブラウザに本当に貼らせる検査は tests/browser/ にある。
const fs = require('fs'), vm = require('vm');

function grab(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} が見つからない`);
  let depth = 0, i = src.indexOf('{', src.indexOf(')', start)), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
function grabConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} が見つからない`);
  const end = src.indexOf(';', src.indexOf(']', start));
  return src.slice(start, end + 1);
}

const R = process.env.SRC || __dirname + '/../';
const app = fs.readFileSync(R + 'app.js', 'utf8');

const ctx = { console };
vm.createContext(ctx);
vm.runInContext([
  grabConst(app, 'MEMO_BLOCK_TAGS'),
  grab(app, 'memoBlockFromNode'),
  grab(app, 'memoStripListMarker'),
].join('\n'), ctx);

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}: ${JSON.stringify(got)}${ok ? '' : `（期待 ${JSON.stringify(want)}）`}`);
  if (!ok) fail++;
};

/* ── 張りぼてのノード ──
 * el('p', 'なまえ')  要素。name は assert で見分けるための目印
 * tx('文字')         テキストノード
 */
function el(tag, name) { return { nodeType: 1, tagName: tag.toUpperCase(), name: name || tag, parentNode: null }; }
function tx(name) { return { nodeType: 3, name: name || 'text', parentNode: null }; }
function tree(root, ...chain) {   // 上から下へつないで、いちばん下を返す
  let p = root;
  for (const n of chain) { n.parentNode = p; p = n; }
  return p;
}
const nameOf = (n) => (n ? n.name : null);

const memo = el('div', '#memo');

console.log('■ 手で打っているとき（#memo 直下の div が1行）');
{
  const div = el('div', '行div');
  const t = tx('文字');
  tree(memo, div, t);
  eq('テキストノードから行の div', nameOf(ctx.memoBlockFromNode(t, memo)), '行div');
  eq('要素そのものを渡しても同じ', nameOf(ctx.memoBlockFromNode(div, memo)), '行div');
}

console.log('\n■ 貼り付けで入れ子ができたとき（これが壊れていた）');
{
  // <div 外側><p>貼り付けた行</p><p>・ぶどう</p></div>
  const outer = el('div', '外側div');
  const p = el('p', '行p');
  const t = tx('・ぶどう');
  tree(memo, outer, p, t);
  eq('外側の塊ではなく内側の p', nameOf(ctx.memoBlockFromNode(t, memo)), '行p');
}
{
  // Google Docs などの <span style> 入り: <div 外側><div 行><span>・ぶどう</span></div></div>
  const t = tx('・ぶどう');
  tree(memo, el('div', '外側div'), el('div', '行div'), el('span', 'span'), t);
  eq('span は飛ばして内側の div', nameOf(ctx.memoBlockFromNode(t, memo)), '行div');
}
{
  // 表の中。td を行として返す（箇条書きにはならないが、外側の table を
  // 返して全文を1行扱いするよりはまし）
  const t = tx('い');
  tree(memo, el('div', '外側div'), el('table', 'table'), el('tbody', 'tbody'),
       el('tr', 'tr'), el('td', 'td'), t);
  eq('表の中は td', nameOf(ctx.memoBlockFromNode(t, memo)), 'td');
}

console.log('\n■ ブロックが見つからないときは従来どおり直下の子');
{
  const t = tx('文字');
  tree(memo, el('span', '直下span'), el('b', 'b'), t);
  eq('インラインだけなら直下の子', nameOf(ctx.memoBlockFromNode(t, memo)), '直下span');
}

console.log('\n■ 箇条書きの中は li を返す（ul ではない）');
{
  const t = tx('みかん');
  tree(memo, el('ul', 'ul'), el('li', 'li'), t);
  eq('ul ではなく li', nameOf(ctx.memoBlockFromNode(t, memo)), 'li');
}

console.log('\n■ 変なものを渡しても落ちない');
eq('node が null', ctx.memoBlockFromNode(null, memo), null);
eq('root が null', ctx.memoBlockFromNode(el('div'), null), null);
eq('root 自身', ctx.memoBlockFromNode(memo, memo), null);

console.log('\n■ すでに li の中で打たれた行頭の記号を外す');
eq('・みかん', ctx.memoStripListMarker('・みかん'), 'みかん');
eq('・ みかん（空白あり）', ctx.memoStripListMarker('・ みかん'), 'みかん');
eq('- りんご', ctx.memoStripListMarker('- りんご'), 'りんご');
eq('* ぶどう', ctx.memoStripListMarker('* ぶどう'), 'ぶどう');
eq('・ だけなら触らない（打ちかけを消さない）', ctx.memoStripListMarker('・'), null);
eq('-だけなら触らない', ctx.memoStripListMarker('-'), null);
eq('-りんご（空白なし）は記号ではない', ctx.memoStripListMarker('-りんご'), null);
eq('ふつうの行', ctx.memoStripListMarker('ふつうの行'), null);
eq('行頭以外の ・ は残す', ctx.memoStripListMarker('・A・B'), 'A・B');
eq('空文字', ctx.memoStripListMarker(''), null);
eq('null', ctx.memoStripListMarker(null), null);

console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
process.exit(fail === 0 ? 0 : 1);
