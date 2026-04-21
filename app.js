/**
 * dictation — Step3+ 完成版ロジック
 * v0.3 Gemini整形＋無音検出＋停止確認＋設定＋エクスポート
 * 【修正履歴】
 *   v0.1 初期実装
 *   v0.2 編集可能化・スクロール制御・末尾append保証
 *   v0.3 Gemini整形、無音検出、設定モーダル、停止確認ダイアログ、Markdown保存
 */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const SETTINGS_KEY = 'dictation:settings';
const SESSIONS_KEY = 'dictation:sessions';
const ACTIVE_TAB_KEY = 'dictation:activeTab';
const DEFAULT_SETTINGS = {
  apiKey: '',
  silenceSec: 3,
  aiEnabled: true,
  autoStopSec: 120,
  autoStopEnabled: true,
};

const AUTOSAVE_INTERVAL_MS = 15000;

const state = {
  recognition: null,
  isRecording: false,
  shouldAutoRestart: false,
  userScrolledUp: false,
  settings: { ...DEFAULT_SETTINGS },

  pendingChunkEl: null,
  pendingChunkText: '',

  silenceTimer: null,
  longSilenceTimer: null,
  silenceCountdownTimer: null,
  silenceCountdownLeft: 0,
  autoSaveTimer: null,

  sessions: [],
  activeId: null,
  isSwitching: false,
};

const els = {
  btnToggle: document.getElementById('btn-toggle'),
  btnAi: document.getElementById('btn-ai'),
  btnCopy: document.getElementById('btn-copy'),
  btnExport: document.getElementById('btn-export'),
  btnClear: document.getElementById('btn-clear'),
  btnSettings: document.getElementById('btn-settings'),
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
  settingsModal: document.getElementById('settings-modal'),
  silenceDialog: document.getElementById('silence-dialog'),
  silenceCountdown: document.getElementById('silence-countdown'),
  btnSettingsSave: document.getElementById('btn-settings-save'),
  btnSilenceStop: document.getElementById('btn-silence-stop'),
  btnSilenceContinue: document.getElementById('btn-silence-continue'),
  inputApiKey: document.getElementById('input-api-key'),
  inputSilenceSec: document.getElementById('input-silence-sec'),
  inputAiEnabled: document.getElementById('input-ai-enabled'),
  inputAutoStop: document.getElementById('input-auto-stop'),
  inputAutoStopSec: document.getElementById('input-auto-stop-sec'),
  tabsList: document.getElementById('tabs-list'),
  btnTabNew: document.getElementById('btn-tab-new'),
};

/* ───────── Settings ───────── */
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    console.warn('loadSettings failed', e);
  }
  applyAiButtonState();
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (e) {
    console.error('saveSettings failed', e);
  }
}

function applyAiButtonState() {
  els.btnAi.classList.toggle('active', state.settings.aiEnabled && !!state.settings.apiKey);
}

/* ───────── UI helpers ───────── */
function setStatus(mode, label) {
  els.status.className = `status ${mode}`;
  els.status.textContent = label;
}

function setRecordingUI(isRec) {
  els.btnToggle.classList.toggle('recording', isRec);
  els.btnToggle.querySelector('.btn-icon').textContent = isRec ? '⏹' : '▶';
  els.btnToggle.querySelector('.btn-label').textContent = isRec ? '停止' : '録音開始';
  if (typeof renderTabs === 'function') renderTabs();
}

function hideEmptyHint() {
  if (els.emptyHint && !els.emptyHint.hidden) els.emptyHint.hidden = true;
}

function isPinnedToBottom() {
  const t = els.transcript;
  return t.scrollTop + t.clientHeight >= t.scrollHeight - 40;
}

function autoScroll(force = false) {
  if (force || !state.userScrolledUp) els.transcript.scrollTop = els.transcript.scrollHeight;
}

