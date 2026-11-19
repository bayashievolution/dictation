// 要素からプレーンテキストを取り出す処理を、実物の関数のまま検査する。
//
// v0.24.3 で入れた。innerText は**画面に出ている見た目**を返すので、
// タブが閉じているペインや document に繋がっていない div では textContent に
// 落ち、**改行が全部消える**。質問ペインに渡すメモと要約はこれまでずっと
// 一塊で渡っていた（質問するときに開いているのは必ず質問タブなので）。
//
// jsdom は使わない。childNodes / nodeType / tagName / data だけの張りぼてで足りる。
// 実機での確認は tests/browser/t-plain-text-browser.js。
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
  grabConst(app, 'PLAIN_LINE_TAGS'),
  grab(app, 'elementToPlainText'),
].join('\n'), ctx);

let fail = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? '✓' : '✕'} ${label}: ${JSON.stringify(got)}${ok ? '' : `（期待 ${JSON.stringify(want)}）`}`);
  if (!ok) fail++;
};

// 張りぼて: el('div', [子...]) / tx('文字')
const tx = (data) => ({ nodeType: 3, data });
const el = (tag, children) => ({ nodeType: 1, tagName: tag.toUpperCase(), childNodes: children || [] });

console.log('■ 1行ずつのブロック（メモの基本形）');
eq('div が3つ',
   ctx.elementToPlainText(el('div', [
     el('div', [tx('いちぎょう')]), el('div', [tx('にぎょう')]), el('div', [tx('さんぎょう')]),
   ])),
   'いちぎょう\nにぎょう\nさんぎょう');

console.log('\n■ 箇条書き（項目の間に空行を入れない）');
eq('ul > li が3つ',
   ctx.elementToPlainText(el('div', [
     el('ul', [el('li', [tx('りんご')]), el('li', [tx('ばなな')]), el('li', [tx('ぶどう')])]),
   ])),
   'りんご\nばなな\nぶどう');

console.log('\n■ 見出し・引用・入れ子');
eq('h2 + ul + blockquote',
   ctx.elementToPlainText(el('div', [
     el('h2', [tx('第3回 評価論')]),
     el('ul', [el('li', [tx('観点は三つ'), el('ul', [el('li', [tx('様式はA4')])])])]),
     el('blockquote', [tx('段階を置く')]),
   ])),
   '第3回 評価論\n観点は三つ\n様式はA4\n段階を置く');

console.log('\n■ インライン要素は行を割らない');
eq('span / b / a はそのまま繋ぐ',
   ctx.elementToPlainText(el('div', [
     el('div', [tx('これは'), el('b', [tx('太い')]), el('span', [tx('ところ')])]),
   ])),
   'これは太いところ');

console.log('\n■ <br>（Shift+Enter）は書き手が入れた改行なので残す');
eq('行の中の <br>',
   ctx.elementToPlainText(el('div', [el('div', [tx('うえ'), el('br'), tx('した')])])),
   'うえ\nした');
eq('空の <div><br></div> は空行になる',
   ctx.elementToPlainText(el('div', [
     el('div', [tx('まえ')]), el('div', [el('br')]), el('div', [tx('あと')]),
   ])),
   'まえ\n\nあと');

console.log('\n■ 文字を持たない要素は飛ばす');
eq('img は無視',
   ctx.elementToPlainText(el('div', [
     el('div', [tx('写真のまえ')]), el('img'), el('div', [tx('写真のあと')]),
   ])),
   '写真のまえ\n写真のあと');
eq('チェックボックスの input は無視して文字だけ',
   ctx.elementToPlainText(el('div', [
     el('div', [el('input'), el('span', [tx('資料DL')])]),
   ])),
   '資料DL');

console.log('\n■ 端の空白・余分な空行');
eq('前後の空白は落とす',
   ctx.elementToPlainText(el('div', [tx('\n  '), el('div', [tx('ほんぶん')]), tx('  \n')])),
   'ほんぶん');
eq('空行は1つまで',
   ctx.elementToPlainText(el('div', [
     el('div', [tx('まえ')]),
     el('div', [el('br')]), el('div', [el('br')]), el('div', [el('br')]),
     el('div', [tx('あと')]),
   ])),
   'まえ\n\nあと');

console.log('\n■ 変なものを渡しても落ちない');
eq('null', ctx.elementToPlainText(null), '');
eq('子が無い', ctx.elementToPlainText(el('div', [])), '');
eq('コメントノード等は無視',
   ctx.elementToPlainText(el('div', [{ nodeType: 8 }, el('div', [tx('ほんぶん')])])),
   'ほんぶん');

console.log(fail === 0 ? '\nすべて通過' : `\n失敗 ${fail} 件`);
process.exit(fail === 0 ? 0 : 1);
