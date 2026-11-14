/**
 * stt-compare.js — 文字起こし比較ページの画面と通信
 *
 * 目的（TODO.md「トークン削減」の続き・2026-11-09）:
 *   講義の Gemini 代の大半は音声の文字起こし。Groq の無料の Whisper に替えられるかを、
 *   同じ音声で比べて決める。見たいのは ①小さい声・遠くの声 ②雑音だけの区間で文を作らないか ③速さ。
 *
 * Gemini は本体の transcribeAudioWithGemini（gemini.js）をそのまま呼ぶ。指示文を写すと
 * 本体が変わったときに比較がずれるため。claude-bridge.js は読み込まないので、必ず Gemini に行く
 * （文字起こしはもともと Claude に回せない処理）。
 *
 * inline script は拡張の CSP（script-src 'self'）で禁止されているので外部 JS にしている。
 */
(function () {
  const el = id => document.getElementById(id);
  const SR = 16000;              // Whisper も中で 16kHz にする。Gemini も音声 1 秒 32 トークンで形式に依らない
  const FRAME_SEC = 0.1;
  // 新しいキー。本体の設定（dictation:settings）には書き込まない
  const STORE_KEY = 'dictation:sttCompare';
  const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  // 無料枠は 1 分 20 回。3 秒あける（ちょうど 20 回/分）と時計のずれで超えるので少し足す
  const GROQ_GAP_MS = 3200;

  const state = {
    audio: null,          // Float32Array（16kHz・モノラル・前処理なし）
    sourceLabel: '',
    stream: null, recorder: null, recParts: [], recStartedAt: 0, meterTimer: null, audioCtx: null,
    running: false, abort: false,
    rows: [], meta: {},
    lastGroqAt: 0,
    sessionsCache: null,
  };

  /* ───────── 保存 ───────── */

  const PREF_IDS = ['groq-key', 'groq-model', 'preprocess', 'min-sec', 'max-sec', 'from-min', 'len-min', 'ctx-field', 'ctx-terms', 'use-gemini', 'use-groq'];
  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) {}
    for (const id of PREF_IDS) {
      if (!(id in p)) continue;
      const n = el(id);
      if (n.type === 'checkbox') n.checked = !!p[id]; else n.value = p[id];
    }
  }
  function savePrefs() {
    const p = {};
    for (const id of PREF_IDS) {
      const n = el(id);
      p[id] = n.type === 'checkbox' ? n.checked : n.value;
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (_) {}
  }

  function geminiKey() {
    try { return (JSON.parse(localStorage.getItem('dictation:settings') || '{}') || {}).apiKey || ''; }
    catch (_) { return ''; }
  }
  function showGeminiKeyState() {
    const k = geminiKey();
    const n = el('gemini-key-state');
    n.textContent = k ? '本体の設定のキーを使います' : '本体の設定にキーがありません（本体の設定画面で入れてください）';
    n.className = k ? 'ok' : 'ng';
  }

  /* ───────── 音声を読み込む ───────── */

  async function decodeToMono16k(blob) {
    const ab = await blob.arrayBuffer();
    // OfflineAudioContext の decodeAudioData は、その context のサンプルレートに変換して返す
    const ctx = new OfflineAudioContext(1, 1, SR);
    const buf = await ctx.decodeAudioData(ab);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  }

  async function loadBlob(blob, label) {
    el('source-label').textContent = '読み込み中…';
    try {
      state.audio = await decodeToMono16k(blob);
      state.sourceLabel = label;
      el('source-label').textContent = `${label}（${sttFmtTime(state.audio.length / SR)}）`;
    } catch (e) {
      state.audio = null;
      el('source-label').textContent = '読み込めませんでした: ' + (e.message || e);
    }
    updatePlan();
  }

  /* マイク。本体の Gemini モードと同じく、Chrome の音声処理（AGC/NS/EC）は全部切る（v0.13.6 の事故） */
  async function startRec() {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      el('rec-time').textContent = 'マイクを使えませんでした: ' + e.message;
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
    state.recorder = rec; state.recParts = []; state.recStartedAt = Date.now();
    rec.ondataavailable = e => { if (e.data && e.data.size) state.recParts.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(state.recParts, { type: rec.mimeType });
      const d = new Date();
      loadBlob(blob, `マイク録音 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    // timeslice で回すと、かけらは 1 本の録音の続きになる（audio-store.js の冒頭のコメント）
    rec.start(1000);

    state.audioCtx = new AudioContext();
    const an = state.audioCtx.createAnalyser();
    an.fftSize = 2048;
    state.audioCtx.createMediaStreamSource(state.stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    state.meterTimer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const db = sttDb(Math.sqrt(s / buf.length));
      el('meter-bar').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
      el('rec-time').textContent = sttFmtTime((Date.now() - state.recStartedAt) / 1000);
    }, 100);
    el('btn-rec').disabled = true;
    el('btn-rec-stop').disabled = false;
  }

  function stopRec() {
    if (state.meterTimer) { clearInterval(state.meterTimer); state.meterTimer = null; }
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    state.recorder = null;
    if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
    if (state.audioCtx) { try { state.audioCtx.close(); } catch (_) {} state.audioCtx = null; }
    el('meter-bar').style.width = '0%';
    el('btn-rec').disabled = false;
    el('btn-rec-stop').disabled = true;
  }

  function sessionsFromStorage() {
    try { return JSON.parse(localStorage.getItem('dictation:sessions') || '[]') || []; } catch (_) { return []; }
  }

  async function listStored() {
    const box = el('sessions');
    box.textContent = '';
    let sum;
    try { sum = await audioStoreSummary(); }
    catch (e) { box.textContent = '保管場所を開けませんでした: ' + (e.message || e); return; }
    if (!sum.sessions.length) { box.textContent = '保管された録音はありません。'; return; }
    const sessions = sessionsFromStorage();
    for (const s of sum.sessions.slice().reverse()) {
      const sess = sessions.find(x => x.id === s.sessionId);
      // v0.24.103: タブを閉じても「残す」にした録音は、覚えておいた名前で出す
      let pinned = {};
      try { pinned = (JSON.parse(localStorage.getItem('dictation:settings') || '{}') || {}).audioPinned || {}; } catch (_) {}
      const title = (sess && sess.title) || (pinned[s.sessionId] && pinned[s.sessionId].title) || '（タブは閉じられています）';
      const when = new Date(s.savedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = `${when}  ${title}  （${formatBytes(s.bytes)}）`;
      b.addEventListener('click', () => pickStoredSession(s.sessionId, title, sess));
      box.appendChild(b);
    }
  }

  async function pickStoredSession(sessionId, title, sess) {
    const box = el('sessions');
    box.textContent = '区間を読み込み中…';
    const segs = await audioStoreGetSegments(sessionId);
    box.textContent = '';
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = `「${title}」は約 10 分ごとの区間 ${segs.length} 個に分かれて保管されています。どれを使いますか？`;
    box.appendChild(note);
    segs.forEach((g, i) => {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = `区間 ${i + 1}（${formatBytes(g.bytes)}）`;
      b.addEventListener('click', () => {
        box.textContent = '';
        loadBlob(g.blob, `${title} の区間 ${i + 1}`);
      });
      box.appendChild(b);
    });
    // その記録で使っていた語彙を、空のときだけ入れておく（同じ条件で比べるため）
    const c = sess && sess.context;
    if (c) {
      if (!el('ctx-field').value && c.field) el('ctx-field').value = c.field;
      if (!el('ctx-terms').value && c.terms) el('ctx-terms').value = c.terms;
      savePrefs();
    }
  }

  /* ───────── 前処理 ───────── */

  /**
   * コンプレッサー → リミッター
   * ただ音量を上げると大きい声が割れるので、大きいところを抑えてから全体を持ち上げる。
   * DynamicsCompressorNode は抑えたぶんを自動で持ち上げる（makeup gain）。
   * 後ろのリミッターは、それでも 0dB を超えそうなところを止めるため。
   */
  async function compress(samples) {
    const ctx = new OfflineAudioContext(1, samples.length, SR);
    const buf = ctx.createBuffer(1, samples.length, SR);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -35; comp.knee.value = 10; comp.ratio.value = 6;
    comp.attack.value = 0.005; comp.release.value = 0.25;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.001; lim.release.value = 0.1;
    src.connect(comp).connect(lim).connect(ctx.destination);
    src.start();
    const out = await ctx.startRendering();
    return out.getChannelData(0).slice();
  }

  /* ───────── 送る ───────── */

  async function callGemini(wavBlob, chunk, prevText, sessionContext) {
    const before = (geminiUsageSnapshot().transcribe) || { input: 0, audio: 0 };
    const t0 = performance.now();
    try {
      const text = await transcribeAudioWithGemini({
        apiKey: geminiKey(),
        audioBlob: wavBlob,
        sessionContext,
        contextHint: tailForContextHint(prevText, 300),   // 本体と同じ長さ（v0.24.55）
        edges: { startsAtSilence: chunk.startsAtSilence, endsAtSilence: chunk.endsAtSilence },
      });
      const after = geminiUsageSnapshot().transcribe || before;
      return {
        text: text || '', ms: performance.now() - t0,
        tokens: { input: after.input - before.input, audio: after.audio - before.audio },
      };
    } catch (e) {
      return { text: '', ms: performance.now() - t0, error: String(e.message || e).slice(0, 200) };
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function callGroq(wavBlob, prevText) {
    const wait = state.lastGroqAt + GROQ_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const prompt = sttWhisperPrompt(el('ctx-terms').value, prevText);
    let t0 = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const fd = new FormData();
      fd.append('file', wavBlob, 'chunk.wav');
      fd.append('model', el('groq-model').value);
      fd.append('language', 'ja');
      fd.append('temperature', '0');
      fd.append('response_format', 'verbose_json');
      if (prompt) fd.append('prompt', prompt);
      state.lastGroqAt = Date.now();
      t0 = performance.now();
      let res;
      try {
        res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + el('groq-key').value.trim() },
          body: fd,
        });
      } catch (e) {
        // 拡張なら host_permissions、ブラウザ版なら Groq が CORS を許しているかで決まる。ここに来たら通信自体が通っていない
        return { text: '', ms: performance.now() - t0, error: groqFetchFailReason(e) };
      }
      if (res.status === 429 && attempt < 2) {
        const ra = Number(res.headers.get('retry-after')) || 10;
        await sleep(Math.min(60, ra) * 1000 + 500);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { text: '', ms: performance.now() - t0, error: `Groq ${res.status}: ${body.slice(0, 200)}` };
      }
      const ms = performance.now() - t0;
      const data = await res.json();
      return { text: String(data.text || '').trim(), ms, suspicious: sttSuspiciousSegments(data.segments) };
    }
    return { text: '', ms: 0, error: 'Groq の回数の上限に当たり続けました' };
  }

  /*
   * Groq に届かなかった理由を言い分ける（2026-11-09 やっさんの実機で「Failed to fetch」だけが出た）
   * fetch の失敗はどれも同じ「Failed to fetch」になり、画面からは原因が分からない。
   *   - 拡張の CSP で止められた → securitypolicyviolation が出る。拡張が古い manifest のまま（↻ していない）
   *   - ブラウザ版（http://127.0.0.1:8765）→ Groq が CORS を許していないと止まる。拡張の住所で開けば通る
   */
  let groqCspBlocked = false;
  document.addEventListener('securitypolicyviolation', e => {
    if (/api\.groq\.com/.test(e.blockedURI || '')) groqCspBlocked = true;
  });
  function groqFetchFailReason(e) {
    const base = '通信できませんでした（' + (e.message || e) + '）';
    if (groqCspBlocked) return base + '。拡張が Groq への通信を許していない古い設定のままです。chrome://extensions でこの拡張の ↻ を押してから、このページを開き直してください';
    if (location.protocol !== 'chrome-extension:') return base + '。ブラウザ版からは Groq に届かないようです。chrome-extension://（拡張の ID）/stt-compare.html で開いてください';
    return base + '。ネットにつながっているか、Groq のキーが正しいかを確かめてください';
  }

  /* ───────── 実行 ───────── */

  function readNum(id, def) { const v = Number(el(id).value); return Number.isFinite(v) ? v : def; }

  function currentPlan() {
    if (!state.audio) return null;
    const minSec = readNum('min-sec', 12), maxSec = Math.max(minSec + 1, readNum('max-sec', 20));
    const frames = sttRmsFrames(state.audio, SR, FRAME_SEC);
    const all = sttPlanChunks(frames, FRAME_SEC, { minSec, maxSec });
    return { minSec, maxSec, chunks: sttPickRange(all, readNum('from-min', 0) * 60, readNum('len-min', 3) * 60) };
  }

  function updatePlan() {
    const p = currentPlan();
    el('btn-run').disabled = !p || !p.chunks.length || state.running;
    if (!p) { el('plan').textContent = ''; return; }
    const sec = p.chunks.reduce((s, c) => s + (c.end - c.start), 0);
    el('plan').textContent = p.chunks.length
      ? `${p.chunks.length} 個に区切って送ります（音声 ${Math.round(sec)} 秒）`
      : 'この範囲に音声がありません';
  }

  function renderRow(row) {
    let box = row.node;
    if (!box) {
      box = row.node = document.createElement('div');
      box.className = 'chunk';
      const head = document.createElement('div');
      head.className = 'chunk-head';
      const t = document.createElement('span');
      t.textContent = `${sttFmtTime(row.start)}–${sttFmtTime(row.end)}（${(row.end - row.start).toFixed(1)}秒）`;
      const lv = document.createElement('span');
      lv.textContent = `最大 ${row.peakDb.toFixed(0)}dB / 平均 ${row.rmsDb.toFixed(0)}dB`
        + (row.gainDb ? ` / ノーマライズ +${row.gainDb.toFixed(1)}dB` : '')
        + (row.endsAtSilence ? '' : ' / 無音でないところで切った');
      const au = document.createElement('audio');
      au.controls = true; au.preload = 'none'; au.src = row.url;
      au.title = '送った音声（前処理のあと）';
      head.append(t, lv, au);
      const cols = document.createElement('div');
      cols.className = 'cols';
      row.cols = {};
      for (const k of ['gemini', 'groq']) {
        if (!row.want[k]) continue;
        const c = document.createElement('div');
        c.className = 'col';
        c.innerHTML = '<div class="who"><span></span><span></span></div><div class="text"></div>';
        c.querySelector('.who span').textContent = k === 'gemini' ? 'Gemini' : 'Groq Whisper';
        cols.appendChild(c);
        row.cols[k] = c;
      }
      box.append(head, cols);
      el('chunks').appendChild(box);
    }
    for (const k of Object.keys(row.cols)) {
      const c = row.cols[k], r = row[k];
      const [, timeEl] = c.querySelectorAll('.who span');
      const textEl = c.querySelector('.text');
      c.querySelectorAll('.warn').forEach(n => n.remove());
      if (!r) { textEl.textContent = '送信中…'; timeEl.textContent = ''; c.classList.add('empty'); continue; }
      timeEl.textContent = (r.ms / 1000).toFixed(1) + '秒'
        + (k === 'gemini' && r.tokens ? ` / ${r.tokens.input} トークン` : '');
      timeEl.className = r.ms / 1000 > (row.end - row.start) ? 'ng' : '';
      if (r.error) { textEl.textContent = r.error; textEl.className = 'text ng'; continue; }
      textEl.className = 'text';
      textEl.textContent = r.text || '（空）';
      c.classList.toggle('empty', !r.text);
      const warns = [];
      if (r.text && row.rmsDb < -50) warns.push('ほとんど無音の区切りなのに文字が出ています');
      for (const s of r.suspicious || []) warns.push(`⚠ ${s.reasons.join('・')}: ${s.text}`);
      for (const w of warns) {
        const n = document.createElement('div');
        n.className = 'warn';
        n.textContent = w;
        c.appendChild(n);
      }
    }
  }

  function renderSummary(done) {
    const s = sttSummarize(state.rows);
    const lines = [];
    lines.push(`${done ? '終わりました' : '送信中…'}（${state.rows.filter(r => (!r.want.gemini || r.gemini) && (!r.want.groq || r.groq)).length} / ${state.rows.length} 個）`);
    if (s.gemini.n) lines.push(`Gemini: 平均 ${s.gemini.avgSec} 秒・最大 ${s.gemini.maxSec} 秒 / 入力 ${s.gemini.input} トークン（うち音声 ${s.gemini.audio}）`);
    if (s.groq.n) lines.push(`Groq: 平均 ${s.groq.avgSec} 秒・最大 ${s.groq.maxSec} 秒 / 無料枠で数えられた音声 ${s.groq.billedSec} 秒（1 時間 7,200 秒・1 日 28,800 秒まで）`);
    lines.push('かかった秒数が赤いものは、その区切りの長さより時間がかかっています（録音しながらだと遅れが溜まります）。');
    el('summary').textContent = lines.join('\n');
    el('summary').className = '';
  }

  async function run() {
    const p = currentPlan();
    if (!p || !p.chunks.length) return;
    const want = { gemini: el('use-gemini').checked, groq: el('use-groq').checked };
    if (!want.gemini && !want.groq) { alert('Gemini と Groq のどちらかには送ってください'); return; }
    if (want.gemini && !geminiKey()) { alert('Gemini の API キーが本体の設定にありません'); return; }
    if (want.groq && !el('groq-key').value.trim()) { alert('Groq の API キーを入れてください'); return; }
    savePrefs();

    state.running = true; state.abort = false;
    el('btn-run').disabled = true; el('btn-abort').disabled = false; el('btn-copy').disabled = true;
    for (const r of state.rows) if (r.url) URL.revokeObjectURL(r.url);
    state.rows = [];
    el('chunks').textContent = '';

    const mode = el('preprocess').value;
    state.meta = {
      when: new Date().toLocaleString('ja-JP'),
      source: state.sourceLabel,
      preprocess: el('preprocess').selectedOptions[0].textContent,
      chunkRange: `${p.minSec}〜${p.maxSec}秒`,
      groqModel: want.groq ? el('groq-model').value : '使わない',
    };
    el('summary').textContent = '前処理中…';
    // 区切り位置は前処理の前の音で決める。前処理を変えても同じ場所で切れるようにするため（比べられなくなる）
    const audio = mode === 'none' ? state.audio : await compress(state.audio);
    const fieldV = el('ctx-field').value.trim(), termsV = el('ctx-terms').value.trim();
    const sessionContext = (fieldV || termsV) ? { field: fieldV, terms: termsV } : undefined;
    let prevGemini = '', prevGroq = '';

    for (const c of p.chunks) {
      if (state.abort) break;
      let samples = audio.subarray(Math.round(c.start * SR), Math.round(c.end * SR));
      let gainDb = 0;
      if (mode === 'comp-norm') ({ samples, gainDb } = sttNormalizePeak(samples));
      let peak = 0, sq = 0;
      for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; sq += a * a; }
      const blob = new Blob([sttEncodeWav16(samples, SR)], { type: 'audio/wav' });
      const row = {
        start: c.start, end: c.end, endsAtSilence: c.endsAtSilence,
        peakDb: sttDb(peak), rmsDb: sttDb(Math.sqrt(sq / Math.max(1, samples.length))), gainDb,
        url: URL.createObjectURL(blob), want,
      };
      state.rows.push(row);
      renderRow(row); renderSummary(false);

      await Promise.all([
        want.gemini && callGemini(blob, c, prevGemini, sessionContext).then(r => { row.gemini = r; if (r.text) prevGemini += '\n' + r.text; renderRow(row); }),
        want.groq && callGroq(blob, prevGroq).then(r => { row.groq = r; if (r.text) prevGroq += r.text; renderRow(row); }),
      ]);
      renderSummary(false);
    }

    state.running = false;
    el('btn-abort').disabled = true;
    el('btn-copy').disabled = !state.rows.length;
    renderSummary(true);
    updatePlan();
  }

  /* ───────── 登録 ───────── */

  loadPrefs();
  showGeminiKeyState();
  for (const id of PREF_IDS) el(id).addEventListener('change', () => { savePrefs(); updatePlan(); });
  el('btn-rec').addEventListener('click', startRec);
  el('btn-rec-stop').addEventListener('click', stopRec);
  el('file').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadBlob(f, f.name); });
  el('btn-stored').addEventListener('click', listStored);
  el('btn-run').addEventListener('click', run);
  el('btn-abort').addEventListener('click', () => { state.abort = true; el('btn-abort').disabled = true; });
  el('btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sttResultText(state.meta, state.rows));
      el('btn-copy').textContent = 'コピーしました';
      setTimeout(() => { el('btn-copy').textContent = '結果をコピー'; }, 1500);
    } catch (e) { alert('コピーできませんでした: ' + e.message); }
  });
  window.addEventListener('storage', e => { if (e.key === 'dictation:settings') showGeminiKeyState(); });
})();
