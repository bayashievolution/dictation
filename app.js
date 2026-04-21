/**
 * dictation — v0.4 Web版
 * - 内側タブ（文字起こし / メモ / 要約）
 * - 外側タブ（セッション）
 * - Gemini による段落整形＋要約生成
 * - JSON 保存/読み込み（セッション単位）
 * - Markdown エクスポート
 * 【修正履歴】
 *   v0.1 Web Speech API 最小実装
 *   v0.2 編集可能化・末尾append・スクロール制御
 *   v0.3 Gemini整形・無音検出・停止確認・設定
 *   v0.4 Chrome前提に方針転換／内側タブ／要約／JSON保存読込
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
  autoSummarize: true,
  appZoom: 100,
  paneOrder: ['pane-transcript', 'pane-memo', 'pane-summary', 'pane-chat'],
  transcriptFont: 'sans',
  transcriptSize: 15,
  memoFont: 'sans',
  memoSize: 15,
  summaryFont: 'sans',
  summarySize: 15,
  chatFont: 'sans',
  chatSize: 14,
  inputMode: 'web-speech',
  audioDeviceId: '',
  audioChunkSec: 12,
};

const PANE_FONT_KEYS = {
  'pane-transcript': { font: 'transcriptFont', size: 'transcriptSize' },
  'pane-memo':       { font: 'memoFont',       size: 'memoSize' },
  'pane-summary':    { font: 'summaryFont',    size: 'summarySize' },
  'pane-chat':       { font: 'chatFont',       size: 'chatSize' },
};

const PANE_META = {
  'pane-transcript': { label: '文字起こし', icon: 'mic' },
  'pane-memo':       { label: 'メモ',       icon: 'pencil' },
  'pane-summary':    { label: '要約',       icon: 'file-text' },
  'pane-chat':       { label: '質問',       icon: 'message-circle' },
};

const FONT_FAMILIES = {
  sans:            "'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Yu Gothic UI', sans-serif",
  'zen-kaku':      "'Zen Kaku Gothic New', 'Noto Sans JP', sans-serif",
  'mplus':         "'M PLUS 1p', 'Noto Sans JP', sans-serif",
  'kosugi-maru':   "'Kosugi Maru', 'Noto Sans JP', sans-serif",
  'sawarabi-goth': "'Sawarabi Gothic', 'Noto Sans JP', sans-serif",
  serif:           "'Noto Serif JP', 'Yu Mincho', 'Hiragino Mincho ProN', 'MS Mincho', serif",
  'shippori':      "'Shippori Mincho', 'Noto Serif JP', serif",
  'kaisei-opti':   "'Kaisei Opti', 'Noto Serif JP', serif",
  'klee':          "'Klee One', 'Noto Serif JP', serif",
  'yomogi':        "'Yomogi', 'Noto Serif JP', cursive",
  mono:            "'Source Code Pro', 'Cascadia Code', Consolas, 'Courier New', monospace",
  'jetbrains':     "'JetBrains Mono', 'Source Code Pro', monospace",
};

const FONT_OPTIONS = [
  { group: 'ゴシック', items: [
    { value: 'sans',            label: 'Noto Sans JP（デフォルト）' },
    { value: 'zen-kaku',        label: 'Zen Kaku Gothic New' },
    { value: 'mplus',           label: 'M PLUS 1p' },
    { value: 'kosugi-maru',     label: 'Kosugi Maru（丸ゴシック）' },
    { value: 'sawarabi-goth',   label: 'Sawarabi Gothic' },
  ]},
  { group: '明朝', items: [
    { value: 'serif',           label: 'Noto Serif JP' },
    { value: 'shippori',        label: 'Shippori Mincho' },
    { value: 'kaisei-opti',     label: 'Kaisei Opti' },
  ]},
  { group: '手書き風', items: [
    { value: 'klee',            label: 'Klee One（教科書体）' },
    { value: 'yomogi',          label: 'Yomogi（筆）' },
  ]},
  { group: '等幅', items: [
    { value: 'mono',            label: 'Source Code Pro' },
    { value: 'jetbrains',       label: 'JetBrains Mono' },
  ]},
];

function populateFontSelects() {
  [els.fontTranscript, els.fontMemo, els.fontSummary].forEach(select => {
    if (!select) return;
    select.innerHTML = '';
    for (const group of FONT_OPTIONS) {
      const og = document.createElement('optgroup');
      og.label = group.group;
      for (const item of group.items) {
        const o = document.createElement('option');
        o.value = item.value;
        o.textContent = item.label;
        og.appendChild(o);
      }
      select.appendChild(og);
    }
  });
}

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

  mediaRecorder: null,
  audioStream: null,
  audioChunks: [],
  audioChunkTimer: null,
  audioInFlightCount: 0,

  sessions: [],
  activeId: null,
  activePane: 'pane-transcript',
  isSummarizing: false,
};

const els = {
  btnToggle: document.getElementById('btn-toggle'),
  btnCopyAllPlain: document.getElementById('btn-copy-all-plain'),
  btnCopyAllMd: document.getElementById('btn-copy-all-md'),
  btnSaveJson: document.getElementById('btn-save-json'),
  btnLoadJson: document.getElementById('btn-load-json'),
  btnClearAll: document.getElementById('btn-clear-all'),
  btnSettings: document.getElementById('btn-settings'),
  btnScrollBottom: document.getElementById('btn-scroll-bottom'),
  fileLoad: document.getElementById('file-load'),
  status: document.getElementById('status-indicator'),
  confirmed: document.getElementById('confirmed'),
  interim: document.getElementById('interim'),
  memo: document.getElementById('memo'),
  summary: document.getElementById('summary'),
  summaryEmpty: document.getElementById('summary-empty'),
  paneTranscript: document.getElementById('pane-transcript'),
  paneMemo: document.getElementById('pane-memo'),
  paneSummary: document.getElementById('pane-summary'),
  paneChat: document.getElementById('pane-chat'),
  paneTranscriptBody: document.querySelector('#pane-transcript .pane-body'),
  chatBody: document.querySelector('#pane-chat .pane-body'),
  chatMessages: document.getElementById('chat-messages'),
  chatEmpty: document.getElementById('chat-empty'),
  chatInput: document.getElementById('chat-input'),
  btnChatSend: document.getElementById('btn-chat-send'),
  innerTabsContainer: document.getElementById('inner-tabs'),
  mainArea: document.getElementById('main-area'),
  titleBar: document.getElementById('title-bar'),
  titleDisplay: document.getElementById('title-display'),
  btnEditTitle: document.getElementById('btn-edit-title'),
  btnRegenTitle: document.getElementById('btn-regen-title'),
  btnSummaryCombo: document.getElementById('btn-summary-combo'),
  btnRefineTranscript: document.getElementById('btn-refine-transcript'),
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
  inputAutoSummarize: document.getElementById('input-auto-summarize'),
  modeWebSpeech: document.getElementById('mode-webspeech'),
  modeGemini: document.getElementById('mode-gemini'),
  inputAudioDevice: document.getElementById('input-audio-device'),
  inputChunkSec: document.getElementById('input-chunk-sec'),
  zoomBar: document.getElementById('zoom-bar'),
  zoomRange: document.getElementById('zoom-range'),
  zoomPercent: document.getElementById('zoom-percent'),
  zoomMinus: document.getElementById('zoom-minus'),
  zoomPlus: document.getElementById('zoom-plus'),
  zoomReset: document.getElementById('zoom-reset'),
  paneOrderList: document.getElementById('pane-order-list'),
  fontTranscript: document.getElementById('font-transcript'),
  sizeTranscript: document.getElementById('size-transcript'),
  fontMemo: document.getElementById('font-memo'),
  sizeMemo: document.getElementById('size-memo'),
  fontSummary: document.getElementById('font-summary'),
  sizeSummary: document.getElementById('size-summary'),
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
  // Migration: add pane-chat to paneOrder if missing
  if (Array.isArray(state.settings.paneOrder) && !state.settings.paneOrder.includes('pane-chat')) {
    state.settings.paneOrder.push('pane-chat');
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
  if (els.btnRefineTranscript) {
    const on = !!state.settings.aiEnabled;
    els.btnRefineTranscript.classList.toggle('on', on);
    els.btnRefineTranscript.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.btnRefineTranscript.classList.toggle('needs-key', on && !state.settings.apiKey);
  }
  if (els.btnSummaryCombo) {
    const on = !!state.settings.autoSummarize;
    els.btnSummaryCombo.classList.toggle('on', on);
    els.btnSummaryCombo.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/* ───────── UI helpers ───────── */
function setStatus(mode, label) {
  els.status.className = `status ${mode}`;
  els.status.textContent = label;
  els.status.title = label;
}

function setRecordingUI(isRec) {
  els.btnToggle.classList.toggle('recording', isRec);
  const iconEl = els.btnToggle.querySelector('[data-icon]');
  if (iconEl && typeof setIcon === 'function') setIcon(iconEl, isRec ? 'stop' : 'play', 18);
  els.btnToggle.title = isRec ? '停止' : '録音開始';
  renderTabs();
}

function hideEmptyHint() {
  if (els.emptyHint && !els.emptyHint.hidden) els.emptyHint.hidden = true;
}

function getActivePaneEl() {
  if (state.activePane === 'pane-transcript') return els.paneTranscript;
  if (state.activePane === 'pane-memo') return els.paneMemo;
  return els.paneSummary;
}

function isPinnedToBottom() {
  const pane = els.paneTranscriptBody;
  return pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 40;
}