function getConfirmedText() {
  const paragraphs = els.confirmed.querySelectorAll('.paragraph');
  return Array.from(paragraphs)
    .map(p => {
      const h2 = p.querySelector('h2');
      const body = p.querySelector('.p-body');
      if (h2 && body) return `## ${h2.textContent.trim()}\n\n${body.innerText.trim()}`;
      return p.innerText.trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

function updateActionButtons() {
  const hasText = getConfirmedText().length > 0;
  els.btnCopy.disabled = !hasText;
  els.btnExport.disabled = !hasText;
}

/* ───────── Chunk / Refinement ───────── */

function createParagraphEl(text, className = 'paragraph') {
  const p = document.createElement('div');
  p.className = className;
  const body = document.createElement('div');
  body.className = 'p-body';
  body.textContent = text;
  p.appendChild(body);
  return p;
}

function setParagraphContent(pEl, refinedText) {
  pEl.innerHTML = '';
  const parts = refinedText.split(/\n{2,}/);
  let isFirst = true;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const headingMatch = trimmed.match(/^##\s+(.+?)(?:\n|$)/);
    if (headingMatch) {
      if (!isFirst) {
        const gap = document.createElement('div');
        gap.style.height = '0.4em';
        pEl.appendChild(gap);
      }
      const h2 = document.createElement('h2');
      h2.textContent = headingMatch[1].trim();
      pEl.appendChild(h2);
      const rest = trimmed.slice(headingMatch[0].length).trim();
      if (rest) {
        const body = document.createElement('div');
        body.className = 'p-body';
        body.textContent = rest;
        pEl.appendChild(body);
      }
    } else {
      const body = document.createElement('div');
      body.className = 'p-body';
      body.textContent = trimmed;
      pEl.appendChild(body);
    }
    isFirst = false;
  }
}

function appendRawChunk(text) {
  if (!text || !text.trim()) return;
  hideEmptyHint();
  if (!state.pendingChunkEl) {
    state.pendingChunkEl = createParagraphEl(text, 'paragraph raw');
    els.confirmed.appendChild(state.pendingChunkEl);
    state.pendingChunkText = text;
  } else {
    state.pendingChunkText += ' ' + text;
    const body = state.pendingChunkEl.querySelector('.p-body');
    if (body) body.textContent = state.pendingChunkText;
  }
  autoScroll();
  updateActionButtons();
}

function getContextForGemini() {
  const paragraphs = els.confirmed.querySelectorAll('.paragraph:not(.raw):not(.refining)');
  const last = Array.from(paragraphs).slice(-3);
  return last.map(p => p.innerText.trim()).filter(Boolean).join('\n\n');
}

async function flushPendingToGemini() {
  if (!state.pendingChunkEl || !state.pendingChunkText.trim()) return;

  const targetEl = state.pendingChunkEl;
  const rawText = state.pendingChunkText.trim();
  state.pendingChunkEl = null;
  state.pendingChunkText = '';

  if (!state.settings.aiEnabled || !state.settings.apiKey) {
    targetEl.className = 'paragraph';
    setParagraphContent(targetEl, rawText);
    return;
  }

  targetEl.className = 'paragraph refining';

  try {
    const refined = await refineWithGemini({
      apiKey: state.settings.apiKey,
      context: getContextForGemini(),
      newChunk: rawText,
    });
    targetEl.className = 'paragraph refined';
    setParagraphContent(targetEl, refined || rawText);
    updateActionButtons();
    if (typeof snapshotActiveToSession === 'function') {
      snapshotActiveToSession();
      persistSessions();
    }
  } catch (e) {
    console.error('Gemini refinement failed:', e);
    targetEl.className = 'paragraph';
    setParagraphContent(targetEl, rawText);
    setStatus('error', 'AI整形失敗');
    setTimeout(() => {
      if (state.isRecording) setStatus('listening', '録音中');
      else setStatus('idle', '停止');
    }, 3000);
  } finally {
    autoScroll();
  }
}

/* ───────── Silence timers ───────── */

function resetSilenceTimer() {
  if (state.silenceTimer) clearTimeout(state.silenceTimer);
  state.silenceTimer = setTimeout(() => {
    state.silenceTimer = null;
    flushPendingToGemini();
  }, state.settings.silenceSec * 1000);
}

function resetLongSilenceTimer() {
  if (state.longSilenceTimer) clearTimeout(state.longSilenceTimer);
  if (!state.settings.autoStopEnabled) return;
  state.longSilenceTimer = setTimeout(() => {
    state.longSilenceTimer = null;
    showSilenceDialog();
  }, state.settings.autoStopSec * 1000);
}

function clearAllTimers() {
  if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
  if (state.longSilenceTimer) { clearTimeout(state.longSilenceTimer); state.longSilenceTimer = null; }
  if (state.silenceCountdownTimer) { clearInterval(state.silenceCountdownTimer); state.silenceCountdownTimer = null; }
}

/* ───────── Silence dialog ───────── */

function showSilenceDialog() {
  els.silenceDialog.classList.remove('hidden');
  state.silenceCountdownLeft = 30;
  updateSilenceCountdown();
  state.silenceCountdownTimer = setInterval(() => {
    state.silenceCountdownLeft--;
    updateSilenceCountdown();
    if (state.silenceCountdownLeft <= 0) {
      hideSilenceDialog();
      stopRecording();
    }
  }, 1000);
}

function hideSilenceDialog() {
  els.silenceDialog.classList.add('hidden');
  if (state.silenceCountdownTimer) {
    clearInterval(state.silenceCountdownTimer);
    state.silenceCountdownTimer = null;
  }
}

function updateSilenceCountdown() {
  els.silenceCountdown.textContent = `${state.silenceCountdownLeft} 秒後に自動停止します`;
}

/* ───────── Recognition ───────── */

function buildRecognition() {
  if (!SpeechRecognition) {
    alert('このブラウザ/環境は Web Speech API に対応していません。');
    return null;
  }
  const rec = new SpeechRecognition();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onstart = () => setStatus('listening', '録音中');

  rec.onresult = (event) => {
    let interim = '';
    let gotFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) {
        appendRawChunk(text);
        gotFinal = true;
      } else {
        interim += text;
      }
    }
    els.interim.textContent = interim;
    if (interim || gotFinal) hideEmptyHint();
    if (gotFinal || interim) {
      resetSilenceTimer();
      resetLongSilenceTimer();
      if (els.silenceDialog && !els.silenceDialog.classList.contains('hidden')) {
        hideSilenceDialog();
      }
    }
    autoScroll();
  };

  rec.onerror = (event) => {
    console.error('SpeechRecognition error:', event.error);
    if (event.error === 'no-speech') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setStatus('error', 'マイク拒否');
      state.shouldAutoRestart = false;
      alert('マイクアクセスが拒否されました。');
    } else {
      setStatus('error', `エラー: ${event.error}`);
    }
  };

  rec.onend = () => {
    els.interim.textContent = '';
    if (state.shouldAutoRestart && state.isRecording) {
      try { rec.start(); }
      catch {
        setTimeout(() => { if (state.isRecording) try { rec.start(); } catch {} }, 300);
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
    resetLongSilenceTimer();
  } catch (e) {
    console.error('start failed', e);
    setStatus('error', '開始失敗');
  }
}

function stopRecording() {
  state.isRecording = false;
  state.shouldAutoRestart = false;
  if (state.recognition) {
    try { state.recognition.stop(); } catch {}
  }
  setStatus('idle', '停止');
  setRecordingUI(false);
  els.interim.textContent = '';
  clearAllTimers();
  flushPendingToGemini().finally(() => {
    snapshotActiveToSession();
    persistSessions();
  });
}

/* ───────── Actions ───────── */

function copyAll() {
  const text = getConfirmedText();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const label = els.btnCopy.querySelector('.btn-label');
    const orig = label.textContent;
    label.textContent = 'コピーしました';
    setTimeout(() => { label.textContent = orig; }, 1500);
  }).catch(err => alert('コピー失敗: ' + err.message));
}

