/**
 * usage.js — Gemini と Groq の使用量を覚えておく (v0.24.104)
 *
 * やっさん「Gemini と Groq の使用量が見れるように。Gemini は月毎のトークン使用量と料金、Groq は無料分の残り。
 * 設定の一番下に新たにカードを作り、ビジュアル的に確認できるように」。
 *
 * ■ 何を数えるか
 *   - Gemini: 返事の usageMetadata（Gemini 自身が数えた実数）を月ごと・働きごとに足す。文字の入力・音声の入力・出力に分ける
 *     （音声と出力は単価が違うので、料金の目安を出すのに要る）
 *   - Groq: 送った音声の秒数と回数を、日ごと・1 時間ごとに足す。Groq は 10 秒未満を 10 秒として数えるので同じように数える。
 *     返事に x-ratelimit-* があれば、それも覚えておく（Groq 自身の数字なので、あればそちらを出す）
 *
 * ■ 正直に書いておくこと
 *   - **このアプリから送った分だけ**。同じキーをほかで使った分・比較ページの分・この版より前の分は入らない
 *   - 料金は目安。単価は Google が変えることがあり、無料枠のキーなら実際には 0 円。請求額とは一致しないことがある
 *   - Groq の「日」は、このパソコンの時計の 0 時で区切っている。Groq 側の区切りとはずれることがある
 *
 * 保存場所は localStorage の 'dictation:usage'（新しいキー。ほかの保存には触らない）。古い月・日は消していく
 */

const USAGE_KEY = 'dictation:usage';

/**
 * Gemini 2.5 Flash の単価（100 万トークンあたり・米ドル）。2026-11 時点で文字起こしに使っているモデル（gemini.js の GEMINI_MODEL）。
 * 変わったらここを直す。画面にもこの値を出す（何で計算したか分かるように）
 */
const GEMINI_PRICE_PER_M = { text: 0.30, audio: 1.00, output: 2.50 };

/** Groq の Whisper の無料枠（spokenly.app の一覧・2026-11 の調べ。比較ページの調査と同じ値） */
const GROQ_FREE = { daySec: 28800, hourSec: 7200, dayReq: 2000, minReq: 20 };

function usageLoad() {
  try { return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function usageSave(u) {
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch (_) { /* 容量いっぱいなどでも本体は止めない */ }
}
function usageMonthKey(d) { const t = d || new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; }
function usageDayKey(d) { const t = d || new Date(); return `${usageMonthKey(t)}-${String(t.getDate()).padStart(2, '0')}`; }
function usageHourKey(d) { const t = d || new Date(); return `${usageDayKey(t)}T${String(t.getHours()).padStart(2, '0')}`; }

/**
 * Gemini の 1 回ぶんを足す（純関数。u を書き換えて返す）
 * @param {object} meta usageMetadata
 */
function usageAddGeminiTo(u, feature, meta, now) {
  if (!meta) return u;
  const m = usageMonthKey(now);
  u.gemini = u.gemini || {};
  const mon = u.gemini[m] || (u.gemini[m] = { calls: 0, text: 0, audio: 0, output: 0, byFeature: {} });
  let audio = 0;
  for (const d of meta.promptTokensDetails || []) if (d && d.modality === 'AUDIO') audio += Number(d.tokenCount) || 0;
  const input = Number(meta.promptTokenCount) || 0;
  const output = (Number(meta.candidatesTokenCount) || 0) + (Number(meta.thoughtsTokenCount) || 0);
  const text = Math.max(0, input - audio);
  mon.calls++; mon.text += text; mon.audio += audio; mon.output += output;
  const k = feature || 'other';
  const f = mon.byFeature[k] || (mon.byFeature[k] = { calls: 0, tokens: 0 });
  f.calls++; f.tokens += input + output;
  // 13 か月より古い月は消す（1 年前と比べられるだけ残す）
  const months = Object.keys(u.gemini).sort();
  while (months.length > 13) delete u.gemini[months.shift()];
  return u;
}

/** Groq の 1 回ぶんを足す（純関数）。durSec は実際の長さ。数えるのは 10 秒未満を 10 秒に切り上げた値 */
function usageAddGroqTo(u, durSec, headers, now) {
  const sec = Math.max(10, Number(durSec) || 0);
  const day = usageDayKey(now), hour = usageHourKey(now);
  u.groq = u.groq || {};
  const g = u.groq;
  if (g.day !== day) { g.day = day; g.daySec = 0; g.dayReq = 0; }
  if (g.hour !== hour) { g.hour = hour; g.hourSec = 0; }
  g.daySec += sec; g.dayReq += 1; g.hourSec += sec;
  if (headers && Object.keys(headers).length) g.headers = { at: (now || new Date()).getTime(), ...headers };
  return u;
}

/** いまの時刻で見た Groq の使用量（日・時が変わっていたら 0 から） */
function usageGroqNow(u, now) {
  const g = (u && u.groq) || {};
  const day = usageDayKey(now), hour = usageHourKey(now);
  return {
    daySec: g.day === day ? g.daySec || 0 : 0,
    dayReq: g.day === day ? g.dayReq || 0 : 0,
    hourSec: g.hour === hour ? g.hourSec || 0 : 0,
    headers: g.headers && g.headers.at && (now || new Date()).getTime() - g.headers.at < 60 * 60 * 1000 ? g.headers : null,
  };
}

/** 料金の目安（米ドル） */
function usageGeminiCost(mon) {
  if (!mon) return 0;
  return (mon.text * GEMINI_PRICE_PER_M.text + mon.audio * GEMINI_PRICE_PER_M.audio + mon.output * GEMINI_PRICE_PER_M.output) / 1e6;
}

// 本体から呼ぶ口（localStorage に読み書きする）
function usageRecordGemini(feature, meta) { usageSave(usageAddGeminiTo(usageLoad(), feature, meta)); }
function usageRecordGroq(durSec, headers) { usageSave(usageAddGroqTo(usageLoad(), durSec, headers)); }

if (typeof window !== 'undefined') {
  window.usageRecordGemini = usageRecordGemini;
  window.usageRecordGroq = usageRecordGroq;
}