function autoScroll(force = false) {
  if (state.activePane !== 'pane-transcript') return;
  if (force || !state.userScrolledUp) {
    els.paneTranscriptBody.scrollTop = els.paneTranscriptBody.scrollHeight;
  }
}

function getConfirmedText() {
  // innerText で全体のプレーンテキストを取る（ペースト直書きにも対応）
  const plain = els.confirmed.innerText.replace(/\u00A0/g, ' ').trim();
  if (!plain) return '';

  const paragraphs = els.confirmed.querySelectorAll('.paragraph');
  if (paragraphs.length === 0) return plain;

  // 録音+Gemini整形された .paragraph 構造を ## 見出し 付きで抽出
  const structured = Array.from(paragraphs)
    .map(p => {
      const h2 = p.querySelector('h2');
      const body = p.querySelector('.p-body');
      if (h2 && body) return `## ${h2.textContent.trim()}\n\n${body.innerText.trim()}`;
      return p.innerText.trim();
    })
    .filter(Boolean)
    .join('\n\n');

  // 構造化抽出がプレーンテキストの大半をカバーしていれば構造化を採用、
  // そうでなければ（ペースト内容が混在している等）プレーンテキスト優先
  return structured.length >= plain.length * 0.8 ? structured : plain;
}

function getMemoText() {
  return els.memo.innerText.trim();
}

function getSummaryText() {
  return els.summary.innerText.trim();
}

function hasAnyContent() {
  return getConfirmedText() || getMemoText() || getSummaryText() || getChatText();
}

function updateActionButtons() {
  const has = hasAnyContent();
  els.btnCopyAllPlain.disabled = !has;
  els.btnCopyAllMd.disabled = !has;
}

/* ───────── Paragraph rendering ───────── */

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
    snapshotActiveToSession();
    persistSessions();
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
    snapshotActiveToSession();
    persistSessions();
  } catch (e) {
    console.error('Gemini refinement failed:', e);
    targetEl.className = 'paragraph';
    setParagraphContent(targetEl, rawText);
    const msg = (e && e.message) ? e.message : String(e);
    setStatus('error', 'AI整形失敗: ' + msg.slice(0, 80));
    setTimeout(() => {
      if (state.isRecording) setStatus('listening', '録音中');
      else setStatus('idle', '停止');
    }, 6000);
  } finally {
    autoScroll();
  }
}

/* ───────── Refine pasted / unstructured text ───────── */

/**
 * #confirmed 内の .paragraph に入っていない生テキスト（ペーストされたもの等）を
 * まとめて Gemini に送って .paragraph として整形置換する。
 */
async function refineUnstructuredInTranscript({ force = false, showFeedback = true } = {}) {
  if (!state.settings.apiKey) {
    if (showFeedback) { alert('Gemini API キーが未設定です'); openSettings(); }
    return;
  }
  if (!force && !state.settings.aiEnabled) return;

  // .paragraph でない直下ノードを収集
  const unstructuredNodes = Array.from(els.confirmed.childNodes).filter(n => {
    if (n.nodeType === Node.ELEMENT_NODE) {
      return !n.classList || !n.classList.contains('paragraph');
    }
    if (n.nodeType === Node.TEXT_NODE) return !!n.textContent.trim();
    return false;
  });
  if (unstructuredNodes.length === 0) return;

  // テキストを集めて改行で結合
  const rawText = unstructuredNodes.map(n => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent;
    return n.innerText || n.textContent || '';
  }).join('\n').trim();
  if (!rawText) return;

  // 除去して refining パラグラフに差し替え（元の位置は末尾）
  unstructuredNodes.forEach(n => n.remove());
  hideEmptyHint();
  const targetEl = createParagraphEl(rawText, 'paragraph refining');
  els.confirmed.appendChild(targetEl);
  updateActionButtons();
  autoScroll();

  try {
    const refined = await refineWithGemini({
      apiKey: state.settings.apiKey,
      context: getContextForGemini(),
      newChunk: rawText,
    });
    targetEl.className = 'paragraph refined';
    setParagraphContent(targetEl, refined || rawText);
    snapshotActiveToSession();
    persistSessions();
  } catch (e) {
    console.error('refine pasted failed:', e);
    targetEl.className = 'paragraph';
    setParagraphContent(targetEl, rawText);
    if (showFeedback) setStatus('error', '整形失敗: ' + (e.message || '').slice(0, 60));
    setTimeout(() => {
      if (state.isRecording) setStatus('listening', '録音中');
      else setStatus('idle', '停止');
    }, 4000);
  } finally {
    updateActionButtons();
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
    alert('このブラウザは Web Speech API に対応していません。Google Chrome で開いてください。');
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
      state.isRecording = false;
      setRecordingUI(false);
      showMicDeniedGuide(event.error);
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

async function ensureMicPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function showMicDeniedGuide(detail) {
  const isExtension = location.protocol === 'chrome-extension:';
  const steps = isExtension ? [
    '【Chrome拡張でマイクを許可する手順】',
    '1. Chromeアドレスバーに chrome://extensions/ と入力',
    '2. 「ばっさんディクテーション」の「詳細」をクリック',
    '3. 「サイト設定」を開く → マイクを「許可」に',
    '',
    'または chrome://settings/content/microphone で',
    'ブロック一覧から拡張機能URLを削除 → 拡張を再読込',
  ] : [
    'ブラウザのアドレスバー左端の錠マークをクリック',
    '→ マイクを「許可」に変更 → ページをリロード',
  ];
  alert([
    'マイクアクセスが拒否されました。',
    '',
    ...steps,
    '',
    'エラー: ' + (detail || 'Permission denied'),
  ].join('\n'));
}

async function startRecording() {
  if (state.settings.inputMode === 'gemini-audio') {
    return startGeminiAudioRecording();
  }
  // 事前にマイク許可を明示的に取得（拡張サイドパネル等では必要）
  const perm = await ensureMicPermission();
  if (!perm.ok) {
    setStatus('error', 'マイク拒否');
    const err = perm.error || {};
    showMicDeniedGuide(err.message || err.name || '');
    return;
  }

  // Web Speech API モード
  if (state.recognition) {
    state.recognition.onend = null;
    state.recognition.onresult = null;
    state.recognition.onerror = null;
    state.recognition.onstart = null;
    try { state.recognition.abort(); } catch {}
  }
  state.recognition = buildRecognition();
  if (!state.recognition) return;
  state.isRecording = true;
  state.shouldAutoRestart = true;
  try {
    state.recognition.start();
    setRecordingUI(true);
    resetLongSilenceTimer();
  } catch (e) {
    console.error('start failed', e);
    setStatus('error', '開始失敗: ' + e.message);
    state.isRecording = false;
    state.shouldAutoRestart = false;
    setRecordingUI(false);
  }
}

function stopRecording() {
  state.isRecording = false;
  state.shouldAutoRestart = false;
  if (state.settings.inputMode === 'gemini-audio') {
    stopGeminiAudioRecording();
  } else {
    if (state.recognition) {
      try { state.recognition.stop(); } catch {}
    }
    els.interim.textContent = '';
  }
  setStatus('idle', '停止');
  setRecordingUI(false);
  clearAllTimers();
  flushPendingToGemini().finally(async () => {
    snapshotActiveToSession();
    persistSessions();
    if (state.settings.autoSummarize && state.settings.aiEnabled && state.settings.apiKey) {
      await generateSummary({ silent: true });
      await autoGenerateTitle();
    }
  });
}

/* ───────── Gemini Audio recording mode ───────── */

async function startGeminiAudioRecording() {
  if (!state.settings.apiKey) {
    alert('Gemini Audio モードは API キーが必要です');
    openSettings();
    return;
  }
  const constraints = {
    audio: state.settings.audioDeviceId
      ? { deviceId: { exact: state.settings.audioDeviceId } }
      : true,
  };
  try {
    state.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    console.error('getUserMedia failed:', e);
    setStatus('error', 'マイク取得失敗');
    showMicDeniedGuide(e.message || e.name);
    return;
  }

  let mimeType = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
  }

  state.audioChunks = [];
  const recorder = new MediaRecorder(state.audioStream, mimeType ? { mimeType } : undefined);
  state.mediaRecorder = recorder;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
  };
  recorder.onstop = () => {
    const chunks = state.audioChunks;
    state.audioChunks = [];
    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size > 1200) sendAudioChunkToGemini(blob);
    }
    // 録音継続中なら再スタート
    if (state.isRecording && state.mediaRecorder === recorder) {
      setTimeout(() => {
        if (state.isRecording && recorder.state === 'inactive') {
          try { recorder.start(); } catch (e) { console.warn('restart failed', e); }
        }
      }, 40);
    }
  };
  recorder.onerror = (e) => {
    console.error('MediaRecorder error:', e.error);
    setStatus('error', '録音エラー: ' + (e.error?.message || 'unknown'));
  };

  try {
    recorder.start();
  } catch (e) {
    console.error('recorder start failed:', e);
    setStatus('error', '録音開始失敗: ' + e.message);
    return;
  }

  state.isRecording = true;
  state.shouldAutoRestart = true;
  setRecordingUI(true);
  setStatus('listening', '録音中 (Gemini)');
  resetLongSilenceTimer();

  // チャンク区切り
  const intervalMs = Math.max(5, Math.min(60, state.settings.audioChunkSec || 12)) * 1000;
  state.audioChunkTimer = setInterval(() => {
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
      state.mediaRecorder.stop(); // onstop で送信＋再スタート
    }
  }, intervalMs);
}