function exportMarkdown() {
  const text = getConfirmedText();
  if (!text) return;
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const session = getActiveSession();
  const safeTitle = (session?.title || 'dictation').replace(/[\\/:*?"<>|]/g, '_');
  const header = `# ${session?.title || 'dictation'} (${stamp})\n\n`;
  const blob = new Blob([header + text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeTitle}-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearAll() {
  if (!getConfirmedText() && !els.interim.textContent && !state.pendingChunkEl) return;
  if (!confirm('このタブの書き起こしをすべてクリアしますか？')) return;
  els.confirmed.innerHTML = '';
  els.interim.textContent = '';
  state.pendingChunkEl = null;
  state.pendingChunkText = '';
  updateActionButtons();
  if (els.emptyHint) els.emptyHint.hidden = false;
  snapshotActiveToSession();
  persistSessions();
}

function toggleAi() {
  if (!state.settings.apiKey) {
    openSettings();
    return;
  }
  state.settings.aiEnabled = !state.settings.aiEnabled;
  saveSettings();
  applyAiButtonState();
}

/* ───────── Settings modal ───────── */

function openSettings() {
  els.inputApiKey.value = state.settings.apiKey;
  els.inputSilenceSec.value = state.settings.silenceSec;
  els.inputAiEnabled.checked = state.settings.aiEnabled;
  els.inputAutoStop.checked = state.settings.autoStopEnabled;
  els.inputAutoStopSec.value = state.settings.autoStopSec;
  els.settingsModal.classList.remove('hidden');
  setTimeout(() => els.inputApiKey.focus(), 80);
}

function closeSettings() {
  els.settingsModal.classList.add('hidden');
}

function saveSettingsFromForm() {
  state.settings.apiKey = els.inputApiKey.value.trim();
  state.settings.silenceSec = Math.max(1, Math.min(30, Number(els.inputSilenceSec.value) || 3));
  state.settings.aiEnabled = els.inputAiEnabled.checked;
  state.settings.autoStopEnabled = els.inputAutoStop.checked;
  state.settings.autoStopSec = Math.max(30, Math.min(600, Number(els.inputAutoStopSec.value) || 120));
  saveSettings();
  applyAiButtonState();
  closeSettings();
}

/* ───────── Event wiring ───────── */

els.btnToggle.addEventListener('click', () => state.isRecording ? stopRecording() : startRecording());
els.btnAi.addEventListener('click', toggleAi);
els.btnCopy.addEventListener('click', copyAll);
els.btnExport.addEventListener('click', exportMarkdown);
els.btnClear.addEventListener('click', clearAll);
els.btnSettings.addEventListener('click', openSettings);

els.btnSettingsSave.addEventListener('click', saveSettingsFromForm);
els.settingsModal.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', closeSettings));

els.btnSilenceStop.addEventListener('click', () => {
  hideSilenceDialog();
  stopRecording();
});
els.btnSilenceContinue.addEventListener('click', () => {
  hideSilenceDialog();
  resetLongSilenceTimer();
});

let editSaveTimer = null;
els.confirmed.addEventListener('input', () => {
  updateActionButtons();
  if (editSaveTimer) clearTimeout(editSaveTimer);
  editSaveTimer = setTimeout(() => {
    snapshotActiveToSession();
    persistSessions();
  }, 800);
});

els.transcript.addEventListener('scroll', () => {
  state.userScrolledUp = !isPinnedToBottom();
  els.btnScrollBottom.classList.toggle('hidden', !state.userScrolledUp);
});

els.btnScrollBottom.addEventListener('click', () => {
  state.userScrolledUp = false;
  autoScroll(true);
  els.btnScrollBottom.classList.add('hidden');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.settingsModal.classList.contains('hidden')) closeSettings();
    if (!els.silenceDialog.classList.contains('hidden')) {
      hideSilenceDialog();
      resetLongSilenceTimer();
    }
  }
});

if (!SpeechRecognition) {
  setStatus('error', '未対応');
  els.btnToggle.disabled = true;
}

loadSettings();
initSessions();
renderTabs();
loadActiveSessionIntoDOM();
updateActionButtons();
startAutoSave();

/* ───────── Sessions (tabs) ───────── */

function initSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) state.sessions = JSON.parse(raw);
  } catch (e) {
    console.warn('loadSessions failed', e);
    state.sessions = [];
  }
  state.activeId = localStorage.getItem(ACTIVE_TAB_KEY);
  if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
    createSession({ activate: true, skipSave: false });
    return;
  }
  if (!state.sessions.find(s => s.id === state.activeId)) {
    state.activeId = state.sessions[0].id;
  }
}

