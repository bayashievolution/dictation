/**
 * groq.js — Groq の Whisper で音声を文字にする (v0.24.83 予定・2026-11-09)
 *
 * ■ なぜ足したか
 *   講義の Gemini 代の大半は音声の文字起こし（TODO「トークン削減」）。Groq の Whisper は無料枠
 *   （1 分 20 回・1 時間 7,200 秒・1 日 28,800 秒）で講義 1 コマが収まる。
 *   比較ページ（stt-compare.html）の実機 1 回目で、3m 離れた普通の声を Gemini と同じくらい聞き取り、
 *   倍以上速かった（Groq 0.9 秒 / Gemini 2.1 秒）。
 *
 * ■ Gemini と違うところ
 *   - **整形をしない**（句読点・改行・フィラー削除なし）。呼び出し側がライブ整形に回す
 *   - 雑音だけの区間で「ご視聴ありがとうございました」のような文を作ることがある。
 *     Whisper 本家が「文字にしない」判断に使う目安（話していない確率 0.6 超・自信 -1 未満）に当たる
 *     部分は落として、診断ログに残す。本家の文字起こしはこれを自分で落とすが、API の返事には残っているため
 *
 * Gemini は消さない（足し算）。Groq で失敗したときに Gemini に回すかは呼び出し側（app.js）が決める。
 */

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_DEFAULT_MODEL = 'whisper-large-v3';   // 比較ページの実機 1 回目はこれ。turbo は未比較

/**
 * Whisper の prompt を作る
 * prompt は「この音声の直前に書かれていた文」として扱われ、表記や語の選び方が寄る（固有名詞に効く）。
 * 上限 224 トークン。日本語は 1 字 1 トークン前後なので字数で抑える。語を先に、残りを直前の文の末尾に。
 */
function groqWhisperPrompt(terms, prevText, maxChars = 150) {
  const t = String(terms || '').replace(/\s+/g, ' ').trim();
  const head = t ? ('語: ' + t).slice(0, Math.floor(maxChars * 0.6)) : '';
  const room = maxChars - head.length - (head ? 1 : 0);
  const prev = String(prevText || '').replace(/\s+/g, ' ').trim();
  const tail = room > 0 ? prev.slice(-room) : '';
  return [head, tail].filter(Boolean).join('\n');
}

/**
 * 無音のときに Whisper が作りがちな決まり文句 (v0.24.127)
 * 実機 2026-11-11: 何もしゃべっていないかたまりで「ご視聴ありがとうございました」が出た（やっさん）。
 * 話していない確率（no_speech_prob）は低めに付くことがあり、v0.24.83 の目安（0.6 超かつ自信 -1 未満）では落ちなかった。
 * Whisper が動画の字幕を学習していて、無音の終わりに字幕の締めの文を書く、というよく知られた癖。
 * 入れるのは講義・会議でまず言わないものだけ。「ご清聴ありがとうございました」は発表の締めで本当に言うので入れない。
 */
const GROQ_SILENCE_PHRASES = [
  /^(最後まで)?ご視聴(いただき|頂き)?(まことに|誠に|本当に)?ありがとうございま(した|す)$/,
  /^チャンネル登録(と高評価)?(を|も)?(よろしく)?お願いします$/,
  /^チャンネル登録よろしくお願いします$/,
  /^(次回|次の動画)もお楽しみに$/,
  /^(では|それでは)?また(次回|次の動画)(で|でお会いしましょう)?$/,
  /^字幕(作成|制作|提供)(者)?.*$/,
];

/**
 * 無音のときに出る、相づちだけの短い返事 (v0.24.130)
 * 実機 2026-11-11: 無音のあいだに「はい、どうぞ。」「はい。」「はい。」「はい。」と出た（やっさん）。
 * 前の版で再現すると、**1 つのかたまりの中で** Whisper が相づちを繰り返していた（segments が 4 つ）。全体では「どうぞ」が入るので、
 * app.js の isFillerOnly（相づちだけのかたまりが続いたら 2 つ目から出さない）にも当たらず、整形で行が分かれて 4 行になった。
 *   - 無音だったらしい（quiet）ときは、相づちだけの部分を落とす
 *   - 声があるときも、同じ相づちが続けて繰り返された分は 1 つにする（Whisper の繰り返しの癖。本当の返事は 1 回残る）
 */
const GROQ_QUIET_FILLER = /^(はい|はーい|ええ|うん|どうぞ)+$/;

