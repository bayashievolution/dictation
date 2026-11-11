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
    { value: 'fade', label: 'ふわっと' },
    { value: 'type', label: '一文字ずつ流れる' },
    { value: 'blur', label: 'ぼかしが晴れる' },
    { value: 'diff', label: '直ったところが光る' },
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
    if (mode === 'diff') {
      return { opacity: Math.min(1, 0.25 + p * 3), backgroundColor: `color-mix(in srgb, var(--accent) ${(45 * (1 - p)).toFixed(1)}%, transparent)` };
    }
    return {};
  }

  const SPRING = {
    fade: { response: 0.45, dampingFraction: 1 },
    blur: { response: 0.55, dampingFraction: 1 },
    diff: { response: 1.1, dampingFraction: 1 },   // 光は少し残す（どこが直ったか目で追えるように）
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

  global.ConfirmFx = { CONFIRM_FX, fxDiffMarks, fxStyle, stripFxSpans, playConfirmFx };
})(typeof window !== 'undefined' ? window : globalThis);
