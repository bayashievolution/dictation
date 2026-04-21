/**
 * dictation — Step1 Web Speech API 動作確認版
 * v0.1 生の文字起こしを画面に表示する最小実装
 * 【修正履歴】v0.1 初期実装
 */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  recognition: null,
  isRecording: false,
  confirmedText: '',
  shouldAutoRestart: false,
};

const els = {
  btnToggle: document.getElementById('btn-toggle'),
  btnCopy: document.getElementById('btn-copy'),
  btnClear: document.getElementById('btn-clear'),
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

function autoScroll() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function appendConfirmed(text) {
  if (!text.trim()) return;
  hideEmptyHint();
  const p = document.createElement('div');
  p.className = 'paragraph';
  p.textContent = text;
  els.confirmed.appendChild(p);
  state.confirmedText += (state.confirmedText ? '\n\n' : '') + text;
  els.btnCopy.disabled = false;
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

  rec.onstart = () => {
    setStatus('listening', '録音中');
  };

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
    if (event.error === 'no-speech') {
      return;
    }
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
        console.warn('restart failed, retrying in 300ms', e);
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
    try {
      state.recognition.stop();
    } catch (e) {
      console.warn('stop failed', e);
    }
  }
  setStatus('idle', '停止');
  setRecordingUI(false);
  updateInterim('');
}

function copyAll() {
  if (!state.confirmedText) return;
  navigator.clipboard.writeText(state.confirmedText).then(() => {
    const origLabel = els.btnCopy.querySelector('.btn-label').textContent;
    els.btnCopy.querySelector('.btn-label').textContent = 'コピーしました';
    setTimeout(() => {
      els.btnCopy.querySelector('.btn-label').textContent = origLabel;
    }, 1500);
  }).catch(err => {
    console.error('copy failed', err);
    alert('コピーに失敗しました: ' + err.message);
  });
}

function clearAll() {
  if (!state.confirmedText && !els.interim.textContent) return;
  if (!confirm('書き起こしをすべてクリアしますか？')) return;
  state.confirmedText = '';
  els.confirmed.innerHTML = '';
  els.interim.textContent = '';
  els.btnCopy.disabled = true;
  if (els.emptyHint) els.emptyHint.hidden = false;
}

els.btnToggle.addEventListener('click', () => {
  if (state.isRecording) stopRecording();
  else startRecording();
});

els.btnCopy.addEventListener('click', copyAll);
els.btnClear.addEventListener('click', clearAll);

if (!SpeechRecognition) {
  setStatus('error', '未対応ブラウザ');
  els.btnToggle.disabled = true;
}
