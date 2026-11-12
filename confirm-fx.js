/**
 * 確定の演出 (v0.24.119)
 *
 * AI で聞き取るモードでは、Web Speech の仮の字（うすい斜め字・「未確定」）が、
 * あとから Groq / Gemini の字に入れ替わる。前は字がいきなり変わっていた（高さだけ transcriptMorph でばね）。
 * やっさん「なめらかに確定されていく演出というか、そういうのできないかなあ　試しに何種類か入れてみてほしい」（2026-11-11、研修で実戦投入中）
 *
 * 試しの段階なので、見せ方を 4 つ用意して設定（表示）で選べるようにした。どれに決めるかは実機で見てもらう。
 *   fade … ふわっと：新しい字が薄いところから濃くなる
 *   type … 一文字ずつ流れる：頭から順に字が濃くなる（読む順に流れる）
 *   blur … ぼかしが晴れる：ぼやけた字がくっきりする
 *   diff … 直ったところが光る：仮の字と同じところはそのまま、変わった字だけ緑に光って消える
 *
 * ■ しくみ
 * 段落の中身を差し替えたあと（setParagraphContent のあと）、字を 1 文字ずつ <span class="fxc"> で包み、
 * 1 本のばね（進み具合 p）で毎フレーム濃さなどを書き、終わったら包みを外して元の文字だけに戻す。
 * 動きは ease ではなくばね（SUMADO の仕様書 2.1）。濃さと見た目だけを変え、字の位置は動かさない（行の折り返しが変わらない）。
 *
 * ■ 保存に包みを残さない
 * 演出の途中で保存が走る（差し替えた直後に persist を呼ぶ）。包みがそのまま保存されると、開き直したときに薄いままになる。
 * なので保存の前に stripFxSpans で包みを外す（app.js の savableHtml）。包みは 1 文字ずつなので、中に < は入らない。
 *
 * ■ 位置を写した重ね絵（オーバーレイ）を採らなかった理由
 * 演出のあいだも自動スクロールと transcriptMorph（高さのばね）で段落が動く。上に重ねた絵はずれる。
 */
