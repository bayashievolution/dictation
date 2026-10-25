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


/* ───────── v0.24.6: Gemini に戻したときの文言 ─────────
 *
 * 理由によらず「繋がらない」と出していたのを言い分ける。
 * start.bat は動いているのに「繋がらない」と言われると、直しようが分からない
 * （やっさんが実際にここで詰まった）。 */
vm.runInContext(grab(src, 'claudeBridgeFallbackMessage'), ctx);
console.log('\n■ Gemini に戻したときの文言（理由を言い分ける）');
{
  const m = (e) => ctx.claudeBridgeFallbackMessage(e);
  const is = (label, got, want) => {
    const ok = got === want;
    console.log(`${ok ? '✓' : '✕'} ${label}: ${JSON.stringify(got)}`);
    if (!ok) { console.log(`    期待 ${JSON.stringify(want)}`); fail++; }
  };
  is('サーバーが動いていない',
     m('Claude Code の中継に繋がりません（start.bat でサーバーを起動してください）'),
     '中継に繋がらないので Gemini で処理（start.bat を起動）');
  // 実際に起きたやつ。診断ログに残っていた生の文言そのまま
  is('ログイン切れ', m('Failed to authenticate: OAuth session expired and could not be refreshed'),
     'Claude のログインが切れているので Gemini で処理');
  is('401 でも同じ扱い', m('Request failed with status 401'),
     'Claude のログインが切れているので Gemini で処理');
  is('claude が入っていない', m('claude を実行できませんでした'),
     'claude を実行できないので Gemini で処理しました');
  is('spawn ENOENT でも同じ扱い', m('spawn claude ENOENT'),
     'claude を実行できないので Gemini で処理しました');
  is('時間切れ', m('180秒待っても返事がありませんでした'),
     'Claude が時間内に返さないので Gemini で処理');
  is('長すぎる', m('長すぎます（250000字 / 上限200000字）'),
     '長すぎて Claude に送れないので Gemini で処理');
  // v0.24.7: 生の理由は**画面に出さない**。押したときだけ開く。
  // 一度は文言に貼ってみたが、やっさんから
  // 「ログを画面にずっと出すのはちょっとね」。開け方は tests/browser/ で見る
  is('知らないエラーでも断定しない', m('終了コード 1'),
     'Claude で処理できなかったので Gemini で処理しました');
  is('stderr を画面に流さない', m('Error: not logged in\n  at /usr/lib/cli.js:1:2'),
     'Claude で処理できなかったので Gemini で処理しました');
  is('理由が空なら断定しない', m(''), 'Claude で処理できなかったので Gemini で処理しました');
  is('空白だけでも同じ', m('   '), 'Claude で処理できなかったので Gemini で処理しました');
  is('null', m(null), 'Claude で処理できなかったので Gemini で処理しました');

  // 文言が状態表示に収まるか（max-width: 360px）は**実測しないと分からない**。
  // 文字数では測れない（半角は細いので、36字でも 327px で収まる）。
  // 切れていないことの検査は tests/browser/t-claude-bridge-browser.js にある。
  const all = ['Claude Code の中継に繋がりません（start.bat でサーバーを起動してください）',
               'Failed to authenticate: OAuth session expired and could not be refreshed',
               'claude を実行できませんでした', '180秒待っても返事がありませんでした',
               '長すぎます（1字 / 上限2字）', '終了コード 1', ''];
  // どの文言も「Gemini で処理」したことは必ず言う（黙って戻さない）
  for (const e of all) {
    const t = m(e);
    const ok = t.includes('Gemini で処理');
    console.log(`${ok ? '✓' : '✕'} Gemini に戻したと必ず言う: ${t}`);
    if (!ok) fail++;
  }
}

/* ───────── v0.24.9: ログインまで見る ─────────
 *
 * やっさんの指摘:
 * > で失敗して、どこでログインしたらいいか分からない
 * > 設定の時点でログインしてないと動かないようにしたほうがいいと思う
 *
 * 以前の「接続を確認」は中継が生きているかしか見ておらず、
 * **ログインが切れていても緑で「動いています」と出していた**。 */
vm.runInContext([grab(src, 'claudeBridgeHealthMessage'), grab(src, 'claudeBridgeIsFatal')].join('\n'), ctx);
console.log('\n■ 「接続を確認」の文言（ログインまで見る）');
{
  const h = (x) => ctx.claudeBridgeHealthMessage(x);
  const is = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? '✓' : '✕'} ${label}: ${JSON.stringify(got)}`);
    if (!ok) { console.log(`    期待 ${JSON.stringify(want)}`); fail++; }
  };
  is('中継が落ちている', h({ ok: false }),
     { ok: false, needsLogin: false, unknown: false, text: '中継に繋がりません。start.bat でサーバーを起動してください' });
  is('何も返ってこない', h(null),
     { ok: false, needsLogin: false, unknown: false, text: '中継に繋がりません。start.bat でサーバーを起動してください' });
  is('ログイン済み', h({ ok: true, invocation: 'claude', auth: { ok: true, loggedIn: true } }),
     { ok: true, needsLogin: false, unknown: false, text: '使えます（ログイン済み / claude）' });
  // サーバーの版を出す。拡張のカードの数字と比べられるように (v0.24.11)
  is('版も返ってきたとき',
     h({ ok: true, invocation: 'claude', version: '0.24.11', auth: { ok: true, loggedIn: true } }),
     { ok: true, needsLogin: false, unknown: false,
       text: '使えます（ログイン済み / claude / サーバー 0.24.11）' });
  is('ログインしていない', h({ ok: true, invocation: 'claude', auth: { ok: true, loggedIn: false } }),
     { ok: false, needsLogin: true, unknown: false, text: 'Claude にログインしていません。login.bat でサインインしてください' });
  // ここが肝。**分からないときに「使えます」と言わない**。
  // ただし unknown を立てて、呼び出し側が「壊れている」と扱わないようにする
  is('ログイン状態を読めなかった', h({ ok: true, auth: { ok: false, error: 'spawn claude ENOENT' } }),
     { ok: false, needsLogin: false, unknown: true, text: 'claude を確かめられません: spawn claude ENOENT' });
  // やっさんが実際に踏んだやつ。update.bat でファイルは新しくなるが、
  // 走っている node は入れ替わらない。「理由不明」では直しようがない
  is('auth が無い（古い serve.js が走ったまま）', h({ ok: true, invocation: 'claude' }),
     { ok: false, needsLogin: false, unknown: true,
       text: 'サーバーが古いままです。start.bat を一度閉じて起動し直してください' });
}

console.log('\n■ 待っても直らない失敗かどうか');
{
  const f = (e) => ctx.claudeBridgeIsFatal(e);
  const yes = (label, e) => { const ok = f(e) === true; console.log(`${ok ? '✓' : '✕'} ${label}`); if (!ok) fail++; };
  const no  = (label, e) => { const ok = f(e) === false; console.log(`${ok ? '✓' : '✕'} ${label}`); if (!ok) fail++; };
  yes('OAuth 期限切れ', 'Failed to authenticate: OAuth session expired and could not be refreshed');
  yes('401', 'Request failed with status 401');
  yes('unauthorized', 'Unauthorized');
  no('中継に繋がらない（start.bat を立てれば直る）', 'Claude Code の中継に繋がりません（start.bat でサーバーを起動してください）');
  no('時間切れ（次は通るかもしれない）', '180秒待っても返事がありませんでした');
  no('長すぎる（内容次第）', '長すぎます（250000字 / 上限200000字）');
  no('空', '');
}


console.log(fail ? `\n${fail}件 失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
