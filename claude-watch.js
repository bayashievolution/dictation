/**
 * Claude に頼んでいるあいだの見張り (v0.24.145)
 *
 * やっさん（2026-11-14）: 講義を止めたあと、処理が終わる前に PC をスタンバイにした。立ち上げたら Claude の要約が始まったが、
 * 「いつまで続くのか、正常なのか、試し直しているのか、止まっているのか分からない」。
 * 正常なときは何も出さず、いつもより長い・試し直している・スタンバイから戻った、のときだけ右上で分かるようにした
 * （見本 https://claude.ai/artifact/WiLp7kmj4F1n8V942Ss73a で OK をもらった形。出し方は app.js の paintClaudeWatch）。
 *
 * ■ ここが受け持つこと
 *   - いま Claude に頼んでいる呼び出しの一覧（何の処理か・いつ始めたか・待つ上限・何回目の試し直しか）
 *   - その処理がいつもどれくらいかかるか（直近 7 回の真ん中の値。この PC の localStorage に覚える）
 *   - スタンバイから戻ったことに気づく: 5 秒ごとの見張りが 30 秒以上とんだら、PC が止まっていたとみなす。
 *     そのとき待っている呼び出しは「返事をあきらめる」（claudeWatchRun が wake: true で返す）。
 *     スタンバイのあいだに Claude の処理は止まっているとみられ、待つ上限（長い講義の要約だと 12 分ほど）まで待つのは無駄なため。
 *     呼び出し自体は取り消せない（拡張の口に取り消しが無い）ので、あとから返事が来ても捨てる
 */
(function (global) {
  const calls = new Map();
  let seq = 0;
  const wakeWaiters = new Set();
  const TIMES_KEY = 'dictation:claudeTimes';
  const WAKE_GAP_MS = 30000;

  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - lastTick > WAKE_GAP_MS) fireWake();
    lastTick = now;
  }, 5000);

  function fireWake() {
    for (const w of Array.from(wakeWaiters)) w();
  }

  function changed() {
    if (typeof global.onClaudeWatchChange === 'function') {
      try { global.onClaudeWatchChange(); } catch (_) { /* 表示の失敗で処理を止めない */ }
    }
  }

  /** その処理がいつもかかる秒数（覚えていなければ、録音中の小さな処理は 15 秒・ほかは 45 秒とみる） */
  function typicalSec(feature) {
    try {
      const t = JSON.parse(localStorage.getItem(TIMES_KEY) || '{}')[feature];
      if (Array.isArray(t) && t.length) {
        const s = t.slice().sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      }
    } catch (_) { /* 読めなければ決め打ちで */ }
    return /^live-(refine|heading)$/.test(feature) ? 15 : 45;
  }
  function rememberSec(feature, sec) {
    try {
      const all = JSON.parse(localStorage.getItem(TIMES_KEY) || '{}');
      all[feature] = (Array.isArray(all[feature]) ? all[feature] : []).concat([Math.round(sec)]).slice(-7);
      localStorage.setItem(TIMES_KEY, JSON.stringify(all));
    } catch (_) { /* 覚えられなくても動く */ }
  }

  /**
   * claudeBridgeRun を見張りつきで呼ぶ
   * @param {string} prompt
   * @param {object} opts  claudeBridgeRun にそのまま渡す（timeoutMs は待つ上限の表示にも使う）
   * @param {{feature:string, attempt?:number, retries?:number, mode?:'run'|'retry'|'wake', prevWaitMs?:number}} meta
   * @returns {Promise<object>} claudeBridgeRun の返事。スタンバイから戻ったら { ok: false, wake: true, error }
   */
  async function claudeWatchRun(prompt, opts, meta) {
    const id = ++seq;
    const call = {
      id, feature: meta.feature || '', startedAt: Date.now(), timeoutMs: (opts && opts.timeoutMs) || 0,
      attempt: meta.attempt || 0, retries: meta.retries || 0, mode: meta.mode || 'run', prevWaitMs: meta.prevWaitMs || 0,
    };
    calls.set(id, call);
    changed();
    let wake;
    const wakeP = new Promise((resolve) => {
      wake = () => resolve({ ok: false, wake: true, error: 'スタンバイから戻ったので、やり直します' });
      wakeWaiters.add(wake);
    });
    try {
      const r = await Promise.race([global.claudeBridgeRun(prompt, opts), wakeP]);
      if (r && r.ok) rememberSec(call.feature, (Date.now() - call.startedAt) / 1000);
      return r;
    } finally {
      wakeWaiters.delete(wake);
      calls.delete(id);
      changed();
    }
  }

  global.claudeWatchRun = claudeWatchRun;
  global.claudeWatchCalls = () => Array.from(calls.values());
  global.claudeWatchTypicalSec = typicalSec;
  global.claudeWatchFireWake = fireWake;   // テスト用（本物は時計のとびで起きる）
})(typeof window !== 'undefined' ? window : globalThis);
