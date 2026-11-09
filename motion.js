/**
 * motion.js — ばねの動き（SUMADO の仕様書 1 章・2 章に合わせる）(v0.24.59)
 *
 * やっさんの指定（2026-11-09）「現時点の Dictation アプリの世界観はそのままで、細かい動きだけを更新」。
 * 唐突に出る・消える・跳ぶところを、ばねで動かすための部品。見た目（色・字・形）は変えない。
 *
 * ■ SUMADO から移したもの（計算と値は同じ。書き写しの元は SUMADO の 3880147）
 *   extension/js/spring.js         … ばね（animate / set / current / onFrame / SPRINGS）
 *   extension/js/kit/motion.js     … 動きの型の値（MOTION.pop など）
 *   extension/js/ui/reveal.js      … 出す・しまう（高さと濃さ）
 *   extension/js/ui/smooth-height.js … 入れ物の高さを中身に合わせてすっと
 *   extension/js/ui/flip.js        … 一覧の並びの変化（FLIP）
 *
 * ■ なぜ import せずに写したか
 * ディクテーションは ES モジュールではなく、普通の <script> を並べて読んでいる（SUMADO の iframe の中でも同じ）。
 * SUMADO のファイルを直接読むと、拡張をまたいだ読み込みになり、SUMADO が無いと動かない。
 * 値を変えるときは SUMADO の原本を先に直し、ここを写し直す（CLAUDE.md「写しは直さない」と同じ考え方）。
 *
 * ■ 守ること（仕様書 2.1）
 * 動かすのは transform（位置・大きさ）と opacity だけ。ease / linear は使わない。
 * 高さを変えたいときは、見えない要素をばねで動かして毎フレーム写す（onFrame）。
 * 注意: animate / set は要素の style.transform を上書きする。CSS で transform を使っている要素には使わない
 * （中に包みを1つ入れて、そちらを動かす）。
 */
