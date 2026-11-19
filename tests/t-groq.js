// groq.js（Groq の Whisper で文字にする・v0.24.83）の判断の部分を、実物の関数のまま検査する。
//
// 雑音から作った文を落とす判断を間違えると、言っていない文が記録に残る（v0.13.6 の独り言の事故と同じ壊れ方）。
// 逆に落としすぎると、本当の小さい声が消える。どちらも気づきにくいので、ここで固める。
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.resolve(process.env.SRC || __dirname + '/../');
const file = path.join(SRC, 'groq.js');
if (!fs.existsSync(file)) { console.log('✕ groq.js が無い'); process.exit(1); }

let fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✕'} ${label}` + (ok ? '' : `\n    得 ${JSON.stringify(got)}\n    期 ${JSON.stringify(want)}`));
  if (!ok) fail++;
};
const ctx = { Math, String, Number, Array, window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);

console.log('■ 残す文・落とす文');
{
  const r = ctx.groqPickText({
    text: '本日はよろしくお願いします ご視聴ありがとうございました',
    segments: [
      { text: ' 本日はよろしくお願いします', no_speech_prob: 0.02, avg_logprob: -0.2 },
      { text: ' ご視聴ありがとうございました', no_speech_prob: 0.92, avg_logprob: -1.4 },
    ],
  });
  eq('雑音から作った文は落とす', r.text, '本日はよろしくお願いします');
  eq('落とした文は分かるように返す（診断ログに出す）', r.dropped, ['ご視聴ありがとうございました']);
}
{
  const r = ctx.groqPickText({ segments: [
    { text: '小さい声の発言', no_speech_prob: 0.7, avg_logprob: -0.5 },
    { text: '自信のない発言', no_speech_prob: 0.3, avg_logprob: -1.5 },
  ] });
  eq('話していない確率が高くても、自信があれば残す（小さい声を消さない）', r.text, '小さい声の発言 自信のない発言');
}
eq('segments が無ければ text をそのまま', ctx.groqPickText({ text: ' こんにちは ' }).text, 'こんにちは');
eq('空の返事でも落ちない', ctx.groqPickText({}).text, '');
eq('全部落ちたら空', ctx.groqPickText({ segments: [{ text: 'x', no_speech_prob: 0.9, avg_logprob: -2 }] }).text, '');

console.log('\n■ Whisper の prompt');
{
  const p = ctx.groqWhisperPrompt('玄海、ルーブリック', 'い'.repeat(400));
  eq('上限内（224 トークンを超えない）', p.length <= 150, true);
  eq('語が先頭', p.startsWith('語: 玄海、ルーブリック'), true);
  eq('直前の文は末尾を使う', p.endsWith('い'), true);
  eq('語が長くても直前の文の場所が残る', ctx.groqWhisperPrompt('語'.repeat(500), '終わり').endsWith('終わり'), true);
  eq('どちらも無ければ空', ctx.groqWhisperPrompt(undefined, ''), '');
}

console.log('\n■ 本体とのつなぎ');
{
  const idx = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const m = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  eq('index.html が groq.js を読み込む（版もそろえる）', idx.includes(`groq.js?v=${m.version}`), true);
  eq('groq.js は app.js より前', idx.indexOf('groq.js?v=') < idx.indexOf('app.js?v='), true);
  eq('拡張から Groq に届く（host_permissions）', m.host_permissions.includes('https://api.groq.com/*'), true);
  eq('拡張から Groq に届く（CSP）', /connect-src[^;]*https:\/\/api\.groq\.com/.test(m.content_security_policy.extension_pages), true);
}

console.log('\n■ 無音のときの決まり文句（v0.24.127・実機「何もしゃべらなかった時 ご視聴ありがとうございました って出る」）');
const seg = (text, nsp = 0.1, lp = -0.3) => ({ text, no_speech_prob: nsp, avg_logprob: lp });
// 実機では話していない確率が低めに付いて、v0.24.83 の目安を通り抜けた
eq('無音なら「ご視聴ありがとうございました」を落とす（確率が低くても）', ctx.groqPickText({ segments: [seg('ご視聴ありがとうございました')] }, { quiet: true }).text, '');
eq('句読点・続いた決まり文句も', ctx.groqPickText({ segments: [seg('ご視聴ありがとうございました。チャンネル登録よろしくお願いします！')] }, { quiet: true }).text, '');
eq('segments が無い返事でも', ctx.groqPickText({ text: 'ご視聴ありがとうございました。' }, { quiet: true }).text, '');
eq('無音でなくても、話していない確率が 0.3 を超えるなら落とす', ctx.groqPickText({ segments: [seg('今日は火事の話です。'), seg('ご視聴ありがとうございました', 0.45)] }).text, '今日は火事の話です。');
eq('声があって確率が低いなら残す（本当に言った）', ctx.groqPickText({ segments: [seg('ご視聴ありがとうございました', 0.02)] }).text, 'ご視聴ありがとうございました');
eq('無音でも、決まり文句ではない文は残す（小さな声を消さない）', ctx.groqPickText({ segments: [seg('熱感知器が反応します')] }, { quiet: true }).text, '熱感知器が反応します');
eq('決まり文句が文の一部なら残す', ctx.groqPickText({ segments: [seg('動画のご視聴ありがとうございましたという字幕が出ます')] }, { quiet: true }).text, '動画のご視聴ありがとうございましたという字幕が出ます');
eq('「ご清聴ありがとうございました」は発表の締めで言うので残す', ctx.groqPickText({ segments: [seg('ご清聴ありがとうございました')] }, { quiet: true }).text, 'ご清聴ありがとうございました');
eq('「ありがとうございました」だけは残す（授業でも言う）', ctx.groqPickText({ segments: [seg('ありがとうございました')] }, { quiet: true }).text, 'ありがとうございました');

console.log('\n■ 無音のときの相づち・相づちの繰り返し（v0.24.130・実機「無音部分で はい、どうぞ。はい。はい。はい。となる」）');
eq('無音なら「はい、どうぞ。」を落とす', ctx.groqPickText({ segments: [seg('はい、どうぞ。')] }, { quiet: true }).text, '');
eq('無音なら「はい。」を落とす', ctx.groqPickText({ segments: [seg('はい。')] }, { quiet: true }).text, '');
eq('声があるときの「はい。」は残す（本当の返事かもしれない）', ctx.groqPickText({ segments: [seg('はい。')] }).text, 'はい。');
eq('声があっても、1 つのかたまりの中で相づちが繰り返されたら 1 つに（実機の再現）', ctx.groqPickText({ segments: ['はい、どうぞ。', 'はい。', 'はい。', 'はい。'].map((x) => seg(x)) }).text, 'はい、どうぞ。');
eq('相づちのあいだに文があれば、それぞれ残す', ctx.groqPickText({ segments: ['はい。', '始めます。', 'はい。'].map((x) => seg(x)) }).text, 'はい。 始めます。 はい。');
eq('無音でも、相づちで始まる文は残す', ctx.groqPickText({ segments: [seg('はい、では始めます。')] }, { quiet: true }).text, 'はい、では始めます。');

console.log(fail ? `\n✕ ${fail} 件失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