function stopGeminiAudioRecording() {
  if (state.audioChunkTimer) {
    clearInterval(state.audioChunkTimer);
    state.audioChunkTimer = null;
  }
  const recorder = state.mediaRecorder;
  state.mediaRecorder = null; // onstop の再スタートを抑止
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch {}
  }
  if (state.audioStream) {
    state.audioStream.getTracks().forEach(t => t.stop());
    state.audioStream = null;
  }
}

async function sendAudioChunkToGemini(blob) {
  state.audioInFlightCount++;
  hideEmptyHint();
  const targetEl = createParagraphEl('（文字起こし中…）', 'paragraph refining');
  els.confirmed.appendChild(targetEl);
  autoScroll();

  try {
    const text = await transcribeAudioWithGemini({
      apiKey: state.settings.apiKey,
      audioBlob: blob,
      contextHint: getContextForGemini(),
    });
    if (text && text.trim()) {
      targetEl.className = 'paragraph refined';
      setParagraphContent(targetEl, text);
      snapshotActiveToSession();
      persistSessions();
    } else {
      targetEl.remove(); // 無音チャンクは捨てる
    }
  } catch (e) {
    console.error('audio transcription failed:', e);
    targetEl.className = 'paragraph';
    setParagraphContent(targetEl, '[文字起こし失敗: ' + (e.message || '').slice(0, 60) + ']');
    setStatus('error', 'Gemini Audio失敗: ' + (e.message || '').slice(0, 60));
    setTimeout(() => {
      if (state.isRecording) setStatus('listening', '録音中 (Gemini)');
      else setStatus('idle', '停止');
    }, 5000);
  } finally {
    state.audioInFlightCount--;
    updateActionButtons();
    autoScroll();
  }
}

async function listAudioInputDevices() {
  try {
    // ラベル取得のため一度許可取得
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach(t => t.stop());
  } catch (e) {
    // 許可拒否でもデバイスID一覧は取れる（ラベル空）
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === 'audioinput');
}

function applyGeminiOnlyVisibility(animated = true) {
  const el = document.getElementById('gemini-only-fields');
  if (!el) return;
  const isGemini = els.modeGemini && els.modeGemini.checked;
  if (!animated) {
    // モーダル開いた直後はトランジション無しで確定状態に
    const prev = el.style.transition;
    el.style.transition = 'none';
    el.classList.toggle('is-hidden', !isGemini);
    void el.offsetWidth; // reflow
    el.style.transition = prev;
  } else {
    el.classList.toggle('is-hidden', !isGemini);
  }
}

async function populateAudioDevices() {
  if (!els.inputAudioDevice) return;
  const sel = els.inputAudioDevice;
  sel.innerHTML = '<option value="">（システム既定）</option>';
  try {
    const devices = await listAudioInputDevices();
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `マイク ${d.deviceId.slice(0, 8)}…`;
      sel.appendChild(o);
    }
  } catch (e) {
    console.warn('enumerateDevices failed', e);
  }
  sel.value = state.settings.audioDeviceId || '';
}

/* ───────── Actions ───────── */

function flashButton(btn, label = 'コピー完了') {
  const origTitle = btn.title;
  const iconEl = btn.querySelector('[data-icon]');
  if (iconEl) {
    const origName = iconEl.dataset.icon;
    const origSize = iconEl.dataset.iconSize || '16';
    setIcon(iconEl, 'check', origSize);
    btn.title = label;
    setTimeout(() => { setIcon(iconEl, origName, origSize); btn.title = origTitle; }, 1200);
  } else {
    btn.title = label;
    setTimeout(() => { btn.title = origTitle; }, 1200);
  }
}

async function copyTextOnly(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) flashButton(btn);
  } catch (err) {
    alert('コピー失敗: ' + err.message);
  }
}

async function copyPane(paneId, btn) {
  let text = '';
  if (paneId === 'pane-transcript') text = getConfirmedText();
  else if (paneId === 'pane-memo') text = getMemoText();
  else if (paneId === 'pane-summary') text = getSummaryText();
  if (!text) return;
  await copyTextOnly(text, btn);
}

function getChatText() {
  const chat = getActiveSession()?.chat || [];
  return chat.filter(m => !m.thinking && !m.error).map(m => {
    const prefix = m.role === 'user' ? 'Q: ' : 'A: ';
    return prefix + m.content;
  }).join('\n\n');
}

function getChatHtml() {
  const chat = getActiveSession()?.chat || [];
  if (chat.length === 0) return '';
  const parts = chat.filter(m => !m.thinking).map(m => {
    const who = m.role === 'user' ? 'あなた' : 'Gemini';
    const body = m.role === 'assistant' ? renderMarkdown(m.content)
                                        : `<div>${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>`;
    return `<div class="chat-block"><p><strong>${who}</strong>: ${body}</p></div>`;
  });
  return parts.join('\n');
}

function getPaneText(id) {
  if (id === 'pane-transcript') return getConfirmedText();
  if (id === 'pane-memo') return getMemoText();
  if (id === 'pane-summary') return getSummaryText();
  if (id === 'pane-chat') return getChatText();
  return '';
}
function getPaneHtml(id) {
  if (id === 'pane-transcript') return els.confirmed.innerHTML;
  if (id === 'pane-memo') return els.memo.innerHTML;
  if (id === 'pane-summary') return els.summary.innerHTML;
  if (id === 'pane-chat') return getChatHtml();
  return '';
}

function buildCombinedPlain() {
  const parts = [];
  for (const id of state.settings.paneOrder) {
    const meta = PANE_META[id];
    const t = getPaneText(id);
    if (t) parts.push(`【${meta.label}】\n` + t);
  }
  return parts.join('\n\n──────────\n\n');
}

function buildCombinedMarkdown() {
  const parts = [];
  const session = getActiveSession();
  if (session?.title) parts.push(`# ${session.title}`);
  for (const id of state.settings.paneOrder) {
    const meta = PANE_META[id];
    const t = getPaneText(id);
    if (t) parts.push(`## ${meta.label}\n\n` + t);
  }
  return parts.join('\n\n');
}

function buildCombinedHtmlForNotion() {
  // Notion は <details> を toggle ブロックに変換する
  const session = getActiveSession();
  const title = session?.title ? `<h1>${escapeHtml(session.title)}</h1>` : '';
  const sections = [];
  for (const id of state.settings.paneOrder) {
    const meta = PANE_META[id];
    const html = getPaneHtml(id);
    const plain = getPaneText(id);
    if (!html && !plain) continue;
    const body = html || `<p>${escapeHtml(plain)}</p>`;
    sections.push(`<details open><summary><strong>${escapeHtml(meta.label)}</strong></summary>${body}</details>`);
  }
  return title + sections.join('\n');
}

async function copyAllPlain() {
  const text = buildCombinedPlain();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flashButton(els.btnCopyAllPlain);
  } catch (err) {
    alert('コピー失敗: ' + err.message);
  }
}

async function copyAllMultiformat() {
  const md = buildCombinedMarkdown();
  if (!md) return;
  try {
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      const html = buildCombinedHtmlForNotion();
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([md], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })]);
    } else {
      await navigator.clipboard.writeText(md);
    }
    flashButton(els.btnCopyAllMd);
  } catch (err) {
    console.error('multi-format copy failed, falling back to plain', err);
    try {
      await navigator.clipboard.writeText(md);
      flashButton(els.btnCopyAllMd);
    } catch (err2) {
      alert('コピー失敗: ' + err2.message);
    }
  }
}