(function (global) {
  'use strict';

  const SPRINGS = {
    app: { response: 0.42, dampingFraction: 0.86 },    // 少しだけ行き過ぎて戻る
    page: { response: 0.38, dampingFraction: 0.92 },   // ページの切り替え・横に送る
    press: { response: 0.22, dampingFraction: 0.7 },   // 押したときの縮み・小さなメニューの出入り
    sheet: { response: 0.36, dampingFraction: 0.9 },   // 下から出るシート・高さの伸び縮み
    fade: { response: 0.3, dampingFraction: 1 },       // ふわっと出る・消える（行き過ぎない）
  };

  // 動きの型（SUMADO の kit/motion.js の MOTION から、ディクテーションで使うものだけ）
  const MOTION = {
    pop: { response: 0.36, dampingFraction: 0.6 },     // ポップアップ：少し行き過ぎて、ぽんと出る（大きさだけ）
    popFade: { response: 0.16, dampingFraction: 1 },   // 濃さは行き過ぎずにすぐ
    popFrom: 0.5,                                      // メニューは押したところの小さい大きさから
    alertFrom: 1.15,                                   // アラート（モーダル）は少し大きいところから
    morph: {
      wide: { response: 0.5, dampingFraction: 0.74 },
      tall: { response: 0.62, dampingFraction: 0.8 },
      shrinkW: { response: 0.44, dampingFraction: 0.6 },
      shrinkH: { response: 0.5, dampingFraction: 0.66 },
      vanish: { response: 0.42, dampingFraction: 0.62 },
      vanishFadeDelay: 170,
      fadeOut: { response: 0.2, dampingFraction: 1 },
      appear: { response: 0.16, dampingFraction: 1 },
      contentInDelay: 130,
      contentIn: { response: 0.32, dampingFraction: 1 },
      contentOut: { response: 0.13, dampingFraction: 1 },
      shapeAfterOut: 70,
      radiusMax: 26,
      dot: 6,
      riseHold: 70,
      riseTall: { response: 0.26, dampingFraction: 0.8 },
      riseGap: 150,
      sinkGap: 170,
      sinkWide: { response: 0.3, dampingFraction: 0.9 },
    },
  };

  const DEFAULT_PROPS = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, opacity: 1 };
  const EPS = { x: 0.1, y: 0.1, scale: 0.0005, scaleX: 0.0005, scaleY: 0.0005, opacity: 0.002 };

  class Spring1D {
    constructor(value) { this.value = value; this.target = value; this.velocity = 0; this.k = 0; this.c = 0; }
    configure({ response, dampingFraction }) {
      const omega = (2 * Math.PI) / response;
      this.k = omega * omega;
      this.c = 2 * dampingFraction * omega;
    }
    step(dt) {
      const n = Math.max(1, Math.ceil(dt / (1 / 240)));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        const a = -this.k * (this.value - this.target) - this.c * this.velocity;
        this.velocity += a * h;
        this.value += this.velocity * h;
      }
    }
    atRest(eps) { return Math.abs(this.velocity) < eps * 10 && Math.abs(this.value - this.target) < eps; }
    snap() { this.value = this.target; this.velocity = 0; }
  }

  const states = new WeakMap();
  const running = new Set();
  let rafId = 0;
  let lastT = 0;

  function stateOf(el) {
    let st = states.get(el);
    if (!st) { st = { springs: {}, waiters: [], onFrame: null }; states.set(el, st); }
    return st;
  }

  function current(el) {
    const st = states.get(el);
    const out = Object.assign({}, DEFAULT_PROPS);
    if (st) for (const k of Object.keys(st.springs)) out[k] = st.springs[k].value;
    return out;
  }

  function apply(el, st) {
    const v = (k) => (st.springs[k] ? st.springs[k].value : DEFAULT_PROPS[k]);
    const moves = st.springs.x || st.springs.y || st.springs.scale || st.springs.scaleX || st.springs.scaleY;
    if (moves && el.style) {
      const s = v('scale');
      el.style.transform =
        `translate3d(${v('x').toFixed(2)}px, ${v('y').toFixed(2)}px, 0) ` +
        `scale(${(s * v('scaleX')).toFixed(4)}, ${(s * v('scaleY')).toFixed(4)})`;
    }
    if (st.springs.opacity && el.style) el.style.opacity = Math.max(0, Math.min(1, st.springs.opacity.value)).toFixed(3);
    if (st.onFrame) st.onFrame(current(el));
  }

  function tick(t) {
    const dt = Math.min(0.064, lastT ? (t - lastT) / 1000 : 1 / 60);
    lastT = t;
    for (const el of Array.from(running)) {
      const st = states.get(el);
      if (!st) { running.delete(el); continue; }   // clear() されたもの
      let resting = true;
      for (const k of Object.keys(st.springs)) {
        const sp = st.springs[k];
        sp.step(dt);
        if (!sp.atRest(EPS[k])) resting = false;
      }
      if (resting) {
        for (const k of Object.keys(st.springs)) st.springs[k].snap();
        running.delete(el);
      }
      apply(el, st);
      if (resting) {
        const ws = st.waiters;
        st.waiters = [];
        ws.forEach((w) => w(true));
      }
    }
    if (running.size) rafId = requestAnimationFrame(tick);
    else { rafId = 0; lastT = 0; }
  }

  function ensureLoop() {
    if (!rafId) { lastT = 0; rafId = requestAnimationFrame(tick); }
  }

  /**
   * ばねで目標の値へ動かす
   * @returns {Promise<boolean>} 止まったら true、別の animate / set で割り込まれたら false
   */
  function animate(el, to, opts) {
    opts = opts || {};
    const st = stateOf(el);
    const cfg = opts.spring || SPRINGS.app;
    for (const k of Object.keys(to)) {
      if (!(k in DEFAULT_PROPS)) continue;
      let sp = st.springs[k];
      if (!sp) sp = st.springs[k] = new Spring1D(DEFAULT_PROPS[k]);
      sp.configure(cfg);
      sp.target = to[k];
      if (opts.velocity && opts.velocity[k] !== undefined) sp.velocity = opts.velocity[k];
    }
    const ws = st.waiters;
    st.waiters = [];
    ws.forEach((w) => w(false));
    running.add(el);
    ensureLoop();
    return new Promise((resolve) => st.waiters.push(resolve));
  }

  /** アニメーションなしで値を決める。動いているばねは止める */
  function set(el, values) {
    const st = stateOf(el);
    for (const k of Object.keys(values)) {
      if (!(k in DEFAULT_PROPS)) continue;
      let sp = st.springs[k];
      if (!sp) sp = st.springs[k] = new Spring1D(values[k]);
      sp.value = values[k]; sp.target = values[k]; sp.velocity = 0;
    }
    running.delete(el);
    const ws = st.waiters;
    st.waiters = [];
    ws.forEach((w) => w(false));
    apply(el, st);
  }

  /**
   * ばねで動かしたあとの transform / opacity の書き込みを外し、CSS に戻す（ディクテーション用に足した）
   * ディクテーションは見た目を CSS で決めているので、動き終わったら style に値を残さない
   * （残すと、あとで CSS のクラスで出し入れしているところが効かなくなる）
   */
  function clear(el) {
    states.delete(el);
    running.delete(el);
    if (el.style) { el.style.transform = ''; el.style.opacity = ''; }
  }

  function onFrame(el, fn) { stateOf(el).onFrame = fn; }

  /* ───────── 出す・しまう（reveal） ───────── */
  const revealStates = new WeakMap();
  function reveal(el, show, o) {
    const instant = !!(o && o.instant);
    let st = revealStates.get(el);
    if (!st) {
      const driver = document.createElement('span');
      st = { driver, shown: !el.hidden, moving: false };
      onFrame(driver, ({ x }) => { el.style.height = `${Math.max(0, x)}px`; });
      revealStates.set(el, st);
    }
    if (st.shown === show && !st.moving) { el.hidden = !show; return Promise.resolve(true); }
    st.shown = show;
    if (instant) {
      el.hidden = !show; el.style.height = ''; el.style.overflow = '';
      clear(el);
      return Promise.resolve(true);
    }
    const from = st.moving ? current(st.driver).x : (show ? 0 : el.offsetHeight);
    el.hidden = false;
    el.style.height = '';
    const to = show ? el.offsetHeight : 0;
    el.style.overflow = 'hidden';
    el.style.height = `${from}px`;
    set(st.driver, { x: from });
    st.moving = true;
    // 濃さの始まり：途中から逆にしたときはいまの濃さから、そうでなければ出すなら 0・しまうなら 1 から
    const hasOp = states.get(el) && states.get(el).springs.opacity;
    if (!hasOp) set(el, { opacity: show ? 0 : 1 });
    animate(el, { opacity: show ? 1 : 0 }, { spring: SPRINGS.fade });
    return animate(st.driver, { x: to }, { spring: SPRINGS.sheet }).then((done) => {
      if (!done) return false;
      st.moving = false;
      el.style.height = '';
      el.style.overflow = '';
      if (!show) el.hidden = true;
      clear(el);   // 濃さのばねがまだ動いていても止めて、style を CSS に戻す
      return true;
    });
  }

  /* ───────── 入れ物の高さを中身に合わせてすっと（smoothHeight） ───────── */
  function smoothHeight(box, watch) {
    const driver = document.createElement('div');
    let shown = box.offsetHeight;
    let moving = false;
    let target = -1;
    onFrame(driver, ({ x }) => { shown = x; box.style.height = `${x}px`; });
    const natural = () => {
      const keep = box.style.height;
      box.style.height = '';
      const h = box.offsetHeight;
      box.style.height = keep;
      return h;
    };
    const check = () => {
      if (!box.isConnected) return;
      const from = moving ? current(driver).x : shown;
      const to = natural();
      if (moving && Math.abs(to - target) < 1) return;
      if (Math.abs(to - from) < 1) { if (!moving) shown = to; return; }
      // 見えていない（display:none の中）ときは測れないので、覚えておくだけ
      if (!box.offsetParent && box.offsetHeight === 0) { shown = to; return; }
      if (!moving) set(driver, { x: from });
      box.style.height = `${from}px`;
      box.style.overflow = 'hidden';
      moving = true;
      target = to;
      animate(driver, { x: to }, { spring: SPRINGS.sheet }).then((done) => {
        if (!done) return;
        moving = false;
        box.style.height = '';
        box.style.overflow = '';
        shown = box.offsetHeight;
      });
    };
    const mo = new MutationObserver(check);
    mo.observe(watch, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(check);
    ro.observe(watch);
    return () => { mo.disconnect(); ro.disconnect(); };
  }

  /* ───────── 一覧の並びの変化（flipList） ───────── */
  /**
   * @param {Element} container
   * @param {Function} redraw
   * @param {object} [o] { key: 行を見分ける関数（既定は data-key）, selector: 行の選び方, fadeIn: 新しい行をふわっと,
   *                       ghost: 消えた行の写しを置いてふわっと消す（ディクテーション用に足した。SUMADO の flipList は消えた行をそのまま消す） }
   */
  function flipList(container, redraw, o) {
    o = o || {};
    const selector = o.selector || '[data-key]';
    const keyOf = o.key || ((n) => n.dataset.key);
    const before = new Map();
    const nodes = new Map();
    for (const n of container.querySelectorAll(selector)) {
      const k = keyOf(n);
      if (k != null) { before.set(k, n.getBoundingClientRect()); nodes.set(k, n); }
    }
    const firstTime = before.size === 0;
    redraw();
    if (firstTime) return;
    const after = new Set();
    for (const n of container.querySelectorAll(selector)) after.add(keyOf(n));
    if (o.ghost) {
      for (const [k, old] of nodes) {
        if (after.has(k)) continue;
        const r = before.get(k);
        if (!r || !r.width) continue;
        const g = old.cloneNode(true);
        g.removeAttribute('id');
        g.setAttribute('aria-hidden', 'true');
        Object.assign(g.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`,
          height: `${r.height}px`, margin: '0', pointerEvents: 'none', zIndex: '50', boxSizing: 'border-box' });
        document.body.appendChild(g);
        animate(g, { opacity: 0, scale: 0.94 }, { spring: SPRINGS.fade }).then(() => g.remove());
      }
    }
    for (const n of container.querySelectorAll(selector)) {
      const k = keyOf(n);
      const b = before.get(k);
      const a = n.getBoundingClientRect();
      // 作り直しが続いたとき（増えた直後にもう一度描き直す等）、前の要素で途中だった濃さ・大きさを引き継ぐ。
      // 引き継がないと、ふわっと出ている途中のものが、いきなり濃くなる
      const prev = nodes.get(k);
      if (b && prev && prev !== n && states.has(prev)) {
        const c = current(prev);
        if (c.opacity < 0.999 || Math.abs(c.scale - 1) > 0.001) {
          set(n, { opacity: c.opacity, scale: c.scale, x: b.left - a.left, y: b.top - a.top });
          animate(n, { opacity: 1, scale: 1, x: 0, y: 0 }, { spring: SPRINGS.fade }).then((d) => { if (d) clear(n); });
          continue;
        }
      }
      if (!b) {
        if (o.fadeIn === false) continue;
        set(n, { opacity: 0, scale: 0.97 });
        animate(n, { opacity: 1, scale: 1 }, { spring: SPRINGS.fade }).then((d) => { if (d) clear(n); });
        continue;
      }
      const dx = b.left - a.left;
      const dy = b.top - a.top;
      if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
      set(n, { x: dx, y: dy });
      animate(n, { x: 0, y: 0 }, { spring: SPRINGS.sheet }).then((d) => { if (d) clear(n); });
    }
  }

  global.Motion = { SPRINGS, MOTION, animate, set, current, clear, onFrame, reveal, smoothHeight, flipList, Spring1D };
})(typeof window !== 'undefined' ? window : globalThis);
