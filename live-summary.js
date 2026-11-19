/**
 * live-summary.js — リアルタイム要約（目次付き・Claude 連携のみ）の純関数 (v0.24.22)
 *
 * やっさんの要望:
 * > 10分に1回程度、話の概要（目次）を付けつつ要約する機能を追加してほしい
 * > この機能をオンにすると、要約タブの中身が変わる
 * > 上の方に目次ができて、それに沿って要約されていく
 * > この機能は Claude 連携のみで使える
 * > 分数は自分で変えれるように
 * > 最後、改めて要約しなおすこともできる
 *
 * ■ 毎回「前回の要約」と「文字起こしの全文」を渡す
 *
 * 差分（前回から増えた分）だけ渡す案は採らなかった。文字起こしはミドル整形で
 * **前のほうの段落がまとめ直される**ので、「どこまで要約したか」を文字の位置で
 * 覚えておけない。全文を渡しても Claude はサブスクの範囲なので、トークンを
 * 気にして作りを危うくする理由が無い。長すぎるときだけ冒頭を落とす（前回の要約が覚えている）。
 *
 * ■ 目次は動かさない
 *
 * 読み手は目次を頼りに追っている。10分ごとに見出しの文言や順番が変わると
 * 「さっき読んだところ」が見つからなくなる。なので前回の見出しは保ち、
 * 新しい話題は末尾に足し、続いている最後の話題だけ直してよいことにする。
 * 講義が終わってから全体を見て組み直したいときは「最初から要約し直す」（fresh）。
 *
 * ■ Gemini には戻さない
 *
 * 呼ぶのは claudeBridgeRun（app.js 側）。_callGemini を通すと、Claude に回せなかった
 * ときに黙って Gemini で作られ、10分ごとに Gemini のトークンを使うことになる。
 */

/** Claude に送れる上限（claude-runner.js の CLAUDE_MAX_CHARS）より少し小さく */
const LIVE_SUMMARY_MAX_PROMPT = 180000;

/** 分数の範囲。0 や 1000 を入れられても壊れないように */
function clampLiveSummaryMinutes(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(60, n));
}

/**
 * Claude に渡す文面を作る
 *
 * @param {object} o
 * @param {string} o.transcript  文字起こし（プレーンテキスト）
 * @param {string} [o.previous]  前回のリアルタイム要約（Markdown）。fresh のときは使わない
 * @param {string} [o.memo]
 * @param {string} [o.title]
 * @param {boolean} [o.final]    録音を止めたあと（最後の話題も終わっている）
 * @param {boolean} [o.fresh]    前回に縛られず最初から作り直す
 */
