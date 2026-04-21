/**
 * dictation — Step1.5 編集可能＋末尾append
 * v0.2 contenteditable化、ユーザーが編集しても認識結果は常に末尾へ追加
 * 【修正履歴】v0.1 初期実装, v0.2 編集可能化・スクロール制御・末尾append保証
 */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  recognition: null,
  isRecording: false,
  shouldAutoRestart: false,
  userScrolledUp: false,
};

const els = {
  btnToggle: document.getElementById('btn-toggle'),
  btnCopy: document.getElementById('btn-copy'),
  btnClear: document.getElementById('btn-clear'),
  btnScrollBottom: document.getElementById('btn-scroll-bottom'),
  btnPin: document.getElementById('btn-pin'),
  btnGhost: document.getElementById('btn-ghost'),
  btnMinimize: document.getElementById('btn-minimize'),
  btnClose: document.getElementById('btn-close'),
  status: document.getElementById('status-indicator'),
  confirmed: document.getElementById('confirmed'),
  interim: document.getElementById('interim'),
  transcript: document.getElementById('transcript'),
  emptyHint: document.getElementById('empty-hint'),
};

function setStatus(mode, label) {
  els.status.className = `status ${mode}`;
  els.status.textContent = label;
}

function setRecordingUI(isRec) {
  els.btnToggle.classList.toggle('recording', isRec);
  els.btnToggle.querySelector('.btn-icon').textContent = isRec ? '⏹' : '▶';
  els.btnToggle.querySelector('.btn-label').textContent = isRec ? '停止' : '録音開始';
}

function hideEmptyHint() {
  if (els.emptyHint && !els.emptyHint.hidden) {
    els.emptyHint.hidden = true;
  }
}

function isPinnedToBottom() {
  const t = els.transcript;
  return t.scrollTop + t.clientHeight >= t.scrollHeight - 40;
}

function autoScroll(force = false) {
  if (force || !state.userScrolledUp) {
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }
}

function getConfirmedText() {
  return els.confirmed.innerText.replace(/\u00A0/g, ' ').trim();
}

function updateCopyButtonState() {
  els.btnCopy.disabled = getConfirmedText().length === 0;
}

function appendConfirmed(text) {
  if (!text.trim()) return;
  hideEmptyHint();
  const p = document.createElement('div');
  p.className = 'paragraph';
  p.textContent = text;
  els.confirmed.appendChild(p);
  updateCopyButtonState();
  autoScroll();
}

function updateInterim(text) {
  els.interim.textContent = text;
  if (text) hideEmptyHint();
  autoScroll();
}

function buildRecognition() {
  if (!SpeechRecognition) {
    alert('このブラウザは Web Speech API に対応していません。\nGoogle Chrome で開いてください。');
    return null;
  }
  const rec = new SpeechRecognition();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onstart = () => setStatus('listening', '録音中');

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) {
        appendConfirmed(text);
      } else {
        interim += text;
      }
    }
    updateInterim(interim);
  };

  rec.onerror = (event) => {
    console.error('SpeechRecognition error:', event.error, event);
    if (event.error === 'no-speech') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setStatus('error', 'マイク拒否');
      state.shouldAutoRestart = false;
      alert('マイクアクセスが拒否されました。ブラウザの設定でマイクを許可してください。');
    } else {
      setStatus('error', `エラー: ${event.error}`);
    }
  };

  rec.onend = () => {
    updateInterim('');
    if (state.shouldAutoRestart && state.isRecording) {
      try {
        rec.start();
      } catch (e) {
        setTimeout(() => {
          if (state.isRecording) {
            try { rec.start(); } catch (err) { console.error(err); }
          }
        }, 300);
      }
    } else {
      setStatus('idle', '停止');
      setRecordingUI(false);
    }
  };

  return rec;
}

function startRecording() {
  if (!state.recognition) {
    state.recognition = buildRecognition();
    if (!state.recognition) return;
  }
  state.isRecording = true;
  state.shouldAutoRestart = true;
  try {
    state.recognition.start();
    setRecordingUI(true);
  } catch (e) {
    console.error('start failed', e);
    setStatus('error', '開始失敗');
  }
}

function stopRecording() {
  state.isRecording = false;
  state.shouldAutoRestart = false;
  if (state.recognition) {
    try { state.recognition.stop(); } catch (e) { /* ignore */ }
  }
  setStatus('idle', '停止');
  setRecordingUI(false);
  updateInterim('');
}

function copyAll() {
  const text = getConfirmedText();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const label = els.btnCopy.querySelector('.btn-label');
    const orig = label.textContent;
    label.textContent = 'コピーしました';
    setTimeout(() => { label.textContent = orig; }, 1500);
  }).catch(err => {
    console.error('copy failed', err);
    alert('コピーに失敗しました: ' + err.message);
  });
}

function clearAll() {
  if (!getConfirmedText() && !els.interim.textContent) return;
  if (!confirm('書き起こしをすべてクリアしますか？')) return;
  els.confirmed.innerHTML = '';
  els.interim.textContent = '';
  updateCopyButtonState();
  if (els.emptyHint) els.emptyHint.hidden = false;
}

els.btnToggle.addEventListener('click', () => {
  if (state.isRecording) stopRecording();
  else startRecording();
});

els.btnCopy.addEventListener('click', copyAll);
els.btnClear.addEventListener('click', clearAll);

els.confirmed.addEventListener('input', updateCopyButtonState);

els.transcript.addEventListener('scroll', () => {
  state.userScrolledUp = !isPinnedToBottom();
  els.btnScrollBottom.classList.toggle('hidden', !state.userScrolledUp);
});

els.btnScrollBottom.addEventListener('click', () => {
  state.userScrolledUp = false;
  autoScroll(true);
  els.btnScrollBottom.classList.add('hidden');
});

if (!SpeechRecognition) {
  setStatus('error', '未対応ブラウザ');
  els.btnToggle.disabled = true;
}

/* ───────── Electron window controls ───────── */

function applyWindowState(s) {
  els.btnPin.classList.toggle('active', !!s.alwaysOnTop);
  els.btnGhost.classList.toggle('active', (s.opacity ?? 1.0) < 1.0);
}

if (window.electronAPI) {
  els.btnPin.addEventListener('click', () => window.electronAPI.toggleAlwaysOnTop());
  els.btnGhost.addEventListener('click', () => window.electronAPI.toggleTransparent());
  els.btnMinimize.addEventListener('click', () => window.electronAPI.hideToTray());
  els.btnClose.addEventListener('click', () => window.electronAPI.hideToTray());

  window.electronAPI.getState().then(applyWindowState);
  window.electronAPI.onWindowState(applyWindowState);
} else {
  els.btnPin.style.display = 'none';
  els.btnGhost.style.display = 'none';
  els.btnMinimize.style.display = 'none';
  els.btnClose.style.display = 'none';
}
