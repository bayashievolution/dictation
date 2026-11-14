/**
 * stt-compare-core.js — 文字起こし比較ページ（stt-compare.html）の計算部分
 *
 * 画面にもマイクにも触らない関数だけを置く。tests/t-stt-compare.js が node の vm で
 * このファイルをそのまま読み込んで検査する（ブラウザとマイクは CI で動かせないため）。
 *
 * 本体（index.html）からは読み込まない。比較ページを消しても本体には影響しない。
 */

/* ───────── 音量 ───────── */

/** 振幅（0〜1）を dBFS に。無音は -99 */
function sttDb(amp) {
  return amp > 0 ? 20 * Math.log10(amp) : -99;
}

/**
 * frameSec ごとの RMS を並べる。区切り位置を探すのと、区切りごとの音量表示に使う
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} frameSec
 * @returns {number[]}
 */
function sttRmsFrames(samples, sampleRate, frameSec) {
  const n = Math.max(1, Math.round(sampleRate * frameSec));
  const out = [];
  for (let i = 0; i < samples.length; i += n) {
    const end = Math.min(samples.length, i + n);
    let sum = 0;
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    out.push(Math.sqrt(sum / (end - i)));
  }
  return out;
}

/* ───────── 区切り ─────────
 *
 * 本体（v0.18.0）と同じ考え方で、最短 minSec〜最長 maxSec のあいだの**いちばん静かなところ**で切る。
 * 本体は録音しながら無音を待つが、ここは録音済みの音声なので、範囲の中から最小を選べる。
 * そのため切れ目は本体より少し静かな場所に寄る（比較の条件としては Gemini と Whisper で同じなので問題ない）。
 *
 * 切れ目が本当に静かだったか（silenceDb 未満か）を endsAtSilence に入れる。
 * これは Gemini の指示（buildChunkEdgeRule）に「文の途中で切れているかもしれない」と
 * 正直に伝えるため。静かでないのに静かだと言うと、途中で切れた文を言い切らせてしまう。
 */
function sttPlanChunks(frames, frameSec, { minSec = 12, maxSec = 20, silenceDb = -45, smoothFrames = 3 } = {}) {
  const total = frames.length * frameSec;
  if (!frames.length) return [];
  // 1 フレームだけの谷（クリックの合間など）で切らないよう、前後をならしてから選ぶ
  const smooth = frames.map((_, i) => {
    let s = 0, c = 0;
    for (let k = i - smoothFrames; k <= i + smoothFrames; k++) {
      if (k >= 0 && k < frames.length) { s += frames[k]; c++; }
    }
    return s / c;
  });
  const chunks = [];
  let start = 0, startsAtSilence = true;
  while (start < total - 1e-9) {
    if (total - start <= maxSec + 1e-9) {
      chunks.push({ start, end: total, startsAtSilence, endsAtSilence: true });
      break;
    }
    const lo = Math.ceil((start + minSec) / frameSec);
    const hi = Math.min(frames.length - 1, Math.floor((start + maxSec) / frameSec));
    let best = lo;
    for (let i = lo; i <= hi; i++) if (smooth[i] < smooth[best]) best = i;
    // 同じくらい静かなところが続いていたら、その真ん中で切る。
    // 無音の入り口で切ると、次の発話の頭やこの発話の語尾の余韻を削りやすい
    const flat = smooth[best] * 1.1 + 1e-6;
    let a = best, b = best;
    while (a - 1 >= lo && smooth[a - 1] <= flat) a--;
    while (b + 1 <= hi && smooth[b + 1] <= flat) b++;
    best = Math.round((a + b) / 2);
    const end = best * frameSec;
    const quiet = sttDb(smooth[best]) < silenceDb;
    chunks.push({ start, end, startsAtSilence, endsAtSilence: quiet });
    start = end;
    startsAtSilence = quiet;
  }
  return chunks;
}

/** [fromSec, fromSec+lenSec) にかかる区切りだけを残す（全部送るとお金と回数がかかるため） */
function sttPickRange(chunks, fromSec, lenSec) {
  const to = fromSec + lenSec;
  return chunks.filter(c => c.end > fromSec + 1e-9 && c.start < to - 1e-9);
}

/* ───────── 前処理 ───────── */

/**
 * 区切りごとのノーマライズ（いちばん大きいところを targetDb に合わせる）
 *
 * 上げ幅は maxGainDb で止める。無音に近い区切りを何十 dB も持ち上げると、
 * 雑音だけが大きくなって「言っていない文」の材料になる（v0.13.6 の AGC 事故と同じ）。
 * @returns {{samples: Float32Array, gainDb: number}}
 */
function sttNormalizePeak(samples, { targetDb = -1, maxGainDb = 20 } = {}) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return { samples: new Float32Array(samples), gainDb: 0 };
  const gainDb = Math.min(maxGainDb, targetDb - sttDb(peak));
  const g = Math.pow(10, gainDb / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] * g));
  return { samples: out, gainDb };
}

/* ───────── WAV ─────────
 *
 * 本体は webm/opus を送っているが、ここでは区切った PCM を 16kHz・モノラル・16bit の WAV にして
 * Gemini と Groq の両方へ同じものを送る。
 * opus に作り直すには MediaRecorder で実時間ぶん再生し直す必要があり、10 分の音声に 10 分かかる。
 * Whisper は中で 16kHz に落とすので、16kHz の WAV なら Whisper 側に不利はない。
 * Gemini も音声 1 秒 32 トークンで数えるので、形式でトークン数は変わらない。
 */
