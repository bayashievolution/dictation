/**
 * mic-test.js — Web Speech API と MediaRecorder の同時利用テスト
 *
 * 目的:
 *  1. WebSpeech（即時表示）と MediaRecorder（Gemini 送信）が同じマイクを同時に使えるか
 *  2. ついでに「音量」と「圧縮後のバイト数」を並べて記録する
 *     （本体の無音判定が blob.size なので、小さい声が捨てられていないかを見る材料）
 *
 * inline script は拡張の CSP（script-src 'self'）で禁止されているので外部 JS。
 * 本体のコードには一切触らないので、消しても本体に影響はない。
 */
(function () {
  const el = id => document.getElementById(id);
  const logEl = el('log');

  const state = {
    stream: null, recorder: null, recognition: null,
    audioCtx: null, analyser: null, levelTimer: null,
    chunkTimer: null, audioChunks: [],
    speechFinal: [], speechInterimSeen: false,
    blobs: [],            // { size, peakRms }
    peakRmsInChunk: 0,
    speechError: null, recError: null,
    startedAt: 0,
  };

  function log(msg) {
    const t = ((Date.now() - state.startedAt) / 1000).toFixed(1);
    logEl.textContent += `[${state.startedAt ? t + 's' : '--'}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStat(id, text, cls) {
    const n = el(id);
    n.textContent = text;
    n.className = 'value' + (cls ? ' ' + cls : '');
  }

  /* ───────── 入力レベル（RMS）───────── */

  function startLevelMeter(stream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctx();
    const src = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 2048;
    src.connect(state.analyser);
    const buf = new Float32Array(state.analyser.fftSize);

    state.levelTimer = setInterval(() => {
      state.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (rms > state.peakRmsInChunk) state.peakRmsInChunk = rms;
      // dBFS 表示（-60dB を下限に）
      const db = rms > 0 ? 20 * Math.log10(rms) : -99;
      setStat('st-level', db <= -60 ? '無音 (-60dB以下)' : `${db.toFixed(1)} dBFS`);
      el('meter-bar').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
    }, 100);
  }

  /* ───────── Web Speech ───────── */

  function startSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      state.speechError = 'SpeechRecognition が存在しない';
      setStat('st-speech', '非対応', 'ng');
      log('✕ Web Speech: この環境には SpeechRecognition がありません');
      return;
    }
    const rec = new SR();
    state.recognition = rec;
    rec.lang = 'ja-JP';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => { setStat('st-speech', '認識中', 'ok'); log('✓ Web Speech: 開始'); };
    rec.onaudiostart = () => log('  Web Speech: 音声取得を開始（マイクを掴めた）');
    rec.onspeechstart = () => log('  Web Speech: 発話を検出');
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          state.speechFinal.push(r[0].transcript);
          log(`  Web Speech 確定: 「${r[0].transcript.trim()}」`);
        } else {
          interim += r[0].transcript;
          state.speechInterimSeen = true;
        }
      }
      const shown = state.speechFinal.join('') + (interim ? `［${interim}］` : '');
      el('heard').textContent = shown || '（まだありません）';
    };
    rec.onerror = (e) => {
      state.speechError = e.error;
      setStat('st-speech', 'エラー: ' + e.error, 'ng');
      log(`✕ Web Speech エラー: ${e.error}`);
    };
    rec.onend = () => {
      log('  Web Speech: 終了（continuous でも自動で切れることがある）');
      // テスト中なら自動再開（本体アプリと同じ挙動）
      if (state.recorder && state.recorder.state === 'recording') {
        try { rec.start(); log('  Web Speech: 自動再開'); } catch (_) {}
      }
    };

    try { rec.start(); } catch (e) {
      state.speechError = e.message;
      setStat('st-speech', '開始失敗', 'ng');
      log('✕ Web Speech 開始失敗: ' + e.message);
    }
  }

  /* ───────── MediaRecorder ───────── */

  function startRecorder(stream) {
    let mime = '';
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
      if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
    }
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.recorder = rec;
    log(`  MediaRecorder: mimeType=${rec.mimeType}`);

    rec.ondataavailable = e => { if (e.data && e.data.size > 0) state.audioChunks.push(e.data); };
    rec.onstop = () => {
      const chunks = state.audioChunks;
      state.audioChunks = [];
      if (chunks.length) {
        const blob = new Blob(chunks, { type: rec.mimeType });
        const peak = state.peakRmsInChunk;
        const db = peak > 0 ? 20 * Math.log10(peak) : -99;
        state.blobs.push({ size: blob.size, peakDb: db });
        // 本体アプリの既定しきい値 400 バイトと比べる
        const wouldSkip = blob.size <= 400;
        log(`  チャンク: ${blob.size} バイト / 最大音量 ${db.toFixed(1)}dBFS`
          + (wouldSkip ? '  ← 本体の既定(400B)なら「無音」として捨てられる' : ''));
      }
      state.peakRmsInChunk = 0;
      if (state.recorder === rec && rec.state === 'inactive') {
        setTimeout(() => { try { rec.start(); } catch (_) {} }, 40);
      }
    };
    rec.onerror = e => {
      state.recError = e.error?.message || 'unknown';
      setStat('st-rec', 'エラー', 'ng');
      log('✕ MediaRecorder エラー: ' + state.recError);
    };

    rec.start();
    setStat('st-rec', '録音中', 'ok');
    log('✓ MediaRecorder: 開始');

    // 本体と同じく一定間隔で区切る（テストは短く6秒）
    state.chunkTimer = setInterval(() => {
      if (state.recorder && state.recorder.state === 'recording') state.recorder.stop();
    }, 6000);
  }

  /* ───────── 開始 / 終了 ───────── */

  async function start() {
    logEl.textContent = '';
    state.startedAt = Date.now();
    state.speechFinal = []; state.speechInterimSeen = false;
    state.blobs = []; state.speechError = null; state.recError = null;
    el('heard').textContent = '（まだありません）';
    el('verdict').textContent = '測定中… 20秒ほど喋ってください';
    el('verdict').style.color = 'var(--text-muted)';
    el('btn-start').disabled = true;
    el('btn-stop').disabled = false;

    log(`環境: ${location.protocol}//${location.host || '(なし)'}`);

    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      log('✓ getUserMedia: マイク取得OK');
    } catch (e) {
      setStat('st-rec', 'マイク取得失敗', 'ng');
      log('✕ getUserMedia 失敗: ' + e.message);
      el('verdict').textContent = 'マイクを取得できませんでした: ' + e.message;
      el('verdict').style.color = 'var(--danger)';
      el('btn-start').disabled = false;
      el('btn-stop').disabled = true;
      return;
    }

    startLevelMeter(state.stream);
    startRecorder(state.stream);
    // MediaRecorder を先に走らせてから Web Speech を開始する。
    // 「後から始めた側が弾かれる」かどうかを見たいので、順番は意図的。
    log('--- ここから Web Speech を重ねて開始する ---');
    setTimeout(startSpeech, 300);
  }

  function stop() {
    el('btn-start').disabled = false;
    el('btn-stop').disabled = true;

    if (state.chunkTimer) { clearInterval(state.chunkTimer); state.chunkTimer = null; }
    if (state.levelTimer) { clearInterval(state.levelTimer); state.levelTimer = null; }
    const rec = state.recorder; state.recorder = null;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (_) {} }
    if (state.recognition) { try { state.recognition.onend = null; state.recognition.stop(); } catch (_) {} }
    if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
    if (state.audioCtx) { try { state.audioCtx.close(); } catch (_) {} state.audioCtx = null; }

    setStat('st-speech', '停止');
    setStat('st-rec', '停止');
    setTimeout(verdict, 300);   // 最後の onstop を待つ
  }

  function verdict() {
    const speechOk = state.speechFinal.length > 0 || state.speechInterimSeen;
    const recOk = state.blobs.some(b => b.size > 400);
    const v = el('verdict');
    const lines = [];

    if (speechOk && recOk) {
      v.style.color = 'var(--accent)';
      lines.push('◎ 同時利用できます。WebSpeech で表示しながら裏で Gemini に送る構成が作れます。');
    } else if (!speechOk && recOk) {
      v.style.color = 'var(--danger)';
      lines.push('✕ 録音はできましたが Web Speech が動きませんでした。');
      lines.push(state.speechError ? `  Web Speech のエラー: ${state.speechError}` : '  （エラーは出ていないが文字が取れていない）');
    } else if (speechOk && !recOk) {
      v.style.color = 'var(--danger)';
      lines.push('✕ Web Speech は動きましたが、録音データが取れませんでした。');
    } else {
      v.style.color = 'var(--danger)';
      lines.push('✕ どちらも動きませんでした。喋らずに終了した可能性もあります。');
    }

    if (state.blobs.length) {
      const quiet = state.blobs.filter(b => b.size <= 400 && b.peakDb > -45);
      lines.push('');
      lines.push(`チャンク ${state.blobs.length} 個を記録しました。`);
      if (quiet.length) {
        lines.push(`⚠ うち ${quiet.length} 個は「音は入っているのに 400 バイト以下」でした。`);
        lines.push('  本体の既定設定だと、この分は無音として捨てられています。');
      }
    }

    v.textContent = lines.join('\n');
    v.style.whiteSpace = 'pre-line';
    log('--- 判定 ---');
    for (const l of lines) if (l) log(l);
  }

  el('btn-start').addEventListener('click', start);
  el('btn-stop').addEventListener('click', stop);
  el('btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(logEl.textContent);
      el('btn-copy').textContent = 'コピーしました';
      setTimeout(() => { el('btn-copy').textContent = 'ログをコピー'; }, 1500);
    } catch (e) { alert('コピー失敗: ' + e.message); }
  });
})();