/** 決まり文句だけでできているか（句読点・空白・「!」は見ない。いくつか続いていても同じ） */
function isGroqSilencePhrase(text) {
  const parts = String(text || '').split(/[。．.！!？?\n]+/).map((x) => x.replace(/[\s、,・「」『』"'“”]/g, '')).filter(Boolean);
  return parts.length > 0 && parts.every((p) => GROQ_SILENCE_PHRASES.some((re) => re.test(p)));
}

/** 相づちだけか（句読点・空白は見ない） */
function isGroqQuietFiller(text) {
  const t = String(text || '').replace(/[\s、。，．,.!！?？…・ー〜~「」]/g, '');
  return !!t && GROQ_QUIET_FILLER.test(t);
}

/**
 * verbose_json の返事から、残す文と落とす文を分ける
 * @param {object} data
 * @param {{quiet?: boolean}} [opts] quiet: このかたまりは無音だったらしい（音の大きさの検出・Web Speech が何も聞き取らなかった）。
 *   そのときは決まり文句だけの部分を、話していない確率に関係なく落とす。
 *   無音でないときも、話していない確率が 0.3 を超える決まり文句は落とす（本当に言ったなら、確率はほぼ 0 になる）
 * @returns {{text: string, dropped: string[]}}
 */
function groqPickText(data, opts = {}) {
  const quiet = !!(opts && opts.quiet);
  const segs = data && Array.isArray(data.segments) ? data.segments : null;
  if (!segs) {
    const t = String((data && data.text) || '').trim();
    if (quiet && (isGroqSilencePhrase(t) || isGroqQuietFiller(t))) return { text: '', dropped: [t] };
    return { text: t, dropped: [] };
  }
  const kept = [], dropped = [];
  for (const s of segs) {
    const t = String(s.text || '').trim();
    if (!t) continue;
    if (s.no_speech_prob > 0.6 && s.avg_logprob < -1) dropped.push(t);
    else if (isGroqSilencePhrase(t) && (quiet || s.no_speech_prob > 0.3)) dropped.push(t);
    else if (quiet && isGroqQuietFiller(t)) dropped.push(t);   // v0.24.130
    else if (isGroqQuietFiller(t) && kept.length && isGroqQuietFiller(kept[kept.length - 1])) dropped.push(t);   // v0.24.130: 相づちの繰り返し
    else kept.push(t);
  }
  return { text: kept.join(' ').trim(), dropped };
}

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {Blob}   args.audioBlob   本体の録音のかたまり（webm/opus のまま送れる）
 * @param {object} [args.sessionContext]  buildContextBlock と同じ形。terms だけ使う
 * @param {string} [args.contextHint]     直前の文字起こし
 * @param {boolean} [args.quiet]         無音だったらしい（決まり文句を落とす。groqPickText）
 * @returns {Promise<string>}
 */
async function transcribeAudioWithGroq({ apiKey, audioBlob, sessionContext, contextHint, model, durationSec, quiet = false }) {
  if (!apiKey) throw new Error('Groq の API キーが設定されていません');
  if (!audioBlob || audioBlob.size === 0) return '';
  const prompt = groqWhisperPrompt(sessionContext && sessionContext.terms, contextHint);
  const ext = /wav/.test(audioBlob.type) ? 'wav' : /ogg/.test(audioBlob.type) ? 'ogg' : 'webm';

  // 回数の上限（429）は 1 回だけ待って試し直す。録音中なので長くは待たない（次のかたまりが来る）
  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = new FormData();
    fd.append('file', audioBlob, 'chunk.' + ext);
    fd.append('model', model || GROQ_DEFAULT_MODEL);
    fd.append('language', 'ja');
    fd.append('temperature', '0');
    fd.append('response_format', 'verbose_json');
    if (prompt) fd.append('prompt', prompt);
    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: fd,
    });
    if (res.status === 429 && attempt === 0) {
      const ra = Number(res.headers.get('retry-after')) || 5;
      if (window.diagLog) window.diagLog.info(`Groq の回数の上限に当たったので ${Math.min(ra, 15)} 秒待って試し直します`);
      await new Promise(r => setTimeout(r, Math.min(ra, 15) * 1000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Groq エラー (${res.status}): ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    // v0.24.104: 無料枠の残りを数える（usage.js）。長さが分からなければ大きさから見積もる（本体の録音は 64kbps）
    if (typeof usageRecordGroq === 'function') {
      const headers = {};
      res.headers.forEach((v, k) => { if (/^x-ratelimit-/i.test(k)) headers[k.toLowerCase()] = v; });
      usageRecordGroq(durationSec || (audioBlob.size * 8 / 64000), headers);
    }
    const picked = groqPickText(await res.json(), { quiet });
    if (picked.dropped.length && window.diagLog) {
      window.diagLog.info(`Groq: 話していない見込みの部分を落としました（${picked.dropped.join(' / ').slice(0, 80)}）`);
    }
    return picked.text;
  }
  throw new Error('Groq の回数の上限に当たり続けました');
}

window.transcribeAudioWithGroq = transcribeAudioWithGroq;