function persistSessions() {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(state.sessions));
    if (state.activeId) localStorage.setItem(ACTIVE_TAB_KEY, state.activeId);
  } catch (e) {
    console.error('persistSessions failed', e);
  }
}

function defaultTitle() {
  const n = new Date();
  const pad = x => String(x).padStart(2, '0');
  return `${pad(n.getMonth()+1)}/${pad(n.getDate())} ${pad(n.getHours())}:${pad(n.getMinutes())}`;
}

function createSession({ activate = true, title = null, skipSave = false } = {}) {
  const id = 's_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  const session = {
    id,
    title: title || defaultTitle(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    html: '',
  };
  state.sessions.push(session);
  if (activate) state.activeId = id;
  if (!skipSave) persistSessions();
  renderTabs();
  if (activate) loadActiveSessionIntoDOM();
  return session;
}

function getActiveSession() {
  return state.sessions.find(s => s.id === state.activeId);
}

function snapshotActiveToSession() {
  const s = getActiveSession();
  if (!s) return;
  s.html = els.confirmed.innerHTML;
  s.updatedAt = Date.now();
}

function loadActiveSessionIntoDOM() {
  const s = getActiveSession();
  els.confirmed.innerHTML = s?.html || '';
  els.interim.textContent = '';
  state.pendingChunkEl = null;
  state.pendingChunkText = '';
  if (els.emptyHint) els.emptyHint.hidden = !!els.confirmed.innerHTML;
  updateActionButtons();
  state.userScrolledUp = false;
  requestAnimationFrame(() => autoScroll(true));
}