function buildLiveSummaryPrompt({ transcript, previous = '', memo = '', title = '', final = false, fresh = false }) {
  const prev = fresh ? '' : String(previous || '').trim();
  const head = [
    'あなたは講義や会議を聞きながら、**目次付きの要約**を更新していく係です。',
    '',
    '■ 出力の形（Markdown だけ。前置き・後書き・コードブロックで囲むことはしない）',
    '## 目次',
    '1. 見出し',
    '2. 見出し',
    '',
    '## 1. 見出し',
    '> 始まり: 「その話題が始まった発言」',
    '- 要点',
    '- 要点',
    '',
    '## 2. 見出し',
    '> 始まり: 「その話題が始まった発言」',
    '- 要点',
    '',
    '■ 目次の作り方',
    '- 1つの項目は、ひとまとまりの話題（目安 5〜15分ぶん）',
    '- 見出しは短く、何の話かが分かる言葉にする（「導入」「その他」のようなぼかした言葉は避ける）',
    '- 目次の番号と、本文の見出しの番号・文言を必ず一致させる',
    // v0.24.54 ①: 文字起こしの見出し（見出し追加で付いたもの）と言葉をそろえる。やっさん採用の案①
    '- 文字起こしの「## 」で始まる行は、文字起こしに付けてある見出し。同じ話題なら、目次の見出しもなるべくその言葉に合わせる',
    // v0.24.54 ②: 目次から文字起こしの該当箇所へ飛ぶための手がかり。画面には出さない（normalizeLiveSummary で抜く）
    '- 本文の各見出しのすぐ下に「> 始まり: 「…」」を1行置く。その話題が始まった発言を、文字起こしから**一字一句そのまま** 10〜20字抜き出す（読み手が文字起こしの該当箇所へ飛ぶのに使う）',
  ];
  if (prev) {
    head.push(
      '- **前回の目次の見出しと順番は変えない。** 読み手はそれを頼りに追っている',
      '  - ただし前回の**最後の項目**は話の途中だったので、続きを踏まえて見出しを直してよい',
      '  - 新しい話題が始まっていたら、目次の末尾に足す',
      '- 前回の本文は保ち、続きの分を書き足す（明らかな誤りだけは直してよい）',
    );
  } else if (fresh) {
    head.push('- いまある文字起こし全体を見て、目次を最初から組み立てる');
  }
  head.push(
    final
      ? '- 話はすでに終わっている。「（進行中）」は付けない'
      : '- 最後の話題がまだ続いているなら、その見出し（目次と本文の両方）の末尾に「（進行中）」と付ける',
    '',
    '■ 要約の書き方',
    '- 各見出しの下に、要点を箇条書きで 2〜6 個',
    '- 文字起こしに無い内容は足さない。聞き取れていない部分を想像で埋めない',
    '- 言い間違い・言い直し・相づちは拾わない',
  );
  if (memo && String(memo).trim()) {
    head.push('- 【メモ】は聞き手が書いた補足。本体は文字起こしで、メモにしか無いことを書くときは断片を想像で膨らませない');
  }

  const parts = [head.join('\n')];
  if (title) parts.push(`【タイトル】\n${title}`);
  if (prev) parts.push(`【前回の要約】\n${prev}`);
  if (memo && String(memo).trim()) parts.push(`【メモ】\n${String(memo).trim()}`);

  // 長すぎるときは文字起こしの**冒頭**を落とす。冒頭の内容は前回の要約が持っている
  let t = String(transcript || '').trim();
  const fixed = parts.join('\n\n').length + 200;
  let trimmed = false;
  if (fixed + t.length > LIVE_SUMMARY_MAX_PROMPT) {
    t = t.slice(t.length - Math.max(1000, LIVE_SUMMARY_MAX_PROMPT - fixed));
    trimmed = true;
  }
  parts.push(`【文字起こし${trimmed ? '（長いので冒頭を省略。省略分は前回の要約を参照）' : ''}】\n${t}`);
  return parts.join('\n\n');
}

/**
 * 返ってきた Markdown を整える
 *
 * - コードブロックで包まれていたら外す（claudeBridgeRun でも外すが、念のため）
 * - 「## 目次」より前の前置き（「更新しました。」など）を落とす
 * @returns {{ok:boolean, md:string}} 目次が見つからなければ ok:false（そのまま出すかは呼び出し側）
 */
function normalizeLiveSummary(text) {
  let s = String(text || '').trim();
  const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  const i = s.search(/^#{1,3}\s*目次\s*$/m);
  if (i < 0) { const q = extractLiveSummaryQuotes(s); return { ok: false, md: q.md, quotes: q.quotes }; }
  const q = extractLiveSummaryQuotes(s.slice(i).trim());
  return { ok: true, md: q.md, quotes: q.quotes };
}

/**
 * 「> 始まり: 「…」」の行を抜き出して消す (v0.24.54)
 *
 * 目次から文字起こしへ飛ぶための手がかりで、読み物ではないので画面にも Notion にも出さない。
 * 何番目の節（目次の番号と同じ並び）のものかで覚える。
 * @returns {{md:string, quotes:Object<string,string>}}  quotes は { '1': '発言', ... }
 */
function extractLiveSummaryQuotes(md) {
  const quotes = {};
  let section = 0, inToc = false;
  const out = [];
  for (const line of String(md || '').split('\n')) {
    const h = /^#{1,3}\s*(.*?)\s*$/.exec(line);
    if (h) {
      inToc = h[1] === '目次';
      if (!inToc) section++;
      out.push(line);
      continue;
    }
    const q = /^\s*>?\s*始まり\s*[:：]\s*(.*?)\s*$/.exec(line);
    if (q && !inToc) {
      const t = q[1].replace(/^[「『"“]+|[」』"”]+$/g, '').trim();
      if (section > 0 && t && !quotes[String(section)]) quotes[String(section)] = t;
      continue;
    }
    out.push(line);
  }
  return { md: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), quotes };
}

/** 目次の見出しから、番号と「（進行中）」を外す (v0.24.54) */
function cleanLiveSummaryTitle(t) {
  return String(t || '').replace(/[（(]\s*進行中\s*[)）]/g, '').replace(/^\s*\d+\s*[.．、)）]\s*/, '').trim();
}

