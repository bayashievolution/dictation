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
  activePane: 'pane-transcript',
  isSummarizing: false,
};

const els = {
  btnToggle: document.getElementById('btn-toggle'),
  btnAi: document.getElementById('btn-ai'),
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
  paneTranscriptBody: document.querySelector('#pane-transcript .pane-body'),
  innerTabs: document.querySelectorAll('.inner-tab'),
  btnRegenSummary: document.getElementById('btn-regenerate-summary'),
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
  els.status.title = label;
}

function setRecordingUI(isRec) {
  els.btnToggle.classList.toggle('recording', isRec);
  els.btnToggle.querySelector('.btn-icon').textContent = isRec ? '⏹' : '▶';
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

function getMemoText() {
  return els.memo.innerText.trim();
}

function getSummaryText() {
  return els.summary.innerText.trim();
}

function hasAnyContent() {
  return getConfirmedText() || getMemoText() || getSummaryText();
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
  if (state.recognition) {
    try { state.recognition.stop(); } catch {}
  }
  setStatus('idle', '停止');
  setRecordingUI(false);
  els.interim.textContent = '';
  clearAllTimers();
  flushPendingToGemini().finally(async () => {
    snapshotActiveToSession();
    persistSessions();
    if (state.settings.autoSummarize && state.settings.aiEnabled && state.settings.apiKey) {
      await generateSummary({ silent: true });
    }
  });
}

/* ───────── Actions ───────── */

function flashButton(btn, label = 'コピー完了') {
  const origTitle = btn.title;
  const origHtml = btn.innerHTML;
  const iconSpan = btn.querySelector('.btn-icon');
  if (iconSpan) {
    const origIcon = iconSpan.textContent;
    iconSpan.textContent = '✓';
    btn.title = label;
    setTimeout(() => { iconSpan.textContent = origIcon; btn.title = origTitle; }, 1200);
  } else {
    btn.innerHTML = '<span>✓</span><span>OK</span>';
    btn.title = label;
    setTimeout(() => { btn.innerHTML = origHtml; btn.title = origTitle; }, 1200);
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

function buildCombinedPlain() {
  const parts = [];
  const t = getConfirmedText(); if (t) parts.push('【文字起こし】\n' + t);
  const m = getMemoText();      if (m) parts.push('【メモ】\n' + m);
  const s = getSummaryText();   if (s) parts.push('【要約】\n' + s);
  return parts.join('\n\n──────────\n\n');
}

function buildCombinedMarkdown() {
  const parts = [];
  const session = getActiveSession();
  if (session?.title) parts.push(`# ${session.title}`);
  const s = getSummaryText();   if (s) parts.push('## 要約\n\n' + s);
  const m = getMemoText();      if (m) parts.push('## メモ\n\n' + m);
  const t = getConfirmedText(); if (t) parts.push('## 文字起こし\n\n' + t);
  return parts.join('\n\n');
}

function buildCombinedHtmlForNotion() {
  // Notion は <details> を toggle ブロックに変換する
  const session = getActiveSession();
  const title = session?.title ? `<h1>${escapeHtml(session.title)}</h1>` : '';
  const sections = [];

  const addSection = (label, innerHtml, plainFallback) => {
    if (!innerHtml && !plainFallback) return;
    const body = innerHtml || `<p>${escapeHtml(plainFallback)}</p>`;
    sections.push(`<details open><summary><strong>${escapeHtml(label)}</strong></summary>${body}</details>`);
  };

  addSection('要約', els.summary.innerHTML, getSummaryText());
  addSection('メモ', els.memo.innerHTML, getMemoText());
  addSection('文字起こし', els.confirmed.innerHTML, getConfirmedText());

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

function saveSessionAsJson() {
  snapshotActiveToSession();
  const session = getActiveSession();
  if (!session) return;
  const data = {
    format: 'dictation-session/v1',
    exportedAt: new Date().toISOString(),
    session: {
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      transcript: session.transcript || '',
      memo: session.memo || '',
      summary: session.summary || '',
    },
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const safeTitle = (session.title || 'dictation').replace(/[\\/:*?"<>|]/g, '_');
  triggerDownload(blob, `${safeTitle}-${stamp}.json`);
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

function loadFromJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const s = data.session || data;
      if (typeof s !== 'object' || s === null) throw new Error('形式が正しくありません');
      const title = s.title || 'インポート済み';
      if (state.isRecording) stopRecording();
      snapshotActiveToSession();
      persistSessions();
      const session = createSession({ activate: true, title, skipSave: true });
      session.transcript = s.transcript || s.html || '';
      session.memo = s.memo || '';
      session.summary = s.summary || '';
      session.createdAt = s.createdAt || Date.now();
      session.updatedAt = Date.now();
      persistSessions();
      loadActiveSessionIntoDOM();
    } catch (e) {
      alert('読み込みに失敗しました: ' + e.message);
    }
  };
  reader.readAsText(file);
}

function clearPane(paneId, { confirmFirst = true } = {}) {
  const label = paneId === 'pane-transcript' ? '文字起こし' : paneId === 'pane-memo' ? 'メモ' : '要約';
  const hasContent = paneId === 'pane-transcript' ? !!getConfirmedText()
    : paneId === 'pane-memo' ? !!getMemoText()
    : !!getSummaryText();
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
  } else {
    els.summary.innerHTML = '';
    if (els.summaryEmpty) els.summaryEmpty.hidden = false;
  }
  updateActionButtons();
  snapshotActiveToSession();
  persistSessions();
}

function clearAllPanes() {
  if (!hasAnyContent()) return;
  if (!confirm('このセッションの「文字起こし・メモ・要約」をすべてクリアしますか？')) return;
  clearPane('pane-transcript', { confirmFirst: false });
  clearPane('pane-memo', { confirmFirst: false });
  clearPane('pane-summary', { confirmFirst: false });
}

function toggleAi() {
  if (!state.settings.apiKey) { openSettings(); return; }
  state.settings.aiEnabled = !state.settings.aiEnabled;
  saveSettings();
  applyAiButtonState();
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
  const origBtnHtml = els.btnRegenSummary.innerHTML;
  els.btnRegenSummary.innerHTML = '<span>✨ 生成中…</span>';
  els.btnRegenSummary.disabled = true;
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
    if (!silent) switchInnerPane('pane-summary');
  } catch (e) {
    console.error('Summary generation failed:', e);
    if (!silent) alert('要約生成に失敗しました: ' + e.message);
  } finally {
    state.isSummarizing = false;
    els.summary.classList.remove('generating');
    els.btnRegenSummary.innerHTML = origBtnHtml;
    els.btnRegenSummary.disabled = false;
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

function openSettings() {
  els.inputApiKey.value = state.settings.apiKey;
  els.inputSilenceSec.value = state.settings.silenceSec;
  els.inputAiEnabled.checked = state.settings.aiEnabled;
  els.inputAutoStop.checked = state.settings.autoStopEnabled;
  els.inputAutoStopSec.value = state.settings.autoStopSec;
  els.inputAutoSummarize.checked = state.settings.autoSummarize;
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
  saveSettings();
  applyAiButtonState();
  closeSettings();
}

/* ───────── Inner pane switch ───────── */

function switchInnerPane(paneId) {
  state.activePane = paneId;
  els.innerTabs.forEach(t => t.classList.toggle('active', t.dataset.pane === paneId));
  [els.paneTranscript, els.paneMemo, els.paneSummary].forEach(p => p.classList.toggle('active', p.id === paneId));
  // Update summary empty state
  if (paneId === 'pane-summary') {
    els.summaryEmpty.hidden = !!getSummaryText();
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
  updateActionButtons();
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
      if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
      else if (e.key === 'Escape') { title.textContent = session.title; title.blur(); }
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

/* ───────── Event wiring ───────── */

els.btnToggle.addEventListener('click', () => state.isRecording ? stopRecording() : startRecording());
els.btnAi.addEventListener('click', toggleAi);
els.btnCopyAllPlain.addEventListener('click', copyAllPlain);
els.btnCopyAllMd.addEventListener('click', copyAllMultiformat);
els.btnSaveJson.addEventListener('click', saveSessionAsJson);
els.btnLoadJson.addEventListener('click', () => els.fileLoad.click());
els.fileLoad.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) loadFromJson(f);
  e.target.value = '';
});
els.btnClearAll.addEventListener('click', clearAllPanes);
els.btnSettings.addEventListener('click', openSettings);
els.btnRegenSummary.addEventListener('click', () => generateSummary({ silent: false }));

document.querySelectorAll('[data-pane-copy]').forEach(btn => {
  btn.addEventListener('click', () => copyPane(btn.dataset.paneCopy, btn));
});
document.querySelectorAll('[data-pane-clear]').forEach(btn => {
  btn.addEventListener('click', () => clearPane(btn.dataset.paneClear));
});

els.innerTabs.forEach(t => {
  t.addEventListener('click', () => switchInnerPane(t.dataset.pane));
});

els.btnSettingsSave.addEventListener('click', saveSettingsFromForm);
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

window.addEventListener('beforeunload', () => {
  snapshotActiveToSession();
  persistSessions();
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