function switchSession(id) {
  if (id === state.activeId) return;
  state.isSwitching = true;
  if (state.isRecording) stopRecording();
  snapshotActiveToSession();
  persistSessions();
  state.activeId = id;
  persistSessions();
  renderTabs();
  loadActiveSessionIntoDOM();
  state.isSwitching = false;
}

function closeSession(id) {
  const idx = state.sessions.findIndex(s => s.id === id);
  if (idx < 0) return;
  const session = state.sessions[idx];
  if (session.html && !confirm(`「${session.title}」を閉じます。この内容は削除されます。よろしいですか？`)) return;
  const wasActive = state.activeId === id;
  if (wasActive && state.isRecording) stopRecording();
  state.sessions.splice(idx, 1);
  if (state.sessions.length === 0) {
    createSession({ activate: true, skipSave: true });
  } else if (wasActive) {
    state.activeId = state.sessions[Math.max(0, idx - 1)].id;
    loadActiveSessionIntoDOM();
  }
  persistSessions();
  renderTabs();
}

function renameSession(id, title) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  s.title = title.trim() || defaultTitle();
  s.updatedAt = Date.now();
  persistSessions();
  renderTabs();
}

function renderTabs() {
  els.tabsList.innerHTML = '';
  for (const session of state.sessions) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (session.id === state.activeId ? ' active' : '');
    if (state.isRecording && session.id === state.activeId) tab.classList.add('recording');
    tab.dataset.id = session.id;

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = session.title;
    title.title = session.title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '✕';
    closeBtn.title = '閉じる';

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSession(session.id);
    });

    tab.addEventListener('click', () => {
      if (title.getAttribute('contenteditable') === 'true') return;
      switchSession(session.id);
    });

    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      title.setAttribute('contenteditable', 'true');
      title.focus();
      document.getSelection().selectAllChildren(title);
    });

    title.addEventListener('blur', () => {
      if (title.getAttribute('contenteditable') === 'true') {
        title.removeAttribute('contenteditable');
        renameSession(session.id, title.textContent);
      }
    });

    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        title.blur();
      } else if (e.key === 'Escape') {
        title.textContent = session.title;
        title.blur();
      }
    });

    tab.appendChild(title);
    tab.appendChild(closeBtn);
    els.tabsList.appendChild(tab);
  }
}

function startAutoSave() {
  if (state.autoSaveTimer) clearInterval(state.autoSaveTimer);
  state.autoSaveTimer = setInterval(() => {
    snapshotActiveToSession();
    persistSessions();
  }, AUTOSAVE_INTERVAL_MS);
}

window.addEventListener('beforeunload', () => {
  snapshotActiveToSession();
  persistSessions();
});

els.btnTabNew.addEventListener('click', () => {
  if (state.isRecording) stopRecording();
  snapshotActiveToSession();
  persistSessions();
  createSession({ activate: true });
});

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