function buildExportHtml(session) {
  const data = {
    format: 'dictation-session/v1',
    exportedAt: new Date().toISOString(),
    session: {
      title: session.title,
      aiTitle: session.aiTitle || null,
      titleIsManual: !!session.titleIsManual,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      transcript: session.transcript || '',
      memo: session.memo || '',
      summary: session.summary || '',
    },
  };
  // Embed JSON safely — escape </ so it doesn't close the script tag
  const embedded = JSON.stringify(data).replace(/<\/(script)/gi, '<\\/$1');

  const fmt = (ts) => {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const sections = [];
  for (const id of state.settings.paneOrder) {
    const meta = PANE_META[id];
    let html = '';
    if (id === 'pane-transcript') html = session.transcript || '';
    else if (id === 'pane-memo') html = session.memo || '';
    else if (id === 'pane-summary') html = session.summary || '';
    else if (id === 'pane-chat') {
      const chat = (session.chat || []).filter(m => !m.thinking);
      if (chat.length === 0) continue;
      html = chat.map(m => {
        const who = m.role === 'user' ? 'あなた' : 'Gemini';
        const body = m.role === 'assistant' ? renderMarkdown(m.content)
                    : '<p>' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</p>';
        return `<div class="chat-block ${m.role}"><div class="chat-who">${who}</div>${body}</div>`;
      }).join('\n');
    }
    if (!html || !html.trim()) continue;
    const iconGlyph = id === 'pane-transcript' ? '🎙' : id === 'pane-memo' ? '📝' : id === 'pane-summary' ? '📄' : '💬';
    sections.push(`
<section class="pane-section">
  <h2><span class="sec-icon">${iconGlyph}</span>${escapeHtml(meta.label)}</h2>
  <div class="sec-body">${html}</div>
</section>`);
  }

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="dictation:format" content="dictation-session/v1">
<meta name="dictation:title" content="${escapeHtml(session.title)}">
<title>${escapeHtml(session.title)} — dictation</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #1a1a1f;
  --bg-elevated: #23232a;
  --bg-subtle: #2d2d36;
  --border: #3a3a44;
  --text: #e8e8eb;
  --text-muted: #9b9ba5;
  --text-faint: #6b6b73;
  --accent: #34d399;
  --heading: #7dd3fc;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: 'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 15px;
  line-height: 1.85;
  -webkit-font-smoothing: antialiased;
}
.wrap {
  max-width: 780px;
  margin: 0 auto;
  padding: 48px 20px 80px;
}
header.doc-head {
  margin-bottom: 28px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-faint);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.brand::before {
  content: '🎙';
  font-size: 14px;
}
h1.doc-title {
  font-size: 28px;
  font-weight: 600;
  margin: 8px 0 6px;
  color: var(--text);
  line-height: 1.4;
}
.doc-meta {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.doc-meta span strong {
  color: var(--text-faint);
  font-weight: normal;
  margin-right: 6px;
}
.pane-section {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 22px 26px;
  margin-bottom: 18px;
}
.pane-section h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--accent);
  margin: 0 0 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.sec-icon { font-size: 16px; }
.sec-body {
  color: var(--text);
  word-break: break-word;
}
.sec-body .paragraph {
  margin: 0 0 1.1em;
}
.sec-body .paragraph:last-child { margin-bottom: 0; }
.sec-body .paragraph h2 {
  color: var(--heading);
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 0.4em;
  padding: 0;
  border: none;
}
.sec-body .p-body {
  color: var(--text);
}
.sec-body h2 {
  color: var(--heading);
  font-size: 16px;
  font-weight: 600;
  margin: 1.1em 0 0.35em;
  padding-top: 0.2em;
  border-top: 1px solid var(--border);
}
.sec-body h2:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.sec-body p { margin: 0.35em 0; }
.sec-body ul, .sec-body ol { padding-left: 1.3em; margin: 0.35em 0; }
.sec-body li { margin: 0.15em 0; }
.chat-block {
  margin: 10px 0;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
}
.chat-block.user {
  background: rgba(52, 211, 153, 0.08);
  border-color: rgba(52, 211, 153, 0.35);
  margin-left: 24px;
}
.chat-block.assistant {
  background: var(--bg-subtle);
  margin-right: 24px;
}
.chat-who {
  font-size: 10px;
  color: var(--text-faint);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
footer.doc-foot {
  margin-top: 36px;
  text-align: center;
  font-size: 11px;
  color: var(--text-faint);
  letter-spacing: 0.06em;
}
footer.doc-foot a {
  color: var(--text-faint);
  text-decoration: none;
}
</style>
</head>
<body>
<div class="wrap">
  <header class="doc-head">
    <span class="brand">dictation</span>
    <h1 class="doc-title">${escapeHtml(session.title)}</h1>
    <div class="doc-meta">
      <span><strong>作成</strong>${fmt(session.createdAt)}</span>
      <span><strong>更新</strong>${fmt(session.updatedAt)}</span>
    </div>
  </header>
${sections.join('\n')}
  <footer class="doc-foot">
    generated by dictation — このファイルはダブルクリックで開けます。dictation に再読込も可能。
  </footer>
</div>
<script type="application/json" id="dictation-data">${embedded}</script>
</body>
</html>
`;
}

function saveSessionAsHtml() {
  snapshotActiveToSession();
  const session = getActiveSession();
  if (!session) return;
  const html = buildExportHtml(session);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const safeTitle = (session.title || 'dictation').replace(/[\\/:*?"<>|]/g, '_');
  triggerDownload(blob, `${safeTitle}-${stamp}.html`);
  flashButton(els.btnSaveJson, 'HTML保存完了');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importSessionData(s) {
  if (typeof s !== 'object' || s === null) throw new Error('データ形式が正しくありません');
  const title = s.title || 'インポート済み';
  if (state.isRecording) stopRecording();
  snapshotActiveToSession();
  persistSessions();
  const session = createSession({ activate: true, title, skipSave: true });
  session.transcript = s.transcript || s.html || '';
  session.memo = s.memo || '';
  session.summary = s.summary || '';
  session.chat = Array.isArray(s.chat) ? s.chat : [];
  session.aiTitle = s.aiTitle || null;
  session.titleIsManual = !!s.titleIsManual;
  session.createdAt = s.createdAt || Date.now();
  session.updatedAt = Date.now();
  persistSessions();
  loadActiveSessionIntoDOM();
}

async function loadFromFile(file) {
  try {
    const text = await file.text();
    const name = (file.name || '').toLowerCase();

    // HTML (preferred new format)
    if (name.endsWith('.html') || name.endsWith('.htm') || text.trimStart().toLowerCase().startsWith('<!doctype html')) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');
      const meta = doc.querySelector('meta[name="dictation:format"]');
      if (!meta || !String(meta.getAttribute('content') || '').startsWith('dictation-session/')) {
        alert('これは dictation の保存ファイルではありません。\n\ndictation で「保存」したHTMLファイルか、旧JSONファイルだけを読み込めます。');
        return;
      }
      const script = doc.querySelector('script[type="application/json"]#dictation-data');
      if (!script || !script.textContent.trim()) {
        alert('HTMLファイルにセッションデータが埋め込まれていません。\n別の dictation ファイルを試してください。');
        return;
      }
      const data = JSON.parse(script.textContent);
      importSessionData(data.session || data);
      return;
    }

    // JSON (legacy)
    if (name.endsWith('.json') || text.trimStart().startsWith('{')) {
      const data = JSON.parse(text);
      importSessionData(data.session || data);
      return;
    }

    alert('対応していないファイル形式です（HTML または JSON を選んでください）');
  } catch (e) {
    alert('読み込みに失敗しました: ' + e.message);
  }
}

function clearPane(paneId, { confirmFirst = true } = {}) {
  const label = PANE_META[paneId]?.label || paneId;
  const hasContent = paneId === 'pane-transcript' ? !!getConfirmedText()
    : paneId === 'pane-memo' ? !!getMemoText()
    : paneId === 'pane-summary' ? !!getSummaryText()
    : paneId === 'pane-chat' ? !!getChatText()
    : false;
  if (!hasContent) return;
  if (confirmFirst && !confirm(`「${label}」をクリアしますか？`)) return;
  if (paneId === 'pane-transcript') {
    els.confirmed.innerHTML = '';
    els.interim.textContent = '';
    state.pendingChunkEl = null;
    state.pendingChunkText = '';
    if (els.emptyHint) els.emptyHint.hidden = false;
  } else if (paneId === 'pane-memo') {
    els.memo.innerHTML = '';
  } else if (paneId === 'pane-summary') {
    els.summary.innerHTML = '';
    if (els.summaryEmpty) els.summaryEmpty.hidden = false;
  } else if (paneId === 'pane-chat') {
    const session = getActiveSession();
    if (session) session.chat = [];
    renderChat();
  }
  updateActionButtons();
  snapshotActiveToSession();
  persistSessions();
}

function clearAllPanes() {
  if (!hasAnyContent()) return;
  if (!confirm('このセッションの4タブ（文字起こし・メモ・要約・質問）をすべてクリアしますか？')) return;
  clearPane('pane-transcript', { confirmFirst: false });
  clearPane('pane-memo', { confirmFirst: false });
  clearPane('pane-summary', { confirmFirst: false });
  clearPane('pane-chat', { confirmFirst: false });
}

function toggleAi() {
  if (!state.settings.apiKey) { openSettings(); return; }
  state.settings.aiEnabled = !state.settings.aiEnabled;
  saveSettings();
  applyAiButtonState();
  // ONにした瞬間、ペインの生テキストがあれば即整形
  if (state.settings.aiEnabled) {
    refineUnstructuredInTranscript({ showFeedback: false });
  }
}

/* ───────── Display settings / pane order / inner tabs ───────── */

function applyDisplaySettings() {
  const s = state.settings;
  const root = document.documentElement;
  root.style.setProperty('--transcript-font', FONT_FAMILIES[s.transcriptFont] || FONT_FAMILIES.sans);
  root.style.setProperty('--transcript-size', (s.transcriptSize || 15) + 'px');
  root.style.setProperty('--memo-font', FONT_FAMILIES[s.memoFont] || FONT_FAMILIES.sans);
  root.style.setProperty('--memo-size', (s.memoSize || 15) + 'px');
  root.style.setProperty('--summary-font', FONT_FAMILIES[s.summaryFont] || FONT_FAMILIES.sans);
  root.style.setProperty('--summary-size', (s.summarySize || 15) + 'px');
  root.style.setProperty('--chat-font', FONT_FAMILIES[s.chatFont] || FONT_FAMILIES.sans);
  root.style.setProperty('--chat-size', (s.chatSize || 14) + 'px');
  applyAppZoom(s.appZoom || 100);
  syncPaneFontControls();
}

function syncPaneFontControls() {
  document.querySelectorAll('.pane-font-select').forEach(sel => {
    const paneId = sel.dataset.paneFont;
    const keys = PANE_FONT_KEYS[paneId];
    if (!keys) return;
    sel.value = state.settings[keys.font];
  });
  document.querySelectorAll('.pane-size-input').forEach(inp => {
    const paneId = inp.dataset.paneSize;
    const keys = PANE_FONT_KEYS[paneId];
    if (!keys) return;
    inp.value = state.settings[keys.size];
  });
}

function populatePaneFontSelects() {
  document.querySelectorAll('.pane-font-select').forEach(select => {
    select.innerHTML = '';
    for (const group of FONT_OPTIONS) {
      const og = document.createElement('optgroup');
      og.label = group.group;
      for (const item of group.items) {
        const o = document.createElement('option');
        o.value = item.value;
        o.textContent = item.label;
        og.appendChild(o);
      }
      select.appendChild(og);
    }
  });
}

function wireNumberSteppers() {
  document.querySelectorAll('.number-stepper-btn[data-stepper-target]').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = btn.dataset.stepperTarget;
      const delta = Number(btn.dataset.stepperDelta) || 0;
      const input = document.getElementById(targetId);
      if (!input) return;
      const step = Number(input.step) || 1;
      const current = Number(input.value) || Number(input.min) || 0;
      const min = input.min !== '' ? Number(input.min) : -Infinity;
      const max = input.max !== '' ? Number(input.max) : Infinity;
      const next = Math.max(min, Math.min(max, current + delta * step));
      if (next === current) return;
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

function wirePaneFontControls() {
  document.querySelectorAll('.pane-font-select').forEach(select => {
    select.addEventListener('change', () => {
      const paneId = select.dataset.paneFont;
      const keys = PANE_FONT_KEYS[paneId];
      if (!keys) return;
      state.settings[keys.font] = select.value;
      saveSettings();
      applyDisplaySettings();
    });
  });
  document.querySelectorAll('.pane-size-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const paneId = inp.dataset.paneSize;
      const keys = PANE_FONT_KEYS[paneId];
      if (!keys) return;
      const v = Math.max(10, Math.min(36, Number(inp.value) || 15));
      state.settings[keys.size] = v;
      inp.value = v;
      saveSettings();
      applyDisplaySettings();
    });
  });
  document.querySelectorAll('[data-pane-size-step]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const [paneId, deltaStr] = btn.dataset.paneSizeStep.split(':');
      const delta = Number(deltaStr) || 0;
      const keys = PANE_FONT_KEYS[paneId];
      if (!keys) return;
      const current = Number(state.settings[keys.size]) || 15;
      const next = Math.max(10, Math.min(36, current + delta));
      if (next === current) return;
      state.settings[keys.size] = next;
      saveSettings();
      applyDisplaySettings();
    });
  });
}

function applyAppZoom(v) {
  // #app / body への細工は全部解除
  const app = document.getElementById('app');
  if (app) {
    app.style.zoom = '';
    app.style.transform = '';
    app.style.transformOrigin = '';
    app.style.width = '';
    app.style.height = '';
  }
  const root = document.documentElement;
  const z = v / 100;
  if (v === 100) {
    root.style.zoom = '';
    root.style.width = '';
    root.style.height = '';
  } else {
    // html に zoom を適用し、layout 側を逆スケールで拡大
    //   → html 視覚サイズ = viewport を埋める
    //   → 内側の vh/vw/% もすべて viewport カバーに追従
    root.style.zoom = z;
    root.style.width  = (100 / z) + 'vw';
    root.style.height = (100 / z) + 'vh';
  }
}

function applyPaneOrder() {
  for (const id of state.settings.paneOrder) {
    const pane = document.getElementById(id);
    if (pane) els.mainArea.appendChild(pane);
  }
}

function renderInnerTabs() {
  els.innerTabsContainer.innerHTML = '';
  for (const id of state.settings.paneOrder) {
    const meta = PANE_META[id];
    if (!meta) continue;
    const btn = document.createElement('button');
    btn.className = 'inner-tab' + (state.activePane === id ? ' active' : '');
    btn.dataset.pane = id;
    btn.innerHTML = `<span class="inner-tab-icon" data-icon="${meta.icon}"></span>${meta.label}`;
    btn.addEventListener('click', () => switchInnerPane(id));
    els.innerTabsContainer.appendChild(btn);
  }
  renderIcons(els.innerTabsContainer);
  enablePointerDragSort(els.innerTabsContainer, {
    itemSelector: '.inner-tab',
    idAttr: 'pane',
    onReorder: reorderPaneOrder,
  });
}

function reorderPaneOrder(newOrder) {
  if (!Array.isArray(newOrder) || newOrder.length !== state.settings.paneOrder.length) return;
  state.settings.paneOrder = newOrder;
  saveSettings();
  applyPaneOrder();
}

/* ───────── Chat (NotebookLM風) ───────── */

function renderChat() {
  const session = getActiveSession();
  const chat = session?.chat || [];
  els.chatMessages.innerHTML = '';
  if (chat.length === 0) {
    if (els.chatEmpty) els.chatEmpty.hidden = false;
    return;
  }
  if (els.chatEmpty) els.chatEmpty.hidden = true;
  for (const msg of chat) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + msg.role + (msg.thinking ? ' thinking' : '') + (msg.error ? ' error' : '');
    const who = msg.role === 'user' ? 'あなた' : 'Gemini';
    const body = document.createElement('div');
    body.className = 'chat-msg-body';
    if (msg.thinking) {
      body.textContent = '考え中';
    } else if (msg.role === 'assistant') {
      body.innerHTML = renderMarkdown(msg.content);
    } else {
      body.innerHTML = escapeHtml(msg.content).replace(/\n/g, '<br>');
    }
    const header = document.createElement('div');
    header.className = 'chat-msg-header';
    header.textContent = who;
    div.appendChild(header);
    div.appendChild(body);
    els.chatMessages.appendChild(div);
  }
  requestAnimationFrame(() => { els.chatBody.scrollTop = els.chatBody.scrollHeight; });
}

function resizeChatInput() {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = Math.min(200, els.chatInput.scrollHeight) + 'px';
}

async function sendChatMessage() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  if (!state.settings.apiKey) {
    alert('Gemini API キーが未設定です。設定から登録してください。');
    openSettings();
    return;
  }
  const session = getActiveSession();
  if (!session) return;
  if (!Array.isArray(session.chat)) session.chat = [];

  const history = session.chat.slice();
  session.chat.push({ role: 'user', content: text, ts: Date.now() });
  els.chatInput.value = '';
  resizeChatInput();
  const thinking = { role: 'assistant', content: '', ts: Date.now(), thinking: true };
  session.chat.push(thinking);
  renderChat();
  els.btnChatSend.disabled = true;

  try {
    const answer = await chatWithGemini({
      apiKey: state.settings.apiKey,
      contextSources: {
        transcript: getConfirmedText(),
        memo: getMemoText(),
        summary: getSummaryText(),
      },
      history,
      question: text,
    });
    session.chat = session.chat.filter(m => m !== thinking);
    session.chat.push({ role: 'assistant', content: answer, ts: Date.now() });
    persistSessions();
    updateActionButtons();
    renderChat();
  } catch (e) {
    console.error('chat failed:', e);
    session.chat = session.chat.filter(m => m !== thinking);
    session.chat.push({ role: 'assistant', content: '⚠️ ' + (e.message || String(e)), ts: Date.now(), error: true });
    persistSessions();
    renderChat();
  } finally {
    els.btnChatSend.disabled = false;
    els.chatInput.focus();
  }
}

/* ───────── Auto title ───────── */

function formatDatePart(ts) {
  const d = new Date(ts);
  const pad = x => String(x).padStart(2, '0');
  return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function autoGenerateTitle({ silent = true, force = false } = {}) {
  const session = getActiveSession();
  if (!session) return;
  if (!force && session.titleIsManual) return;
  if (!state.settings.apiKey) {
    if (!silent) { alert('Gemini API キーが未設定です。設定から登録してください。'); openSettings(); }
    return;
  }
  // auto（録音停止時等）は aiEnabled に従う。手動再生成（force）は常に実行。
  if (!force && !state.settings.aiEnabled) return;
  const transcript = getConfirmedText();
  const summary = getSummaryText();
  if (!transcript && !summary) {
    if (!silent) alert('タイトル生成の素材がありません（文字起こし・要約が空）');
    return;
  }
  try {
    const aiTitle = await generateTitleWithGemini({
      apiKey: state.settings.apiKey,
      summary,
      transcript,
    });
    if (!aiTitle) {
      if (!silent) alert('タイトルが空で返ってきました');
      return;
    }
    session.aiTitle = aiTitle;
    session.title = `${aiTitle}(${formatDatePart(session.createdAt)})`;
    session.titleIsManual = false;
    session.updatedAt = Date.now();
    persistSessions();
    renderTabs();
  } catch (e) {
    console.warn('auto title failed:', e);
    if (!silent) alert('タイトル生成に失敗しました: ' + (e.message || String(e)));
  }
}

/* ───────── Summary generation ───────── */

async function generateSummary({ silent = false } = {}) {
  if (state.isSummarizing) return;
  const transcript = getConfirmedText();
  if (!transcript) {
    if (!silent) alert('文字起こしが空です。要約を生成できません。');
    return;
  }
  if (!state.settings.apiKey) {
    if (!silent) { alert('Gemini API キーが未設定です。設定から登録してください。'); openSettings(); }
    return;
  }
  state.isSummarizing = true;
  els.summary.classList.add('generating');
  els.summaryEmpty.hidden = true;
  if (els.btnSummaryCombo) els.btnSummaryCombo.classList.add('firing');
  setStatus('listening', '要約生成中');
  try {
    const session = getActiveSession();
    const summary = await summarizeWithGemini({
      apiKey: state.settings.apiKey,
      transcript,
      title: session?.title,
    });
    els.summary.innerHTML = renderMarkdown(summary);
    snapshotActiveToSession();
    persistSessions();
    updateActionButtons();
    if (!silent) {
      switchInnerPane('pane-summary');
      autoGenerateTitle();
    }
  } catch (e) {
    console.error('Summary generation failed:', e);
    if (!silent) alert('要約生成に失敗しました: ' + e.message);
  } finally {
    state.isSummarizing = false;
    els.summary.classList.remove('generating');
    if (els.btnSummaryCombo) els.btnSummaryCombo.classList.remove('firing');
    setStatus(state.isRecording ? 'listening' : 'idle', state.isRecording ? '録音中' : '停止');
  }
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let paragraph = [];
  let inList = false;
  let listType = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (inList) { out.push(`</${listType}>`); inList = false; listType = null; }
  };
  const flush = () => { flushParagraph(); flushList(); };

  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.+)$/);
    const ul = line.match(/^[-*]\s+(.+)$/);
    const ol = line.match(/^\d+\.\s+(.+)$/);

    if (h) {
      flush();
      out.push(`<h2>${escapeHtml(h[1])}</h2>`);
    } else if (ul) {
      flushParagraph();
      if (!inList || listType !== 'ul') { flushList(); out.push('<ul>'); inList = true; listType = 'ul'; }
      out.push(`<li>${escapeHtml(ul[1])}</li>`);
    } else if (ol) {
      flushParagraph();
      if (!inList || listType !== 'ol') { flushList(); out.push('<ol>'); inList = true; listType = 'ol'; }
      out.push(`<li>${escapeHtml(ol[1])}</li>`);
    } else if (line.trim() === '') {
      flush();
    } else {
      flushList();
      paragraph.push(escapeHtml(line));
    }
  }
  flush();
  return out.join('\n');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ───────── Settings modal ───────── */

let settingsWorkingOrder = null;

function renderPaneOrderList() {
  els.paneOrderList.innerHTML = '';
  settingsWorkingOrder.forEach((id) => {
    const meta = PANE_META[id];
    const item = document.createElement('div');
    item.className = 'pane-order-item';
    item.dataset.paneId = id;
    item.innerHTML = `
      <span class="pane-order-grip" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
          <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
          <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
        </svg>
      </span>
      <span class="pane-order-item-label"><span data-icon="${meta.icon}"></span>${meta.label}</span>
    `;
    els.paneOrderList.appendChild(item);
  });
  // タッチ対応のポインタドラッグ（マウス即時／タッチ長押し）
  enablePointerDragSort(els.paneOrderList, {
    itemSelector: '.pane-order-item',
    idAttr: 'pane-id',
    onReorder: (newIdOrder) => {
      settingsWorkingOrder = newIdOrder;
      renderPaneOrderList();
    },
  });
  renderIcons(els.paneOrderList);
}

/* ───────── Pointer-based drag sort（マウス即時／タッチ長押し） ───────── */
/**
 * タブなど横向き/縦向きリストをドラッグ並べ替え可能にする。
 * PC: クリック＋ドラッグで即開始。タッチ: 長押し（400ms）で開始。
 * @param {HTMLElement} list
 * @param {object} opts
 * @param {string} opts.itemSelector
 * @param {string} [opts.idAttr='id'] - kebab. 例 'id' / 'pane'
 * @param {function} opts.onReorder
 */
function enablePointerDragSort(list, opts) {
  // 再ワイヤ防止: 既にバインド済みなら opts を更新して返す
  if (list.__dragSortWired) {
    list.__dragSortOpts = opts;
    return;
  }
  list.__dragSortWired = true;
  list.__dragSortOpts = opts;
  const getOpts = () => list.__dragSortOpts || {};
  const itemSelector = opts.itemSelector;
  const idAttr = opts.idAttr || 'id';

  const LONG_PRESS_MS = 400;
  const MOVE_THRESHOLD = 6;

  let activeItem = null;
  let ghost = null;
  let pressTimer = null;
  let startX = 0, startY = 0;
  let pointerId = null;
  let isDragging = false;
  let didReorder = false;
  let edgeScrollRAF = null;
  let lastPointerEvent = null;

  function dataKeyFor(attr) {
    return attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  function detectHorizontal() {
    const items = list.querySelectorAll(itemSelector);
    if (items.length < 2) return true;
    const r1 = items[0].getBoundingClientRect();
    const r2 = items[1].getBoundingClientRect();
    return Math.abs(r1.top - r2.top) < Math.abs(r1.left - r2.left);
  }

  function clearHighlights() {
    list.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over-left, .drag-over-right')
      .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-left', 'drag-over-right'));
  }

  function createGhost(item) {
    const rect = item.getBoundingClientRect();
    const g = item.cloneNode(true);
    g.classList.add('drag-ghost');
    g.style.position = 'fixed';
    g.style.pointerEvents = 'none';
    g.style.zIndex = '9999';
    g.style.width = rect.width + 'px';
    g.style.height = rect.height + 'px';
    g.style.left = rect.left + 'px';
    g.style.top = rect.top + 'px';
    g.style.opacity = '0.9';
    g.style.boxShadow = '0 8px 24px rgba(0,0,0,0.55)';
    document.body.appendChild(g);
    return g;
  }

  function startDrag(item, e) {
    activeItem = item;
    isDragging = true;
    didReorder = false;
    item.classList.add('dragging');
    ghost = createGhost(item);
    try { list.setPointerCapture(pointerId); } catch {}
  }

  function moveGhost(e) {
    if (!ghost) return;
    ghost.style.left = (e.clientX - ghost.offsetWidth / 2) + 'px';
    ghost.style.top = (e.clientY - ghost.offsetHeight / 2) + 'px';
  }

  function updateHighlight(e) {
    if (!ghost) return;
    ghost.style.display = 'none';
    const hovered = document.elementFromPoint(e.clientX, e.clientY);
    ghost.style.display = '';
    const target = hovered ? hovered.closest(itemSelector) : null;
    clearHighlights();
    if (!target || target === activeItem || !list.contains(target)) return;
    const horiz = detectHorizontal();
    const r = target.getBoundingClientRect();
    const before = horiz
      ? e.clientX < r.left + r.width / 2
      : e.clientY < r.top + r.height / 2;
    target.classList.add(horiz ? (before ? 'drag-over-left' : 'drag-over-right')
                                : (before ? 'drag-over-top'  : 'drag-over-bottom'));
  }

  function endDrag(e) {
    if (!activeItem) return;
    if (ghost) { try { document.body.removeChild(ghost); } catch {} ghost = null; }
    activeItem.classList.remove('dragging');

    ghost = null;
    const hovered = document.elementFromPoint(e.clientX, e.clientY);
    const target = hovered ? hovered.closest(itemSelector) : null;
    if (target && target !== activeItem && list.contains(target)) {
      // FLIP: First ── 並べ替え前の位置を記録
      const itemsBefore = Array.from(list.querySelectorAll(itemSelector));
      const firstRects = new Map();
      itemsBefore.forEach(el => firstRects.set(el, el.getBoundingClientRect()));

      const horiz = detectHorizontal();
      const r = target.getBoundingClientRect();
      const before = horiz
        ? e.clientX < r.left + r.width / 2
        : e.clientY < r.top + r.height / 2;
      if (before) list.insertBefore(activeItem, target);
      else list.insertBefore(activeItem, target.nextSibling);

      // FLIP: Last/Invert ── 新しい位置を測り、差分だけ過去位置へ飛ばす
      const itemsAfter = Array.from(list.querySelectorAll(itemSelector));
      itemsAfter.forEach(el => {
        const first = firstRects.get(el);
        if (!first) return;
        const last = el.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      // FLIP: Play ── 次フレームで transform を戻すとトランジションでスライド
      requestAnimationFrame(() => {
        itemsAfter.forEach(el => {
          if (!el.style.transform) return;
          el.style.transition = 'transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)';
          el.style.transform = '';
        });
        setTimeout(() => {
          itemsAfter.forEach(el => {
            el.style.transition = '';
            el.style.transform = '';
          });
        }, 320);
      });

      const key = dataKeyFor(idAttr);
      const newOrder = itemsAfter.map(el => el.dataset[key]);
      didReorder = true;
      const cb = getOpts().onReorder;
      if (cb) cb(newOrder);
    }
    clearHighlights();
    try { list.releasePointerCapture(pointerId); } catch {}

    // 直後の click を抑止（ドラッグ結果で予期せぬ切替を防ぐ）
    if (isDragging) {
      const suppress = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', suppress, { capture: true, once: true });
    }

    activeItem = null;
    pointerId = null;
    isDragging = false;
  }

  list.addEventListener('pointerdown', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item || !list.contains(item)) return;
    // ボタン/入力欄クリックはドラッグ発動しない
    if (e.target !== item && e.target.closest('button, input, textarea, select, [contenteditable="true"]')) return;

    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;

    if (e.pointerType === 'touch') {
      // タッチ: 長押しでドラッグ発動
      pressTimer = setTimeout(() => {
        pressTimer = null;
        startDrag(item, e);
      }, LONG_PRESS_MS);
    } else {
      // マウス等: 十分に動いたらドラッグ発動
      activeItem = item;
    }
  });

  function edgeScrollStep() {
    if (!isDragging || !lastPointerEvent) { edgeScrollRAF = null; return; }
    // スクロール対象: list そのものか、スクロール可能な祖先
    const scrollEl = (list.scrollWidth > list.clientWidth || list.scrollHeight > list.clientHeight)
      ? list
      : (list.closest('nav, .pane-body, main, section') || list);
    const rect = scrollEl.getBoundingClientRect();
    const ex = lastPointerEvent.clientX, ey = lastPointerEvent.clientY;
    const horiz = detectHorizontal();
    const EDGE = 50, SPEED = 10;
    if (horiz) {
      if (ex < rect.left + EDGE) scrollEl.scrollLeft -= SPEED;
      else if (ex > rect.right - EDGE) scrollEl.scrollLeft += SPEED;
    } else {
      if (ey < rect.top + EDGE) scrollEl.scrollTop -= SPEED;
      else if (ey > rect.bottom - EDGE) scrollEl.scrollTop += SPEED;
    }
    edgeScrollRAF = requestAnimationFrame(edgeScrollStep);
  }

  list.addEventListener('pointermove', (e) => {
    // 長押し待ち中に動いた → キャンセル
    if (pressTimer) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD * 2) {
        clearTimeout(pressTimer);
        pressTimer = null;
        activeItem = null;
      }
      return;
    }
    if (!activeItem) return;

    if (!isDragging && e.pointerId === pointerId) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.sqrt(dx * dx + dy * dy) < MOVE_THRESHOLD) return;
      startDrag(activeItem, e);
    }
    if (!isDragging) return;
    e.preventDefault();
    moveGhost(e);
    updateHighlight(e);
    // エッジスクロール起動
    lastPointerEvent = e;
    if (!edgeScrollRAF) edgeScrollRAF = requestAnimationFrame(edgeScrollStep);
  });

  const finish = (e) => {
    if (edgeScrollRAF) { cancelAnimationFrame(edgeScrollRAF); edgeScrollRAF = null; }
    lastPointerEvent = null;
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; activeItem = null; pointerId = null; return; }
    if (isDragging) endDrag(e);
    activeItem = null;
    pointerId = null;
    isDragging = false;
  };
  list.addEventListener('pointerup', finish);
  list.addEventListener('pointercancel', finish);
}

/* ───────── Drag-sort (HTML5 Drag API) ───────── */
/**
 * 汎用的なドラッグ並べ替え。
 * list の直下の itemSelector にマッチする要素を並べ替え可能にする。
 * 各要素は draggable=true で、data 属性でIDを保持していること前提。
 * @param {HTMLElement} list
 * @param {object} opts
 * @param {string} opts.itemSelector - 例: '.pane-order-item'
 * @param {string} [opts.idAttr] - ID を取り出す data 属性（kebab）、既定 'pane-id'
 * @param {function} opts.onReorder - 新しいID配列を引数に呼ばれる
 */
function enableDragSort(list, { itemSelector, idAttr = 'pane-id', onReorder }) {
  let dragged = null;

  const items = list.querySelectorAll(itemSelector);
  items.forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragged = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', ''); } catch {}
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      dragged = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!dragged || dragged === item) return;
      const rect = item.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      item.classList.toggle('drag-over-top', isAbove);
      item.classList.toggle('drag-over-bottom', !isAbove);
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragged || dragged === item) return;
      const rect = item.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      if (isAbove) list.insertBefore(dragged, item);
      else list.insertBefore(dragged, item.nextSibling);
      item.classList.remove('drag-over-top', 'drag-over-bottom');
      const dataKey = idAttr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const newOrder = Array.from(list.querySelectorAll(itemSelector)).map(el => el.dataset[dataKey]);
      if (onReorder) onReorder(newOrder);
    });
  });
}

function openSettings() {
  els.inputApiKey.value = state.settings.apiKey;
  els.inputSilenceSec.value = state.settings.silenceSec;
  els.inputAiEnabled.checked = state.settings.aiEnabled;
  els.inputAutoStop.checked = state.settings.autoStopEnabled;
  els.inputAutoStopSec.value = state.settings.autoStopSec;
  els.inputAutoSummarize.checked = state.settings.autoSummarize;
  // 音声入力モード
  if (state.settings.inputMode === 'gemini-audio') {
    els.modeGemini.checked = true;
  } else {
    els.modeWebSpeech.checked = true;
  }
  els.inputChunkSec.value = state.settings.audioChunkSec || 12;
  populateAudioDevices();
  applyGeminiOnlyVisibility(/* animated */ false);
  els.fontTranscript.value = state.settings.transcriptFont;
  els.sizeTranscript.value = state.settings.transcriptSize;
  els.fontMemo.value = state.settings.memoFont;
  els.sizeMemo.value = state.settings.memoSize;
  els.fontSummary.value = state.settings.summaryFont;
  els.sizeSummary.value = state.settings.summarySize;
  settingsWorkingOrder = state.settings.paneOrder.slice();
  renderPaneOrderList();
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
  state.settings.autoSummarize = els.inputAutoSummarize.checked;
  state.settings.inputMode = els.modeGemini.checked ? 'gemini-audio' : 'web-speech';
  state.settings.audioDeviceId = els.inputAudioDevice ? els.inputAudioDevice.value : '';
  state.settings.audioChunkSec = Math.max(5, Math.min(60, Number(els.inputChunkSec.value) || 12));
  state.settings.transcriptFont = els.fontTranscript.value;
  state.settings.transcriptSize = Math.max(10, Math.min(36, Number(els.sizeTranscript.value) || 17));
  state.settings.memoFont = els.fontMemo.value;
  state.settings.memoSize = Math.max(10, Math.min(36, Number(els.sizeMemo.value) || 15));
  state.settings.summaryFont = els.fontSummary.value;
  state.settings.summarySize = Math.max(10, Math.min(36, Number(els.sizeSummary.value) || 15));
  if (settingsWorkingOrder && settingsWorkingOrder.length === 3) {
    state.settings.paneOrder = settingsWorkingOrder.slice();
  }
  saveSettings();
  applyAiButtonState();
  applyDisplaySettings();
  applyPaneOrder();
  renderInnerTabs();
  els.settingsModal.classList.add('hidden');
}

/* ───────── Inner pane switch ───────── */

function switchInnerPane(paneId) {
  if (state.activePane === paneId) return;
  // zoom-bar をフェードしながら位置切替（チャット入力欄との重なり回避）
  const wasChat = document.body.classList.contains('chat-active');
  const willBeChat = paneId === 'pane-chat';
  if (wasChat !== willBeChat) {
    const zb = els.zoomBar;
    if (zb) {
      zb.classList.add('fading');
      setTimeout(() => {
        document.body.classList.toggle('chat-active', willBeChat);
        zb.classList.remove('fading');
      }, 180);
    } else {
      document.body.classList.toggle('chat-active', willBeChat);
    }
  }

  // 方向判定（zemicale パターン）: 並びの右へ移動 → 新ペインは右から入る、左へ → 左から入る
  const order = state.settings.paneOrder || [];
  const oldIdx = order.indexOf(state.activePane);
  const newIdx = order.indexOf(paneId);
  const direction = (oldIdx >= 0 && newIdx >= 0 && newIdx < oldIdx) ? 'left' : 'right';

  state.activePane = paneId;
  els.innerTabsContainer.querySelectorAll('.inner-tab').forEach(t => t.classList.toggle('active', t.dataset.pane === paneId));
  const panes = [els.paneTranscript, els.paneMemo, els.paneSummary, els.paneChat];
  panes.forEach(p => {
    p.classList.toggle('active', p.id === paneId);
    p.classList.remove('enter-from-right', 'enter-from-left');
  });

  const newPane = document.getElementById(paneId);
  if (newPane && oldIdx >= 0 && newIdx >= 0 && oldIdx !== newIdx) {
    // reflow で animation を確実に再発火
    void newPane.offsetWidth;
    newPane.classList.add(direction === 'right' ? 'enter-from-right' : 'enter-from-left');
    setTimeout(() => {
      newPane.classList.remove('enter-from-right', 'enter-from-left');
    }, 280);
  }

  if (paneId === 'pane-summary') {
    els.summaryEmpty.hidden = !!getSummaryText();
  }
  if (paneId === 'pane-chat') {
    setTimeout(() => { els.chatBody.scrollTop = els.chatBody.scrollHeight; }, 0);
  }
}

/* ───────── Sessions (outer tabs) ───────── */

function initSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) state.sessions = JSON.parse(raw);
  } catch (e) {
    console.warn('loadSessions failed', e);
    state.sessions = [];
  }
  // Migrate legacy format (session.html → session.transcript)
  for (const s of state.sessions) {
    if (s.html !== undefined && s.transcript === undefined) {
      s.transcript = s.html;
      delete s.html;
    }
    if (s.memo === undefined) s.memo = '';
    if (s.summary === undefined) s.summary = '';
    if (s.transcript === undefined) s.transcript = '';
    if (!Array.isArray(s.chat)) s.chat = [];
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
    transcript: '',
    memo: '',
    summary: '',
    chat: [],
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
  s.transcript = els.confirmed.innerHTML;
  s.memo = els.memo.innerHTML;
  s.summary = els.summary.innerHTML;
  s.updatedAt = Date.now();
}

function loadActiveSessionIntoDOM() {
  const s = getActiveSession();
  els.confirmed.innerHTML = s?.transcript || '';
  els.memo.innerHTML = s?.memo || '';
  els.summary.innerHTML = s?.summary || '';
  els.interim.textContent = '';
  state.pendingChunkEl = null;
  state.pendingChunkText = '';
  if (els.emptyHint) els.emptyHint.hidden = !!els.confirmed.innerHTML;
  if (els.summaryEmpty) els.summaryEmpty.hidden = !!getSummaryText();
  renderChat();
  updateActionButtons();
  renderTitleBar();
  state.userScrolledUp = false;
  requestAnimationFrame(() => autoScroll(true));
}

function switchSession(id) {
  if (id === state.activeId) return;
  if (state.isRecording) stopRecording();
  snapshotActiveToSession();
  persistSessions();
  state.activeId = id;
  persistSessions();
  renderTabs();
  loadActiveSessionIntoDOM();
}

function closeSession(id) {
  const idx = state.sessions.findIndex(s => s.id === id);
  if (idx < 0) return;
  const session = state.sessions[idx];
  const hasContent = session.transcript || session.memo || session.summary;
  if (hasContent && !confirm(`「${session.title}」を閉じます。この内容は削除されます。よろしいですか？`)) return;
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
  s.titleIsManual = true;
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
    closeBtn.innerHTML = '<span data-icon="x"></span>';
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
      if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
      else if (e.key === 'Escape') { title.textContent = session.title; title.blur(); }
    });

    tab.appendChild(title);
    tab.appendChild(closeBtn);
    els.tabsList.appendChild(tab);
  }
  renderIcons(els.tabsList);
  enablePointerDragSort(els.tabsList, {
    itemSelector: '.tab',
    idAttr: 'id',
    onReorder: reorderSessions,
  });
  renderTitleBar();
}

function reorderSessions(newIds) {
  const map = new Map(state.sessions.map(s => [s.id, s]));
  const reordered = newIds.map(id => map.get(id)).filter(Boolean);
  if (reordered.length === state.sessions.length) {
    state.sessions = reordered;
    persistSessions();
  }
}

/* ───────── Title bar ───────── */

function renderTitleBar() {
  const session = getActiveSession();
  if (!session) { els.titleDisplay.textContent = ''; return; }
  if (els.titleDisplay.classList.contains('editing')) return;
  els.titleDisplay.textContent = session.title;
  els.titleDisplay.title = session.title;
}

function startTitleEdit() {
  const session = getActiveSession();
  if (!session) return;
  els.titleDisplay.contentEditable = 'true';
  els.titleDisplay.classList.add('editing');
  els.titleDisplay.focus();
  const range = document.createRange();
  range.selectNodeContents(els.titleDisplay);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function commitTitleEdit() {
  if (!els.titleDisplay.classList.contains('editing')) return;
  const session = getActiveSession();
  els.titleDisplay.contentEditable = 'false';
  els.titleDisplay.classList.remove('editing');
  if (!session) return;
  const next = els.titleDisplay.textContent.trim() || defaultTitle();
  if (next !== session.title) renameSession(session.id, next);
  else renderTitleBar();
}

function cancelTitleEdit() {
  const session = getActiveSession();
  els.titleDisplay.contentEditable = 'false';
  els.titleDisplay.classList.remove('editing');
  if (session) els.titleDisplay.textContent = session.title;
}

async function regenTitleFromBar() {
  const session = getActiveSession();
  if (!session) return;
  els.btnRegenTitle.classList.add('spinning');
  try {
    await autoGenerateTitle({ silent: false, force: true });
  } finally {
    els.btnRegenTitle.classList.remove('spinning');
  }
}

function startAutoSave() {
  if (state.autoSaveTimer) clearInterval(state.autoSaveTimer);
  state.autoSaveTimer = setInterval(() => {
    snapshotActiveToSession();
    persistSessions();
  }, AUTOSAVE_INTERVAL_MS);
}

/* ───────── Event wiring ───────── */

els.btnToggle.addEventListener('click', () => state.isRecording ? stopRecording() : startRecording());
els.btnCopyAllPlain.addEventListener('click', copyAllPlain);
els.btnCopyAllMd.addEventListener('click', copyAllMultiformat);
els.btnSaveJson.addEventListener('click', saveSessionAsHtml);
els.btnLoadJson.addEventListener('click', () => els.fileLoad.click());
els.fileLoad.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) loadFromFile(f);
  e.target.value = '';
});
els.btnClearAll.addEventListener('click', clearAllPanes);
els.btnSettings.addEventListener('click', openSettings);
if (els.btnSummaryCombo) {
  els.btnSummaryCombo.addEventListener('click', async (e) => {
    // あたり判定: ノブ(track)=自動ON/OFFトグル、それ以外=今すぐ生成
    const hit = e.target.closest('[data-role]');
    const role = hit?.dataset.role;
    if (role === 'toggle') {
      state.settings.autoSummarize = !state.settings.autoSummarize;
      saveSettings();
      applyAiButtonState();
    } else {
      els.btnSummaryCombo.classList.add('firing');
      try {
        await generateSummary({ silent: false });
      } finally {
        els.btnSummaryCombo.classList.remove('firing');
      }
    }
  });
}

document.querySelectorAll('[data-pane-copy]').forEach(btn => {
  btn.addEventListener('click', () => copyPane(btn.dataset.paneCopy, btn));
});
document.querySelectorAll('[data-pane-clear]').forEach(btn => {
  btn.addEventListener('click', () => clearPane(btn.dataset.paneClear));
});

els.btnSettingsSave.addEventListener('click', saveSettingsFromForm);

// モード切替で Gemini 専用フィールドの表示/非表示をアニメーション
if (els.modeWebSpeech) els.modeWebSpeech.addEventListener('change', () => applyGeminiOnlyVisibility(true));
if (els.modeGemini) els.modeGemini.addEventListener('change', () => applyGeminiOnlyVisibility(true));

/* ───────── Zoom bar (bottom-right) ───────── */
function setZoom(pct, persist = true) {
  const v = Math.max(75, Math.min(200, Math.round(pct / 5) * 5 || 100));
  state.settings.appZoom = v;
  applyAppZoom(v);
  els.zoomRange.value = v;
  els.zoomPercent.textContent = v + '%';
  if (persist) saveSettings();
}

els.zoomRange.addEventListener('input', () => setZoom(Number(els.zoomRange.value) || 100, false));
els.zoomRange.addEventListener('change', () => setZoom(Number(els.zoomRange.value) || 100, true));
els.zoomMinus.addEventListener('click', () => setZoom(state.settings.appZoom - 5));
els.zoomPlus.addEventListener('click', () => setZoom(state.settings.appZoom + 5));
els.zoomReset.addEventListener('click', () => setZoom(100));
els.settingsModal.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', closeSettings));

els.btnSilenceStop.addEventListener('click', () => { hideSilenceDialog(); stopRecording(); });
els.btnSilenceContinue.addEventListener('click', () => { hideSilenceDialog(); resetLongSilenceTimer(); });

let editSaveTimer = null;
function onEdit() {
  updateActionButtons();
  if (editSaveTimer) clearTimeout(editSaveTimer);
  editSaveTimer = setTimeout(() => { snapshotActiveToSession(); persistSessions(); }, 800);
}
els.confirmed.addEventListener('input', onEdit);
els.memo.addEventListener('input', onEdit);
els.summary.addEventListener('input', onEdit);

// ペースト時：AI整形ONなら少し待って整形発動
els.confirmed.addEventListener('paste', () => {
  if (!state.settings.aiEnabled || !state.settings.apiKey) return;
  setTimeout(() => { refineUnstructuredInTranscript({ showFeedback: false }); }, 150);
});

// 文字起こし整形コンボ: ノブ=自動ON/OFFトグル、本体=今すぐ整形
if (els.btnRefineTranscript) {
  els.btnRefineTranscript.addEventListener('click', async (e) => {
    const hit = e.target.closest('[data-role]');
    const role = hit?.dataset.role;
    if (role === 'toggle') {
      toggleAi();
    } else {
      if (!state.settings.apiKey) { openSettings(); return; }
      els.btnRefineTranscript.classList.add('firing');
      try {
        await refineUnstructuredInTranscript({ force: true, showFeedback: true });
      } finally {
        els.btnRefineTranscript.classList.remove('firing');
      }
    }
  });
}

els.paneTranscriptBody.addEventListener('scroll', () => {
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

els.btnTabNew.addEventListener('click', () => {
  if (state.isRecording) stopRecording();
  snapshotActiveToSession();
  persistSessions();
  createSession({ activate: true });
});

els.btnEditTitle.addEventListener('click', startTitleEdit);
els.btnRegenTitle.addEventListener('click', regenTitleFromBar);

els.chatInput.addEventListener('input', resizeChatInput);
els.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChatMessage();
  }
});
els.btnChatSend.addEventListener('click', sendChatMessage);
els.titleDisplay.addEventListener('blur', commitTitleEdit);
els.titleDisplay.addEventListener('keydown', (e) => {
  if (!els.titleDisplay.classList.contains('editing')) return;
  if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit(); }
  else if (e.key === 'Escape') { e.preventDefault(); cancelTitleEdit(); }
});

window.addEventListener('beforeunload', () => {
  snapshotActiveToSession();
  persistSessions();
});

if (!SpeechRecognition) {
  setStatus('error', '未対応');
  els.btnToggle.disabled = true;
}

loadSettings();
populateFontSelects();
populatePaneFontSelects();
wirePaneFontControls();
wireNumberSteppers();
applyDisplaySettings();
applyPaneOrder();
renderInnerTabs();
if (typeof renderIcons === 'function') renderIcons();
els.zoomRange.value = state.settings.appZoom;
els.zoomPercent.textContent = state.settings.appZoom + '%';
initSessions();
renderTabs();
loadActiveSessionIntoDOM();
updateActionButtons();
startAutoSave();
