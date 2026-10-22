// Claude Code ブリッジの振り分けを、実物の関数のまま検査する。
// ここを間違えると「音声が Claude に飛ぶ」「録音中に詰まる」という形で壊れる。
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
const R = process.env.SRC || __dirname + '/../';
const src = fs.readFileSync(R + 'claude-bridge.js', 'utf8');
const ctx = { console, Set, Array, String, JSON };
vm.createContext(ctx);
const consts = /const CLAUDE_BRIDGE_FEATURES = new Set\(\[[\s\S]*?\]\);/.exec(src)[0];
vm.runInContext([consts, grab(src, 'claudeBridgeShouldUse'),
  grab(src, 'claudeBridgeBodyIsTextOnly'), grab(src, 'claudeBridgePromptFromBody'),
  grab(src, 'claudeBridgeUnfence'),
  '\nglobalThis.__feats = Array.from(CLAUDE_BRIDGE_FEATURES);'].join('\n'), ctx);
const { claudeBridgeShouldUse: use, claudeBridgeBodyIsTextOnly: textOnly,
        claudeBridgePromptFromBody: prompt, claudeBridgeUnfence: unfence } = ctx;

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}${ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`}`);
  if (!ok) fail++;
};
const TEXT = { contents: [{ role: 'user', parts: [{ text: 'あ' }] }] };
const on = (feature, body = TEXT) => use({ enabled: true, feature, body });

console.log('■ 回してよいもの（後処理）');
for (const f of ['whole-refine', 'summary', 'chat', 'title', 'memo-refine']) eq(f, on(f), true);

console.log('\n■ 回してはいけないもの');
// 音声は Claude の API に入らない
eq('文字起こし', on('transcribe'), false);
eq('話者判別', on('diarize'), false);
// 実測で8〜10秒。12〜20秒ごとのチャンクには間に合わない
eq('録音中のチャンク整形', on('chunk-refine'), false);
eq('字幕のリアルタイム整形', on('osd'), false);
eq('文脈の自動抽出（JSON）', on('context-extract'), false);
eq('名前が無いものは回さない', on(''), false);
eq('知らない名前も回さない', on('なにか新しい処理'), false);

console.log('\n■ 設定がオフなら何も回さない');
eq('オフ', use({ enabled: false, feature: 'summary', body: TEXT }), false);

console.log('\n■ body の中身でも二重に止める（feature の付け忘れ対策）');
// ここが効かないと、音声を積んだ body が黙って Claude に飛ぶ
eq('音声(inline_data)が混じったら止める',
  on('summary', { contents: [{ role: 'user', parts: [{ text: 'x' }, { inline_data: {} }] }] }), false);
eq('音声(file_data)が混じったら止める',
  on('summary', { contents: [{ role: 'user', parts: [{ file_data: {} }] }] }), false);
eq('キャメルケースでも止める',
  on('summary', { contents: [{ role: 'user', parts: [{ inlineData: {} }] }] }), false);
eq('JSON を期待していたら止める',
  on('summary', { contents: [{ role: 'user', parts: [{ text: 'x' }] }],
                  generationConfig: { responseMimeType: 'application/json' } }), false);
eq('responseSchema があったら止める',
  on('summary', { contents: [{ role: 'user', parts: [{ text: 'x' }] }],
                  generationConfig: { responseSchema: {} } }), false);
eq('text/plain の明示は通す',
  on('summary', { contents: [{ role: 'user', parts: [{ text: 'x' }] }],
                  generationConfig: { responseMimeType: 'text/plain' } }), true);
eq('body が無ければ止める', on('summary', null), false);
eq('空の body でも落ちない', textOnly({}), true);

console.log('\n■ プロンプトの畳み方（Gemini 用の書き方をそのまま使う）');
eq('system を先頭に置く',
  prompt({ system_instruction: { parts: [{ text: 'あなたは編集者です' }] },
           contents: [{ role: 'user', parts: [{ text: '整形して' }] }] }),
  'あなたは編集者です\n\n整形して');
eq('往復は誰の発言か分かる形にする',
  prompt({ contents: [
    { role: 'user', parts: [{ text: 'Q1' }] },
    { role: 'model', parts: [{ text: 'A1' }] },
    { role: 'user', parts: [{ text: 'Q2' }] }] }),
  'Q1\n\n【これまでのあなたの回答】\nA1\n\nQ2');
eq('空のパートは飛ばす',
  prompt({ contents: [{ role: 'user', parts: [{ text: '' }, { text: 'あ' }] }] }), 'あ');
eq('system だけでも成立する',
  prompt({ system_instruction: { parts: [{ text: 'S' }] }, contents: [] }), 'S');
eq('空でも落ちない', prompt({}), '');
eq('undefined でも落ちない', prompt(undefined), '');

console.log('\n■ 全体を囲うコードフェンスを外す（通し確認で実際に出た）');
eq('```markdown で包まれていたら外す',
  unfence('```markdown\n## 要約\n\n- あ\n```'), '## 要約\n\n- あ');
eq('言語指定なしでも外す', unfence('```\n本文\n```'), '本文');
eq('包まれていなければそのまま', unfence('## 要約\n\n- あ'), '## 要約\n\n- あ');
// 本文の途中にあるコードブロックは中身なので触らない
eq('中にフェンスがあるなら触らない',
  unfence('```markdown\n説明\n```js\ncode\n```\n```'),
  '```markdown\n説明\n```js\ncode\n```\n```');
eq('コードブロックが1つだけの回答は壊さない',
  unfence('次のコードです\n\n```js\nconst a = 1;\n```'),
  '次のコードです\n\n```js\nconst a = 1;\n```');
eq('空でも落ちない', unfence(''), '');
eq('undefined でも落ちない', unfence(undefined), '');

console.log(fail ? `\n${fail}件 失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