function sttEncodeWav16(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true);          // fmt チャンクの長さ
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // モノラル
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/* ───────── Groq（Whisper） ───────── */

/** Groq は 10 秒未満の音声を 10 秒として数える（無料枠の 1 時間 7,200 秒・1 日 28,800 秒に効く） */
function sttGroqBilledSec(durSec) {
  return Math.max(10, durSec);
}

/**
 * Whisper の prompt を作る
 *
 * Whisper の prompt は「この音声の直前に書かれていた文」として扱われ、表記や語の選び方が寄る。
 * 上限は 224 トークン（それを超えると前が切られる）。日本語は 1 字 1 トークン前後になるので
 * 字数で maxChars に収める。よく出る語を先に、残りを直前の文字起こしの末尾に使う。
 * 末尾を使うのは、Whisper は prompt の**後ろ寄り**ほど強く効くため。
 */
function sttWhisperPrompt(terms, prevText, maxChars = 150) {
  const t = String(terms || '').replace(/\s+/g, ' ').trim();
  const head = t ? ('語: ' + t).slice(0, Math.floor(maxChars * 0.6)) : '';
  const room = maxChars - head.length - (head ? 1 : 0);
  const prev = String(prevText || '').replace(/\s+/g, ' ').trim();
  const tail = room > 0 ? prev.slice(-room) : '';
  return [head, tail].filter(Boolean).join('\n');
}

/**
 * Whisper が雑音から文を作ったかもしれない部分を拾う
 *
 * verbose_json の segments には、Whisper 自身の見立て（話していない確率・自信・繰り返しの度合い）が付く。
 * 目安は Whisper 本家が「文字にしない」判断に使う値（no_speech 0.6・logprob -1・圧縮率 2.4）。
 * **消さずに印を付けるだけ**にする。本当に話している部分を消すほうがまずいので、判断は人が音を聞いて行う。
 */
function sttSuspiciousSegments(segments) {
  const out = [];
  for (const s of segments || []) {
    const reasons = [];
    if (s.no_speech_prob > 0.6 && s.avg_logprob < -1) reasons.push('話していない見込み');
    if (s.compression_ratio > 2.4) reasons.push('同じ言葉の繰り返し');
    if (reasons.length) out.push({ text: String(s.text || '').trim(), reasons });
  }
  return out;
}

/* ───────── 結果を書き出す ───────── */

function sttFmtTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 結果をチャットに貼れるテキストにする（やっさんがカルディに貼って見てもらう用）
 * @param {object} meta { source, preprocess, groqModel, chunkRange }
 * @param {Array} rows  { start, end, peakDb, gemini:{text,ms,tokens,error}, groq:{text,ms,error,suspicious} }
 */
function sttResultText(meta, rows) {
  const lines = [];
  lines.push(`# 文字起こし比較  ${meta.when || ''}`);
  lines.push(`音声: ${meta.source || ''} / 前処理: ${meta.preprocess || ''} / 区切り: ${meta.chunkRange || ''} / Groq: ${meta.groqModel || ''}`);
  const sum = sttSummarize(rows);
  if (sum.gemini.n) lines.push(`Gemini: ${sum.gemini.n}回 平均 ${sum.gemini.avgSec}秒 最大 ${sum.gemini.maxSec}秒 / 入力 ${sum.gemini.input} トークン（うち音声 ${sum.gemini.audio}）`);
  if (sum.groq.n) lines.push(`Groq: ${sum.groq.n}回 平均 ${sum.groq.avgSec}秒 最大 ${sum.groq.maxSec}秒 / 数えられた音声 ${sum.groq.billedSec}秒`);
  lines.push('');
  for (const r of rows) {
    lines.push(`## ${sttFmtTime(r.start)}–${sttFmtTime(r.end)}（最大 ${r.peakDb.toFixed(0)}dB）`);
    if (r.gemini) lines.push(`[Gemini ${fmtSec(r.gemini.ms)}] ${r.gemini.error ? '（エラー）' + r.gemini.error : (r.gemini.text || '（空）')}`);
    if (r.groq) {
      lines.push(`[Groq ${fmtSec(r.groq.ms)}] ${r.groq.error ? '（エラー）' + r.groq.error : (r.groq.text || '（空）')}`);
      for (const s of r.groq.suspicious || []) lines.push(`  ⚠ ${s.reasons.join('・')}: ${s.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
  function fmtSec(ms) { return Number.isFinite(ms) ? (ms / 1000).toFixed(1) + '秒' : '—'; }
}

function sttSummarize(rows) {
  const pick = (k) => rows.map(r => r[k]).filter(x => x && !x.error && Number.isFinite(x.ms));
  const stat = (xs) => ({
    n: xs.length,
    avgSec: xs.length ? +(xs.reduce((s, x) => s + x.ms, 0) / xs.length / 1000).toFixed(1) : 0,
    maxSec: xs.length ? +(Math.max(...xs.map(x => x.ms)) / 1000).toFixed(1) : 0,
  });
  const g = pick('gemini'), q = pick('groq');
  return {
    gemini: Object.assign(stat(g), {
      input: g.reduce((s, x) => s + ((x.tokens && x.tokens.input) || 0), 0),
      audio: g.reduce((s, x) => s + ((x.tokens && x.tokens.audio) || 0), 0),
    }),
    groq: Object.assign(stat(q), {
      billedSec: Math.round(rows.filter(r => r.groq && !r.groq.error).reduce((s, r) => s + sttGroqBilledSec(r.end - r.start), 0)),
    }),
  };
}