(function (global) {
  const CONFIRM_FX = [
    { value: 'none', label: 'なし' },
    // v0.24.128: 名前をやっさんの指定に（ふわっと→フェードイン・ぼかしが晴れる→ブラー・一文字ずつ流れる→タイプライター・直ったところが光る→アップデートグロー）。並びも指定どおり
    { value: 'fade', label: 'フェードイン' },
    { value: 'blur', label: 'ブラー' },
    { value: 'type', label: 'タイプライター' },
    { value: 'diff', label: 'アップデートグロー' },
  ];

  /**
   * 新しい字のうち、古い字から変わったところに true を立てる（文字単位の最長共通部分列）
   * 長すぎるとき（掛け算で 40 万を超える）は計算せずに全部「変わった」とする（1 段落はふつう 200 字ほど）
   * @returns {boolean[]} newStr と同じ長さ
   */
  function fxDiffMarks(oldStr, newStr) {
    const a = Array.from(oldStr || ''), b = Array.from(newStr || '');
    const n = a.length, m = b.length;
    if (!n || n * m > 400000) return b.map(() => true);
    // dp[i][j] = a[i..] と b[j..] の最長共通部分列の長さ
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const marks = b.map(() => true);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { marks[j] = false; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return marks;
  }

  /** 保存する HTML から演出の包みを外す */
  function stripFxSpans(html) {
    if (!html || html.indexOf('fxc') < 0) return html;
    return html.replace(/<span class="fxc"[^>]*>([^<]*)<\/span>/g, '$1');
  }

  /** 1 文字ごとの見た目（p は 0→1 の進み具合、rank は包んだ字の何番目か、total は包んだ字の数） */
  function fxStyle(mode, p, rank, total) {
    if (mode === 'fade') return { opacity: 0.15 + 0.85 * p };
    if (mode === 'blur') return { opacity: 0.3 + 0.7 * p, filter: `blur(${(5 * (1 - p)).toFixed(2)}px)` };
    if (mode === 'type') {
      const W = 6;   // 濃くなりかけの字の幅（何文字ぶんでなめらかにつなぐか）
      const head = p * (total + W);
      return { opacity: Math.max(0, Math.min(1, (head - rank) / W)) };
    }
    if (mode === 'glow') {
      // v0.24.133: 下書きのグローを段落にかけるとき（Web Speech を並走させず、AI の字が下書きになる場合）。緑から字の色へ
      return { color: `color-mix(in srgb, var(--accent) ${(100 * (1 - p)).toFixed(1)}%, var(--text))` };
    }
    if (mode === 'diff') {
      return { opacity: Math.min(1, 0.25 + p * 3), backgroundColor: `color-mix(in srgb, var(--accent) ${(45 * (1 - p)).toFixed(1)}%, transparent)` };
    }
    return {};
  }

  const SPRING = {
    fade: { response: 0.45, dampingFraction: 1 },
    blur: { response: 0.55, dampingFraction: 1 },
    diff: { response: 1.1, dampingFraction: 1 },   // 光は少し残す（どこが直ったか目で追えるように）
    glow: { response: 1.0, dampingFraction: 1 },   // 下書きのグロー（CSS の draftGlow と同じ長さ）
  };
  const typeSpring = (total) => ({ response: Math.max(0.45, Math.min(1.4, 0.35 + total / 250)), dampingFraction: 1 });

  const tokens = new WeakMap();   // 段落ごとに、いま動いている演出（新しく始まったら古いほうは止める）

  function textNodesOf(pEl) {
    const out = [];
    pEl.querySelectorAll('.p-body, h2').forEach((host) => {
      const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) if (t.nodeValue) out.push(t);
    });
    return out;
  }

  function unwrap(pEl) {
    const spans = pEl.querySelectorAll('span.fxc');
    if (!spans.length) return;
    const parents = new Set();
    spans.forEach((s) => { parents.add(s.parentNode); s.replaceWith(document.createTextNode(s.textContent)); });
    parents.forEach((p) => p && p.normalize());
  }

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /**
   * 差し替えたばかりの段落に演出をかける
   * @param {HTMLElement} pEl
   * @param {string} oldText 差し替える前の字（diff で使う）
   * @param {string} mode CONFIRM_FX の value
   * @returns {Promise<void>} 終わったら（止められたときも）解決する
   */
  function playConfirmFx(pEl, oldText, mode) {
    if (!pEl || !mode || mode === 'none' || !global.Motion || reduced()) return Promise.resolve();
    const prev = tokens.get(pEl);
    if (prev) prev.cancel();
    unwrap(pEl);

    const nodes = textNodesOf(pEl);
    const full = nodes.map((t) => t.nodeValue).join('');
    const marks = mode === 'diff' ? fxDiffMarks(oldText || '', full) : null;
    const spans = [];
    let k = 0;
    for (const t of nodes) {
      const chars = Array.from(t.nodeValue);
      const frag = document.createDocumentFragment();
      let plain = '';
      for (const ch of chars) {
        const wrap = marks ? marks[k] : !/\s/.test(ch);
        k++;
        if (!wrap) { plain += ch; continue; }
        if (plain) { frag.appendChild(document.createTextNode(plain)); plain = ''; }
        const s = document.createElement('span');
        s.className = 'fxc';
        s.textContent = ch;
        frag.appendChild(s);
        spans.push(s);
      }
      if (plain) frag.appendChild(document.createTextNode(plain));
      t.replaceWith(frag);
    }
    if (!spans.length) return Promise.resolve();

    const total = spans.length;
    const paint = (p) => {
      for (let i = 0; i < total; i++) Object.assign(spans[i].style, fxStyle(mode, p, i, total));
    };
    paint(0);

    const sp = new global.Motion.Spring1D(0);
    sp.configure(mode === 'type' ? typeSpring(total) : (SPRING[mode] || SPRING.fade));
    sp.target = 1;
    return new Promise((resolve) => {
      let raf = 0, last = 0, done = false;
      const finish = (cancelled) => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        if (tokens.get(pEl) === tok) tokens.delete(pEl);
        if (!cancelled) unwrap(pEl);
        resolve();
      };
      const tok = { cancel: () => finish(true) };
      tokens.set(pEl, tok);
      const frame = (t) => {
        if (done) return;
        if (!pEl.isConnected) return finish(false);
        const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
        last = t;
        sp.step(dt);
        if (sp.atRest(0.002)) { sp.snap(); paint(1); return finish(false); }
        paint(Math.max(0, Math.min(1, sp.value)));
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });
  }

  /* ───────── Web Speech の下書き (v0.24.120) ─────────
   *
   * やっさんの指定で「文字起こしエフェクト」を 2 段にした: Web Speech の下書き（エフェクト・スタイル）と AI 整形（上の playConfirmFx）。
   * 下書きは Web Speech が数百ミリ秒ごとに「ここまでの全文」を送ってくる。前の全文と頭から比べて、
   * 同じところは触らず、増えたところだけを <span> で足してアニメーションをかける（前の字はちらつかない）。
   * Web Speech が前の字を言い直したら（頭からの一致が短くなったら）、そこから後ろを切って足し直す。
   *
   * ここは毎回の更新で span が増えるので、1 本ずつ JS のばねで動かさず、CSS のアニメーションにした。
   * そのかわり動きの曲線はばねで作る（springLinear: ばねを計算して CSS の linear() に写す。SUMADO の仕様書 2.1「ease は使わない」）。
   */
  const DRAFT_FX = [
    { value: 'none', label: 'なし' },
    { value: 'fade', label: 'フェードイン' },
    { value: 'blur', label: 'ブラー' },          // v0.24.128: ぼかしから→ブラー
    { value: 'glow', label: 'グロー' },          // v0.24.128: 光ってから落ち着く→グロー
  ];
  // v0.24.128: スタイルは 4 つの段階（下書き・確定・聞き取り・整形）で共通。並びはやっさんの指定どおり
  const DRAFT_STYLE = [
    { value: 'none', label: 'なし' },
    { value: 'underline', label: '下線' },
    { value: 'italic', label: 'イタリック' },
    { value: 'bold', label: 'ボールド' },
  ];

  /**
   * 段階のスタイルを CSS の変数にする (v0.24.128)
   * 変数にするのは、いちばん近い指定が勝つようにするため（ページ全体は保存した値、プレビューの箱は設定の欄の値）
   * @param {HTMLElement} el  変数を付ける要素
   * @param {string} stage    draft / commit / heard / refine
   * @param {string} value    DRAFT_STYLE の value
   */
  function applyStageStyle(el, stage, value) {
    if (!el || !el.style) return;
    const v = value || 'none';
    el.style.setProperty(`--st-${stage}-fs`, v === 'italic' ? 'italic' : 'normal');
    // 'inherit' にしない: 変数が親（ページ全体）の値を引き継いでしまい、プレビューで「なし」を選んでもボールドのままになる
    el.style.setProperty(`--st-${stage}-fw`, v === 'bold' ? '700' : 'normal');
    el.style.setProperty(`--st-${stage}-td`, v === 'underline' ? 'underline' : 'none');
  }

  /** 頭から何文字同じか */
  function commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    // サロゲートペアの片割れで切らない
    if (i > 0 && i < a.length && /[\uDC00-\uDFFF]/.test(a[i])) i--;
    return i;
  }

  /** ばねの動き（0→1）を CSS の linear() にする。返すのは { easing, ms } */
  function springLinear({ response, dampingFraction }, points = 40) {
    const sp = new Spring1D0(0);
    sp.configure({ response, dampingFraction });
    sp.target = 1;
    const dt = 1 / 240, vals = [0];
    let t = 0;
    while (t < 3) {
      sp.step(dt); t += dt; vals.push(sp.value);
      if (Math.abs(sp.velocity) < 0.01 && Math.abs(sp.value - 1) < 0.002) break;
    }
    const ms = Math.round(t * 1000);
    const stepN = Math.max(1, Math.floor(vals.length / points));
    const out = [];
    for (let i = 0; i < vals.length; i += stepN) out.push(Number(vals[i].toFixed(4)));
    out[out.length - 1] = 1;
    return { easing: `linear(${out.join(', ')})`, ms };
  }
  // Motion が無くても計算できるように、同じばねの式をここにも持つ（motion.js の Spring1D と同じ）
  class Spring1D0 {
    constructor(v) { this.value = v; this.target = v; this.velocity = 0; }
    configure({ response, dampingFraction }) { const w = (2 * Math.PI) / response; this.k = w * w; this.c = 2 * dampingFraction * w; }
    step(dt) { const a = -this.k * (this.value - this.target) - this.c * this.velocity; this.velocity += a * dt; this.value += this.velocity * dt; }
  }

  /** 下書きの曲線を CSS の変数にしておく（起動時に 1 回） */
  function installDraftEasing(root) {
    if (!root || !root.style) return;
    const f = springLinear({ response: 0.45, dampingFraction: 1 });
    const g = springLinear({ response: 1.0, dampingFraction: 1 });   // 光は少し残す
    root.style.setProperty('--draft-ease', f.easing);
    root.style.setProperty('--draft-ms', f.ms + 'ms');
    root.style.setProperty('--draft-glow-ease', g.easing);
    root.style.setProperty('--draft-glow-ms', g.ms + 'ms');
  }

  /** el の中の字を、頭から len 文字だけ残す */
  function trimTo(el, len) {
    let left = len;
    for (const node of Array.from(el.childNodes)) {
      const t = node.textContent;
      if (left <= 0) { node.remove(); continue; }
      if (t.length <= left) { left -= t.length; continue; }
      node.textContent = t.slice(0, left);
      left = 0;
    }
  }

  /**
   * 下書きの欄（#interim）に字を書く
   * @param {HTMLElement} el
   * @param {string} text Web Speech が送ってきた、ここまでの全文
   * @param {string} mode DRAFT_FX の value
   */
  function renderDraft(el, text, mode) {
    if (!el) return;
    text = text || '';
    if (!text || !mode || mode === 'none' || reduced()) { if (el.textContent !== text || el.children.length) el.textContent = text; return; }
    const prev = el.textContent;
    if (prev === text) return;
    const keep = commonPrefixLen(prev, text);
    trimTo(el, keep);
    const add = text.slice(keep);
    if (!add) return;
    const s = document.createElement('span');
    s.className = 'draft-in draft-in-' + mode;
    s.textContent = add;
    el.appendChild(s);
  }

  global.ConfirmFx = { CONFIRM_FX, fxDiffMarks, fxStyle, stripFxSpans, playConfirmFx,
    DRAFT_FX, DRAFT_STYLE, commonPrefixLen, springLinear, installDraftEasing, renderDraft, applyStageStyle };
})(typeof window !== 'undefined' ? window : globalThis);