/** 比べるための形（全角半角・空白・句読点・括弧・「## 」をそろえる）(v0.24.54) */
function liveSummaryTextKey(s) {
  let t = String(s || '');
  if (t.normalize) t = t.normalize('NFKC');
  return t.replace(/^#+\s*/gm, '').replace(/[\s、。，．,.・「」『』（）()［］\[\]【】!！?？:：;；"'“”‘’…ー〜~\-]/g, '').toLowerCase();
}

function liveSummaryBigrams(s) {
  const set = new Set();
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

/**
 * 目次の項目に当たる、文字起こしの場所を探す (v0.24.54・やっさん採用の案②)
 *
 * @param {object} o
 * @param {string} o.title   目次の見出し
 * @param {string} [o.quote] その話題が始まった発言（Claude が文字起こしから抜いたもの）
 * @param {{kind:'h2'|'p', text:string}[]} o.blocks  文字起こしの見出しと本文を上から順に
 * @returns {{index:number, by:string}}  見つからなければ index -1
 *
 * 1. 見出しの言葉がそのまま同じ（①で言葉をそろえているので、これが一番確か）
 * 2. 始まりの発言が含まれている本文（聞き間違いの直しで少し変わっても拾えるよう、2文字ずつの重なりで見る）
 * 3. 見出しの言葉が近い
 * 同じくらい当たるものが複数あれば、上にあるほう（話題の始まり）を選ぶ。
 */
function findLiveSummaryTarget({ title, quote = '', blocks }) {
  const tk = liveSummaryTextKey(cleanLiveSummaryTitle(title));
  const list = (blocks || []).map((b) => ({ kind: b.kind, key: liveSummaryTextKey(b.text) }));
  if (tk) {
    const exact = list.findIndex((b) => b.kind === 'h2' && b.key === tk);
    if (exact >= 0) return { index: exact, by: 'heading' };
  }
  const qk = liveSummaryTextKey(quote);
  if (qk.length >= 4) {
    const qb = liveSummaryBigrams(qk);
    let best = -1, bestScore = 0;
    list.forEach((b, i) => {
      if (b.kind !== 'p' || !b.key) return;
      if (b.key.includes(qk)) { if (bestScore < 1) { best = i; bestScore = 1; } return; }
      const bb = liveSummaryBigrams(b.key);
      let hit = 0;
      for (const g of qb) if (bb.has(g)) hit++;
      const score = hit / qb.size;
      if (score > bestScore) { best = i; bestScore = score; }
    });
    if (best >= 0 && bestScore >= 0.6) return { index: best, by: 'quote' };
  }
  if (tk.length >= 2) {
    const tb = liveSummaryBigrams(tk);
    let best = -1, bestScore = 0;
    list.forEach((b, i) => {
      if (b.kind !== 'h2' || !b.key) return;
      const bb = liveSummaryBigrams(b.key);
      let hit = 0;
      for (const g of tb) if (bb.has(g)) hit++;
      const score = (2 * hit) / (tb.size + bb.size);
      if (score > bestScore) { best = i; bestScore = score; }
    });
    if (best >= 0 && bestScore >= 0.5) return { index: best, by: 'similar-heading' };
  }
  return { index: -1, by: '' };
}

/**
 * 描いたあとの要約に、目次 → 本文の飛び先を付ける（DOM を直接いじる）
 *
 * renderMarkdown は見出しを全部 <h2> にする。「目次」の <h2> の直後の <ol> の
 * i 番目の項目を、そのあとの i 番目の <h2> に結びつける。
 * @param {HTMLElement} root
 * @returns {number} 結びつけた数
 */
function linkLiveSummaryToc(root) {
  const heads = Array.from(root.querySelectorAll('h2'));
  const tocHead = heads.find((h) => h.textContent.trim() === '目次');
  if (!tocHead) return 0;
  const list = tocHead.nextElementSibling;
  if (!list || list.tagName !== 'OL') return 0;
  root.classList.add('live-summary');
  tocHead.classList.add('live-summary-toc-head');
  list.classList.add('live-summary-toc');
  const sections = heads.filter((h) => h !== tocHead);
  const items = Array.from(list.children);
  let n = 0;
  items.forEach((li, i) => {
    const sec = sections[i];
    if (!sec) return;
    sec.dataset.lsSection = String(i + 1);
    li.dataset.lsJump = String(i + 1);
    n++;
  });
  return n;
}

if (typeof module !== 'undefined') {
  module.exports = { buildLiveSummaryPrompt, normalizeLiveSummary, linkLiveSummaryToc,
                     clampLiveSummaryMinutes, LIVE_SUMMARY_MAX_PROMPT,
                     extractLiveSummaryQuotes, cleanLiveSummaryTitle, liveSummaryTextKey, findLiveSummaryTarget };
}
