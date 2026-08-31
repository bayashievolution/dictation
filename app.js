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

/* ───────── 診断ログ（最新N件を保持・設定モーダルでビューアに表示） ───────── */
const DIAG_LOG_MAX = 120;
const diagLog = {
  entries: [], // { ts, level: 'info'|'warn'|'error', msg: string }
  install() {
    const wrap = (level, original) => (...args) => {
      try {
        const msg = args.map(a => {
          if (a instanceof Error) return (a.stack || a.message || String(a));
          if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
          return String(a);
        }).join(' ');
        diagLog.entries.push({ ts: Date.now(), level, msg });
        while (diagLog.entries.length > DIAG_LOG_MAX) diagLog.entries.shift();
        // ビューアが開いている時だけ追記
        const viewer = document.getElementById('diag-log-viewer');
        if (viewer && !document.getElementById('settings-modal')?.classList.contains('hidden')) {
          diagLog.renderInto(viewer);
        }
      } catch {}
      return original.apply(console, args);
    };
    console.warn  = wrap('warn',  console.warn.bind(console));
    console.error = wrap('error', console.error.bind(console));
    // 未処理エラーもキャプチャ（try/catchを通らないクラッシュ用）
    window.addEventListener('error', (e) => {
      try {
        diagLog.entries.push({
          ts: Date.now(), level: 'error',
          msg: `[uncaught] ${e.message || ''} @ ${e.filename || '?'}:${e.lineno || '?'}`
        });
        while (diagLog.entries.length > DIAG_LOG_MAX) diagLog.entries.shift();
      } catch {}
    });
    window.addEventListener('unhandledrejection', (e) => {
      try {
        const r = e.reason;
        const msg = r instanceof Error ? (r.stack || r.message) : String(r);
        diagLog.entries.push({ ts: Date.now(), level: 'error', msg: `[unhandled] ${msg}` });
        while (diagLog.entries.length > DIAG_LOG_MAX) diagLog.entries.shift();
      } catch {}
    });
  },
  /**
   * アプリの内部イベント（エラーでない）を記録。
   * 録音開始/停止、BG切替、チャンク送信、リトライ、発火タイマーなど。
   * 設定→診断ログでこれを見ることで、DevToolsが開けない環境でも挙動が追える。
   */
  info(msg) {
    diagLog.entries.push({ ts: Date.now(), level: 'info', msg: String(msg) });
    while (diagLog.entries.length > DIAG_LOG_MAX) diagLog.entries.shift();
    const viewer = document.getElementById('diag-log-viewer');
    if (viewer && !document.getElementById('settings-modal')?.classList.contains('hidden')) {
      diagLog.renderInto(viewer);
    }
  },
  formatTs(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },
  renderInto(el) {
    if (!el) return;
    if (diagLog.entries.length === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = diagLog.entries.slice().reverse().map(e =>
      `<span class="diag-log-line ${e.level}"><span class="diag-ts">${diagLog.formatTs(e.ts)}</span><span class="diag-level">${e.level}</span>${escapeHtmlSimple(e.msg)}</span>`
    ).join('');
  },
  toPlainText() {
    return diagLog.entries.map(e =>
      `[${new Date(e.ts).toLocaleString()}] ${e.level.toUpperCase()}: ${e.msg}`
    ).join('\n');
  },
  clear() {
    diagLog.entries = [];
    const v = document.getElementById('diag-log-viewer');
    if (v) v.innerHTML = '';
  },
};
function escapeHtmlSimple(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
diagLog.install();
window.diagLog = diagLog; // gemini.js 等から info() を呼べるように公開

const DEFAULT_SETTINGS = {
  apiKey: '',
  silenceSec: 3,
  aiEnabled: true,
  autoStopSec: 120,
  autoStopEnabled: true,
  autoSummarize: true,
  summaryDetail: 'medium',
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
  audioMinChunkBytes: 400, // 旧1200から感度↑。小さい発話（小声・短語）もGeminiへ送る
  // v0.18.0: 無音位置での区切り。audioChunkSec は「最短」、audioChunkMaxSec は「最長」。
  // 最短を過ぎたら次の無音の切れ目で切り、最長に達したら無音でなくても切る。
  audioSilenceCut: true,
  audioChunkMaxSec: 20,
  /* v0.19.0: 録音音声の一時保管（全文やり直し用）
   *
   * **既定は保持しない。** 「文字起こしはよいが録音の保存はダメ」という
   * 同意の場面は普通にあるので、こちらを既定にする。
   * この設定が制御するのは「端末に残すか」だけで、Gemini モードは live の
   * 時点ですでに音声を Google に送っている（設定 UI にもそう書く）。 */
  audioKeepRecording: false,
  audioRetention: 'repass',   // repass / close / 1d / 7d / manual
  // 音声認識用途では 128kbps は過剰。64kbps なら 90分で約43MB
  audioBitrate: 64000,
  // v0.13.24: 旧 webspeechInterimDebounceMs / webspeechInterimOpacity (v0.13.9) は撤去。
  // 字幕ウィンドウ側の cap-para-interim を v0.13.17 で撤去済み・UI も v0.13.23 で
  // 削除済み。設定値だけ残しても読み手なしで意味ない。
  // Web Speech モードの強制 commit（チャンク間隔）設定 (v0.13.14〜)
  // - 0 にすると WebSpeech 任せ、N 秒にすると N 秒ごとに recognition.stop() を呼んで
  //   「ここまで」と区切らせる。これが字幕の「ちょうどいい塊感」の鍵。
  // - v0.13.20 でうかつに撤去したが、やっさんから「最初の状態に戻った」と即指摘され
  //   v0.13.21 で revert。実は本機能が Web Speech 字幕成功の根幹だった。
  // - **N 秒は話し手のリズムで調整するパラメータ。6 という数字は重要ではない。**
  //   岡田斗司夫（早口の解説系）でやっさんがテストした時に 6 がちょうどよかっただけ。
  //   児童のゆっくりめ発表なら 8〜10、早口の長文なら 3〜4 が適。
  //   既定 6 は「最初に試す値」程度の位置付け（CLAUDE.md ルール11、2回目の説明）。
  webspeechCommitSec: 6,
  // v0.13.31: 真の「改行」方式。interim を N 字単位にカットして新段落として流す。
  // recognition.stop() は呼ばない（言葉抜けゼロ）。0=OFF / 25 / 30 / 40。既定 30。
  // やっさんの当初の発言「バッファしながら指定文字数で改行 改行した時点で字幕を更新」
  // を文字通り実装したもの。v0.13.30 の「stop()で final 化」誤翻訳の正しいやり直し。
  webspeechSliceChars: 30,
  // v0.13.31: 無音 stop。interim の中身が変化していない時間が N 秒続いたら stop() で強制 final 化。
  // 30 字未満で喋り終わった時、字幕に流れるまでの待ち時間を短縮するため。
  // v0.13.30 の誤発火（onresult タイミング判定）を、interim 中身比較で回避した改良版。
  // 0=OFF、min=0、max=10、既定 3 秒。
  webspeechSilenceStopSec: 3,
  // v0.14.1: Notion 連携。トークンは Notion の「コネクト」のアクセストークン
  // （旧称: インテグレーション / 内部インテグレーションシークレット）。
  // notionLastDataSourceId / Title は「前回の保存先」を覚えておくためのもの。
  // 保存先は毎回聞くが、前回の場所が最初から選ばれた状態で出る（やっさん指示）。
  notionToken: '',
  notionLastDataSourceId: '',
  notionLastDataSourceTitle: '',
  // v0.15.0: 録音日時を入れる日付プロパティ名。'' なら使わない（タイトルに日時が残る）
  notionLastDatePropName: '',
  // v0.15.0: 保存できたタブを自動で閉じる。進捗ダイアログのチェックと連動して記憶する
  notionAutoClose: false,
  // v0.16.0: 文字起こしに渡す文脈の既定値。新しいタブはこれを引き継いで始まる
  // （同じ講義を何度も録るので、毎回入力し直さずに済ませるため）
  defaultContextField: '',
  defaultContextSpeakers: '',
  defaultContextTerms: '',
  // v0.17.0: Gemini モードでも Web Speech を並走させ、確定までの間を未確定表示で埋める
  geminiLiveDisplay: true,
};
// v0.13.24: WEB_SPEECH_DEFAULTS（v0.13.9 「Web Speech 設定をデフォルトに戻す」
// ボタン用のリセット値）は UI 撤去済み（v0.13.23）に伴い削除。

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
  // v0.18.0: 無音位置で切るための状態
  silenceDetector: null,      // { silentMs(), db(), close() }
  liveLastActivityAt: 0,      // Web Speech が最後に「音声あり」を示した時刻 (v0.18.4)
  chunkStartedAt: 0,          // 今のチャンクを開始した時刻
  chunkStartedAtSilence: true,// 今のチャンクの「頭」が無音の切れ目だったか（録音開始直後は真）
  pendingChunkEdges: null,    // onstop に渡す { startsAtSilence, endsAtSilence }
  finalChunkPending: false,   // 停止時、最後のチャンクがまだ送り出されていない (v0.18.6)
  audioSeq: 0,                // 保管するチャンクの通し番号 (v0.19.0)

  sessions: [],
  activeId: null,
  activePane: 'pane-transcript',
  isSummarizing: false,

  // バックグラウンド録音: recordingSessionId は録音対象セッション。
  // activeId !== recordingSessionId の間は、文字起こしは bgTranscriptEl (detached) に流れる。
  recordingSessionId: null,
  bgTranscriptEl: null,

  // ミドル整形（短チャンクの遅延コンソリデーション）用
  isConsolidatingShortChunks: false,
  midChunkWatchdog: null,

  // 複数タブ選択（Ctrl+クリック=追加/除外、Shift+クリック=範囲選択、一括ドラッグ移動）
  selectedTabIds: new Set(),
  selectionAnchorId: null, // Shift+クリックの基準

  // v0.13.31: Web Speech interim slice（真の「改行」方式）の累積オフセット。
  // 1 つの認識単位（result index）の中で「すでに段落として流した文字数」。
  // final 到来時 / 録音停止 / onend で 0 にリセット。
  interimSliceOffset: 0,

  // v0.13.31 (Step4): 「無音 stop」用。interim の中身が変化していない時間が
  // N 秒続いたら recognition.stop() で強制 final 化＝字幕に流す。
  // v0.13.30 の誤発火（onresult 来ない時間ベース判定）の改良版で、
  // 「interim 文字列の中身を比較して、変化していない＝本当に止まっている」を判定。
  lastInterimText: '',
  webspeechSilenceStopTimer: null,
};

/**
 * 文字起こしの書き込み先コンテナを返す。
 * - 通常: els.confirmed（DOM）
 * - バックグラウンド録音中: 切り離された <div>（録音対象セッションの transcript HTML をロード済）
 */
function getWriteContainer() {
  if (!state.isRecording) return els.confirmed;
  if (!state.recordingSessionId || state.recordingSessionId === state.activeId) return els.confirmed;
  // BG mode
  if (!state.bgTranscriptEl) {
    const s = state.sessions.find(x => x.id === state.recordingSessionId);
    state.bgTranscriptEl = document.createElement('div');
    state.bgTranscriptEl.innerHTML = s?.transcript || '';
  }
  return state.bgTranscriptEl;
}

/** BG コンテナの innerHTML を録音対象セッションのデータへ書き戻す */
function syncBgToSession() {
  if (!state.bgTranscriptEl) return;
  const s = state.sessions.find(x => x.id === state.recordingSessionId);
  if (!s) return;
  s.transcript = state.bgTranscriptEl.innerHTML;
  s.updatedAt = Date.now();
}

/** BG モードか判定 */
function isBgRecording() {
  return state.isRecording && state.recordingSessionId && state.recordingSessionId !== state.activeId;
}

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
  btnQuickChat: document.getElementById('btn-quick-chat'),
  quickChatModal: document.getElementById('quick-chat-modal'),
  quickChatBody: document.querySelector('#quick-chat-modal .quick-chat-body'),
  quickChatMessages: document.getElementById('quick-chat-messages'),
  quickChatEmpty: document.getElementById('quick-chat-empty'),
  quickChatInput: document.getElementById('quick-chat-input'),
  btnQuickChatSend: document.getElementById('btn-quick-chat-send'),
  innerTabsContainer: document.getElementById('inner-tabs'),
  mainArea: document.getElementById('main-area'),
  titleBar: document.getElementById('title-bar'),
  titleDisplay: document.getElementById('title-display'),
  btnEditTitle: document.getElementById('btn-edit-title'),
  btnRegenTitle: document.getElementById('btn-regen-title'),
  btnCopyTitle: document.getElementById('btn-copy-title'),
  summaryDetailSelect: document.getElementById('summary-detail-select'),
  btnSummaryCombo: document.getElementById('btn-summary-combo'),
  btnRefineTranscript: document.getElementById('btn-refine-transcript'),
  emptyHint: document.getElementById('empty-hint'),
  settingsModal: document.getElementById('settings-modal'),
  btnNotionUpload: document.getElementById('btn-notion-upload'),
  notionPicker: document.getElementById('notion-picker'),
  notionPickerSummary: document.getElementById('notion-picker-summary'),
  notionPickerSelect: document.getElementById('notion-picker-select'),
  notionPickerError: document.getElementById('notion-picker-error'),
  btnNotionPickerOk: document.getElementById('btn-notion-picker-ok'),
  notionProgress: document.getElementById('notion-progress'),
  notionProgressTitle: document.getElementById('notion-progress-title'),
  notionProgressBody: document.getElementById('notion-progress-body'),
  notionProgressList: document.getElementById('notion-progress-list'),
  notionPickerDate: document.getElementById('notion-picker-date'),
  notionProgressFooter: document.getElementById('notion-progress-footer'),
  btnNotionCancel: document.getElementById('btn-notion-cancel'),
  notionAutoClose: document.getElementById('notion-auto-close'),
  notionAutoCloseRow: document.getElementById('notion-auto-close-row'),
  btnNotionCloseTabs: document.getElementById('btn-notion-close-tabs'),
  btnNotionKeepTabs: document.getElementById('btn-notion-keep-tabs'),
  btnContext: document.getElementById('btn-context'),
  contextModal: document.getElementById('context-modal'),
  inputContextField: document.getElementById('input-context-field'),
  inputContextSpeakers: document.getElementById('input-context-speakers'),
  inputContextTerms: document.getElementById('input-context-terms'),
  inputContextDefault: document.getElementById('input-context-default'),
  btnContextFromMemo: document.getElementById('btn-context-from-memo'),
  contextMemoResult: document.getElementById('context-memo-result'),
  btnContextSave: document.getElementById('btn-context-save'),
  autoContextBox: document.getElementById('auto-context-box'),
  btnContextAdoptAuto: document.getElementById('btn-context-adopt-auto'),
  notionSettingsGroup: document.getElementById('notion-settings-group'),
  inputNotionToken: document.getElementById('input-notion-token'),
  btnNotionTest: document.getElementById('btn-notion-test'),
  notionTestResult: document.getElementById('notion-test-result'),
  notionLastTarget: document.getElementById('notion-last-target'),
  btnNotionForget: document.getElementById('btn-notion-forget'),
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
  summaryDetailLow: document.getElementById('summary-detail-low'),
  summaryDetailMedium: document.getElementById('summary-detail-medium'),
  summaryDetailHigh: document.getElementById('summary-detail-high'),
  modeWebSpeech: document.getElementById('mode-webspeech'),
  modeGemini: document.getElementById('mode-gemini'),
  inputAudioDevice: document.getElementById('input-audio-device'),
  inputChunkSec: document.getElementById('input-chunk-sec'),
  inputSilenceCut: document.getElementById('input-silence-cut'),
  inputChunkMaxSec: document.getElementById('input-chunk-max-sec'),
  inputAudioBitrate: document.getElementById('input-audio-bitrate'),
  inputKeepRecording: document.getElementById('input-keep-recording'),
  inputAudioRetention: document.getElementById('input-audio-retention'),
  audioUsageText: document.getElementById('audio-usage-text'),
  btnClearAudio: document.getElementById('btn-clear-audio'),
  inputGeminiLiveDisplay: document.getElementById('input-gemini-live-display'),
  inputMinChunkBytes: document.getElementById('input-min-chunk-bytes'),
  // v0.13.24: 旧 v0.13.9 interim 設定 UI（input-webspeech-interim-debounce /
  // input-webspeech-interim-opacity / btn-webspeech-defaults）への els 参照は削除。
  // HTML から削除済み（v0.13.23）+ 機能本体撤去（v0.13.24）に伴い不要。
  inputWsCommitSec: document.getElementById('input-webspeech-commit-sec'),
  inputWsSliceChars: document.getElementById('input-webspeech-slice-chars'),
  inputWsSilenceStopSec: document.getElementById('input-webspeech-silence-stop-sec'),
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
  btnTabPrev: document.getElementById('btn-tab-prev'),
  btnTabNext: document.getElementById('btn-tab-next'),
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
  if (iconEl && typeof setIcon === 'function') setIcon(iconEl, isRec ? 'record-stop' : 'record', 18);
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
  //
  // v0.17.4: 以前は querySelector('h2') / querySelector('.p-body') で
  // **最初の1つずつ**しか見ていなかった。ところが setParagraphContent() は
  // 空行区切りごとに .p-body を作るので、1つの .paragraph の中に
  // h2 + .p-body + .p-body … と並ぶことがある。
  // その結果「見出しのある段落の2つ目以降の本文」が、画面には出ているのに
  // コピー・Notion 送信・要約の入力から**黙って消えていた**（やっさん発見）。
  // 子要素を順番に全部見る形に直す。
  const structured = Array.from(paragraphs)
    .map(p => {
      const parts = [];
      for (const child of p.children) {
        const t = (child.innerText || '').trim();
        if (!t) continue;                                  // 段落間のすき間 div 等
        parts.push(child.tagName === 'H2' ? `## ${t}` : t);
      }
      return parts.length ? parts.join('\n\n') : p.innerText.trim();
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
  // v0.14.2: Notion アップロードは拡張版のみ。HTML 版では押せないようにしておく
  if (els.btnNotionUpload) {
    const usable = notionIsAvailable();
    els.btnNotionUpload.disabled = !has || !usable;
    if (!usable) els.btnNotionUpload.title = 'Notion保存はChrome拡張版でのみ使えます';
  }
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

/* ───────── Web Speech 強制 commit タイマー (v0.13.14) ─────────
 * settings.webspeechCommitSec 秒ごとに recognition.stop() を呼び出して、
 * Web Speech に「ここまで」と区切らせる。stop() で現在の interim が final として
 * onresult に届き、appendRawChunk で transcript の新しい段落になる。
 * その後 onend が呼ばれ、既存の自動再起動ロジック（state.shouldAutoRestart）が
 * recognition を再 start するので、認識ループは継続する。
 *
 * Gemini Audio の audioChunkSec（MediaRecorder.stop → 再start）と対称的な仕組み。
 * 0 にすると WebSpeech 任せの既存挙動。岡田斗司夫みたいに長文を続けて喋る人で
 * final が遅れて字幕がドカっと出るのを防ぐためのコア機能。
 */
function restartWebSpeechCommitTimer() {
  stopWebSpeechCommitTimer();
  const sec = Number(state.settings.webspeechCommitSec || 0);
  if (sec <= 0) return; // OFF
  const intervalMs = Math.max(2, Math.min(20, sec)) * 1000;
  state.webspeechCommitTimer = setInterval(() => {
    if (!state.isRecording) return;
    if (state.settings.inputMode !== 'web-speech') return;
    if (!state.recognition) return;
    try {
      // stop() を呼ぶと Web Speech が現在の interim を final として吐き出し、
      // 続いて onend が走る → 既存の自動再起動ロジックで rec.start() が走る。
      state.recognition.stop();
      diagLog.info(`Web Speech 強制 commit (${sec}秒)`);
    } catch (e) {
      console.warn('webspeech commit stop failed', e);
    }
  }, intervalMs);
}
function stopWebSpeechCommitTimer() {
  if (state.webspeechCommitTimer) {
    clearInterval(state.webspeechCommitTimer);
    state.webspeechCommitTimer = null;
  }
}

/* ───────── Web Speech 無音 stop タイマー (v0.13.31) ─────────
 * onresult 内で「interim の中身が変化したとき」だけリセット&セット。
 * 同じ interim のまま N 秒経つ＝本当に喋りが止まっている＝stop() で final 化。
 * 30 字 slice に達しない短い発話を、6 秒（webspeechCommitSec）待たずに字幕へ流す。
 * v0.13.30 の「onresult が N 秒来なかったら判定」は誤発火多発で revert。
 * 今回は中身比較なので、Web Speech が interim を更新中（喋り中）は誤発火しない。
 */
function resetWebSpeechSilenceStopTimer() {
  stopWebSpeechSilenceStopTimer();
  const sec = Number(state.settings.webspeechSilenceStopSec || 0);
  if (sec <= 0) return;
  state.webspeechSilenceStopTimer = setTimeout(() => {
    state.webspeechSilenceStopTimer = null;
    if (!state.isRecording) return;
    if (state.settings.inputMode !== 'web-speech') return;
    if (!state.recognition) return;
    if (!state.lastInterimText) return; // 既に final 済みなら何もしない
    try {
      state.recognition.stop();
      diagLog.info(`Web Speech 無音 stop (${sec}秒、interim ${state.lastInterimText.length}字)`);
    } catch (e) {
      console.warn('webspeech silence stop failed', e);
    }
  }, sec * 1000);
}
function stopWebSpeechSilenceStopTimer() {
  if (state.webspeechSilenceStopTimer) {
    clearTimeout(state.webspeechSilenceStopTimer);
    state.webspeechSilenceStopTimer = null;
  }
}

// v0.13.24: v0.13.9 で追加した interim ライブ表示の機能本体（scheduleInterimSync /
// _writeLiveInterim / LIVE_INTERIM_KEY / _interimSyncTimer / _pendingInterim）は撤去。
// v0.13.17 で字幕ウィンドウ側の cap-para-interim 撤去 = 読み手なし、
// v0.13.23 で UI 撤去 = 設定経路なし。app.js 側だけ残しても呼び出し元が無く意味なし。
// 機能撤去のトリガは「読み手なし」のコード整合性チェック（CLAUDE.md ルール12 学び）。

/* ───────── 字幕用バッファ (v0.13.31 完全分離型) ─────────
 * やっさん発「文字起こしウィンドウに表示されるものと、字幕に表示されるものは別にしてほしい。
 *   字幕に表示される内容＝バッファだからいけるよね？」の実装。
 *
 * - 文字起こしペイン (transcript HTML)：自然 final 単位で段落追加（appendRawChunk、v0.13.16 の元の挙動）
 * - 字幕ウィンドウ／オーバーレイ：30 字 slice 単位で段落追加（appendCaptionSlice、新規）
 * - AI 整形は文字起こしペイン側だけ。字幕は生テキスト（即時性優先）。
 *   字幕を整形したい用途は Gemini Audio モードを使う。
 *
 * localStorage キー：dictation:liveCaption（最新 N 件、JSON 配列）。
 * captions.js が監視して、存在すれば字幕表示に優先反映。
 */
const CAPTION_BUFFER_KEY = 'dictation:liveCaption';
const CAPTION_BUFFER_MAX = 10; // 最新 10 段落保持（captions.js の paraCount=2 より十分大きい）

function appendCaptionSlice(text) {
  if (!text) return;
  let buf = [];
  try { buf = JSON.parse(localStorage.getItem(CAPTION_BUFFER_KEY) || '[]'); } catch {}
  if (!Array.isArray(buf)) buf = [];
  buf.push({ text: String(text), ts: Date.now() });
  if (buf.length > CAPTION_BUFFER_MAX) buf = buf.slice(-CAPTION_BUFFER_MAX);
  try { localStorage.setItem(CAPTION_BUFFER_KEY, JSON.stringify(buf)); } catch (e) {
    console.warn('appendCaptionSlice persist failed', e);
  }
}

function clearCaptionBuffer() {
  try { localStorage.removeItem(CAPTION_BUFFER_KEY); } catch {}
}

function appendRawChunk(text) {
  if (!text || !text.trim()) return;
  const container = getWriteContainer();
  const inBg = container !== els.confirmed;
  if (!inBg) hideEmptyHint();
  // v0.13.16: Web Speech モードでは final（確定）が来るたびに新しい段落を作る。
  // 旧来は同じ pendingChunkEl にスペースで連結し続けてベタ書き状態になり、
  // 字幕（最新N段落）に長文がドカっと出る原因だった。
  // Web Speech が「ここで一区切り」と自分で判断して final を出すタイミングは
  // 自然な発話の切れ目なので、それを段落区切りとして尊重する。
  // Gemini Audio の 6 秒チャンク = 1 段落、と対称的な構造になる。
  const forceNewPara = state.settings.inputMode === 'web-speech';
  if (forceNewPara || !state.pendingChunkEl || !container.contains(state.pendingChunkEl)) {
    // v0.13.31: Web Speech モードの final 毎段落にも .short-refined と dataset.shortTs を付与。
    // これでショート整形（flushPendingToGemini）が即発火対象になり、ミドル整形
    // （consolidateShortChunks）も .short-refined を拾って 3 段落単位で統合・見出し付与する。
    // やっさん発「喋り通しても整形されるように、final のチャンクに合わせて整形」の実装。
    const klass = forceNewPara ? 'paragraph raw short-refined' : 'paragraph raw';
    state.pendingChunkEl = createParagraphEl(text, klass);
    if (forceNewPara) state.pendingChunkEl.dataset.shortTs = String(Date.now());
    container.appendChild(state.pendingChunkEl);
    state.pendingChunkText = text;
  } else {
    state.pendingChunkText += ' ' + text;
    const body = state.pendingChunkEl.querySelector('.p-body');
    if (body) body.textContent = state.pendingChunkText;
  }
  if (inBg) {
    syncBgToSession();
  } else {
    autoScroll();
    // v0.13.19: 通常 active 録音時は、DOM の最新 paragraph を state.sessions[active].transcript
    // に同期する必要がある（syncBgToSession は BG 時のみで対称性が抜けていた）。
    // これがないと v0.13.18 で persist しても古い transcript が localStorage に書かれて
    // 字幕ウィンドウに反映されない（ブロック溜まり一気流れ症状）。
    // fromAutosave: true でタイピング Undo の baseline 同期はスキップする
    // （録音中の baseline 更新は別経路で管理するため、ここで上書きしない）。
    snapshotActiveToSession({ fromAutosave: true });
  }
  updateActionButtons();
  // v0.13.18: final ごとに localStorage に persist。
  // 旧来は appendRawChunk で persist しておらず、別タイミング（autoSave 等）で
  // まとめて persist されていたため、字幕ウィンドウへの伝達が遅延し、
  // 「ブロックが溜まってから一気に流れる」症状が出ていた。
  // Gemini Audio は sendAudioChunkToGemini 内で persist しているので問題なかった。
  persistSessions();
  // v0.13.31: Web Speech final 毎にショート整形を即発火（無音 3 秒待ちじゃない）。
  // やっさん発「岡田斗司夫を喋り通しても整形されるように、final のチャンクに合わせて整形」の実装。
  // flushPendingToGemini は state.pendingChunkEl をローカルに退避してから state を null クリア
  // するので、次の appendRawChunk 呼び出しと競合しない。
  // 喋りが速くて整形が追いつかない場合は、未整形段落が .short-refined のまま残り、
  // 既存のミドル整形（maybeConsolidateShortChunks、3 段落 or 60 秒）が拾って統合・見出し付け。
  if (
    state.settings.inputMode === 'web-speech' &&
    state.settings.aiEnabled &&
    state.settings.apiKey
  ) {
    flushPendingToGemini();
  }
}

function getContextForGemini() {
  // 録音対象コンテナから直近の整形済み3段落を使う（BG録音中はBG側から）
  const container = getWriteContainer();
  const paragraphs = container.querySelectorAll('.paragraph:not(.raw):not(.refining)');
  const last = Array.from(paragraphs).slice(-3);
  return last.map(p => p.innerText.trim()).filter(Boolean).join('\n\n');
}

async function flushPendingToGemini() {
  if (!state.pendingChunkEl || !state.pendingChunkText.trim()) return;

  const targetEl = state.pendingChunkEl;
  const rawText = state.pendingChunkText.trim();
  state.pendingChunkEl = null;
  state.pendingChunkText = '';

  // 書き込み先がBG（detached）か els.confirmed かで、永続化手段が異なる
  const inBg = state.bgTranscriptEl && state.bgTranscriptEl.contains(targetEl);
  const persist = () => {
    if (inBg) syncBgToSession();
    else snapshotActiveToSession();
    persistSessions();
  };

  if (!state.settings.aiEnabled || !state.settings.apiKey) {
    targetEl.className = 'paragraph';
    setParagraphContent(targetEl, rawText);
    persist();
    return;
  }

  targetEl.className = 'paragraph refining';

  try {
    const refined = await refineWithGemini({
      apiKey: state.settings.apiKey,
      sessionContext: getSessionContextForAi(),
      context: getContextForGemini(),
      newChunk: rawText,
    });
    targetEl.className = 'paragraph refined';
    setParagraphContent(targetEl, refined || rawText);
    updateActionButtons();
    persist();
  } catch (e) {
    console.warn('[refine] skipped (marked for retry):', e.message || e);
    targetEl.className = 'paragraph needs-retry';
    setParagraphContent(targetEl, rawText);
    persist();
  } finally {
    if (!inBg) autoScroll();
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

  // 破壊的操作: Undo スナップショットを取る（force 指定時のみ、つまり手動クリック時）
  if (force) pushUndo('貼付けテキスト整形', 'pane-transcript');

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
      sessionContext: getSessionContextForAi(),
      context: getContextForGemini(),
      newChunk: rawText,
    });
    targetEl.className = 'paragraph refined';
    setParagraphContent(targetEl, refined || rawText);
    snapshotActiveToSession();
    persistSessions();
  } catch (e) {
    // 貼り付け整形の失敗も needs-retry マークして、後で再試行可能に
    console.warn('[refine pasted] skipped (marked for retry):', e.message || e);
    targetEl.className = 'paragraph needs-retry';
    setParagraphContent(targetEl, rawText);
    snapshotActiveToSession();
    persistSessions();
  } finally {
    updateActionButtons();
    autoScroll();
  }
}

/**
 * 過去に整形失敗した .paragraph.needs-retry をまとめて再試行する。
 * 「今すぐ整形」ボタン押下時に呼ばれる。
 */
async function retryPendingRefinements({ showFeedback = true } = {}) {
  if (!state.settings.apiKey) return { tried: 0, ok: 0, failed: 0 };
  const pending = Array.from(els.confirmed.querySelectorAll('.paragraph.needs-retry'));
  if (pending.length === 0) return { tried: 0, ok: 0, failed: 0 };
  let ok = 0, failed = 0;
  for (const p of pending) {
    const rawText = p.innerText.trim();
    if (!rawText) { p.remove(); continue; }
    p.className = 'paragraph refining';
    try {
      const refined = await refineWithGemini({
        apiKey: state.settings.apiKey,
        sessionContext: getSessionContextForAi(),
        context: getContextForGemini(),
        newChunk: rawText,
      });
      p.className = 'paragraph refined';
      setParagraphContent(p, refined || rawText);
      ok++;
    } catch (e) {
      console.warn('[retry refine] still failing:', e.message || e);
      p.className = 'paragraph needs-retry';
      setParagraphContent(p, rawText);
      failed++;
    }
  }
  snapshotActiveToSession();
  persistSessions();
  updateActionButtons();
  autoScroll();
  if (showFeedback && failed > 0) {
    setStatus('error', `${failed}件の整形は失敗（後でまた再試行可）`);
    setTimeout(() => {
      if (state.isRecording) setStatus('listening', '録音中');
      else setStatus('idle', '停止');
    }, 4000);
  }
  return { tried: pending.length, ok, failed };
}

/**
 * 全文字起こしを丸ごと文脈付き再整形＋見出し付与（「今すぐ整形」ボタン本体が呼ぶ）。
 * 現状が「既に整形済み」「短チャンクだけ」「needs-retry混在」のどれであっても、
 * 上から下までまとめて Gemini に送り直して 1つの整った文書として再構築する。
 * ミドル整形を全体に拡張した版。
 */
async function refineWholeTranscript({ showFeedback = true } = {}) {
  if (!state.settings.apiKey) {
    if (showFeedback) { alert('Gemini API キーが未設定です'); openSettings(); }
    return;
  }

  const container = getWriteContainer();
  const paragraphs = Array.from(container.querySelectorAll('.paragraph'));

  // 1つの .paragraph に複数の h2+p-body が入れ子になっている場合がある
  // （setParagraphContent が refined テキストの "## A\n\nA本文\n\n## B\n\nB本文" を
  //  全部同じ paragraph に展開する仕様のため）。
  // querySelector('h2') だと先頭1つしか取れず、残りを丸ごとロストする。
  // 全子要素を走査して h2/.p-body/その他 を順序通りに並べ直す。
  let allText = paragraphs.map(p => {
    const parts = [];
    for (const child of p.children) {
      const t = (child.textContent || '').trim();
      if (!t) continue;
      if (child.tagName === 'H2') parts.push('## ' + t);
      else parts.push(t);
    }
    if (parts.length === 0) {
      return (p.innerText || p.textContent || '').trim();
    }
    return parts.join('\n\n');
  }).filter(Boolean).join('\n\n');

  // パラグラフに入っていない生テキストも拾う
  const unstructured = Array.from(container.childNodes).filter(n => {
    if (n.nodeType === Node.TEXT_NODE) return !!n.textContent.trim();
    if (n.nodeType === Node.ELEMENT_NODE) return !n.classList || !n.classList.contains('paragraph');
    return false;
  }).map(n => (n.nodeType === Node.TEXT_NODE ? n.textContent : (n.innerText || n.textContent || '')).trim())
    .filter(Boolean).join('\n\n');
  if (unstructured) allText = (allText ? allText + '\n\n' : '') + unstructured;

  if (!allText.trim()) {
    if (showFeedback) setStatus('idle', '整形対象のテキストがありません');
    return;
  }

  // 常時確認ダイアログ（破壊的操作。Undoで戻せる旨も明記）
  const lengthStr = allText.length.toLocaleString();
  const willChunk = allText.length > 5000;
  const chunkNote = willChunk
    ? `\n\n⚠️ 長文のため、段落境界で分割して順次整形します（約${Math.ceil(allText.length / 3000)}チャンク、各 3000字 目安）。`
    : '';
  if (!confirm(
    `現在の文字起こし ${lengthStr} 文字を、見出し付きで再整形します。\n` +
    `既存のパラグラフ構造は置き換わります。${chunkNote}\n\n` +
    `もし結果がおかしければ「戻す」（Ctrl+Z）で元に戻せます。\n\n` +
    `続けますか？`
  )) return;

  // 破壊的操作なので Undo スナップショット
  pushUndo('全体整形', 'pane-transcript');

  // 全部消して refining プレースホルダを置く
  paragraphs.forEach(p => p.remove());
  Array.from(container.childNodes).forEach(n => {
    if (n.nodeType === Node.TEXT_NODE) n.remove();
    else if (n.nodeType === Node.ELEMENT_NODE && !n.classList.contains('paragraph')) n.remove();
  });
  const target = createParagraphEl('（全体整形中… しばらくお待ちください）', 'paragraph refining');
  container.appendChild(target);

  const inBg = container !== els.confirmed;
  const persist = () => {
    if (inBg) syncBgToSession();
    else snapshotActiveToSession();
    persistSessions();
  };
  if (inBg) syncBgToSession(); else autoScroll();
  diagLog.info(`全体整形開始: ${allText.length}字${willChunk ? '（チャンク分割）' : ''}`);

  try {
    let refined;
    if (willChunk) {
      refined = await refineByChunks(allText, target);
    } else {
      refined = await refineWithGemini({
        apiKey: state.settings.apiKey,
        sessionContext: getSessionContextForAi(),
        context: '',
        newChunk: allText,
        maxOutputTokens: 8192,
      });
    }
    target.className = 'paragraph refined';
    setParagraphContent(target, refined || allText);
    persist();
    diagLog.info(`全体整形完了: ${(refined || allText).length}字`);
    if (!inBg) { updateActionButtons(); autoScroll(); }
  } catch (e) {
    console.warn('[refine whole] failed:', e.message || e);
    target.className = 'paragraph needs-retry';
    setParagraphContent(target, allText);
    persist();
    if (showFeedback) {
      setStatus('error', '全体整形失敗: ' + (e.message || '').slice(0, 60));
      setTimeout(() => setStatus(state.isRecording ? 'listening' : 'idle',
                                  state.isRecording ? '録音中' : '停止'), 4000);
    }
  }
}

/**
 * 長文を段落境界（\n\n）で約3000字のチャンクに分け、
 * 順次 Gemini で整形。直前チャンクの末尾を context に渡して文脈連続を保つ。
 * 出力切れ（maxOutputTokens超過）を確実に回避。
 */
async function refineByChunks(fullText, progressTargetEl) {
  const CHUNK_SIZE = 3000;
  const paragraphs = fullText.split(/\n\n+/);
  // まず段落を束ねて ~CHUNK_SIZE のブロックにする
  const blocks = [];
  let buf = '';
  for (const p of paragraphs) {
    if (buf.length + p.length + 2 > CHUNK_SIZE && buf.length > 0) {
      blocks.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf) blocks.push(buf);

  const results = [];
  let prevTail = '';
  for (let i = 0; i < blocks.length; i++) {
    diagLog.info(`全体整形: チャンク ${i + 1}/${blocks.length} (${blocks[i].length}字)`);
    if (progressTargetEl) {
      const body = progressTargetEl.querySelector('.p-body');
      if (body) body.textContent = `（全体整形中… ${i + 1}/${blocks.length}チャンク処理中）`;
    }
    try {
      const out = await refineWithGemini({
        apiKey: state.settings.apiKey,
        sessionContext: getSessionContextForAi(),
        context: prevTail.slice(-500),  // 直前チャンクの末尾500字だけ文脈として
        newChunk: blocks[i],
        maxOutputTokens: 4096,           // チャンク単位なので 4k で十分
      });
      const outClean = (out || blocks[i]).trim();
      results.push(outClean);
      prevTail = outClean;
    } catch (e) {
      console.warn(`[refine chunk ${i + 1}] failed:`, e.message || e);
      // チャンクが失敗したら原文をそのまま入れて次へ
      results.push(blocks[i]);
      prevTail = blocks[i];
    }
  }
  return results.join('\n\n');
}

/* ───────── ミドル整形（短チャンクを蓄積→文脈込みで再整形＋見出し付与） ─────────
 * Geminiオーディオ録音の短チャンクは個別に文字起こしされるが、見出しが付かず
 * 誤字が残ることがある。3段落溜まるか 60秒経ったら refineWithGemini で
 * 文脈込みに統合 + 見出し追加 で整形しなおす。 */

const MID_CHUNK_THRESHOLD = 3;      // 何段落溜まったら発火
const MID_TIME_THRESHOLD_MS = 60000; // 最初の短チャンクから何ms経ったら発火

/**
 * 送信中の音声チャンクが全部確定するまで黙って待つ (v0.18.6)
 *
 * 停止直後の最終整形が、**最後のチャンクの到着を待たずに**走っていた。
 * 実機ログ:
 *   18:34:35 録音停止
 *   18:34:36 ミドル整形開始 2段落      ← まだ2つしか届いていない
 *   18:34:36 音声チャンク送信 6.9秒    ← 最後のチャンクはこの後
 * 結果、最後の段落だけが繋ぎ直しの対象から漏れ、文の途中で切れたまま残っていた。
 *
 * ensureTranscriptSettled() は確認ダイアログを出す対話用なので、ここでは使えない。
 *
 * recorder.stop() から onstop までは非同期なので、カウンタが増える前に見にいくと
 * 「0件」と誤認する。finalChunkPending でその隙間を埋める。
 */
async function waitForAudioSettled(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while ((state.finalChunkPending || state.audioInFlightCount > 0) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (state.finalChunkPending || state.audioInFlightCount > 0) {
    diagLog.info(`確定待ちが${(timeoutMs / 1000)}秒で時間切れ`
      + `（残り${state.audioInFlightCount}件）。そのまま整形に進みます`);
  }
  state.finalChunkPending = false;
}

function maybeConsolidateShortChunks() {
  if (state.isConsolidatingShortChunks) return; // 多重実行防止
  if (!state.settings.aiEnabled || !state.settings.apiKey) return;
  // v0.18.9: 停止処理中は、最後のチャンクまで揃えてから一度にまとめたい。
  // ここで先に発火すると、最後の1つが取り残されて別立てで整形される:
  //   19:00:07 ミドル整形開始 3段落・224字   ← 3つ溜まって発火
  //   19:00:09 ミドル整形開始 1段落・5字     ← 最後の1つだけ
  // 分かれると、境界をまたいだ文を繋ぎ直せないうえ、呼び出しも1回余計になる。
  // 停止処理の最後で consolidateShortChunks が全部まとめて呼ばれる
  if (!state.isRecording && (state.finalChunkPending || state.audioInFlightCount > 0)) return;
  const container = getWriteContainer();
  if (!container) return;
  const shortParas = Array.from(container.querySelectorAll('.paragraph.short-refined'));
  if (shortParas.length === 0) return;

  const firstTs = parseInt(shortParas[0].dataset.shortTs || '0', 10);
  const elapsed = firstTs ? Date.now() - firstTs : 0;

  if (shortParas.length < MID_CHUNK_THRESHOLD && elapsed < MID_TIME_THRESHOLD_MS) return;

  consolidateShortChunks(shortParas);
}

async function consolidateShortChunks(shortParas) {
  if (!shortParas || shortParas.length === 0) return;
  state.isConsolidatingShortChunks = true;
  const container = shortParas[0].parentElement;
  const inBg = container !== els.confirmed;

  const firstPara = shortParas[0];
  const rawText = shortParas.map(p => p.innerText.trim()).filter(Boolean).join('\n\n');

  // 先頭を refining に、2つ目以降は削除
  firstPara.className = 'paragraph refining';
  setParagraphContent(firstPara, '（文脈整形中…）');
  for (let i = 1; i < shortParas.length; i++) {
    shortParas[i].remove();
  }
  if (inBg) syncBgToSession(); else snapshotActiveToSession();
  persistSessions();

  diagLog.info(`ミドル整形開始 ${shortParas.length}段落・${rawText.length}字`);

  try {
    const refined = await refineWithGemini({
      apiKey: state.settings.apiKey,
      sessionContext: getSessionContextForAi(),
      context: getContextForGemini(),
      newChunk: rawText,
      // v0.17.2: ここに集まるのは同じ発話を機械的に切った断片の並び。
      // 文の途中で切れているものを繋ぎ直させる
      joinFragments: true,
    });
    firstPara.className = 'paragraph refined';
    setParagraphContent(firstPara, refined || rawText);
    diagLog.info(`ミドル整形完了 → ${(refined || rawText).length}字`);
  } catch (e) {
    console.warn('[consolidate] failed:', e.message || e);
    firstPara.className = 'paragraph needs-retry';
    setParagraphContent(firstPara, rawText);
  } finally {
    state.isConsolidatingShortChunks = false;
    if (inBg) syncBgToSession(); else snapshotActiveToSession();
    persistSessions();
    if (!inBg) { updateActionButtons(); autoScroll(); }
    // 途中でさらに短チャンクが溜まっていれば再度チェック
    setTimeout(maybeConsolidateShortChunks, 50);
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
  state.longSilenceTimer = null;
  // v0.13.28: 録音停止中は無音検出ダイアログを起動しない。
  // 旧来は onresult が録音停止後に遅れて発火した時など、停止後に
  // タイマーが再起動されて「録音停止中なのに無音ダイアログが出る」
  // 症状があった（やっさん指摘）。「録音中にもかかわらず文字が出ない」
  // 場合のみ出すのが正しい挙動。
  if (!state.isRecording) return;
  if (!state.settings.autoStopEnabled) return;
  state.longSilenceTimer = setTimeout(() => {
    state.longSilenceTimer = null;
    if (!state.isRecording) return; // タイマー発火時の二重防御
    showSilenceDialog();
  }, state.settings.autoStopSec * 1000);
}

function clearAllTimers() {
  if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
  if (state.longSilenceTimer) { clearTimeout(state.longSilenceTimer); state.longSilenceTimer = null; }
  if (state.silenceCountdownTimer) { clearInterval(state.silenceCountdownTimer); state.silenceCountdownTimer = null; }
}

function showSilenceDialog() {
  // v0.13.28: 三重防御。録音停止中は絶対に出さない。
  if (!state.isRecording) return;
  diagLog.info(`無音停止ダイアログ発火（${state.settings.autoStopSec}秒無音と判定）`);
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
    // v0.13.31 完全分離型：
    // - 文字起こしペイン (transcript HTML)：**自然 final** が来たら appendRawChunk で
    //   1 段落追加（v0.13.16 の元の挙動）。slice では transcript に書かない。
    // - 字幕ウィンドウ／オーバーレイ：interim を **30 字 slice 単位** で字幕用バッファ
    //   (dictation:liveCaption) に append。recognition.stop() は呼ばない＝言葉抜けゼロ。
    // - state.interimSliceOffset は「現在の result 内で字幕バッファに既に流した文字数」
    //   を覚えるためだけに使う（transcript への影響なし）。
    const sliceN = Number(state.settings.webspeechSliceChars || 0);
    let interim = '';
    let gotFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) {
        // 文字起こしペインには **自然 final 全文** を 1 段落として追加（25 字単位の細切れではない）
        appendRawChunk(text);
        // 字幕バッファには「offset 以降の残り」だけを 1 段落として追加（既に流した分は重複させない）
        if (sliceN > 0) {
          const offset = state.interimSliceOffset || 0;
          const remaining = offset > 0 ? text.slice(offset) : text;
          if (remaining) appendCaptionSlice(remaining);
        }
        state.interimSliceOffset = 0; // 次の result の頭から数え直す
        gotFinal = true;
      } else {
        interim += text;
        // 字幕バッファに 30 字 slice 単位で append（transcript には書かない）
        if (sliceN > 0) {
          let cursor = state.interimSliceOffset || 0;
          while (text.length - cursor >= sliceN) {
            const chunk = text.slice(cursor, cursor + sliceN);
            appendCaptionSlice(chunk);
            cursor += sliceN;
            diagLog.info(`字幕バッファ slice (${sliceN}字)`);
          }
          state.interimSliceOffset = cursor;
        }
      }
    }
    // 文字起こしペインの interim 表示は累積 interim をそのまま（slice を transcript に書いていないので重複なし）
    const interimForDisplay = interim;
    // BG録音中（録音対象セッションが非表示）は共有の#interimに書かない。
    // 書くと別セッション（表示中のタブ）の文字起こしエリアに漏れて見える。
    if (isBgRecording()) {
      els.interim.textContent = '';
    } else {
      els.interim.textContent = interimForDisplay;
      if (interim || gotFinal) hideEmptyHint();
      if (gotFinal || interim) autoScroll();
    }
    if (gotFinal || interim) {
      resetSilenceTimer();
      resetLongSilenceTimer();
      if (els.silenceDialog && !els.silenceDialog.classList.contains('hidden')) {
        hideSilenceDialog();
      }
    }
    // v0.13.31: 無音 stop。interim の「中身」が変化したときだけタイマーをリセット&セット。
    // 同じ interim のまま N 秒 = 本当に喋りが止まっている → stop() で final 化。
    // v0.13.30 の「onresult タイミング判定」は喋り中も onresult が空く瞬間があって誤発火していた。
    // 中身比較なら Web Speech が interim を更新し続ける限り（喋り中）は誤発火しない。
    if (interim && interim !== state.lastInterimText) {
      state.lastInterimText = interim;
      resetWebSpeechSilenceStopTimer();
    }
    if (gotFinal) {
      // final が来たら interim 文字列はリセット。次の発話を待つためタイマーも停止。
      state.lastInterimText = '';
      stopWebSpeechSilenceStopTimer();
    }
  };

  rec.onerror = (event) => {
    const err = event.error;
    if (err === 'no-speech') return;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      // マイク拒否: 完全停止
      console.error('SpeechRecognition error:', err);
      setStatus('error', 'マイク拒否');
      state.shouldAutoRestart = false;
      state.isRecording = false;
      setRecordingUI(false);
      showMicDeniedGuide(err);
      return;
    }
    if (err === 'network' || err === 'aborted' || err === 'audio-capture') {
      // 過渡的エラー: 赤バナーは出さず、diagLogに記録。onendで自動再接続が走る。
      // Chromeは長時間録音で約5分ごとに 'network' を返すことがある既知仕様。
      diagLog.info(`SpeechRecognition 過渡エラー(${err}) → 自動再接続待ち`);
      return;
    }
    // その他の未知エラーだけ赤バナー表示
    console.error('SpeechRecognition error:', err);
    setStatus('error', `エラー: ${err}`);
  };

  rec.onend = () => {
    els.interim.textContent = '';
    // v0.13.31: interim slice オフセットを 0 リセット。
    // network エラー等で onend が走った時、再 start 後の result index は新しいので
    // 古いオフセットを残すと slice が壊れる。
    state.interimSliceOffset = 0;
    // v0.13.31: 無音 stop タイマーと比較バッファもリセット。
    state.lastInterimText = '';
    stopWebSpeechSilenceStopTimer();
    if (state.shouldAutoRestart && state.isRecording) {
      // 即再start()は失敗しやすいので、少し遅延してからリトライ
      const tryRestart = (attempt = 0) => {
        if (!state.isRecording) return;
        try {
          rec.start();
          if (attempt > 0) diagLog.info(`SpeechRecognition 再接続成功 (attempt=${attempt + 1})`);
        } catch (e) {
          if (attempt < 4 && state.isRecording) {
            // 指数バックオフ: 200ms → 400ms → 800ms → 1600ms
            const delay = 200 * Math.pow(2, attempt);
            diagLog.info(`SpeechRecognition 再接続リトライ ${attempt + 1} in ${delay}ms (${e.message || e.name || 'error'})`);
            setTimeout(() => tryRestart(attempt + 1), delay);
          } else {
            diagLog.info(`SpeechRecognition 再接続失敗（上限到達）`);
            console.error('SpeechRecognition restart failed:', e);
            setStatus('error', '再接続失敗');
          }
        }
      };
      // 少しだけ待ってから再スタート（連続start()でのInvalidStateErrorを避ける）
      setTimeout(() => tryRestart(0), 120);
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

/** 録音中、一定間隔で文脈を拾い直すタイマー (v0.16.1) */
function startContextExtractTimer() {
  stopContextExtractTimer();
  // 起動直後は記録が短くて意味がないので、最初の実行も間隔ぶん待つ
  state.contextExtractTimer = setInterval(() => { refreshAutoContext(); }, 30 * 1000);
}
function stopContextExtractTimer() {
  if (state.contextExtractTimer) {
    clearInterval(state.contextExtractTimer);
    state.contextExtractTimer = null;
  }
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
  state.recordingSessionId = state.activeId; // BG録音用に固定
  diagLog.info(`録音開始 (Web Speech) session=${state.recordingSessionId?.slice(-6)} commitSec=${state.settings.webspeechCommitSec || 0}`);
  try {
    state.recognition.start();
    setRecordingUI(true);
    startContextExtractTimer();   // v0.16.1
    resetLongSilenceTimer();
    // v0.13.14: Web Speech 強制 commit タイマーを起動（commitSec=0 なら何もしない）
    restartWebSpeechCommitTimer();
  } catch (e) {
    console.error('start failed', e);
    setStatus('error', '開始失敗: ' + e.message);
    state.isRecording = false;
    state.shouldAutoRestart = false;
    state.recordingSessionId = null;
    setRecordingUI(false);
  }
}

function stopRecording() {
  // 停止処理 = 「録音対象セッション（recordingSessionId）」に対して行う。
  // 現在のactiveIdはBG録音でズレている可能性があるので固定して使う。
  const recSessionId = state.recordingSessionId || state.activeId;
  diagLog.info(`録音停止 session=${recSessionId?.slice(-6)}`);
  state.isRecording = false;
  state.shouldAutoRestart = false;
  if (state.midChunkWatchdog) { clearInterval(state.midChunkWatchdog); state.midChunkWatchdog = null; }
  if (state.settings.inputMode === 'gemini-audio') {
    stopLiveDisplay();          // v0.17.0
    stopGeminiAudioRecording();
  } else {
    // v0.13.14: 強制 commit タイマーを止めてから recognition を止める
    stopWebSpeechCommitTimer();
    // v0.13.31: 無音 stop タイマーも停止
    stopWebSpeechSilenceStopTimer();
    state.lastInterimText = '';
    // v0.13.31: 字幕バッファをクリア（次の録音開始時に過去の slice が混ざらないように）
    clearCaptionBuffer();
    if (state.recognition) {
      try { state.recognition.stop(); } catch {}
    }
    els.interim.textContent = '';
  }
  setStatus('idle', '停止');
  setRecordingUI(false);
  // v0.16.1: 文脈の自動抽出を止め、最後の内容で1回だけ更新しておく
  // （次にこのタブで録音を再開したとき、いきなり文脈が効く）
  stopContextExtractTimer();
  refreshAutoContext({ force: true });
  clearAllTimers();
  flushPendingToGemini().finally(async () => {
    // v0.18.6: 最後のチャンクが届く前に整形を始めると、その段落だけが
    // 繋ぎ直しの対象から漏れる（文の途中で切れたまま残る）
    await waitForAudioSettled();
    // 録音停止時に、残っている short-refined パラグラフを強制的に
    // ミドル整形（refineWithGemini で見出し付け＋文脈統合）してからサマリ化
    const container = (state.bgTranscriptEl && recSessionId !== state.activeId)
      ? state.bgTranscriptEl : els.confirmed;
    const remainingShort = Array.from(container.querySelectorAll('.paragraph.short-refined'));
    if (remainingShort.length > 0 && state.settings.aiEnabled && state.settings.apiKey) {
      await consolidateShortChunks(remainingShort);
    }
    // BGモードの場合、flushPendingToGemini は bgTranscriptEl に書き込んだ後 syncBgToSession で
    // session.transcript に反映済み。foreground なら snapshot が必要。
    const inBgAtEnd = state.bgTranscriptEl && recSessionId !== state.activeId;
    if (inBgAtEnd) {
      syncBgToSession();
      state.bgTranscriptEl = null;
    } else {
      snapshotActiveToSession();
    }
    state.recordingSessionId = null;
    persistSessions();
    renderTabs(); // 録音中の赤線消去
    if (state.settings.autoSummarize && state.settings.aiEnabled && state.settings.apiKey) {
      await generateSummary({ silent: true, sessionId: recSessionId });
      await autoGenerateTitle({ sessionId: recSessionId });
    }
  });
}

/* ───────── Gemini Audio recording mode ───────── */

/* ───────── 無音検出（v0.18.0）─────────
 *
 * v0.17 まで、Gemini へ送るチャンクは setInterval で 12 秒ちょうどに切っていた。
 * 喋っている真っ最中だろうと問答無用で切るので、
 *
 *   「実害 | はないので大丈夫ですが」   ← 単語の途中で切れる
 *
 * が普通に起きる。ここから v0.17.1（捏造）と v0.17.2（繋ぎ直し）の問題が生えていた。
 * どちらも**切り方が乱暴なことの後始末**であって、根治ではない。
 *
 * さらに悪いことに、stop → start の再開には 40ms の空白があり、その間の音は
 * どこにも記録されない。発話の途中で切ると、その 40ms 分の音が消える。
 *
 * なので「最短を過ぎたら、次の無音の切れ目で切る」に変える。無音の位置で切れば
 * 40ms の空白も無音に落ちるので、音の欠落も同時に消える。
 *
 * ■ しきい値を固定値にしない理由
 * このアプリの利用者は「小さい声を拾ってくれるから」Gemini モードを使っている。
 * -40dB のような固定値にすると、静かな部屋の小声が丸ごと「無音」に落ちて、
 * 発話の途中で切るという元の失敗に戻る。
 * そこで**その場の暗騒音（ノイズフロア）を推定し、そこから何dB上か**で判定する。
 * 推定の作り方は SILENCE_WINDOW_MS のコメントを参照（v0.18.3 で一度作り直している。
 * 最初の版は実機で「3秒黙っても無音が一度も検出されない」という形で失敗した）。
 */
const SILENCE_MARGIN_DB = 6;     // ノイズフロアからこれだけ上までは「無音」とみなす
/* 「どれだけ静かなら文の切れ目か」(v0.18.2)
 *
 * v0.18.0/0.18.1 は 350ms 一本だった。実機で「…しかし、最初冒頭 / の方に喋り始めた」
 * と真っ二つになった。日本語の話し言葉では、考えながら喋るときの言いよどみが
 * 350ms を軽く超える。350ms は「文の切れ目」ではなく「息継ぎ」まで拾ってしまう。
 *
 * かといって一律に長くすると、切ってよい場所が見つからず強制区切りが増える
 * （それは v0.17 に戻るということ）。そこで段階的にする:
 *
 *   最短〜(最長-4秒)  … 文の切れ目だけを狙う
 *   (最長-4秒)〜最長   … 短い間でも妥協する。強制で切るよりはマシ
 *
 * v0.18.6 で数値を上げた。v0.18.5 で測定がまともになって初めて、実際の間の
 * 長さが分かったため（2026-08-31 18:34 の実機ログ）:
 *
 *   1350ms … 文末（「〜黙ってみます。」）
 *   1300ms … 文末（「〜終わりたいと思います。」）
 *    950ms … **文の途中の言いよどみ**（「どのように…だったでしょうか」）
 *
 * 700ms だと 950ms の言いよどみを文の切れ目と判定して真っ二つにしていた。
 * 1000ms なら分かれる。ただしこれは1回の録音から取った値なので、話し方が
 * 変わればまた見直しが要る。外すほうに転んでも、切る場所が見つからず
 * 最長秒数の強制区切りに落ちるだけで壊れはしない。
 */
const SILENCE_HOLD_MS = 1000;        // 通常。文の切れ目とみなす長さ
const SILENCE_HOLD_LATE_MS = 500;    // 最長が近いときの妥協ライン
const SILENCE_LATE_WINDOW_MS = 4000; // 最長のこれだけ手前から妥協を始める

/* 最短より前に来た「明らかな切れ目」を捨てない (v0.18.9)
 *
 * 実機 2026-08-31 19:00 のログ:
 *   長さ20.0秒 尻=強制 [判定可 最長無音3800ms 採用=level]
 *
 * **3.8秒の沈黙を検出していたのに、そこで切らず20秒で強制区切りした。**
 * その沈黙は「3秒今から黙ってみます」の直後、チャンク開始から約6秒の時点。
 * 最短12秒より前だったので使えないことになっていた。
 *
 * 3.8秒の沈黙は誰がどう見ても文の切れ目で、20秒での強制区切りより明らかに
 * 良い区切り位置。実際その回は末尾が「…コピーして送り」で切れ、続きが失われた。
 *
 * 最短を設けたのは「短すぎるチャンクは文脈が無くて精度が落ちる」ため。だが
 * 直前の文脈は contextHint で渡しているし、短チャンクはミドル整形でまとまる。
 * **明らかな切れ目で終わった短いチャンクは、文の途中で切れた長いチャンクより良い。**
 *
 *   0 ─── 3秒 ────────── 最短 ─────── (最長-4秒) ─── 最長
 *     切らない │ 2秒以上の無音なら切る │ 1秒 │ 0.5秒 │ 強制
 */
const SILENCE_ABS_MIN_MS = 3000;   // これより短いチャンクは作らない
const SILENCE_HOLD_LONG_MS = 2000; // 最短前でも、これだけ空いたら明らかな切れ目
const SILENCE_POLL_MS = 50;      // 判定の刻み

/* ノイズフロアの推定方法 (v0.18.3 で作り直し)
 *
 * v0.18.2 までは「開始1秒を実測して初期値にし、以後は静かなときだけ EMA 追従」
 * だった。実機ログで、3秒黙っても無音が一度も検出されないことが分かった。
 * 原因はデッドロック:
 *
 *   録音開始直後は AudioContext にまだサンプルが流れておらず、解析結果は
 *   ゼロ = -99dB。それが初期実測に入り、フロアが -99dB で確定する。
 *   → quiet = db < -99+6 = -93dB は実際の音では絶対に成立しない
 *   → フロアの学習は「静かなとき」限定なので、-99 から一生回復できない
 *
 * 「喋り続けるとフロアが持ち上がる」のを防ぐために学習を絞ったことが、
 * 逆方向（フロアが低すぎる）から抜け出せない作りになっていた。
 *
 * なので片方向の追従をやめ、**直近の窓の最小値**をフロアにする。最小値なら
 * 両方向に自己修正する。窓は SILENCE_WINDOW_MS のバケツ2本＝直近 4〜8 秒。
 *
 * ただし最小値だけだと、ずっと同じ音量で喋り続けたときにフロアが発話レベルに
 * 張りついて発話が無音に見える。そこで**同じ窓の最大値**も持ち、最大と最小の
 * 開きが SILENCE_DYNAMIC_RANGE_DB 未満なら「大きい側と小さい側の区別がついて
 * いない」と見なして判定を放棄する（＝最長秒数で切る）。
 * 「静か」は相対的な概念なので、開きが無いうちは判定できない。
 *
 * 既知の限界（意図した挙動）: 沈黙が窓を埋め尽くすと大きい側が窓から消え、
 * 判定不能に戻る。判断材料が無いのに「きれいに切れた」と主張するより、
 * 強制区切りに落ちるほうが正しい。実害も小さい（そんなチャンクは中身が沈黙なので
 * 送信閾値で捨てられる）。喋り直せば復帰する。
 */
/* どの周波数を見るか (v0.18.5)
 *
 * v0.18.4 まで全帯域の RMS を測っていた。実機で「発話と3秒の沈黙の差が4dB」に
 * なったのは、外部のゲイン調整ではなく**測る場所が間違っていた**から。
 *
 *   エアコンの効いた部屋でノートPCの近くで小声 →
 *   エアコンの低域（ゴーッという成分）が全帯域 RMS を支配し、
 *   その上に乗っている小声の差が埋もれる
 *
 * 会場で問題になる暗騒音は、空調・プロジェクタの送風・PC のファンなど、
 * たいてい低域が主。全帯域で測っている限りどの会場でも同じ失敗をする。
 * なので**人の声の帯域だけ**を見る。電話帯域（300〜3400Hz）が定番で、
 * 日本語の音声認識でもこの範囲に主要な情報が入る。
 */
const VOICE_BAND_LOW_HZ = 300;
const VOICE_BAND_HIGH_HZ = 3400;

const SILENCE_WINDOW_MS = 4000;       // 最小/最大を集めるバケツの長さ（窓は最大この2倍）
const SILENCE_DYNAMIC_RANGE_DB = 10;  // 窓内の最大-最小がこれ未満なら判定しない
/* 「このチャンクに発話があったか」の判定に、続いていることを要求する (v0.18.10)
 *
 * 実機 2026-08-31 20:36 で、1.0秒の末尾チャンク（Gemini も Web Speech も
 * 何も拾わなかった）に「発話あり」の判定が付き、
 * 「（音声不明瞭・再試行可）」が残った。
 * 1フレーム(50ms)でも大きい音があれば発話と見なしていたため、
 * 舌打ちやクリック音、前の発話の余韻でも成立してしまう。
 */
const SILENCE_SPEECH_MIN_MS = 200;   // これだけ続いて初めて「発話あり」
// 完全なゼロ（-95dB 未満）は「静かな部屋」ではなく「まだ音が流れていない」。
// これをフロアの材料にすると上記のデッドロックが起きるので、材料から外す。
const DIGITAL_SILENCE_DB = -95;

function createSilenceDetector(stream) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  let ctx, analyser, src;
  try {
    ctx = new Ctx();
    src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // 既定 0.8 だと周波数データが平滑化され、短い切れ目が鈍る
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    // 自動再生ポリシーで suspended のまま作られることがある。
    // そのままだと解析値が常にゼロになり、無音判定が一切効かなくなる
    // （＝最長秒数での強制区切りに落ちるだけなので致命的ではないが、機能しない）
    if (ctx.state === 'suspended') {
      // resume は非同期。戻るまでの数フレームはゼロが返るが、ゼロは
      // フロアの材料から外してあるので推定は汚れない
      ctx.resume().then(
        () => diagLog.info('無音検出: AudioContext を resume しました'),
        () => diagLog.info('無音検出: AudioContext の resume に失敗（強制区切りに落ちます）'),
      );
    }
  } catch (e) {
    console.warn('[silence] AudioContext を作れませんでした:', e);
    try { ctx && ctx.close(); } catch {}
    return null;
  }

  const buf = new Float32Array(analyser.fftSize);       // 時間領域（音が流れているかの確認用）
  const freq = new Float32Array(analyser.frequencyBinCount); // 周波数領域（判定はこちら）
  // 声の帯域に対応するビンの範囲を求めておく
  const binHz = (ctx.sampleRate || 48000) / analyser.fftSize;
  const binLo = Math.max(1, Math.floor(VOICE_BAND_LOW_HZ / binHz));
  const binHi = Math.min(analyser.frequencyBinCount - 1, Math.ceil(VOICE_BAND_HIGH_HZ / binHz));

  let silentSinceMs = 0;    // 無音が始まった時刻（0 = いま無音ではない）
  let lastDb = -99;      // 声の帯域（判定に使う値）
  let lastWideDb = -99;  // 全帯域（比較用。v0.18.4 まではこちらで判定していた）
  let speechInChunk = false;   // いまのチャンクの中で発話らしい音量を見たか
  let speechFrames = 0;        // 発話らしい音量が何フレーム続いているか
  let longestSilentInChunk = 0; // 同上・いちばん長かった無音（診断用）
  // チャンク全体の音量の振れ幅（診断用）。窓の値だけだと、そのチャンクに
  // そもそも十分な差があったのかが分からない
  let chunkMinDb = Infinity, chunkMaxDb = -Infinity;

  // 直近の窓の最小/最大。バケツ2本を回して「直近 4〜8 秒」を見る
  let curMin = Infinity, curMax = -Infinity;
  let prevMin = Infinity, prevMax = -Infinity;
  let bucketStartedAt = Date.now();

  const floorDb = () => Math.min(curMin, prevMin);
  const peakDb = () => Math.max(curMax, prevMax);
  /** 大きい側と小さい側の区別がついているか（ついていなければ判定を放棄する） */
  const canJudge = () => {
    const f = floorDb(), p = peakDb();
    return Number.isFinite(f) && Number.isFinite(p) && p - f >= SILENCE_DYNAMIC_RANGE_DB;
  };

  const timer = setInterval(() => {
    // 音がそもそも流れているか（時間領域）。完全なゼロなら「まだ来ていない」
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const wideDb = rms > 0 ? 20 * Math.log10(rms) : -99;

    // 判定は声の帯域だけで行う（空調などの低域に埋もれさせない）
    analyser.getFloatFrequencyData(freq);
    let power = 0;
    for (let i = binLo; i <= binHi; i++) {
      const v = freq[i];
      if (Number.isFinite(v)) power += Math.pow(10, v / 10);
    }
    const db = power > 0 ? 10 * Math.log10(power) : -99;
    lastDb = db;
    lastWideDb = wideDb;
    const now = Date.now();

    // 完全なゼロは「まだ音が流れていない」。フロアの材料にしないし、
    // 無音とも見なさない（材料にすると v0.18.2 のデッドロックが再発する）。
    // 判断は時間領域の広帯域値で行う（帯域を絞った値はゼロ入力でも -99 とは限らない）
    const hasSignal = wideDb > DIGITAL_SILENCE_DB;
    if (hasSignal) {
      if (db < curMin) curMin = db;
      if (db > curMax) curMax = db;
      if (db < chunkMinDb) chunkMinDb = db;
      if (db > chunkMaxDb) chunkMaxDb = db;
      if (now - bucketStartedAt >= SILENCE_WINDOW_MS) {
        prevMin = curMin; prevMax = curMax;
        curMin = Infinity; curMax = -Infinity;
        bucketStartedAt = now;
      }
    }

    const quiet = hasSignal && canJudge() && db < floorDb() + SILENCE_MARGIN_DB;
    // 一瞬の物音を発話と取り違えないよう、続いていることを条件にする
    if (hasSignal && canJudge() && db >= floorDb() + SILENCE_DYNAMIC_RANGE_DB) {
      speechFrames++;
      if (speechFrames * SILENCE_POLL_MS >= SILENCE_SPEECH_MIN_MS) speechInChunk = true;
    } else {
      speechFrames = 0;
    }

    if (quiet) {
      if (!silentSinceMs) silentSinceMs = now;
      const held = now - silentSinceMs;
      if (held > longestSilentInChunk) longestSilentInChunk = held;
    } else {
      silentSinceMs = 0;
    }
  }, SILENCE_POLL_MS);

  return {
    /**
     * いま何 ms 静かが続いているか（0 = 静かではない／判定できない）。
     * どれだけ続いたら切るかの判断は decideChunkCut 側に置く。
     */
    silentMs() {
      if (!silentSinceMs) return 0;
      return Date.now() - silentSinceMs;
    },
    db() { return lastDb; },
    wideDb() { return lastWideDb; },
    floorDb() { const f = floorDb(); return Number.isFinite(f) ? f : -99; },
    peakDb() { const p = peakDb(); return Number.isFinite(p) ? p : -99; },
    /** 大きい側と小さい側の区別がついているか（診断用） */
    canJudge,
    /** AudioContext の状態（suspended のままだと解析値が全部ゼロになる） */
    ctxState() { return ctx.state; },
    /** いまのチャンクの中で、一度でも発話らしい音量があったか */
    sawSpeechInChunk() { return speechInChunk; },
    /** いまのチャンクの中でいちばん長かった無音（ms・診断用） */
    longestSilentMsInChunk() { return longestSilentInChunk; },
    /** そのチャンク全体での音量の振れ幅 [最小, 最大]（診断用） */
    chunkRangeDb() {
      return [Number.isFinite(chunkMinDb) ? chunkMinDb : -99,
              Number.isFinite(chunkMaxDb) ? chunkMaxDb : -99];
    },
    /** チャンクを切ったときに呼ぶ */
    resetChunkSpeech() {
      speechInChunk = false; speechFrames = 0; longestSilentInChunk = 0;
      chunkMinDb = Infinity; chunkMaxDb = -Infinity;
    },
    close() {
      clearInterval(timer);
      try { src.disconnect(); } catch {}
      try { ctx.close(); } catch {}
    },
  };
}

/**
 * 「いまチャンクを切るべきか」の判断 (v0.18.0 / しきい値は v0.18.2)
 *
 *   0 ─────── minMs ─────────────── maxMs
 *   |  絶対切らない  |  無音になったら切る  | 無音でなくても切る
 *
 * minMs 未満で切らないのは、短すぎるチャンクは文脈が無くて精度が落ちるから。
 * maxMs で諦めるのは、ずっと喋り続けられたときにチャンクが無限に伸びて
 * 画面が止まる（＆ Gemini の入力上限に当たる）のを防ぐため。
 *
 * @returns {null|'silence'|'forced'} null = まだ切らない
 */
function decideChunkCut({ elapsed, minMs, maxMs, useSilenceCut, silentMs }) {
  if (elapsed >= maxMs) return 'forced';
  if (!useSilenceCut) return null;          // 従来動作では minMs === maxMs なので上で切れる
  const ms = silentMs || 0;

  // 最短より前でも、明らかな切れ目（長い無音）なら使う。
  // 捨てると、そのあと切る場所が見つからず強制区切りに落ちることがある
  if (elapsed < minMs) {
    return (elapsed >= SILENCE_ABS_MIN_MS && ms >= SILENCE_HOLD_LONG_MS) ? 'silence' : null;
  }

  // 最長が近づいたら、短い間でも妥協する（強制で切るよりはマシ）
  const needed = elapsed >= maxMs - SILENCE_LATE_WINDOW_MS
    ? SILENCE_HOLD_LATE_MS
    : SILENCE_HOLD_MS;
  return ms >= needed ? 'silence' : null;
}

/**
 * 無音検出の状態を1行にまとめる（診断ログ用・v0.18.3）
 *
 * v0.18.2 は「3秒黙ったのに無音が一度も検出されない」という形で壊れていたが、
 * ログには「尻=強制」としか出ず、検出器の中で何が起きているか分からなかった。
 * **そのチャンク中でいちばん長かった無音**を出せば、次からは一目で切り分けられる:
 *   最長無音 3000ms なのに強制で切れている → 区切りの判断がおかしい
 *   最長無音 0ms なのに黙っていた          → 検出器がおかしい
 */
/**
 * 「何 ms 声が途切れているか」を、使える手段から選ぶ (v0.18.4)
 *
 * 音量だけに頼っていたら、実機で床-38dB / 天井-34dB という**差が4dBしかない**
 * 音が来た。20秒の中に発話と3秒の沈黙が両方入っているのにこの差では、
 * 大きい側と小さい側を区別できない（`autoGainControl:false` は要求済みなので、
 * Chrome の外側 ── Windows の音声拡張やドライバ、マイク本体 ── で平坦化されている）。
 *
 * そこで Web Speech を第二の手段にする。並走している音声認識器が「いま声が
 * 出ているか」を判断してくれるので、**音量が平坦でも効く**。
 *
 * 優先順位を明確にする（両方を混ぜない）:
 *   1. 音量で判定できるなら音量（合成音で検証済みの経路）
 *   2. 無理なら Web Speech（音量に依存しない）
 *   3. どちらも無理なら 0 ＝ 最長秒数での強制区切り（v0.17 と同じ）
 *
 * @returns {{ms: number, source: 'level'|'webspeech'|'none'}}
 */
function pickSilentMs({ levelMs, levelCanJudge, webMs, webActive }) {
  if (levelCanJudge) return { ms: levelMs || 0, source: 'level' };
  if (webActive) return { ms: webMs || 0, source: 'webspeech' };
  return { ms: 0, source: 'none' };
}

/** いま使える無音シグナルを集める */
function currentSilenceSignal() {
  const d = state.silenceDetector;
  // liveLastActivityAt が 0 ＝ Web Speech がまだ一度も聞き取っていない。
  // その状態を「無音が続いている」と読んではいけない（判断材料が無いだけ）
  const webActive = !!state.liveRecognition && !!state.liveLastActivityAt;
  return pickSilentMs({
    levelMs: d ? d.silentMs() : 0,
    levelCanJudge: !!d && d.canJudge(),
    webMs: webActive ? Date.now() - state.liveLastActivityAt : 0,
    webActive,
  });
}

function silenceDiag(source) {
  const d = state.silenceDetector;
  if (!d) return `[検出器なし 採用=${source || '?'}]`;
  const [lo, hi] = d.chunkRangeDb();
  // v0.19.1: 無音の計測はチャンクの区切りをまたいで続く（判定にはそれが正しい）。
  // ただしログにそのまま出すと「このチャンクの中に3.4秒の沈黙があった」と
  // 読めてしまうので、チャンク自身の長さで頭打ちにする。
  // 前から続いていた分は `+` を付けて区別する
  const elapsed = state.chunkStartedAt ? Date.now() - state.chunkStartedAt : Infinity;
  const raw = d.longestSilentMsInChunk();
  const shown = Math.min(raw, elapsed);
  return `[声帯域 窓${d.floorDb().toFixed(0)}〜${d.peakDb().toFixed(0)} `
    + `全体${lo.toFixed(0)}〜${hi.toFixed(0)}(幅${(hi - lo).toFixed(0)}dB) `
    + `${d.canJudge() ? '判定可' : '判定不能'} `
    // v0.19.2: 空チャンクを消すかどうかはこの値で決まるのに、出していなかった。
    // 実機で「（音声不明瞭・再試行可）」が残った理由を判断できなかった
    + `発話${d.sawSpeechInChunk() ? 'あり' : 'なし'} `
    + `最長無音${Math.round(shown)}ms${raw > elapsed ? '+' : ''} `
    + `採用=${source || '?'} ctx=${d.ctxState()}]`;
}

/* ───────── Web Speech の遅れによる二重表示 (v0.18.8) ─────────
 *
 * Web Speech の「確定」は遅れて届く。あるチャンクの音声に対応する文字が、
 * そのチャンクを切った**後**に確定し、次のチャンクの「未確定分」として付く。
 *
 * 実機 2026-08-31 18:48:
 *   チャンク3(16.0秒) … 「はい、3秒間黙りました…報告します。」の音声が入っている
 *   チャンク4( 2.3秒) … 残りのほぼ沈黙。Gemini は空を返した
 *   → チャンク3の音声に対応する Web Speech の文字がチャンク4に付いていたため、
 *     v0.17.0 の「Gemini が空でも Web Speech の結果は捨てない」が働いて、
 *     **すでに画面にある文がもう一度出た**
 *
 * 時刻で対応づけ直すことはできない（Web Speech は確定の元になった音声の時刻を
 * 教えてくれない）。なので「すでに画面にあるものは出さない」で対処する。
 * 消してよいと分かるのは**同じ内容が確かに残っているとき**だけなので、
 * 取りこぼしにはならない。
 */

/** 比較用に表記のゆれを落とす（空白・句読点・注記を除く） */
function normalizeForCompare(text) {
  return (text || '')
    .replace(/\[[^\]]*\]/g, '')                      // [Gemini は聞き取れず…] のような注記
    .replace(/[\s\u3000]/g, '')
    .replace(/[、。，．,.!?！？・「」『』（）()]/g, '');
}

/** 2文字ずつの並びの集合（語の切れ目が engine ごとに違っても比べられる） */
function bigrams(str) {
  const set = new Set();
  for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
  return set;
}

/**
 * provisionalText が、すでに確定している末尾の文とほぼ同じ内容か
 *
 * Gemini と Web Speech では表記が違う（「はい、3秒間黙りました。」と
 * 「はい 3秒間 黙りました」）ので、完全一致では判定できない。
 * 2文字の並びがどれだけ重なるかで見る。
 */
/* 判定の下限を2段階にする (v0.19.2)
 *
 * v0.18.8 は一律 8 文字未満を対象外にしていた。実機で「乗り越えるべき」（7文字）が
 * 二重に出て、**1文字足りずにすり抜けた**。
 *
 * かといって一律に下げると、あいまい一致（2文字の並びの重なり）で偶然の一致が増える。
 * ただし**そのまま含まれている**場合は短くても確実なので、そこだけ下限を下げる。
 */
const DUP_MIN_EXACT = 4;   // 完全に含まれているなら、これだけあれば確か
const DUP_MIN_FUZZY = 8;   // あいまい一致は短いと偶然当たる

function isDuplicateOfTail(provisionalText, tailText, threshold = 0.7) {
  const a = normalizeForCompare(provisionalText);
  const b = normalizeForCompare(tailText);
  if (a.length < DUP_MIN_EXACT || b.length < DUP_MIN_EXACT) return false;
  // そのまま含まれているなら、短くても重複と断定してよい
  if (b.includes(a)) return true;
  // ここから先はあいまい一致。短い文字列は偶然当たるので判定しない
  if (a.length < DUP_MIN_FUZZY || b.length < DUP_MIN_FUZZY) return false;
  const ba = bigrams(a), bb = bigrams(b);
  if (ba.size === 0) return false;
  let hit = 0;
  for (const g of ba) if (bb.has(g)) hit++;
  return hit / ba.size >= threshold;
}

/** 指定要素を除いた、直近の確定テキスト（末尾 maxChars 文字） */
function confirmedTailText(excludeEl, maxChars = 400) {
  const container = excludeEl && excludeEl.parentElement;
  if (!container) return '';
  const parts = [];
  for (const child of container.children) {
    if (child === excludeEl) continue;
    const t = (child.innerText || '').trim();
    if (t) parts.push(t);
  }
  const all = parts.join('\n');
  return all.length > maxChars ? all.slice(-maxChars) : all;
}

/**
 * 録音チャンクを一時保管する (v0.19.0)
 *
 * 設定がオフなら何もしない（**既定はオフ**）。
 * 保管に失敗しても録音と文字起こしは止めない。あくまで「やり直せたら嬉しい」
 * 付加機能であって、これのために本筋を落とす価値は無い。
 */
function keepAudioChunk(blob) {
  if (!state.settings.audioKeepRecording) return;
  const sessionId = state.recordingSessionId || state.activeId;
  if (!sessionId || !blob || !blob.size) return;
  audioStorePut(sessionId, blob, state.audioSeq++).catch(e => {
    // 容量不足などで失敗しうる。1回だけ知らせて、以後は黙って諦める
    if (!state.audioStoreWarned) {
      state.audioStoreWarned = true;
      diagLog.info('音声の保管に失敗しました（録音と文字起こしは続きます）: ' + (e.message || e));
    }
  });
}

/**
 * 期限切れの音声を掃除する (v0.19.0)
 *
 * **起動時に必ず呼ぶ。** 「タブを閉じたら消す」はクラッシュや強制リロードでは
 * 走らないので、消し忘れを防ぐ本体はこちら。
 */
/** 設定画面の「保持中の音声: …」表示を更新する (v0.19.0) */
async function refreshAudioUsage() {
  if (!els.audioUsageText) return;
  try {
    const { sessions, totalBytes } = await audioStoreSummary();
    els.audioUsageText.textContent = sessions.length === 0
      ? '保持中の音声: なし'
      : `保持中の音声: ${sessions.length}件 / ${formatBytes(totalBytes)}`;
    if (els.btnClearAudio) els.btnClearAudio.disabled = sessions.length === 0;
  } catch (e) {
    // IndexedDB が使えない環境（プライベートモード等）でも設定画面は開けるべき
    els.audioUsageText.textContent = '保持中の音声: 確認できません（' + (e.message || e) + '）';
    if (els.btnClearAudio) els.btnClearAudio.disabled = true;
  }
}

async function sweepStoredAudio() {
  try {
    const live = new Set(state.sessions.map(s => s.id));
    const done = new Map(state.sessions
      .filter(s => s.audioRepassDoneAt)
      .map(s => [s.id, s.audioRepassDoneAt]));
    const r = await audioStoreSweep({
      // 保持がオフなら 'off' を渡して、残っている分を全部消す
      retention: state.settings.audioKeepRecording ? state.settings.audioRetention : 'off',
      liveSessionIds: live,
      repassDoneAt: done,
    });
    if (r.deletedSessions > 0) {
      diagLog.info(`保管していた音声を掃除: ${r.deletedSessions}件 / ${formatBytes(r.deletedBytes)}`);
    }
  } catch (e) {
    console.warn('[audio] 掃除に失敗:', e.message || e);
  }
}

/**
 * Gemini が空を返したチャンクを、画面から消してよいか (v0.18.1 / v0.18.10)
 *
 * 無音位置で区切るようになった結果、最後の区切りのあとに「中身が沈黙だけ」の
 * チャンクが必ず1本できるようになった。それを送ると Gemini は正しく空を返すが、
 * 従来のコードはそれを「（音声不明瞭・再試行可）」として画面に残していた。
 *
 * **間違えると小声を黙って捨てることになる**ので、条件は厳しくする。
 * 前提として次の2つは必須:
 *   - Gemini が空（呼び出し側で確認済み）
 *   - Web Speech も何も拾っていない（別エンジンでも聞こえていない）
 *
 * そのうえで、次のどちらかが言えるときに消す:
 *   (a) 検出器がこのチャンク中に発話音量を一度も見ていない
 *   (b) チャンクが SILENCE_ABS_MIN_MS より短い
 *
 * (b) は v0.18.10 で追加。実機 2026-08-31 20:36 で 1.0 秒の末尾チャンクに
 * 「（音声不明瞭・再試行可）」が残った。(a) が成立していなかったため
 * （幅12dB の物音を発話と判定していた。そちらは SILENCE_SPEECH_MIN_MS で対処済み）。
 *
 * (b) が安全な理由: cutChunk は SILENCE_ABS_MIN_MS より前に切らないので、
 * これより短いチャンクは**録音停止時の末尾**しか存在しない。そのうえ両エンジンが
 * 何も拾っていないので、消しても失う文字が無い。
 * この表示は「再試行できます」と言うが、再試行はテキストを整形し直す仕組みなので、
 * 中身が空のこれを再試行しても何も起きない。
 *
 * 検出器が無い場合 hadSpeech は undefined なので (a) は成立せず、(b) だけで判断する。
 */
function shouldDropEmptyChunk(provisionalText, edges) {
  if (provisionalText) return false;
  if (!edges) return false;
  if (edges.hadSpeech === false) return true;
  return Number.isFinite(edges.durationMs) && edges.durationMs < SILENCE_ABS_MIN_MS;
}

async function startGeminiAudioRecording() {
  if (!state.settings.apiKey) {
    alert('Gemini Audio モードは API キーが必要です');
    openSettings();
    return;
  }
  // Gemini Audio は録音生データをそのまま AI に送るルートなので、
  // Chrome の音声前処理（AGC/NS/EC）はすべて OFF にする。
  // 特に AGC（autoGainControl）は仮想ケーブル経由の音声で「無音区間」に
  // 過剰ブーストをかけるため、リアルマイクから漏れる微弱音や室内雑音を
  // 持ち上げて Gemini が「独り言として」拾ってしまう症状を引き起こす。
  // （v0.13.6 修正: VB-Cable + YouTube 音声の文字起こしで
  //  「変えようかな」「もうダメだ」など独り言が混入する事故への対策）
  const audioOpts = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (state.settings.audioDeviceId) {
    audioOpts.deviceId = { exact: state.settings.audioDeviceId };
  }
  const constraints = { audio: audioOpts };
  try {
    state.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    console.error('getUserMedia failed:', e);
    setStatus('error', 'マイク取得失敗');
    showMicDeniedGuide(e.message || e.name);
    return;
  }

  // v0.18.4: 要求した制約が本当に効いているかは getSettings() でしか分からない。
  // autoGainControl が true のままだと、静かになるとゲインが上がって暗騒音が
  // 発話と同じ音量まで持ち上がり、無音が無音に見えなくなる
  try {
    const st = state.audioStream.getAudioTracks()[0]?.getSettings?.() || {};
    diagLog.info(`マイク実設定 AGC=${st.autoGainControl} ノイズ抑制=${st.noiseSuppression} `
      + `エコー除去=${st.echoCancellation} ${st.sampleRate || '?'}Hz`);
  } catch (e) { /* getSettings 非対応でも録音は続ける */ }

  // v0.18.0: 無音位置で切るための検出器。作れなかった場合は null になり、
  // 従来どおりの固定間隔にフォールバックする（録音自体は止めない）。
  // 前回の分が残っていたら必ず閉じる（AudioContext はページあたりの生成数に
  // 上限があり、漏らすと数回の録音で作れなくなる）
  if (state.silenceDetector) {
    try { state.silenceDetector.close(); } catch {}
    state.silenceDetector = null;
  }
  if (state.audioChunkTimer) { clearInterval(state.audioChunkTimer); state.audioChunkTimer = null; }
  state.silenceDetector = state.settings.audioSilenceCut !== false
    ? createSilenceDetector(state.audioStream)
    : null;

  let mimeType = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
  }

  state.audioChunks = [];
  // v0.19.0: 音声認識用途では既定(約128kbps)は過剰。下げると保管サイズも送信量も減る
  const recOpts = {};
  if (mimeType) recOpts.mimeType = mimeType;
  const bitrate = Number(state.settings.audioBitrate);
  if (Number.isFinite(bitrate) && bitrate >= 16000) recOpts.audioBitsPerSecond = bitrate;
  const recorder = new MediaRecorder(state.audioStream, recOpts);
  state.mediaRecorder = recorder;

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
  };
  recorder.onstop = () => {
    const chunks = state.audioChunks;
    state.audioChunks = [];
    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      // 設定の minChunkBytes 未満は無音と見なしてスキップ（デフォ400: 従来1200より感度↑）
      const minBytes = Number.isFinite(state.settings.audioMinChunkBytes) ? state.settings.audioMinChunkBytes : 400;
      // v0.19.0: 保管は「送るかどうか」とは独立に行う。
      // 無音判定でスキップしたチャンクも、やり直しでは音声の連続性が要るので残す
      keepAudioChunk(blob);
      if (blob.size > minBytes) {
        // 発話あり（と推定） → 長無音タイマーをリセット
        resetLongSilenceTimer();
        const edges = state.pendingChunkEdges || { startsAtSilence: false, endsAtSilence: false };
        // 長さも出す。強制区切りばかりになっていないかを実機ログで見分けるため
        diagLog.info(`音声チャンク送信 ${blob.size}B (>${minBytes}) `
          + `長さ${((edges.durationMs || 0) / 1000).toFixed(1)}秒 `
          + `切り口 頭=${edges.startsAtSilence ? '無音' : '強制'} 尻=${edges.endsAtSilence ? '無音' : '強制'} `
          + (edges.diag || ''));
        // 未確定分はここで確定（次のチャンクに持ち越さない）。
        // 送らなかったチャンクでは取り出さず、次まで溜め続ける
        sendAudioChunkToGemini(blob, takeLiveFinals(), edges);
      } else {
        diagLog.info(`音声チャンクスキップ ${blob.size}B (<=${minBytes}, 無音判定)`);
      }
    }
    // 停止時の最後のチャンク。ここまで来れば送り出し済み
    state.finalChunkPending = false;
    // 録音継続中なら再スタート
    if (state.isRecording && state.mediaRecorder === recorder) {
      setTimeout(() => {
        if (state.isRecording && recorder.state === 'inactive') {
          try {
            recorder.start();
            // 次チャンクの「頭」は、直前のチャンクの「尻」と同じ切り口になる。
            // 無音で切ったなら頭も無音始まり、強制で切ったなら文の途中から始まる。
            state.chunkStartedAtSilence = !!(state.pendingChunkEdges
              && state.pendingChunkEdges.endsAtSilence);
            state.chunkStartedAt = Date.now();
          } catch (e) { console.warn('restart failed', e); }
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
  state.recordingSessionId = state.activeId; // BG録音用に固定
  // v0.19.1: 保持のオン/オフをログに残す。これが無いと、保持まわりの
  // 動作確認をログから判断できない（実機テストで実際に困った）
  diagLog.info(state.settings.audioKeepRecording
    ? `録音の保持: オン（${{
        repass: 'やり直しが終わったら消す', close: 'タブを閉じたら消す',
        '1d': '1日', '7d': '7日', manual: '手動で消すまで',
      }[state.settings.audioRetention] || state.settings.audioRetention}）`
    : '録音の保持: オフ（端末に残しません）');
  diagLog.info(`録音開始 (Gemini) session=${state.recordingSessionId?.slice(-6)} `
    + `最短=${state.settings.audioChunkSec || 12}秒 `
    + (state.settings.audioSilenceCut !== false && state.silenceDetector
        ? `最長=${state.settings.audioChunkMaxSec || 20}秒 (無音位置で区切る)`
        : '(固定間隔)'));
  setRecordingUI(true);
  startContextExtractTimer();   // v0.16.1
  startLiveDisplay();           // v0.17.0
  setStatus('listening', '録音中 (Gemini)');
  resetLongSilenceTimer();

  // チャンク区切り（v0.18.0: 無音位置で切る。判断は decideChunkCut）
  const minMs = Math.max(5, Math.min(60, state.settings.audioChunkSec || 12)) * 1000;
  const useSilenceCut = state.settings.audioSilenceCut !== false && !!state.silenceDetector;
  // 最長は最短より短くできない。既定は 20 秒
  const maxMs = useSilenceCut
    ? Math.max(minMs + 2000, Math.min(90, state.settings.audioChunkMaxSec || 20) * 1000)
    : minMs;

  state.chunkStartedAt = Date.now();
  state.chunkStartedAtSilence = true;   // 録音開始直後は必ず「頭から」
  state.audioSeq = 0;                   // v0.19.0: 保管の通し番号

  const cutChunk = (endedAtSilence, source) => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;
    state.pendingChunkEdges = {
      startsAtSilence: !!state.chunkStartedAtSilence,
      endsAtSilence: !!endedAtSilence,
      // 検出器が無いときは undefined のまま（＝判断材料なし）にしておく
      hadSpeech: state.silenceDetector ? state.silenceDetector.sawSpeechInChunk() : undefined,
      durationMs: Date.now() - state.chunkStartedAt,
      diag: silenceDiag(source),
    };
    if (state.silenceDetector) state.silenceDetector.resetChunkSpeech();
    state.mediaRecorder.stop(); // onstop で送信＋再スタート
  };

  state.audioChunkTimer = setInterval(() => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;
    const sig = useSilenceCut ? currentSilenceSignal() : { ms: 0, source: 'none' };
    const cut = decideChunkCut({
      elapsed: Date.now() - state.chunkStartedAt,
      minMs, maxMs, useSilenceCut,
      silentMs: sig.ms,
    });
    if (cut) cutChunk(cut === 'silence', sig.source);
  }, SILENCE_POLL_MS);

  // 時間しきい値（60秒経過）だけでも発火できるよう、ウォッチドッグを常駐させる
  if (state.midChunkWatchdog) clearInterval(state.midChunkWatchdog);
  state.midChunkWatchdog = setInterval(maybeConsolidateShortChunks, 15 * 1000);
}

function stopGeminiAudioRecording() {
  if (state.audioChunkTimer) {
    clearInterval(state.audioChunkTimer);
    state.audioChunkTimer = null;
  }
  const recorder = state.mediaRecorder;
  state.mediaRecorder = null; // onstop の再スタートを抑止
  // 最後のチャンクの切り口。尻は検出器の実測に従う
  // （利用者が文の途中で停止したなら「強制」＝続きを作らせない）
  const stopSig = currentSilenceSignal();
  state.pendingChunkEdges = {
    startsAtSilence: !!state.chunkStartedAtSilence,
    endsAtSilence: stopSig.ms >= SILENCE_HOLD_LATE_MS,
    hadSpeech: state.silenceDetector ? state.silenceDetector.sawSpeechInChunk() : undefined,
    durationMs: state.chunkStartedAt ? Date.now() - state.chunkStartedAt : 0,
    diag: silenceDiag(stopSig.source),
  };
  if (recorder && recorder.state !== 'inactive') {
    state.finalChunkPending = true;   // onstop で下ろす
    try { recorder.stop(); } catch { state.finalChunkPending = false; }
  }
  if (state.silenceDetector) {
    try { state.silenceDetector.close(); } catch {}
    state.silenceDetector = null;
  }
  if (state.audioStream) {
    state.audioStream.getTracks().forEach(t => t.stop());
    state.audioStream = null;
  }
}

/* ───────── Gemini モードのリアルタイム表示 (v0.17.0) ─────────
 *
 * Gemini モードは 12 秒ごとに一気に文字が出るので、喋っている間は画面が動かない。
 * そこで Web Speech を「表示専用」で並走させ、確定までの間を埋める。
 * （マイクを同時に使えることは mic-test.html で実機確認済み）
 *
 *   喋る → Web Speech の文字が「未確定」として出る
 *        → チャンクの区切りでその文が段落に固定される（まだ未確定の見た目）
 *        → Gemini の結果が返ったらその段落が置き換わる（確定）
 *
 * ここで作る recognition は **transcript に一切書かない**。
 * buildRecognition() は appendRawChunk や字幕バッファと密結合しているので流用しない。
 *
 * チャンクの区切りで受け渡すので、Web Speech と Gemini の時間軸を突き合わせる必要がない。
 * 「区切りまでに Web Speech が確定した分」がそのままそのチャンクの未確定表示になる。
 */

/** 表示専用の Web Speech を作る。文字起こしペインには書かない */
function buildLiveDisplayRecognition() {
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (event) => {
    let interim = '';
    let gotText = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) { state.liveFinals = (state.liveFinals || '') + r[0].transcript; gotText = true; }
      else { interim += r[0].transcript; if (r[0].transcript) gotText = true; }
    }
    // v0.18.4: 「いま声が出ているか」の記録。音量ではなく音声認識器の判断なので、
    // マイク側のゲイン調整で音量が平坦化されていても効く
    if (gotText) state.liveLastActivityAt = Date.now();
    // BG録音中は共有の #interim に書かない（表示中の別タブに漏れるため）
    if (isBgRecording()) els.interim.textContent = '';
    else els.interim.textContent = (state.liveFinals || '') + interim;
  };

  rec.onerror = (e) => {
    // 表示専用なので、失敗しても録音は続ける。Gemini 側が本体
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      console.warn('[live] Web Speech エラー（表示のみ・録音は継続）:', e.error);
    }
  };

  rec.onend = () => {
    // continuous でも切れることがあるので、録音中なら黙って再開する
    if (state.isRecording && state.liveRecognition === rec) {
      try { rec.start(); } catch (_) {}
    }
  };
  return rec;
}

function startLiveDisplay() {
  if (state.settings.geminiLiveDisplay === false) return;
  stopLiveDisplay();
  state.liveFinals = '';
  const rec = buildLiveDisplayRecognition();
  if (!rec) {
    diagLog.info('リアルタイム表示: この環境は Web Speech 非対応のためスキップ');
    return;
  }
  state.liveRecognition = rec;
  // v0.18.11: ここで現在時刻を入れてはいけない。
  // 入れると「録音開始からずっと無音」に見えて、まだ一言も喋っていない
  // 3.0秒（最短チャンク長）の時点で区切ってしまう。実機 2026-08-31 20:42:
  //   音声チャンク送信 長さ3.0秒 [幅5dB 判定不能 最長無音0ms 採用=webspeech]
  // 表示はされないが Gemini への送信が1回まるまる無駄になる。
  // 0 のままにしておけば currentSilenceSignal の webActive が false になり、
  // Web Speech が実際に何か聞き取るまでこの手段は使われない
  // （レベル検出器で「大きい側を知るまで判定しない」としたのと同じ原則）。
  state.liveLastActivityAt = 0;
  try {
    rec.start();
    diagLog.info('リアルタイム表示 (Web Speech 並走) を開始');
  } catch (e) {
    console.warn('[live] 開始できませんでした（表示のみ・録音は継続）:', e.message);
    state.liveRecognition = null;
  }
}

function stopLiveDisplay() {
  const rec = state.liveRecognition;
  state.liveRecognition = null;
  if (rec) {
    rec.onend = null;
    try { rec.stop(); } catch (_) {}
  }
  els.interim.textContent = '';
  // state.liveFinals はここでは消さない。
  // 停止時に MediaRecorder が最後のチャンクを吐くので、その未確定表示に使う。
  // 次の録音開始時に startLiveDisplay() が '' に戻すので溜まりっぱなしにはならない。
}

/** チャンクの区切りで、そこまでに確定した文を取り出して次に持ち越さない */
function takeLiveFinals() {
  const t = (state.liveFinals || '').trim();
  state.liveFinals = '';
  els.interim.textContent = '';
  return t;
}

async function sendAudioChunkToGemini(blob, provisionalText = '', edges = null) {
  state.audioInFlightCount++;
  const container = getWriteContainer();
  const inBg = container !== els.confirmed;
  if (!inBg) hideEmptyHint();
  // v0.17.0: Web Speech が聞き取った分があれば、それを未確定として置いておく。
  // 無ければ従来どおり「（文字起こし中…）」
  const targetEl = provisionalText
    ? createParagraphEl(provisionalText, 'paragraph refining provisional')
    : createParagraphEl('（文字起こし中…）', 'paragraph refining');
  container.appendChild(targetEl);
  if (inBg) syncBgToSession();
  else autoScroll();

  const persist = () => {
    if (inBg) syncBgToSession();
    else snapshotActiveToSession();
    persistSessions();
  };

  try {
    const text = await transcribeAudioWithGemini({
      apiKey: state.settings.apiKey,
      sessionContext: getSessionContextForAi(),
      audioBlob: blob,
      contextHint: getContextForGemini(),
      edges,
    });
    if (text && text.trim()) {
      // Geminiオーディオ経由の短チャンクは `.short-refined` とマーク。
      // このあと maybeConsolidateShortChunks() が 3つ溜まったら
      // refineWithGemini（見出し付き）でまとめて整形する。
      targetEl.className = 'paragraph short-refined';
      targetEl.dataset.shortTs = String(Date.now());
      setParagraphContent(targetEl, text);
      if (state.isRecording) resetLongSilenceTimer();
      persist();
      // 遅延ミドル整形をチェック
      maybeConsolidateShortChunks();
    } else if (shouldDropEmptyChunk(provisionalText, edges)) {
      // 沈黙だけのチャンク。従来はこれが「（音声不明瞭・再試行可）」として
      // 画面に残っていた（判断根拠は shouldDropEmptyChunk のコメント）
      diagLog.info('沈黙のみのチャンクだったので表示しない');
      targetEl.remove();
      persist();
    } else if (isDuplicateOfTail(provisionalText, confirmedTailText(targetEl))) {
      // v0.18.8: Web Speech の確定が遅れて次のチャンクに付いた分。
      // 同じ内容がすでに画面にあるので出さない（判断根拠は上のコメント）
      diagLog.info('Web Speech の確定が直前の内容と重複していたので表示しない');
      targetEl.remove();
      persist();
    } else {
      // 空テキストも「要再試行」として残す（消さない）
      // v0.17.0: Web Speech が聞き取っていたなら、その文字は捨てない。
      // Gemini が空でも「聞こえていた内容」は残っているほうが役に立つ
      targetEl.className = 'paragraph needs-retry';
      /* v0.19.3: 文言を正直にする。
       *
       * 実機で番組終わりのジングル（音楽）にこれが付いた。従来の
       * 「（音声不明瞭・再試行可）」は2点で嘘をついていた:
       *   - 「音声不明瞭」… 不明瞭なのではなく、そもそも言葉ではない
       *   - 「再試行可」  … 再試行はテキストを整形し直す仕組みで、
       *                     中身が空のこれを再試行しても何も起きない
       *
       * 音楽かどうかの判別は作らない。hadSpeech は「大きい音があったか」を
       * 見ているだけなので鳴り続ける音楽は素通りするが、それを直すには
       * 変調スペクトルのような別の特徴量が要る。ここで得られるものに対して
       * 大きすぎる。**何秒ぶんが文字にならなかったか**が分かれば用は足りる。 */
      const sec = ((edges && edges.durationMs) || 0) / 1000;
      setParagraphContent(targetEl, provisionalText
        ? provisionalText + '　[Gemini は聞き取れず・Web Speech の結果です]'
        : `（この${sec ? sec.toFixed(1) + '秒' : '区間'}は言葉として聞き取れませんでした。音楽や物音の可能性があります）`);
      persist();
    }
  } catch (e) {
    // 通信エラー等も黙って needs-retry に落とす（赤バナーは出さない）
    console.warn('[audio transcribe] skipped (marked for retry):', e.message || e);
    // v0.17.0: 失敗しても Web Speech の結果は残す。ここで捨てると、
    // 聞き取れていたのに何も残らないという最悪の結果になる
    targetEl.className = 'paragraph needs-retry';
    setParagraphContent(targetEl, provisionalText
      ? provisionalText + '　[Gemini 失敗・Web Speech の結果です: ' + (e.message || '').slice(0, 40) + ']'
      : '[文字起こし失敗: ' + (e.message || '').slice(0, 60) + ']');
    persist();
  } finally {
    state.audioInFlightCount--;
    updateActionButtons();
    if (!inBg) autoScroll();
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

function applyWebSpeechOnlyVisibility(animated = true) {
  const el = document.getElementById('webspeech-only-fields');
  if (!el) return;
  const isWs = els.modeWebSpeech && els.modeWebSpeech.checked;
  if (!animated) {
    const prev = el.style.transition;
    el.style.transition = 'none';
    el.classList.toggle('is-hidden', !isWs);
    void el.offsetWidth;
    el.style.transition = prev;
  } else {
    el.classList.toggle('is-hidden', !isWs);
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

// v0.14.0: copyTextOnly / copyPane はペインのコピーボタン撤去に伴い削除。
// ペイン単位のコピーはアプリ全体メニューの「プレーンテキストでコピー」と重複していた。

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

/* ───────── Notion アップロード (v0.14.2) ─────────
 *
 * 単位はセッション（タブバーの1タブ）= Notion のノート1枚。
 * ペイン（文字起こし・メモ・要約・質問）はノート内のトグル1つずつになる。
 *
 * クリック          … 今開いているタブだけ
 * Shift+クリック/長押し … 全タブ。統合せず、タブごとに1ノートずつ作る
 *
 * 保存先は毎回聞くが、前回の保存先が選択済みの状態で出るので Enter/保存だけで済む。
 */

/**
 * Notion アップ済み印を外す (v0.15.1)。
 * 上げたあとに中身が変わったら「最新が上がっている」とは言えないので印を消す。
 * Notion 側でノートが消されたかどうかは見ない（やっさん指示）。
 */
function clearNotionUploadedMark(session) {
  if (!session || !session.notionUploadedAt) return;
  session.notionUploadedAt = null;
  // タブバーの印を即座に消す。persist は呼び出し元の保存に任せる
  renderTabs();
}

/** セッション1件 → ノート内のトグル配列。空のペインは省略する */
function buildNotionToggles(session) {
  const toggles = [];
  for (const id of state.settings.paneOrder) {
    const meta = PANE_META[id];
    let blocks = [];
    if (id === 'pane-transcript')   blocks = notionBlocksFromHtml(session.transcript || '');
    else if (id === 'pane-memo')    blocks = notionBlocksFromHtml(session.memo || '');
    else if (id === 'pane-summary') blocks = notionBlocksFromHtml(session.summary || '');
    else if (id === 'pane-chat') {
      // 質問ペインは配列なので、Q/A を見出し無しの段落ペアとして組み立てる
      const chat = (session.chat || []).filter(m => !m.thinking && !m.error);
      for (const m of chat) {
        const who = m.role === 'user' ? 'あなた' : 'Gemini';
        blocks.push(notionBlock.paragraph(notionRichText(`${who}:`, { bold: true })));
        blocks.push(...notionBlocksFromText(m.content));
      }
    }
    if (blocks.length) toggles.push({ label: meta.label, blocks });
  }
  return toggles;
}

/** そのセッションに Notion へ送る中身があるか */
function sessionHasContentForNotion(session) {
  return !!(session && (session.transcript || session.memo || session.summary
    || (session.chat || []).some(m => !m.thinking && !m.error)));
}

/* ───────── 保存先ピッカー ───────── */

let notionPickerResolve = null;
let notionPickerSchema = null;   // 選択中 DB の { titleProp, dateProps }
let notionSchemaSeq = 0;         // 取得の世代番号。古い応答が後から勝つのを防ぐ

function closeNotionPicker(result) {
  els.notionPicker.classList.add('hidden');
  const fn = notionPickerResolve;
  notionPickerResolve = null;
  if (fn) fn(result || null);
}

function setNotionPickerError(msg) {
  els.notionPickerError.textContent = msg || '';
  els.notionPickerError.classList.toggle('is-ng', !!msg);
}

/**
 * 選択中の DB の列構成を取り、日付プロパティのセレクトを埋める。
 * 日付列が無い DB では「使わない」だけになる。
 */
async function loadNotionPickerSchema() {
  const seq = ++notionSchemaSeq;
  const dsId = els.notionPickerSelect.value;
  notionPickerSchema = null;
  els.notionPickerDate.innerHTML = '<option value="">読み込み中…</option>';
  els.notionPickerDate.disabled = true;
  els.btnNotionPickerOk.disabled = true;
  if (!dsId) return;

  let schema;
  try {
    schema = await notionGetSchema(state.settings.notionToken, dsId);
  } catch (e) {
    if (seq !== notionSchemaSeq) return;   // 既に別の保存先が選ばれている
    els.notionPickerDate.innerHTML = '<option value="">（取得できませんでした）</option>';
    setNotionPickerError(e.message);
    console.warn('[notion] 列構成の取得に失敗:', e.message);
    return;
  }
  if (seq !== notionSchemaSeq) return;     // 待っている間に選択が変わっていたら捨てる
  notionPickerSchema = schema;

  const opts = ['<option value="">使わない（タイトルに日時を残す）</option>']
    .concat(notionPickerSchema.dateProps.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`));
  els.notionPickerDate.innerHTML = opts.join('');

  // 前回選んだ日付列があればそれを、無ければ日付列が1つだけならそれを既定にする
  const last = state.settings.notionLastDatePropName;
  if (last && notionPickerSchema.dateProps.includes(last)) {
    els.notionPickerDate.value = last;
  } else if (notionPickerSchema.dateProps.length === 1) {
    els.notionPickerDate.value = notionPickerSchema.dateProps[0];
  }

  els.notionPickerDate.disabled = false;
  els.btnNotionPickerOk.disabled = false;
  setNotionPickerError('');
}

/**
 * 保存先データベースと、録音日時を入れる日付プロパティを選ばせる。
 * @returns {Promise<{id:string,title:string,titleProp:string,dateProp:string}|null>} キャンセルなら null
 */
async function openNotionPicker(summaryText) {
  const token = state.settings.notionToken;
  if (!token) {
    alert('Notion のアクセストークンが未設定です。設定 → Notion 連携 で登録してください。');
    return null;
  }

  els.notionPickerSummary.textContent = summaryText;
  setNotionPickerError('');
  els.notionPickerSelect.innerHTML = '<option>読み込み中…</option>';
  els.notionPickerSelect.disabled = true;
  els.notionPickerDate.innerHTML = '';
  els.notionPickerDate.disabled = true;
  els.btnNotionPickerOk.disabled = true;
  els.notionPicker.classList.remove('hidden');

  let list = [];
  try {
    list = await notionListDataSources(token);
  } catch (e) {
    els.notionPickerSelect.innerHTML = '';
    setNotionPickerError(e.message);
    console.warn('[notion] 保存先の取得に失敗:', e.message);
    return new Promise(resolve => { notionPickerResolve = () => resolve(null); });
  }

  if (list.length === 0) {
    els.notionPickerSelect.innerHTML = '';
    setNotionPickerError('保存先に使えるデータベースがありません。Notion でデータベースのページを開き「…」→「コネクト」から接続してください。');
    return new Promise(resolve => { notionPickerResolve = () => resolve(null); });
  }

  els.notionPickerSelect.innerHTML = list
    .map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.title)}</option>`).join('');
  // 前回の保存先を初期選択に（無ければ先頭）
  const lastDs = state.settings.notionLastDataSourceId;
  if (lastDs && list.some(d => d.id === lastDs)) els.notionPickerSelect.value = lastDs;
  els.notionPickerSelect.disabled = false;

  await loadNotionPickerSchema();
  els.btnNotionPickerOk.focus();

  return new Promise(resolve => {
    notionPickerResolve = (picked) => {
      if (!picked || !notionPickerSchema) return resolve(null);
      const id = els.notionPickerSelect.value;
      return resolve({
        id,
        title: list.find(d => d.id === id)?.title || '',
        titleProp: notionPickerSchema.titleProp,
        dateProp: els.notionPickerDate.value || '',
      });
    };
  });
}

/* ───────── 進捗ダイアログ ───────── */

// v0.15.0: 中止フラグ。ノートを1件送り終えた区切りで見て、次に進まず抜ける。
// 送信中のノートを途中で切ると Notion 側に中身が欠けたノートが残るので、
// 区切りまでは走り切らせる方針にしている。
let notionCancelRequested = false;

function notionProgressOpen(title, { cancellable = true } = {}) {
  notionCancelRequested = false;
  els.notionProgressTitle.textContent = title;
  els.notionProgressBody.textContent = '';
  els.notionProgressList.innerHTML = '';
  // 1件だけの保存は、区切りが来る前に終わるので中止できない。ボタンを出さない
  els.btnNotionCancel.hidden = !cancellable;
  els.notionAutoCloseRow.hidden = false;
  els.notionAutoClose.checked = !!state.settings.notionAutoClose;
  els.btnNotionCancel.disabled = false;
  els.btnNotionCancel.textContent = '中止';
  els.btnNotionCloseTabs.hidden = true;
  els.btnNotionKeepTabs.hidden = true;
  els.notionProgress.classList.remove('hidden');
}

function notionProgressSet(text) {
  els.notionProgressBody.textContent = text;
}

function notionProgressAddRow(label, state_, detail) {
  const row = document.createElement('div');
  row.className = `notion-progress-row is-${state_}`;
  row.textContent = (state_ === 'ok' ? '✓ ' : '✕ ') + label + (detail ? ` — ${detail}` : '');
  els.notionProgressList.appendChild(row);
  els.notionProgressList.scrollTop = els.notionProgressList.scrollHeight;
}

function notionProgressClose() {
  els.notionProgress.classList.add('hidden');
}

/** 中止ボタン。押した瞬間は止まらない（今のノートは送り切る）のでその旨を出す */
function requestNotionCancel() {
  notionCancelRequested = true;
  els.btnNotionCancel.disabled = true;
  els.btnNotionCancel.textContent = '中止しています…';
  notionProgressSet('中止します。いま送信中のノートだけ最後まで保存します…');
}

/* ───────── アップロード本体 ───────── */

/**
 * セッション群を Notion に保存する。統合せずセッションごとに1ノート。
 * @param {Array} sessions
 * @returns {Promise<{results:Array, cancelled:boolean}>}
 */
/**
 * 未確定の文字起こしが残っていないか確かめる (v0.17.3)
 *
 * Notion 保存のあと「閉じる」を押すとタブは削除される。
 * このとき Gemini の返事待ちのチャンクが残っていると、
 * **保存されないまま消える＝永久に失われる**。
 * やっさんの普段の使い方（保存して閉じる）だと現実に起きうるので、先に止める。
 *
 * @returns {Promise<boolean>} 続行してよければ true
 */
async function ensureTranscriptSettled() {
  if (state.isRecording) {
    return confirm(
      '録音中です。\n'
      + 'いま保存すると、これから確定する分は含まれません。\n\n'
      + '録音を止めてから保存することをおすすめします。このまま続けますか？'
    );
  }

  if (state.audioInFlightCount > 0) {
    const n = state.audioInFlightCount;
    const wait = confirm(
      `まだ確定していない文字起こしが ${n} 件あります。\n`
      + 'いま保存すると、その分は含まれません。\n\n'
      + '「OK」= 確定を待ってから保存します（最大30秒）\n'
      + '「キャンセル」= 保存をやめます'
    );
    if (!wait) return false;

    const deadline = Date.now() + 30000;
    while (state.audioInFlightCount > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (state.audioInFlightCount > 0) {
      return confirm(
        `30秒待ちましたが、まだ ${state.audioInFlightCount} 件が確定していません。\n`
        + 'このまま保存しますか？（その分は含まれません）'
      );
    }
    // 待っている間に確定した分を取り込む
    snapshotActiveToSession();
    persistSessions();
  }
  return true;
}

async function uploadSessionsToNotion(sessions) {
  const targets = sessions.filter(sessionHasContentForNotion);
  if (targets.length === 0) {
    alert('Notion に保存する中身がありません。');
    return { results: [], cancelled: false };
  }

  // 確定待ちを残したまま保存 → 閉じる、で内容が消えるのを防ぐ
  if (!(await ensureTranscriptSettled())) return { results: [], cancelled: false };

  const summary = targets.length === 1
    ? `「${targets[0].title}」を1ノートとして保存します。`
    : `${targets.length}個のタブを、1つずつ別のノートとして保存します。`;

  const dest = await openNotionPicker(summary);
  if (!dest) return { results: [], cancelled: false };

  // 選んだ保存先と日付列を次回の既定として覚える
  state.settings.notionLastDataSourceId = dest.id;
  state.settings.notionLastDataSourceTitle = dest.title;
  state.settings.notionLastDatePropName = dest.dateProp || '';
  saveSettings();

  notionProgressOpen(
    targets.length === 1 ? 'Notion に保存中…' : `Notion に保存中…（0/${targets.length}）`,
    { cancellable: targets.length > 1 },
  );

  const results = [];
  let done = 0;
  let cancelled = false;
  for (const session of targets) {
    if (notionCancelRequested) { cancelled = true; break; }
    notionProgressSet(`「${session.title}」を保存しています…`);
    try {
      await notionCreateNote({
        token: state.settings.notionToken,
        dataSourceId: dest.id,
        titleProp: dest.titleProp,
        dateProp: dest.dateProp,
        dateTs: session.createdAt,
        title: notionNoteTitle(session, dest.dateProp),
        toggles: buildNotionToggles(session),
      });
      // アップ済み印。閉じずに残したタブをタブバーで見分けられるようにする
      session.notionUploadedAt = Date.now();
      results.push({ session, ok: true });
      notionProgressAddRow(session.title, 'ok');
    } catch (e) {
      results.push({ session, ok: false, error: e.message });
      notionProgressAddRow(session.title, 'ng', e.message);
      // v0.15.2: どの保存先に送ろうとして失敗したかも残す。
      // 以前はタブ名と理由だけで、あとからログを見ても保存先が特定できなかった。
      console.warn(`[notion] アップロード失敗: ${session.title}`,
        `／保存先: ${dest.title} (${dest.id})`,
        `／日付列: ${dest.dateProp || 'なし'}`,
        `／理由: ${e.message}`);
    }
    done += 1;
    if (targets.length > 1) els.notionProgressTitle.textContent = `Notion に保存中…（${done}/${targets.length}）`;
  }
  if (notionCancelRequested) cancelled = true;
  if (results.some(r => r.ok)) { persistSessions(); renderTabs(); }
  return { results, cancelled, remaining: targets.length - done };
}

/**
 * ノートのタイトルを決める。
 * 日付列に録音日時を入れるなら、タイトル側の "(08/30 14:30)" は要らないので
 * AI が付けた純粋なタイトルだけにする。
 * aiTitle が無いセッション（既定タイトル "08/30 14:30" や手動タイトル）は
 * 外すと何も残らない/意図を壊すので、session.title をそのまま使う。
 */
function notionNoteTitle(session, dateProp) {
  if (dateProp && session.aiTitle) return session.aiTitle;
  return session.title;
}

/**
 * アップロード結果を出して「閉じますか？」を聞く。
 * 成功したタブだけを閉じる対象にする（やっさん指示: 失敗した分は残す）。
 */
function notionFinish({ results, cancelled, remaining }) {
  const ok = results.filter(r => r.ok);
  const ng = results.filter(r => !r.ok);

  // チェックの状態は次回のために覚える
  const autoClose = !!els.notionAutoClose.checked;
  if (autoClose !== state.settings.notionAutoClose) {
    state.settings.notionAutoClose = autoClose;
    saveSettings();
  }

  els.btnNotionCancel.hidden = true;
  els.notionAutoCloseRow.hidden = true;
  els.btnNotionKeepTabs.hidden = false;

  if (ok.length === 0) {
    els.notionProgressTitle.textContent = cancelled ? 'Notion への保存を中止しました' : 'Notion への保存に失敗しました';
    notionProgressSet('保存できたタブはありません。タブはそのまま残しています。');
    els.btnNotionCloseTabs.hidden = true;
    els.btnNotionKeepTabs.textContent = '閉じる';
    els.btnNotionKeepTabs.onclick = notionProgressClose;
    els.btnNotionKeepTabs.focus();
    return;
  }

  els.notionProgressTitle.textContent = cancelled
    ? 'Notion への保存を中止しました' : 'Notion への保存が完了しました';

  const label = ok.length === 1 ? `「${ok[0].session.title}」` : `${ok.length}個のタブ`;
  const notes = [];
  if (ng.length) notes.push(`${ng.length}個は失敗したので残します`);
  if (cancelled && remaining > 0) notes.push(`${remaining}個は中止したので送っていません`);
  const note = notes.length ? `\n（${notes.join('／')}）` : '';

  // Notion に上がっている前提なので、closeSession の削除確認は出さない（二重確認の回避）
  const closeOkTabs = () => closeMultipleSessions(ok.map(r => r.session.id), { skipConfirm: true });

  if (autoClose) {
    // 「自動的に閉じる」がオンなら聞かずに閉じ、結果だけ見せる
    closeOkTabs();
    els.btnNotionCloseTabs.hidden = true;
    els.btnNotionKeepTabs.textContent = '閉じる';
    els.btnNotionKeepTabs.onclick = notionProgressClose;
    notionProgressSet(`${label}を保存して閉じました。${note}`);
    els.btnNotionKeepTabs.focus();
    return;
  }

  els.btnNotionCloseTabs.hidden = false;
  els.btnNotionKeepTabs.textContent = '残す';
  notionProgressSet(`${label}を保存しました。タブを閉じますか？（閉じるとアプリ内の内容は削除されます）${note}`);

  els.btnNotionCloseTabs.onclick = () => {
    notionProgressClose();
    closeOkTabs();
  };
  els.btnNotionKeepTabs.onclick = notionProgressClose;
  els.btnNotionCloseTabs.focus();
}

/** クリック = 今開いているタブだけ */
async function uploadActiveSessionToNotion() {
  snapshotActiveToSession();
  const session = getActiveSession();
  if (!session) return;
  const outcome = await uploadSessionsToNotion([session]);
  if (outcome.results.length || outcome.cancelled) notionFinish(outcome);
}

/** Shift+クリック / 長押し = 全タブを1つずつ */
async function uploadAllSessionsToNotion() {
  snapshotActiveToSession();
  // 録音中のタブは閉じられると困るので対象から外す
  const list = state.sessions.filter(s => !(state.isRecording && s.id === state.recordingSessionId));
  if (list.length === 0) {
    alert('録音中のタブしかないため、保存をスキップしました。');
    return;
  }
  const outcome = await uploadSessionsToNotion(list);
  if (outcome.results.length || outcome.cancelled) notionFinish(outcome);
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

/**
 * 全セッションを1つのHTMLファイルに。各セッションは <details> 折り畳みで
 * 独立して展開できる。pane はユーザー設定の並び順を尊重。
 */
function buildAllSessionsExportHtml() {
  const fmt = (ts) => {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const sessionsHtml = state.sessions.map((session, idx) => {
    const sections = [];
    for (const paneId of state.settings.paneOrder) {
      const meta = PANE_META[paneId];
      let innerHtml = '';
      if (paneId === 'pane-transcript') innerHtml = session.transcript || '';
      else if (paneId === 'pane-memo') innerHtml = session.memo || '';
      else if (paneId === 'pane-summary') innerHtml = session.summary || '';
      else if (paneId === 'pane-chat') {
        const chat = (session.chat || []).filter(m => !m.thinking);
        if (chat.length === 0) continue;
        innerHtml = chat.map(m => {
          const who = m.role === 'user' ? 'あなた' : 'Gemini';
          const body = m.role === 'assistant' ? renderMarkdown(m.content)
                      : '<p>' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</p>';
          return `<div class="chat-block ${m.role}"><div class="chat-who">${who}</div>${body}</div>`;
        }).join('\n');
      }
      if (!innerHtml || !innerHtml.trim()) continue;
      const iconGlyph = paneId === 'pane-transcript' ? '🎙' : paneId === 'pane-memo' ? '📝' : paneId === 'pane-summary' ? '📄' : '💬';
      sections.push(`<section class="pane-section">
    <h3><span class="sec-icon">${iconGlyph}</span>${escapeHtml(meta.label)}</h3>
    <div class="sec-body">${innerHtml}</div>
  </section>`);
    }
    const hasContent = sections.length > 0;
    const summaryPreview = hasContent ? '' : ' <span class="empty-flag">（空）</span>';
    const sessId = `sess-${idx + 1}`;
    return `<details class="sess" id="${sessId}">
  <summary>
    <span class="sess-num">${idx + 1}.</span>
    <span class="sess-title">${escapeHtml(session.title || '(無題)')}</span>
    <span class="sess-meta">${fmt(session.createdAt)}</span>${summaryPreview}
  </summary>
  <div class="sess-body">
    ${sections.length > 0 ? sections.join('\n    ') : '<p class="empty-note">このセッションは空です。</p>'}
  </div>
</details>`;
  }).join('\n\n');

  // TOCリンク
  const tocLinks = state.sessions.map((s, idx) =>
    `<li><a href="#sess-${idx + 1}">${idx + 1}. ${escapeHtml(s.title || '(無題)')}</a></li>`
  ).join('\n      ');

  const now = new Date();
  const exportedAt = fmt(now.getTime());
  const pageTitle = `dictation — 全セッション (${state.sessions.length}件) ${exportedAt}`;

  // 再インポート用の JSON データを末尾 <script> に埋め込む（単体版と同じ方式の複数版）
  const multiData = {
    format: 'dictation-multi/v1',
    exportedAt: now.toISOString(),
    sessions: state.sessions.map(s => ({
      title: s.title,
      aiTitle: s.aiTitle || null,
      titleIsManual: !!s.titleIsManual,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      transcript: s.transcript || '',
      memo: s.memo || '',
      summary: s.summary || '',
      chat: Array.isArray(s.chat) ? s.chat.filter(m => !m.thinking) : [],
    })),
  };
  // </script> を閉じないようにエスケープ
  const embeddedMulti = JSON.stringify(multiData).replace(/<\/(script)/gi, '<\\/$1');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="dictation:format" content="dictation-multi/v1">
<title>${escapeHtml(pageTitle)}</title>
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
  line-height: 1.8;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 860px; margin: 0 auto; padding: 48px 20px 80px; }
header.doc-head { margin-bottom: 28px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
.brand {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-faint);
  letter-spacing: 0.08em; text-transform: uppercase;
}
.brand::before { content: '🎙'; font-size: 14px; }
h1.doc-title { font-size: 26px; font-weight: 600; margin: 8px 0 6px; }
.doc-meta { font-size: 12px; color: var(--text-muted); }
.doc-controls {
  margin: 18px 0 10px;
  display: flex; gap: 8px; flex-wrap: wrap;
}
.doc-controls button {
  background: var(--bg-elevated);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s, border-color 0.15s;
}
.doc-controls button:hover { background: var(--bg-subtle); border-color: #4a4a54; }
.toc {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 20px;
  margin-bottom: 24px;
}
.toc summary {
  cursor: pointer; font-weight: 600; color: var(--accent);
  padding: 2px 0; outline: none;
}
.toc ol { margin: 10px 0 2px; padding-left: 24px; font-size: 13px; color: var(--text-muted); }
.toc ol li { margin: 2px 0; }
.toc ol a { color: var(--text-muted); text-decoration: none; }
.toc ol a:hover { color: var(--accent); }

details.sess {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 10px;
  padding: 0;
  scroll-margin-top: 20px;
}
details.sess > summary {
  cursor: pointer;
  padding: 14px 20px;
  list-style: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 15px;
  outline: none;
  user-select: none;
}
details.sess > summary::-webkit-details-marker { display: none; }
details.sess > summary::before {
  content: '▶';
  color: var(--text-faint);
  font-size: 10px;
  transition: transform 0.2s;
  display: inline-block;
  flex-shrink: 0;
  width: 14px;
}
details.sess[open] > summary::before { transform: rotate(90deg); color: var(--accent); }
details.sess:hover { border-color: #4a4a54; }
details.sess[open] { border-color: var(--accent); }
.sess-num { color: var(--text-faint); font-weight: 500; min-width: 2.5em; flex-shrink: 0; }
.sess-title { font-weight: 600; flex: 1; word-break: break-word; }
.sess-meta { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
.empty-flag { font-size: 11px; color: var(--text-faint); margin-left: 6px; }
.empty-note { color: var(--text-faint); font-style: italic; margin: 0; }

.sess-body {
  padding: 4px 20px 20px;
  border-top: 1px solid var(--border);
}
.sess-body .pane-section { margin: 18px 0 0; }
.sess-body .pane-section:first-child { margin-top: 16px; }
.sess-body .pane-section h3 {
  display: flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 600;
  color: var(--accent);
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.sec-icon { font-size: 14px; }
.sec-body .paragraph { margin: 0 0 1em; }
.sec-body .paragraph:last-child { margin-bottom: 0; }
.sec-body .paragraph h2 { color: var(--heading); font-size: 16px; font-weight: 600; margin: 0 0 0.4em; padding: 0; border: none; }
.sec-body .p-body { color: var(--text); }
.sec-body h1 { font-size: 1.4em; font-weight: 700; margin: 0.5em 0 0.3em; color: var(--text); }
.sec-body h2 { color: var(--heading); font-size: 16px; font-weight: 600; margin: 1em 0 0.3em; padding-top: 0.2em; border-top: 1px solid var(--border); }
.sec-body h2:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.sec-body p { margin: 0.3em 0; }
.sec-body ul, .sec-body ol { padding-left: 1.3em; margin: 0.3em 0; }
.sec-body li { margin: 0.15em 0; }
.chat-block { margin: 10px 0; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border); }
.chat-block.user { background: rgba(52, 211, 153, 0.08); border-color: rgba(52, 211, 153, 0.35); margin-left: 24px; }
.chat-block.assistant { background: var(--bg-subtle); margin-right: 24px; }
.chat-who { font-size: 10px; color: var(--text-faint); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }
footer.doc-foot { margin-top: 36px; text-align: center; font-size: 11px; color: var(--text-faint); letter-spacing: 0.06em; }
</style>
</head>
<body>
<div class="wrap">
  <header class="doc-head">
    <span class="brand">dictation</span>
    <h1 class="doc-title">全セッション一覧 (${state.sessions.length}件)</h1>
    <div class="doc-meta">書き出し: ${exportedAt}</div>
    <div class="doc-controls">
      <button type="button" onclick="document.querySelectorAll('details.sess').forEach(d => d.open = true)">すべて展開</button>
      <button type="button" onclick="document.querySelectorAll('details.sess').forEach(d => d.open = false)">すべて折りたたみ</button>
    </div>
  </header>
  <details class="toc" open>
    <summary>目次 (${state.sessions.length}件)</summary>
    <ol>
      ${tocLinks}
    </ol>
  </details>

  ${sessionsHtml}

  <footer class="doc-foot">generated by dictation — 全セッション一括書き出し</footer>
</div>
<script type="application/json" id="dictation-multi-data">${embeddedMulti}</script>
</body>
</html>
`;
}

function saveAllSessionsAsHtml() {
  snapshotActiveToSession();
  if (state.sessions.length === 0) {
    alert('書き出すセッションがありません');
    return;
  }
  const html = buildAllSessionsExportHtml();
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  triggerDownload(blob, `dictation-all-${state.sessions.length}sessions-${stamp}.html`);
  flashButton(els.btnSaveJson, `${state.sessions.length}件 一括保存完了`);
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

/** 全セッション一括HTMLから読み取ったセッション配列を現状に追加インポート */
function importMultipleSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    alert('インポートするセッションがありません');
    return;
  }
  if (!confirm(`${sessions.length}個のセッションをインポートします。現在のタブに追加されます。よろしいですか？`)) {
    return;
  }
  if (state.isRecording) stopRecording();
  snapshotActiveToSession();
  persistSessions();

  let firstCreatedId = null;
  for (const s of sessions) {
    const title = (s.title || 'インポート').toString();
    const session = createSession({ activate: false, title, skipSave: true });
    session.transcript = s.transcript || s.html || '';
    session.memo = s.memo || '';
    session.summary = s.summary || '';
    session.chat = Array.isArray(s.chat) ? s.chat : [];
    session.aiTitle = s.aiTitle || null;
    session.titleIsManual = !!s.titleIsManual;
    session.createdAt = s.createdAt || Date.now();
    session.updatedAt = Date.now();
    if (!firstCreatedId) firstCreatedId = session.id;
  }
  if (firstCreatedId) state.activeId = firstCreatedId;
  persistSessions();
  renderTabs();
  loadActiveSessionIntoDOM();
  setTimeout(() => {
    if (typeof scrollActiveTabIntoView === 'function') scrollActiveTabIntoView();
  }, 50);
}

/** JSON 埋込が無い旧形式の全件HTMLから、DOM構造を読んでセッション配列を復元 */
function parseMultiSessionsFromDom(doc) {
  const sessions = [];
  const sessDetails = doc.querySelectorAll('details.sess');
  sessDetails.forEach(el => {
    const titleEl = el.querySelector('summary .sess-title');
    const metaEl = el.querySelector('summary .sess-meta');
    const title = titleEl ? (titleEl.textContent || '').trim() : '(無題)';
    const s = {
      title,
      transcript: '',
      memo: '',
      summary: '',
      chat: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    el.querySelectorAll('section.pane-section').forEach(sec => {
      const h3 = sec.querySelector('h3');
      const body = sec.querySelector('.sec-body');
      if (!h3 || !body) return;
      const label = (h3.textContent || '').trim();
      if (/文字起こし/.test(label)) s.transcript = body.innerHTML;
      else if (/メモ/.test(label)) s.memo = body.innerHTML;
      else if (/要約/.test(label)) s.summary = body.innerHTML;
      else if (/質問|チャット/.test(label)) {
        const chat = [];
        body.querySelectorAll('.chat-block').forEach(cb => {
          const role = cb.classList.contains('user') ? 'user' : 'assistant';
          const clone = cb.cloneNode(true);
          const who = clone.querySelector('.chat-who');
          if (who) who.remove();
          const content = (clone.textContent || '').trim();
          if (content) chat.push({ role, content, ts: Date.now() });
        });
        s.chat = chat;
      }
    });
    // summary の日時テキストから createdAt を推定
    if (metaEl) {
      const m = (metaEl.textContent || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
      if (m) {
        const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        if (!isNaN(d.getTime())) s.createdAt = d.getTime();
      }
    }
    sessions.push(s);
  });
  return sessions;
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
      const fmt = meta ? String(meta.getAttribute('content') || '') : '';

      // 全セッション一括 HTML（新旧どちらも対応）
      if (fmt.startsWith('dictation-multi/')) {
        // 新形式: <script id="dictation-multi-data"> に JSON 埋め込み
        const script = doc.querySelector('script[type="application/json"]#dictation-multi-data');
        if (script && script.textContent.trim()) {
          const data = JSON.parse(script.textContent);
          importMultipleSessions(data.sessions || []);
          return;
        }
        // 旧形式（JSON 埋め込み無し）: DOM 構造から復元
        const sessions = parseMultiSessionsFromDom(doc);
        if (sessions.length === 0) {
          alert('このHTMLからセッションデータを読み取れませんでした。\n構造が想定と異なる可能性があります。');
          return;
        }
        importMultipleSessions(sessions);
        return;
      }

      // 単体セッション HTML
      if (fmt.startsWith('dictation-session/')) {
        const script = doc.querySelector('script[type="application/json"]#dictation-data');
        if (!script || !script.textContent.trim()) {
          alert('HTMLファイルにセッションデータが埋め込まれていません。\n別の dictation ファイルを試してください。');
          return;
        }
        const data = JSON.parse(script.textContent);
        importSessionData(data.session || data);
        return;
      }

      alert('これは dictation の保存ファイルではありません。\n\ndictation で「保存」したHTMLファイルか、旧JSONファイルだけを読み込めます。');
      return;
    }

    // JSON (legacy)
    if (name.endsWith('.json') || text.trimStart().startsWith('{')) {
      const data = JSON.parse(text);
      // 複数セッション JSON も受け付ける
      if (data && Array.isArray(data.sessions)) {
        importMultipleSessions(data.sessions);
        return;
      }
      importSessionData(data.session || data);
      return;
    }

    alert('対応していないファイル形式です（HTML または JSON を選んでください）');
  } catch (e) {
    alert('読み込みに失敗しました: ' + e.message);
  }
}

function clearPane(paneId, { confirmFirst = true, skipUndo = false } = {}) {
  const label = PANE_META[paneId]?.label || paneId;
  const hasContent = paneId === 'pane-transcript' ? !!getConfirmedText()
    : paneId === 'pane-memo' ? !!getMemoText()
    : paneId === 'pane-summary' ? !!getSummaryText()
    : paneId === 'pane-chat' ? !!getChatText()
    : false;
  if (!hasContent) return;
  if (confirmFirst && !confirm(`「${label}」をクリアしますか？\n\nCtrl+Z で戻せます。`)) return;
  if (!skipUndo && PANE_FIELD[paneId]) pushUndo(`クリア: ${label}`, paneId);
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
  if (!confirm('このセッションの4タブ（文字起こし・メモ・要約・質問）をすべてクリアしますか？\n\nCtrl+Z（Undo）で元に戻せます。')) return;
  // 各ペインにスナップショット（chatは対象外）
  for (const pid of Object.keys(PANE_FIELD)) pushUndo('全タブクリア', pid);
  clearPane('pane-transcript', { confirmFirst: false, skipUndo: true });
  clearPane('pane-memo',       { confirmFirst: false, skipUndo: true });
  clearPane('pane-summary',    { confirmFirst: false, skipUndo: true });
  clearPane('pane-chat',       { confirmFirst: false, skipUndo: true });
}

/* ───────── Pane別 Undo / Redo ─────────
 * タブごとに独立したスタックを持つ。各スタック項目は以下:
 *   { sessionId, content, ts, op }
 * content は各 pane の HTML 文字列 または chat JSON。
 * localStorage に永続化し、pane単位で保存（容量対策）。 */

const PANE_FIELD = {
  'pane-transcript': 'transcript',
  'pane-memo':       'memo',
  'pane-summary':    'summary',
};
const MAX_UNDO_ENTRIES = 15;

// paneId -> { undo: [], redo: [] }
const paneStacks = (function loadAll() {
  const obj = {};
  for (const paneId of Object.keys(PANE_FIELD)) {
    try {
      obj[paneId] = {
        undo: JSON.parse(localStorage.getItem(`dictation:undo:${paneId}`) || '[]'),
        redo: JSON.parse(localStorage.getItem(`dictation:redo:${paneId}`) || '[]'),
      };
    } catch { obj[paneId] = { undo: [], redo: [] }; }
  }
  return obj;
})();

function _persistPaneStack(paneId) {
  const s = paneStacks[paneId];
  if (!s) return;
  try {
    localStorage.setItem(`dictation:undo:${paneId}`, JSON.stringify(s.undo));
    localStorage.setItem(`dictation:redo:${paneId}`, JSON.stringify(s.redo));
  } catch (e) {
    // 容量オーバー時は半分に圧縮して再保存
    s.undo = s.undo.slice(Math.floor(s.undo.length / 2));
    s.redo = s.redo.slice(Math.floor(s.redo.length / 2));
    try {
      localStorage.setItem(`dictation:undo:${paneId}`, JSON.stringify(s.undo));
      localStorage.setItem(`dictation:redo:${paneId}`, JSON.stringify(s.redo));
    } catch {}
  }
}

function _paneSnapshot(paneId, opLabel) {
  snapshotActiveToSession();
  const sess = getActiveSession();
  if (!sess) return null;
  const field = PANE_FIELD[paneId];
  if (!field) return null;
  return {
    sessionId: sess.id,
    content: sess[field] || '',
    ts: Date.now(),
    op: opLabel || '操作',
  };
}

function _applyPaneSnapshot(paneId, snap) {
  const target = state.sessions.find(x => x.id === snap.sessionId);
  if (!target) return false;
  const field = PANE_FIELD[paneId];
  if (!field) return false;
  target[field] = snap.content;
  target.updatedAt = Date.now();
  persistSessions();
  if (state.activeId === snap.sessionId) {
    loadActiveSessionIntoDOM();
  }
  renderTabs();
  return true;
}

// 現在セッションに属する最新のUndo/Redo項目のインデックスを返す（無ければ-1）
function _topForSession(stack, sessionId) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].sessionId === sessionId) return i;
  }
  return -1;
}

/** 任意の content 文字列を指定して Undo スタックに積む（タイピング用） */
function pushUndoSnapshot(paneId, opLabel, content) {
  if (!PANE_FIELD[paneId]) return;
  const sess = getActiveSession();
  if (!sess) return;
  const s = paneStacks[paneId];
  s.undo.push({
    sessionId: sess.id,
    content: content != null ? content : '',
    ts: Date.now(),
    op: opLabel || '編集',
  });
  while (s.undo.length > MAX_UNDO_ENTRIES) s.undo.shift();
  s.redo = [];
  _persistPaneStack(paneId);
  updatePaneUndoRedoButtons();
}

/* ───── タイピングの Undo スナップショット ─────
 * 各ペインの contenteditable への user input を 2秒でデバウンスして、
 * 打ち始める前の状態を Undo スタックに積む。
 * loadActiveSessionIntoDOM / _applyPaneSnapshot 等のプログラム側変更では
 * syncPaneBaselineFromDOM() で baseline を更新して、誤ったスナップショットを防ぐ。 */
const paneLastStable = {
  'pane-transcript': '',
  'pane-memo': '',
  'pane-summary': '',
};
const paneTypingTimers = {};

function syncPaneBaselineFromDOM() {
  if (els.confirmed) paneLastStable['pane-transcript'] = els.confirmed.innerHTML;
  if (els.memo)      paneLastStable['pane-memo']       = els.memo.innerHTML;
  if (els.summary)   paneLastStable['pane-summary']    = els.summary.innerHTML;
}

function bindPaneTypingUndo() {
  const targets = [
    { paneId: 'pane-transcript', el: els.confirmed },
    { paneId: 'pane-memo',       el: els.memo },
    { paneId: 'pane-summary',    el: els.summary },
  ];

  /* スナップショット頻度の目安:
   *  - 句読点（。.!?！？、,）→ 即スナップ（文/句の区切り）
   *  - 20文字以上打った → 即スナップ（文字数閾値）
   *  - Enter → 即スナップ（行区切り）
   *  - 2秒放置 → スナップ（idle安全ネット）
   *  - blur → スナップ
   *  こうすると「バーっと打ち続け」ても、20〜25字ごと + 句読点ごと に段階的に戻れる。 */
  const CHARS_THRESHOLD = 20;
  const PUNCT_RE = /[。．.!?！？、,，]/;

  // baseline（paneLastStable）の textContent 長を取るヘルパ
  const baseTextLen = (paneId) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = paneLastStable[paneId] || '';
    return (tmp.textContent || '').length;
  };

  for (const { paneId, el } of targets) {
    if (!el || el.__typingUndoWired) continue;
    el.__typingUndoWired = true;
    paneLastStable[paneId] = el.innerHTML;

    // 現在のバーストを Undo スタックに確定させて baseline を更新するヘルパ
    const flushBurst = (opLabel = '編集') => {
      if (paneTypingTimers[paneId]) {
        clearTimeout(paneTypingTimers[paneId]);
        paneTypingTimers[paneId] = null;
      }
      const current = el.innerHTML;
      if (current === paneLastStable[paneId]) return;
      pushUndoSnapshot(paneId, opLabel, paneLastStable[paneId]);
      paneLastStable[paneId] = current;
    };

    el.addEventListener('input', (e) => {
      // 入力された文字列（IME 確定時も含む）
      const inputData = (e && 'data' in e && e.data) ? e.data : '';

      // 1) 句読点が入力されたら即スナップ（文/句の区切り）
      if (inputData && PUNCT_RE.test(inputData)) {
        flushBurst('文区切り');
        return;
      }

      // 2) 文字数閾値（baseline から 20字以上増えた）
      const baseLen = baseTextLen(paneId);
      const curLen = (el.textContent || '').length;
      if (Math.abs(curLen - baseLen) >= CHARS_THRESHOLD) {
        flushBurst('編集');
        return;
      }

      // 3) 2秒デバウンス（idle 時の安全ネット）
      if (paneTypingTimers[paneId]) clearTimeout(paneTypingTimers[paneId]);
      paneTypingTimers[paneId] = setTimeout(() => {
        paneTypingTimers[paneId] = null;
        flushBurst('編集');
      }, 2000);
    });

    // Enter を境界に（1行単位）
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        flushBurst('行編集');
        requestAnimationFrame(() => {
          paneLastStable[paneId] = el.innerHTML;
        });
      }
    });

    // フォーカスアウト時に未確定のバーストを確定
    el.addEventListener('blur', () => flushBurst('編集'));
  }
}

/**
 * 破壊的操作の直前に呼ぶ。対象ペインの現状をUndoスタックに積む。
 * Redoスタックはクリア（新操作後はRedoできないため）。
 */
function pushUndo(opLabel, paneId) {
  // 旧呼び出し（paneId なし）は active pane で推定（後方互換）
  paneId = paneId || state.activePane || 'pane-transcript';
  if (!PANE_FIELD[paneId]) return;
  const snap = _paneSnapshot(paneId, opLabel);
  if (!snap) return;
  const s = paneStacks[paneId];
  s.undo.push(snap);
  while (s.undo.length > MAX_UNDO_ENTRIES) s.undo.shift();
  s.redo = [];
  _persistPaneStack(paneId);
  updatePaneUndoRedoButtons();
  diagLog.info(`Undo可: ${paneId} / ${opLabel}`);
}

function doPaneUndo(paneId) {
  const s = paneStacks[paneId];
  if (!s) return;
  const idx = _topForSession(s.undo, state.activeId);
  if (idx < 0) {
    setStatus('idle', '戻せる操作がありません');
    setTimeout(() => setStatus(state.isRecording ? 'listening' : 'idle',
                                state.isRecording ? '録音中' : '停止'), 1500);
    return;
  }
  // 現在状態をRedoに退避
  const current = _paneSnapshot(paneId, s.undo[idx].op);
  if (current) {
    s.redo.push(current);
    while (s.redo.length > MAX_UNDO_ENTRIES) s.redo.shift();
  }
  const last = s.undo.splice(idx, 1)[0];
  _persistPaneStack(paneId);
  if (!_applyPaneSnapshot(paneId, last)) {
    setStatus('error', 'Undo対象のセッションが見つかりません');
    updatePaneUndoRedoButtons();
    return;
  }
  updatePaneUndoRedoButtons();
  const paneLabel = PANE_META[paneId]?.label || paneId;
  diagLog.info(`Undo実行: ${paneId} / ${last.op}`);
  setStatus('idle', `[${paneLabel}] 戻しました: ${last.op}`);
  setTimeout(() => setStatus(state.isRecording ? 'listening' : 'idle',
                              state.isRecording ? '録音中' : '停止'), 2000);
}

function doPaneRedo(paneId) {
  const s = paneStacks[paneId];
  if (!s) return;
  const idx = _topForSession(s.redo, state.activeId);
  if (idx < 0) {
    setStatus('idle', 'やり直せる操作がありません');
    setTimeout(() => setStatus(state.isRecording ? 'listening' : 'idle',
                                state.isRecording ? '録音中' : '停止'), 1500);
    return;
  }
  const current = _paneSnapshot(paneId, s.redo[idx].op);
  if (current) {
    s.undo.push(current);
    while (s.undo.length > MAX_UNDO_ENTRIES) s.undo.shift();
  }
  const next = s.redo.splice(idx, 1)[0];
  _persistPaneStack(paneId);
  if (!_applyPaneSnapshot(paneId, next)) {
    setStatus('error', 'Redo対象のセッションが見つかりません');
    updatePaneUndoRedoButtons();
    return;
  }
  updatePaneUndoRedoButtons();
  const paneLabel = PANE_META[paneId]?.label || paneId;
  diagLog.info(`Redo実行: ${paneId} / ${next.op}`);
  setStatus('idle', `[${paneLabel}] やり直しました: ${next.op}`);
  setTimeout(() => setStatus(state.isRecording ? 'listening' : 'idle',
                              state.isRecording ? '録音中' : '停止'), 2000);
}

function updatePaneUndoRedoButtons() {
  const sid = state.activeId;
  for (const paneId of Object.keys(PANE_FIELD)) {
    const s = paneStacks[paneId];
    const undoBtn = document.querySelector(`[data-pane-undo="${paneId}"]`);
    const redoBtn = document.querySelector(`[data-pane-redo="${paneId}"]`);
    const paneLabel = PANE_META[paneId]?.label || paneId;
    // 現在セッションに属する最新エントリだけ考慮
    const undoIdx = _topForSession(s.undo, sid);
    const redoIdx = _topForSession(s.redo, sid);
    if (undoBtn) {
      undoBtn.disabled = undoIdx < 0;
      const last = undoIdx >= 0 ? s.undo[undoIdx] : null;
      undoBtn.title = last
        ? `${paneLabel}を戻す: ${last.op} (Ctrl+Z)`
        : `${paneLabel}を戻す — なし`;
    }
    if (redoBtn) {
      redoBtn.disabled = redoIdx < 0;
      const next = redoIdx >= 0 ? s.redo[redoIdx] : null;
      redoBtn.title = next
        ? `${paneLabel}をやり直す: ${next.op} (Ctrl+Shift+Z)`
        : `${paneLabel}をやり直す — なし`;
    }
  }
}

// 旧名との互換（既存の呼び出しを壊さないため残す）
function updateUndoRedoButtons() { updatePaneUndoRedoButtons(); }
function updateUndoButton() { updatePaneUndoRedoButtons(); }
function doUndo() { doPaneUndo(state.activePane || 'pane-transcript'); }
function doRedo() { doPaneRedo(state.activePane || 'pane-transcript'); }

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
  // 内側ラッパ .inner-tabs-list が無ければ作る（外側タブの #tabs-list と同構造）
  // これでアクティブ線 indicator が位置: relative の基準を持てる
  let listEl = els.innerTabsContainer.querySelector('.inner-tabs-list');
  if (!listEl) {
    els.innerTabsContainer.innerHTML = '';
    listEl = document.createElement('div');
    listEl.className = 'inner-tabs-list';
    els.innerTabsContainer.appendChild(listEl);
  }

  // renderTabs と同じく indicator を renderInnerTabs を跨いで保持
  let indicator = listEl.__activeIndicator;
  if (indicator && indicator.parentElement === listEl) indicator.remove();

  listEl.innerHTML = '';
  for (const id of state.settings.paneOrder) {
    const meta = PANE_META[id];
    if (!meta) continue;
    const btn = document.createElement('button');
    btn.className = 'inner-tab' + (state.activePane === id ? ' active' : '');
    btn.dataset.pane = id;
    btn.innerHTML = `<span class="inner-tab-icon" data-icon="${meta.icon}"></span>${meta.label}`;
    btn.addEventListener('click', () => switchInnerPane(id));
    listEl.appendChild(btn);
  }

  // indicator を再アペンド（新規なら作る）
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'inner-tab-active-indicator';
    listEl.__activeIndicator = indicator;
  }
  listEl.appendChild(indicator);

  renderIcons(listEl);
  enablePointerDragSort(listEl, {
    itemSelector: '.inner-tab',
    idAttr: 'pane',
    onReorder: reorderPaneOrder,
  });

  requestAnimationFrame(updateInnerTabsIndicator);
}

/* 内側タブのアクティブ線を現在位置に滑らす */
function updateInnerTabsIndicator() {
  const listEl = els.innerTabsContainer && els.innerTabsContainer.querySelector('.inner-tabs-list');
  const bar = listEl && listEl.__activeIndicator;
  if (!bar) return;
  const activeTab = listEl.querySelector('.inner-tab.active');
  if (!activeTab) {
    bar.classList.remove('visible');
    return;
  }
  const x = activeTab.offsetLeft;
  const w = activeTab.offsetWidth;
  const firstShow = !bar.classList.contains('visible');
  if (firstShow) {
    const saved = bar.style.transition;
    bar.style.transition = 'none';
    bar.style.transform = `translateX(${x}px)`;
    bar.style.width = `${w}px`;
    void bar.offsetWidth;
    bar.style.transition = saved;
    requestAnimationFrame(() => bar.classList.add('visible'));
  } else {
    bar.style.transform = `translateX(${x}px)`;
    bar.style.width = `${w}px`;
  }
}

function reorderPaneOrder(newOrder) {
  if (!Array.isArray(newOrder) || newOrder.length !== state.settings.paneOrder.length) return;
  state.settings.paneOrder = newOrder;
  saveSettings();
  applyPaneOrder();
}

/* ───────── Chat (NotebookLM風) ───────── */

function renderChatInto(container, emptyHint, scrollContainer) {
  if (!container) return;
  const session = getActiveSession();
  const chat = session?.chat || [];
  container.innerHTML = '';
  if (chat.length === 0) {
    if (emptyHint) emptyHint.hidden = false;
    return;
  }
  if (emptyHint) emptyHint.hidden = true;
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
    container.appendChild(div);
  }
  if (scrollContainer) {
    requestAnimationFrame(() => { scrollContainer.scrollTop = scrollContainer.scrollHeight; });
  }
}

function renderChat() {
  renderChatInto(els.chatMessages, els.chatEmpty, els.chatBody);
  if (els.quickChatModal && !els.quickChatModal.classList.contains('hidden')) {
    renderChatInto(els.quickChatMessages, els.quickChatEmpty, els.quickChatBody);
  }
}

function resizeChatInput() {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = Math.min(200, els.chatInput.scrollHeight) + 'px';
}

async function sendChatMessageFrom(inputEl, sendBtn) {
  const text = inputEl.value.trim();
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
  clearNotionUploadedMark(session);
  session.chat.push({ role: 'user', content: text, ts: Date.now() });
  inputEl.value = '';
  inputEl.style.height = '';
  const thinking = { role: 'assistant', content: '', ts: Date.now(), thinking: true };
  session.chat.push(thinking);
  renderChat();
  if (sendBtn) sendBtn.disabled = true;

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
    if (sendBtn) sendBtn.disabled = false;
    inputEl.focus();
  }
}

async function sendChatMessage() {
  return sendChatMessageFrom(els.chatInput, els.btnChatSend);
}
async function sendQuickChatMessage() {
  return sendChatMessageFrom(els.quickChatInput, els.btnQuickChatSend);
}

/* ───────── Auto title ───────── */

function formatDatePart(ts) {
  const d = new Date(ts);
  const pad = x => String(x).padStart(2, '0');
  return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * セッションの transcript/summary HTML からプレーンテキストを取り出す
 * （アクティブセッションは DOM から、それ以外はストアされた HTML から）
 */
function htmlToPlain(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.innerText || tmp.textContent || '').trim();
}

async function autoGenerateTitle({ silent = true, force = false, sessionId = null } = {}) {
  // 対象セッションをIDで固定（非同期中に activeId が変わっても誤適用しない）
  const targetId = sessionId || state.activeId;
  let session = state.sessions.find(s => s.id === targetId);
  if (!session) return;
  if (!force && session.titleIsManual) return;
  if (!state.settings.apiKey) {
    if (!silent) { alert('Gemini API キーが未設定です。設定から登録してください。'); openSettings(); }
    return;
  }
  // auto（録音停止時等）は aiEnabled に従う。手動再生成（force）は常に実行。
  if (!force && !state.settings.aiEnabled) return;
  // 対象セッションが現在表示中ならDOMから、そうでなければストアHTMLから読む
  const transcript = (targetId === state.activeId)
    ? getConfirmedText()
    : htmlToPlain(session.transcript);
  const summary = (targetId === state.activeId)
    ? getSummaryText()
    : htmlToPlain(session.summary);
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
    // 非同期から戻ってきた時点でセッションがまだ存在するか再確認
    session = state.sessions.find(s => s.id === targetId);
    if (!session) return;
    session.aiTitle = aiTitle;
    session.title = `${aiTitle}(${formatDatePart(session.createdAt)})`;
    session.titleIsManual = false;
    session.updatedAt = Date.now();
    persistSessions();
    renderTabs();
    // 表示中ならタイトルバーも更新
    if (targetId === state.activeId) renderTitleBar();
  } catch (e) {
    console.warn('auto title failed:', e);
    if (!silent) alert('タイトル生成に失敗しました: ' + (e.message || String(e)));
  }
}

/* ───────── Summary generation ───────── */

async function generateSummary({ silent = false, sessionId = null } = {}) {
  if (state.isSummarizing) return;
  // 対象セッションをIDで固定（非同期中にタブ切替されても安全に）
  const targetId = sessionId || state.activeId;
  let session = state.sessions.find(s => s.id === targetId);
  if (!session) return;
  const transcript = (targetId === state.activeId)
    ? getConfirmedText()
    : htmlToPlain(session.transcript);
  if (!transcript) {
    if (!silent) alert('文字起こしが空です。要約を生成できません。');
    return;
  }
  if (!state.settings.apiKey) {
    if (!silent) { alert('Gemini API キーが未設定です。設定から登録してください。'); openSettings(); }
    return;
  }
  // 要約は既存内容を置き換える破壊的操作。Undoスタックに退避（対象セッションがアクティブな時のみ）
  if (targetId === state.activeId && (session.summary || '').trim()) {
    pushUndo(silent ? '要約自動生成' : '要約生成', 'pane-summary');
  }
  state.isSummarizing = true;
  // 表示中のセッションだった場合のみ UI にローディング表示
  const wasActive = (targetId === state.activeId);
  if (wasActive) {
    els.summary.classList.add('generating');
    els.summaryEmpty.hidden = true;
    if (els.btnSummaryCombo) els.btnSummaryCombo.classList.add('firing');
  }
  setStatus('listening', '要約生成中');
  try {
    const summary = await summarizeWithGemini({
      apiKey: state.settings.apiKey,
      transcript,
      title: session?.title,
      detail: state.settings.summaryDetail || 'medium',
    });
    // 非同期戻り後にセッションが生きているか再確認
    session = state.sessions.find(s => s.id === targetId);
    if (!session) return;
    const summaryHtml = renderMarkdown(summary);
    // セッションデータに直接書く（DOMは現在のactiveIdのものなので使わない）
    session.summary = summaryHtml;
    session.updatedAt = Date.now();
    persistSessions();
    // 対象セッションが今も表示中ならDOMにも反映
    if (targetId === state.activeId) {
      els.summary.innerHTML = summaryHtml;
      els.summaryEmpty.hidden = true;
      updateActionButtons();
      if (!silent) {
        switchInnerPane('pane-summary');
        autoGenerateTitle({ sessionId: targetId });
      }
    }
    // silent モードの場合、呼び出し側（stopRecording 等）が
    // 明示的に autoGenerateTitle を呼ぶのでここでは呼ばない
  } catch (e) {
    console.error('Summary generation failed:', e);
    if (!silent) alert('要約生成に失敗しました: ' + e.message);
  } finally {
    state.isSummarizing = false;
    if (wasActive && targetId === state.activeId) {
      els.summary.classList.remove('generating');
      if (els.btnSummaryCombo) els.btnSummaryCombo.classList.remove('firing');
    }
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
    // グループ決定（単体 or 複数選択）
    const getGroup = getOpts().getDragGroup;
    const group = getGroup ? getGroup(item) : [item];
    activeItem.__dragGroup = group;
    group.forEach(el => el.classList.add('dragging'));
    ghost = createGhost(item);
    // 複数選択のドラッグならゴーストに件数バッジを表示
    if (group.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'drag-ghost-badge';
      badge.textContent = '× ' + group.length;
      ghost.appendChild(badge);
    }
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
    const group = activeItem.__dragGroup || [activeItem];
    group.forEach(el => el.classList.remove('dragging'));

    ghost = null;
    const hovered = document.elementFromPoint(e.clientX, e.clientY);
    let target = hovered ? hovered.closest(itemSelector) : null;
    // グループ内のタブは drop target にできない（自分自身への移動は無意味）
    if (target && group.includes(target)) target = null;

    if (target && list.contains(target)) {
      // FLIP: First ── 並べ替え前の位置を記録
      const itemsBefore = Array.from(list.querySelectorAll(itemSelector));
      const firstRects = new Map();
      itemsBefore.forEach(el => firstRects.set(el, el.getBoundingClientRect()));

      const horiz = detectHorizontal();
      const r = target.getBoundingClientRect();
      const before = horiz
        ? e.clientX < r.left + r.width / 2
        : e.clientY < r.top + r.height / 2;

      // グループを一旦外して、ターゲット位置に挿入（グループの並び順は保持）
      group.forEach(el => el.remove());
      const insertRef = before ? target : target.nextSibling;
      // insertBefore(item, ref) は item を ref の直前に挿入。
      // グループを順番に insertBefore すると、各要素が ref の直前に積み重なる形で
      // 結果として group[0], group[1], ..., ref の順に並ぶ。
      for (const el of group) {
        list.insertBefore(el, insertRef);
      }

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

      // ドラッグで並び順が変わったら、アクティブ線（下のスライド指示線）の
      // 位置が古いままになるので、FLIPアニメ完了後に再計算
      if (typeof updateActiveTabIndicator === 'function') {
        setTimeout(() => updateActiveTabIndicator(), 340);
      }
      if (typeof updateInnerTabsIndicator === 'function') {
        setTimeout(() => updateInnerTabsIndicator(), 340);
      }
    }
    clearHighlights();
    try { list.releasePointerCapture(pointerId); } catch {}

    // 直後の click を抑止（ドラッグ結果で予期せぬ切替を防ぐ）
    if (isDragging) {
      const suppress = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', suppress, { capture: true, once: true });
    }

    if (activeItem) activeItem.__dragGroup = null;
    activeItem = null;
    pointerId = null;
    isDragging = false;
  }

  list.addEventListener('pointerdown', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item || !list.contains(item)) return;
    // ボタン/入力欄クリックはドラッグ発動しない
    if (e.target !== item && e.target.closest('button, input, textarea, select, [contenteditable="true"]')) return;
    // 左クリック（主ボタン）以外はドラッグ対象外（右クリックは contextmenu に任せる）
    if (e.button !== undefined && e.button !== 0) return;

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

/* ───────── 録音の文脈（語彙ヒント） v0.16.0 ─────────
 *
 * 講義や会議は分野の語彙がほぼ決まっている。同音異義語と固有名詞は音だけでは
 * 決められないので、先に語を渡して選ばせる。
 * 実測例: Web Speech が「Gemini」を「ジムニー」と書いた。これは語彙で防げる誤り。
 *
 * 渡す先は音声文字起こし（transcribeAudioWithGemini）と整形（refineWithGemini）の両方。
 * Web Speech モードでも整形の段で誤変換を直せることがあるため。
 */

/** 「改行/カンマ/読点」区切りの文字列 → 語の配列 */
function splitTerms(text) {
  return String(text || '').split(/[\n,、]/).map(t => t.trim()).filter(Boolean);
}

/**
 * Gemini に渡す文脈。手入力と自動抽出をまとめる。
 * 中身が空なら undefined を返し、プロンプトに何も足さない（従来と同じ挙動になる）。
 *
 * 手入力を先に並べる。やっさんが書いた語が最終権限で、
 * 自動抽出はその補いという位置づけ（v0.16.1）。
 */
function getSessionContextForAi() {
  const s = getActiveSession();
  const c = s?.context;
  if (!c) return undefined;

  const manual = splitTerms(c.terms);
  const auto = (s.autoContext?.terms || []).filter(t => !manual.includes(t));
  const terms = manual.concat(auto);

  const ctx = {
    field: (c.field || '').trim(),
    speakers: (c.speakers || '').trim(),
    terms: terms.join('、'),
    topicPath: s.autoContext?.topicPath || [],
    flow: s.autoContext?.flow || '',
  };
  const has = ctx.field || ctx.speakers || ctx.terms || ctx.topicPath.length || ctx.flow;
  return has ? ctx : undefined;
}

/* ───────── 文脈の自動抽出 (v0.16.1) ─────────
 *
 * メモが空でも文脈を効かせるため、記録が溜まってきたら語彙と議題を拾い直す。
 * 録音中に一定間隔で走らせ、停止時にも1回走らせる。
 */

const CONTEXT_EXTRACT_INTERVAL_MS = 120 * 1000;   // 2分ごと
let contextExtractInFlight = false;

/** メモの見出し・箇条書きだけを取り出す（抽出の手がかりとして最優先で渡す） */
function getMemoOutlineText() {
  const lines = [];
  els.memo.querySelectorAll('h1, h2, h3, li, .task-item').forEach(el => {
    const t = (el.innerText || '').trim();
    if (t && t.length <= 60) lines.push(t);
  });
  return lines.slice(0, 40).join('\n');
}

/**
 * 記録から語彙と議題を拾って session.autoContext を更新する。
 * @param {object} [opts]
 * @param {boolean} [opts.force] - 間隔を無視して実行（録音停止時など）
 */
async function refreshAutoContext(opts = {}) {
  if (contextExtractInFlight) return;
  if (!state.settings.aiEnabled || !state.settings.apiKey) return;

  const session = getActiveSession();
  if (!session) return;
  const auto = session.autoContext || (session.autoContext = { terms: [], topicPath: [], flow: '', updatedAt: 0 });
  if (!opts.force && Date.now() - (auto.updatedAt || 0) < CONTEXT_EXTRACT_INTERVAL_MS) return;

  // 末尾側だけ渡す。全文を毎回送ると長くなるうえ、いま何の話かは直近で決まる
  const full = getConfirmedText();
  if (!full || full.length < 200) return;
  const tail = full.slice(-4000);

  contextExtractInFlight = true;
  try {
    const out = await extractContextWithGemini({
      apiKey: state.settings.apiKey,
      transcript: tail,
      memoOutline: getMemoOutlineText(),
      knownTerms: splitTerms(session.context?.terms),
    });
    // 非同期の間にセッションが閉じられている可能性がある
    const still = state.sessions.find(x => x.id === session.id);
    if (!still) return;
    still.autoContext = {
      terms: out.terms,
      topicPath: out.topicPath,
      flow: out.flow,
      updatedAt: Date.now(),
    };
    persistSessions();
    diagLog.info(`文脈を更新: 語${out.terms.length}件 / 議題「${out.topicPath.join(' > ') || '—'}」`);
    // 文脈モーダルを開いていたら表示も更新する
    if (els.contextModal && !els.contextModal.classList.contains('hidden')) renderAutoContext(still);
  } catch (e) {
    console.warn('[context] 自動抽出に失敗:', e.message);
  } finally {
    contextExtractInFlight = false;
  }
}

/** 文脈モーダルの「自動で拾った内容」欄を描く */
function renderAutoContext(session) {
  if (!els.autoContextBox) return;
  const a = session?.autoContext;
  const hasAny = a && (a.terms?.length || a.topicPath?.length || a.flow);
  if (!hasAny) {
    els.autoContextBox.textContent = '（まだありません。録音が2〜3分進むと自動で埋まります）';
    els.btnContextAdoptAuto.disabled = true;
    return;
  }
  const lines = [];
  if (a.topicPath?.length) lines.push(`いまの議題: ${a.topicPath.join(' > ')}`);
  if (a.flow) lines.push(`流れ: ${a.flow}`);
  if (a.terms?.length) lines.push(`拾った語: ${a.terms.join('、')}`);
  els.autoContextBox.textContent = lines.join('\n');
  els.btnContextAdoptAuto.disabled = !a.terms?.length;
}

/** 自動で拾った語を、手入力の欄に移す（以後そちらが最終権限になる） */
function adoptAutoTerms() {
  const s = getActiveSession();
  const auto = s?.autoContext?.terms || [];
  if (!auto.length) return;
  const existing = splitTerms(els.inputContextTerms.value);
  const added = auto.filter(t => !existing.includes(t));
  els.inputContextTerms.value = existing.concat(added).join('\n');
  els.contextMemoResult.textContent = added.length
    ? `自動で拾った語から ${added.length}件を追加しました。ここで直せます`
    : 'すでにすべて登録済みでした';
  els.contextMemoResult.className = 'field-hint notion-test-result ' + (added.length ? 'is-ok' : 'is-note');
}

function openContextModal() {
  const s = getActiveSession();
  if (!s) return;
  if (!s.context) s.context = { field: '', speakers: '', terms: '' };
  els.inputContextField.value = s.context.field || '';
  els.inputContextSpeakers.value = s.context.speakers || '';
  els.inputContextTerms.value = s.context.terms || '';
  els.inputContextDefault.checked = false;
  els.contextMemoResult.textContent = '';
  els.contextMemoResult.className = 'field-hint';
  renderAutoContext(s);
  els.contextModal.classList.remove('hidden');
  els.inputContextField.focus();
}

function closeContextModal() {
  els.contextModal.classList.add('hidden');
}

function saveContextModal() {
  const s = getActiveSession();
  if (!s) return closeContextModal();
  s.context = {
    field: els.inputContextField.value.trim(),
    speakers: els.inputContextSpeakers.value.trim(),
    terms: els.inputContextTerms.value.trim(),
  };
  if (els.inputContextDefault.checked) {
    state.settings.defaultContextField = s.context.field;
    state.settings.defaultContextSpeakers = s.context.speakers;
    state.settings.defaultContextTerms = s.context.terms;
    saveSettings();
  }
  persistSessions();
  closeContextModal();
}

/**
 * メモペインから語彙を拾う。
 * 見出し・箇条書き・チェック項目の「行」を候補にして、既存の語と重複しないものを足す。
 * 文章まるごとではなく短い語だけを拾う（長文を語彙として渡しても効かないうえ、
 * 台本として読まれる危険が増すため）。
 */
function importContextFromMemo() {
  const lines = [];
  els.memo.querySelectorAll('h1, h2, h3, li, .task-item').forEach(el => {
    const t = (el.innerText || '').trim();
    if (t) lines.push(t);
  });

  // 1行が長いものは語彙ではなく文なので除く。記号だけの行も捨てる
  const picked = [];
  for (const raw of lines) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 30) continue;
    if (!/[\u3040-\u30ff\u4e00-\u9fff a-zA-Z0-9]/.test(t)) continue;
    if (!picked.includes(t)) picked.push(t);
  }

  if (picked.length === 0) {
    els.contextMemoResult.textContent = 'メモに拾える見出し・箇条書きがありませんでした';
    els.contextMemoResult.className = 'field-hint notion-test-result is-ng';
    return;
  }

  const existing = els.inputContextTerms.value.split(/[\n,、]/).map(x => x.trim()).filter(Boolean);
  const added = picked.filter(t => !existing.includes(t));
  els.inputContextTerms.value = existing.concat(added).join('\n');
  els.contextMemoResult.textContent = added.length
    ? `${added.length}件を追加しました（重複は除いています）`
    : 'メモの内容はすべて登録済みでした';
  els.contextMemoResult.className = 'field-hint notion-test-result ' + (added.length ? 'is-ok' : 'is-note');
}

/* ───────── Notion 連携の設定 UI (v0.14.1) ───────── */

/** 接続テスト欄の色を design-system の変数で塗り分ける（style.css の .notion-test-result） */
function setNotionTestResult(msg, kind = 'note') {
  if (!els.notionTestResult) return;
  els.notionTestResult.textContent = msg;
  els.notionTestResult.classList.remove('is-ok', 'is-ng', 'is-note');
  if (msg) els.notionTestResult.classList.add(`is-${kind}`);
}

/** 設定モーダルを開くたびに、トークン・前回の保存先・環境の制約を反映する */
function syncNotionSettingsUi() {
  if (!els.inputNotionToken) return;
  els.inputNotionToken.value = state.settings.notionToken || '';
  setNotionTestResult('');

  if (els.notionLastTarget) {
    const t = state.settings.notionLastDataSourceTitle;
    const d = state.settings.notionLastDatePropName;
    els.notionLastTarget.textContent = t ? (d ? `${t}（録音日時 → ${d}）` : t) : '（まだありません）';
  }
  if (els.btnNotionForget) {
    els.btnNotionForget.disabled = !state.settings.notionLastDataSourceId;
  }

  // HTML 版では api.notion.com が CORS で叩けない。設定はできるが使えない旨を出す。
  if (!notionIsAvailable()) {
    setNotionTestResult('HTML版では利用できません（Chrome拡張版で使えます）', 'note');
    if (els.btnNotionTest) els.btnNotionTest.disabled = true;
  } else if (els.btnNotionTest) {
    els.btnNotionTest.disabled = false;
  }
}

async function testNotionConnection() {
  const token = els.inputNotionToken.value.trim();
  if (!token) {
    setNotionTestResult('トークンを入力してください', 'ng');
    return;
  }
  els.btnNotionTest.disabled = true;
  setNotionTestResult('確認中…', 'note');
  try {
    const name = await notionTestConnection(token);
    const list = await notionListDataSources(token);
    if (list.length === 0) {
      setNotionTestResult(`${name} に接続できましたが、保存先に使えるデータベースが 0 件です。Notion 側でデータベースを「コネクト」してください`, 'ng');
    } else {
      setNotionTestResult(`OK: ${name} — 保存先に使えるデータベース ${list.length} 件`, 'ok');
    }
  } catch (e) {
    setNotionTestResult('NG: ' + e.message, 'ng');
    console.warn('[notion] 接続テスト失敗:', e.message); // console.warn は diagLog に記録される
  } finally {
    els.btnNotionTest.disabled = false;
  }
}

function forgetNotionTarget() {
  state.settings.notionLastDataSourceId = '';
  state.settings.notionLastDataSourceTitle = '';
  state.settings.notionLastDatePropName = '';
  saveSettings();
  syncNotionSettingsUi();
}

function openSettings() {
  els.inputApiKey.value = state.settings.apiKey;
  syncNotionSettingsUi();
  els.inputSilenceSec.value = state.settings.silenceSec;
  els.inputAiEnabled.checked = state.settings.aiEnabled;
  els.inputAutoStop.checked = state.settings.autoStopEnabled;
  els.inputAutoStopSec.value = state.settings.autoStopSec;
  els.inputAutoSummarize.checked = state.settings.autoSummarize;
  const detail = state.settings.summaryDetail || 'medium';
  if (detail === 'low') els.summaryDetailLow.checked = true;
  else if (detail === 'high') els.summaryDetailHigh.checked = true;
  else els.summaryDetailMedium.checked = true;
  // 音声入力モード
  if (state.settings.inputMode === 'gemini-audio') {
    els.modeGemini.checked = true;
  } else {
    els.modeWebSpeech.checked = true;
  }
  els.inputChunkSec.value = state.settings.audioChunkSec || 12;
  if (els.inputSilenceCut) els.inputSilenceCut.checked = state.settings.audioSilenceCut !== false;
  if (els.inputChunkMaxSec) els.inputChunkMaxSec.value = state.settings.audioChunkMaxSec || 20;
  if (els.inputAudioBitrate) els.inputAudioBitrate.value = String(state.settings.audioBitrate || 64000);
  if (els.inputKeepRecording) els.inputKeepRecording.checked = !!state.settings.audioKeepRecording;
  if (els.inputAudioRetention) els.inputAudioRetention.value = state.settings.audioRetention || 'repass';
  refreshAudioUsage();
  if (els.inputGeminiLiveDisplay) els.inputGeminiLiveDisplay.checked = state.settings.geminiLiveDisplay !== false;
  if (els.inputMinChunkBytes) els.inputMinChunkBytes.value = state.settings.audioMinChunkBytes ?? 400;
  if (els.inputWsCommitSec) {
    // v0.13.29: localStorage に古い値（3/4/5 等、v0.13.26 で削除した選択肢）が
    // 残っていると、UI のセレクトが空欄表示になる（option に value マッチがない）。
    // 妥当な選択肢に含まれない値は既定 6 にフォールバックして state.settings も
    // 即時更新（次回 saveSettingsFromForm で localStorage にも反映される）。
    let v = Number(state.settings.webspeechCommitSec ?? 6);
    if (![0, 6, 8, 10].includes(v)) v = 6;
    els.inputWsCommitSec.value = String(v);
    state.settings.webspeechCommitSec = v;
  }
  if (els.inputWsSliceChars) {
    // v0.13.31: 改行文字数。number input（10〜100）。範囲外は既定 30 にクランプ。
    let v = Number(state.settings.webspeechSliceChars ?? 30);
    if (!Number.isFinite(v) || v < 10 || v > 100) v = 30;
    els.inputWsSliceChars.value = String(v);
    state.settings.webspeechSliceChars = v;
  }
  if (els.inputWsSilenceStopSec) {
    // v0.13.31: 無音 stop 秒数。number input（0〜10、0=OFF）。範囲外は既定 3。
    let v = Number(state.settings.webspeechSilenceStopSec ?? 3);
    if (!Number.isFinite(v) || v < 0 || v > 10) v = 3;
    els.inputWsSilenceStopSec.value = String(v);
    state.settings.webspeechSilenceStopSec = v;
  }
  populateAudioDevices();
  applyGeminiOnlyVisibility(/* animated */ false);
  applyWebSpeechOnlyVisibility(/* animated */ false);
  els.fontTranscript.value = state.settings.transcriptFont;
  els.sizeTranscript.value = state.settings.transcriptSize;
  els.fontMemo.value = state.settings.memoFont;
  els.sizeMemo.value = state.settings.memoSize;
  els.fontSummary.value = state.settings.summaryFont;
  els.sizeSummary.value = state.settings.summarySize;
  settingsWorkingOrder = state.settings.paneOrder.slice();
  renderPaneOrderList();
  // 診断ログビューアを最新状態で描画
  const diagViewer = document.getElementById('diag-log-viewer');
  if (diagViewer) diagLog.renderInto(diagViewer);
  els.settingsModal.classList.remove('hidden');
  setTimeout(() => els.inputApiKey.focus(), 80);
}

function closeSettings() {
  els.settingsModal.classList.add('hidden');
}

function saveSettingsFromForm() {
  state.settings.apiKey = els.inputApiKey.value.trim();
  if (els.inputNotionToken) state.settings.notionToken = els.inputNotionToken.value.trim();
  state.settings.silenceSec = Math.max(1, Math.min(30, Number(els.inputSilenceSec.value) || 3));
  state.settings.aiEnabled = els.inputAiEnabled.checked;
  state.settings.autoStopEnabled = els.inputAutoStop.checked;
  state.settings.autoStopSec = Math.max(30, Math.min(600, Number(els.inputAutoStopSec.value) || 120));
  state.settings.autoSummarize = els.inputAutoSummarize.checked;
  state.settings.summaryDetail =
    els.summaryDetailLow.checked ? 'low' :
    els.summaryDetailHigh.checked ? 'high' : 'medium';
  state.settings.inputMode = els.modeGemini.checked ? 'gemini-audio' : 'web-speech';
  state.settings.audioDeviceId = els.inputAudioDevice ? els.inputAudioDevice.value : '';
  state.settings.audioChunkSec = Math.max(5, Math.min(60, Number(els.inputChunkSec.value) || 12));
  if (els.inputSilenceCut) state.settings.audioSilenceCut = els.inputSilenceCut.checked;
  if (els.inputAudioBitrate) {
    const br = Number(els.inputAudioBitrate.value);
    state.settings.audioBitrate = Number.isFinite(br) && br >= 16000 ? br : 64000;
  }
  if (els.inputKeepRecording) {
    const wasOn = !!state.settings.audioKeepRecording;
    state.settings.audioKeepRecording = els.inputKeepRecording.checked;
    // オフに切り替えたら、残っている分をその場で消す（次の起動を待たない）
    if (wasOn && !state.settings.audioKeepRecording) {
      audioStoreClearAll()
        .then(n => { if (n > 0) diagLog.info(`保持をオフにしたので音声 ${n} 件を消しました`); })
        .catch(() => {})
        .finally(refreshAudioUsage);
    }
  }
  if (els.inputAudioRetention) state.settings.audioRetention = els.inputAudioRetention.value || 'repass';
  if (els.inputChunkMaxSec) {
    // 最長は最短より短くできない（短いと無音を探す余地が消える）
    state.settings.audioChunkMaxSec = Math.max(
      state.settings.audioChunkSec + 2,
      Math.min(90, Number(els.inputChunkMaxSec.value) || 20),
    );
  }
  if (els.inputGeminiLiveDisplay) state.settings.geminiLiveDisplay = els.inputGeminiLiveDisplay.checked;
  if (els.inputMinChunkBytes) state.settings.audioMinChunkBytes = Math.max(100, Math.min(5000, Number(els.inputMinChunkBytes.value) || 400));
  if (els.inputWsCommitSec) {
    const newSec = Math.max(0, Math.min(20, Number(els.inputWsCommitSec.value) || 0));
    if (newSec !== state.settings.webspeechCommitSec) {
      state.settings.webspeechCommitSec = newSec;
      // 録音中なら即時タイマー反映
      if (typeof restartWebSpeechCommitTimer === 'function') restartWebSpeechCommitTimer();
    }
  }
  if (els.inputWsSliceChars) {
    // v0.13.31: 改行文字数。10〜100 にクランプ。設定変更は次の onresult から効くので即時反映処理は不要。
    const newN = Math.max(10, Math.min(100, Number(els.inputWsSliceChars.value) || 30));
    state.settings.webspeechSliceChars = newN;
  }
  if (els.inputWsSilenceStopSec) {
    // v0.13.31: 無音 stop 秒数。0〜10 にクランプ。次の onresult からタイマーが新しい値で動くので即時反映処理は不要。
    const newSec = Math.max(0, Math.min(10, Number(els.inputWsSilenceStopSec.value) || 0));
    state.settings.webspeechSilenceStopSec = newSec;
  }
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
      // 0.5s フェード: 480ms で透明、位置切替、480ms でフェードイン
      setTimeout(() => {
        document.body.classList.toggle('chat-active', willBeChat);
        zb.classList.remove('fading');
      }, 480);
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
  // アクティブ線（下の色バー）を新しいアクティブタブへ滑らす
  if (typeof updateInnerTabsIndicator === 'function') updateInnerTabsIndicator();
  // 検索バー等のリスナーに通知
  document.dispatchEvent(new CustomEvent('dictation:paneSwitched', { detail: { paneId } }));
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
    // v0.16.0: 文脈が無い古いセッションに空の器を足す
    if (!s.context || typeof s.context !== 'object') s.context = { field: '', speakers: '', terms: '' };
    if (!s.autoContext || typeof s.autoContext !== 'object') {
      s.autoContext = { terms: [], topicPath: [], flow: '', updatedAt: 0 };
    }
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
    // v0.16.0: 文字起こしの語彙ヒント。既定値を引き継いで開始する
    context: {
      field: state.settings.defaultContextField || '',
      speakers: state.settings.defaultContextSpeakers || '',
      terms: state.settings.defaultContextTerms || '',
    },
    // v0.16.1: 記録から自動で拾った語彙と議題。手入力とは別に持ち、手入力を優先する
    autoContext: { terms: [], topicPath: [], flow: '', updatedAt: 0 },
  };
  state.sessions.push(session);
  if (activate) state.activeId = id;
  if (!skipSave) persistSessions();
  renderTabs();
  if (activate) {
    loadActiveSessionIntoDOM();
    // v0.13.31: 新規タブは末尾に追加されるので、scrollWidth まで一発で行けば必ず見える。
    // 旧 scrollActiveTabIntoView は新規 DOM のレイアウト前に getBoundingClientRect を取って
    // 「最新タブの手前で止まる」事故が起きていた（やっさん指摘）。
    scrollTabsToEnd();
  }
  return session;
}

function getActiveSession() {
  return state.sessions.find(s => s.id === state.activeId);
}

function snapshotActiveToSession(opts = {}) {
  const s = getActiveSession();
  if (!s) return;
  const nextTranscript = els.confirmed.innerHTML;
  const nextMemo       = els.memo.innerHTML;
  const nextSummary    = els.summary.innerHTML;
  // v0.15.1: Notion に上げたあとで中身が変わったら、アップ済み印を外す。
  // 「印は付いているが最新版は上がっていない」状態を作らないため。
  if (s.notionUploadedAt &&
      (s.transcript !== nextTranscript || s.memo !== nextMemo || s.summary !== nextSummary)) {
    clearNotionUploadedMark(s);
  }
  s.transcript = nextTranscript;
  s.memo = nextMemo;
  s.summary = nextSummary;
  s.updatedAt = Date.now();
  // タイピングUndoの baseline も同期（autosave 由来の場合はスキップ：
  // ユーザーが入力中の可能性があり、baseline を上書きすると履歴が流れるため）
  if (!opts.fromAutosave && typeof paneLastStable !== 'undefined') {
    paneLastStable['pane-transcript'] = s.transcript;
    paneLastStable['pane-memo']       = s.memo;
    paneLastStable['pane-summary']    = s.summary;
  }
}

function migrateMemoTaskItems() {
  // 旧: <label class="task-item"> → 新: <div class="task-item">
  // label だとテキストクリックでもチェックが発火してしまうため
  const labels = els.memo.querySelectorAll('label.task-item');
  labels.forEach(label => {
    const div = document.createElement('div');
    div.className = label.className;
    while (label.firstChild) div.appendChild(label.firstChild);
    label.replaceWith(div);
  });
}

function loadActiveSessionIntoDOM() {
  const s = getActiveSession();
  els.confirmed.innerHTML = s?.transcript || '';
  els.memo.innerHTML = s?.memo || '';
  migrateMemoTaskItems();
  els.summary.innerHTML = s?.summary || '';
  els.interim.textContent = '';
  state.pendingChunkEl = null;
  state.pendingChunkText = '';
  if (els.emptyHint) els.emptyHint.hidden = !!els.confirmed.innerHTML;
  if (els.summaryEmpty) els.summaryEmpty.hidden = !!getSummaryText();
  updateMemoCheatsheetVisibility();
  renderChat();
  updateActionButtons();
  renderTitleBar();
  // Undo/Redo ボタンはセッションごとにフィルタされるので、セッション切替時にも更新
  if (typeof updatePaneUndoRedoButtons === 'function') updatePaneUndoRedoButtons();
  // タイピングUndoの基準状態をDOMから再同期（プログラム変更で baseline が古くなるのを防ぐ）
  if (typeof syncPaneBaselineFromDOM === 'function') syncPaneBaselineFromDOM();
  state.userScrolledUp = false;
  requestAnimationFrame(() => autoScroll(true));
}

function switchSession(id) {
  if (id === state.activeId) return;
  // 方向判定: 並びで右へ移動 → 新コンテンツは右から、左へ → 左から
  const oldIdx = state.sessions.findIndex(s => s.id === state.activeId);
  const newIdx = state.sessions.findIndex(s => s.id === id);
  const direction = (oldIdx >= 0 && newIdx >= 0 && newIdx < oldIdx) ? 'left' : 'right';

  // ===== BG録音対応: 録音は止めず、書き込み先を切替える =====
  const oldActiveId = state.activeId;
  const leavingRecordingSession = state.isRecording && state.recordingSessionId === oldActiveId && id !== state.recordingSessionId;
  const enteringRecordingSession = state.isRecording && state.recordingSessionId === id && oldActiveId !== state.recordingSessionId;

  if (leavingRecordingSession) diagLog.info(`BG録音開始（録音中のまま他タブへ）rec=${state.recordingSessionId?.slice(-6)} → view=${id?.slice(-6)}`);
  if (enteringRecordingSession) diagLog.info(`BG録音→FG復帰 rec=${state.recordingSessionId?.slice(-6)}`);

  if (leavingRecordingSession) {
    // FG → BG へ遷移: 現在のDOMを録音セッションに保存し、以降はBG要素に書き込む
    snapshotActiveToSession(); // recSessionに保存
    // DOM内容を bgTranscriptEl に移す（pendingChunkElも一緒に追従）
    if (!state.bgTranscriptEl) {
      state.bgTranscriptEl = document.createElement('div');
    }
    // els.confirmed の全子要素を bg に移動（pendingChunkEl の DOM参照はそのまま有効）
    while (els.confirmed.firstChild) {
      state.bgTranscriptEl.appendChild(els.confirmed.firstChild);
    }
    // bg の内容をセッションへ反映
    syncBgToSession();
    // pendingChunkEl/Text を一時退避（loadActiveSessionIntoDOM で null化されるのを回避）
    state._bgPendingChunkEl = state.pendingChunkEl;
    state._bgPendingChunkText = state.pendingChunkText;
  } else if (enteringRecordingSession) {
    // BG → FG へ遷移: 先に現DOMを現activeセッションに保存
    snapshotActiveToSession();
    // bgTranscriptEl の内容を録音セッションに同期（最新を持ってる）
    syncBgToSession();
    // bg は後で loadActiveSessionIntoDOM が session.transcript を els.confirmed に復元するので、破棄する
    state.bgTranscriptEl = null;
  } else {
    // 通常の切替（録音中でもFG録音中でない場合 or 録音外）
    snapshotActiveToSession();
  }
  persistSessions();

  state.activeId = id;
  persistSessions();
  renderTabs();
  loadActiveSessionIntoDOM();

  // FG→BG遷移時: loadActiveSessionIntoDOM が pendingChunkEl を null化するので、
  // 退避していた bg上の pendingChunkEl を復元（以降の appendRawChunk が同じ raw 段落に追記できる）
  if (leavingRecordingSession) {
    state.pendingChunkEl = state._bgPendingChunkEl || null;
    state.pendingChunkText = state._bgPendingChunkText || '';
    delete state._bgPendingChunkEl;
    delete state._bgPendingChunkText;
  }

  // BG→FG遷移時: 録音対象セッションに戻ったので、els.confirmed に入った内容から
  // pendingChunkEl を再検出する（raw クラスの末尾要素）
  if (enteringRecordingSession) {
    const raws = els.confirmed.querySelectorAll('.paragraph.raw');
    state.pendingChunkEl = raws[raws.length - 1] || null;
    if (state.pendingChunkEl) {
      const body = state.pendingChunkEl.querySelector('.p-body');
      state.pendingChunkText = body ? body.textContent.trim() : '';
    } else {
      state.pendingChunkText = '';
    }
  }

  // アクティブタブが見切れないよう横スクロール（renderTabs後の次フレームで）
  requestAnimationFrame(scrollActiveTabIntoView);

  // main-area 全体をスライドで切替
  if (els.mainArea && oldIdx >= 0 && newIdx >= 0 && oldIdx !== newIdx) {
    els.mainArea.classList.remove('enter-from-right', 'enter-from-left');
    void els.mainArea.offsetWidth;
    els.mainArea.classList.add(direction === 'right' ? 'enter-from-right' : 'enter-from-left');
    setTimeout(() => {
      els.mainArea.classList.remove('enter-from-right', 'enter-from-left');
    }, 320);
  }
}

function closeSession(id) {
  const idx = state.sessions.findIndex(s => s.id === id);
  if (idx < 0) return;
  const session = state.sessions[idx];
  const hasContent = session.transcript || session.memo || session.summary;
  if (hasContent && !confirm(`「${session.title}」を閉じます。この内容は削除されます。よろしいですか？`)) return;
  const wasActive = state.activeId === id;
  // 録音対象セッションが閉じられるなら（BGでも）録音を止める
  if (state.isRecording && state.recordingSessionId === id) stopRecording();
  // v0.19.0: タブが消えるなら、その音声も消す（設定に関係なく）
  audioStoreDeleteSession(id).catch(() => {});
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

/* ───────── タブの一括閉じ（Chrome タブ風） ───────── */

/** 指定したIDのリストを一括削除。中身ありは件数付きまとめ確認 */
function closeMultipleSessions(ids, { skipConfirm = false } = {}) {
  const targets = ids.map(id => state.sessions.find(s => s.id === id)).filter(Boolean);
  if (targets.length === 0) return;
  const withContent = targets.filter(s => s.transcript || s.memo || s.summary);
  if (!skipConfirm && withContent.length > 0) {
    const msg = withContent.length === targets.length
      ? `${targets.length}個のタブを閉じます。内容はすべて削除されます。よろしいですか？`
      : `${targets.length}個のタブを閉じます（うち${withContent.length}個に内容あり、削除されます）。よろしいですか？`;
    if (!confirm(msg)) return;
  }
  // 録音対象が含まれるなら先に停止
  if (state.isRecording && targets.some(s => s.id === state.recordingSessionId)) {
    stopRecording();
  }
  const activeIsTarget = targets.some(s => s.id === state.activeId);
  const idSet = new Set(targets.map(s => s.id));
  // v0.19.0: 消えるタブの音声も消す
  for (const id of idSet) audioStoreDeleteSession(id).catch(() => {});
  state.sessions = state.sessions.filter(s => !idSet.has(s.id));
  if (state.sessions.length === 0) {
    createSession({ activate: true, skipSave: true });
  } else if (activeIsTarget) {
    // 活性なセッションが消えたら、なるべく近い位置のタブを活性化
    state.activeId = state.sessions[0].id;
    loadActiveSessionIntoDOM();
  }
  state.selectedTabIds = new Set();
  state.selectionAnchorId = null;
  persistSessions();
  renderTabs();
}

function closeTabsToLeft(pivotId) {
  const idx = state.sessions.findIndex(s => s.id === pivotId);
  if (idx <= 0) return;
  closeMultipleSessions(state.sessions.slice(0, idx).map(s => s.id));
}

function closeTabsToRight(pivotId) {
  const idx = state.sessions.findIndex(s => s.id === pivotId);
  if (idx < 0 || idx >= state.sessions.length - 1) return;
  closeMultipleSessions(state.sessions.slice(idx + 1).map(s => s.id));
}

function closeOtherTabs(pivotId) {
  const others = state.sessions.filter(s => s.id !== pivotId).map(s => s.id);
  if (others.length === 0) return;
  closeMultipleSessions(others);
}

function closeAllTabs() {
  const all = state.sessions.map(s => s.id);
  if (all.length === 0) return;
  closeMultipleSessions(all);
}

/* ───────── タブ右クリック／長押しのコンテキストメニュー ───────── */

function hideTabContextMenu() {
  const menu = document.getElementById('tab-context-menu');
  if (menu) menu.classList.add('hidden');
}

// メニューを開いた瞬間の event がそのまま document まで伝播して
// 外側リスナーが「外でクリック/右クリックされた」と誤認して即閉じする問題を防ぐガード。
let _tabCtxMenuOpening = false;

function showTabContextMenu(sessionId, clientX, clientY) {
  // 開いたイベントと同じバブリング中の外側リスナーの誤発火を無効化
  _tabCtxMenuOpening = true;
  setTimeout(() => { _tabCtxMenuOpening = false; }, 0);

  let menu = document.getElementById('tab-context-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'tab-context-menu';
    menu.className = 'context-menu hidden';
    document.body.appendChild(menu);
    // 初回だけ外側クリック/Escで閉じるリスナーを設置
    document.addEventListener('click', (e) => {
      if (_tabCtxMenuOpening) return;
      if (!menu.contains(e.target)) hideTabContextMenu();
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (_tabCtxMenuOpening) return; // 開いた直後のイベントは無視
      if (!menu.contains(e.target)) hideTabContextMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.classList.contains('hidden')) hideTabContextMenu();
    });
  }
  const idx = state.sessions.findIndex(s => s.id === sessionId);
  const hasLeft = idx > 0;
  const hasRight = idx >= 0 && idx < state.sessions.length - 1;
  const hasOthers = state.sessions.length > 1;

  const items = [
    { label: 'このタブを閉じる', icon: 'x', onClick: () => closeSession(sessionId) },
    { sep: true },
    { label: '左のタブをすべて閉じる', icon: 'chevron-left', disabled: !hasLeft, onClick: () => closeTabsToLeft(sessionId) },
    { label: '右のタブをすべて閉じる', icon: 'chevron-right', disabled: !hasRight, onClick: () => closeTabsToRight(sessionId) },
    { label: '他のタブをすべて閉じる', icon: 'trash', disabled: !hasOthers, onClick: () => closeOtherTabs(sessionId) },
    { sep: true },
    { label: 'すべてのタブを閉じる', icon: 'trash', onClick: () => closeAllTabs(), danger: true },
  ];

  menu.innerHTML = '';
  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item' + (it.danger ? ' danger' : '');
    btn.disabled = !!it.disabled;
    btn.innerHTML = `<span class="cm-icon" data-icon="${it.icon}"></span><span class="cm-label">${it.label}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      if (!it.disabled) it.onClick();
    });
    menu.appendChild(btn);
  }
  renderIcons(menu);

  // 画面端を超えないよう位置を調整
  menu.style.visibility = 'hidden';
  menu.classList.remove('hidden');
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = clientX, y = clientY;
    if (x + rect.width > vw - 4) x = Math.max(4, vw - rect.width - 4);
    if (y + rect.height > vh - 4) y = Math.max(4, vh - rect.height - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.visibility = '';
  });
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
  // セッションから消えたIDはselectedから除く
  state.selectedTabIds = new Set(Array.from(state.selectedTabIds).filter(id =>
    state.sessions.some(s => s.id === id)
  ));

  els.tabsList.innerHTML = '';
  for (const session of state.sessions) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (session.id === state.activeId ? ' active' : '');
    // 録音中はアクティブ/非アクティブ問わず録音対象セッションを赤で示す
    if (state.isRecording && session.id === state.recordingSessionId) tab.classList.add('recording');
    // 複数選択中の非アクティブタブにハイライト（単体選択時は表示しない＝.active の線で十分）
    if (state.selectedTabIds.size > 1 && state.selectedTabIds.has(session.id)) {
      tab.classList.add('selected');
    }
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

    // 右クリック（またはタッチ長押し後のcontextmenu）でタブメニュー
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabContextMenu(session.id, e.clientX, e.clientY);
    });

    tab.addEventListener('click', (e) => {
      if (title.getAttribute('contenteditable') === 'true') return;
      // Ctrl/Cmd+クリック: 選択に追加/除外（アクティブセッションは切り替えない）
      if (e.ctrlKey || e.metaKey) {
        if (state.selectedTabIds.has(session.id)) state.selectedTabIds.delete(session.id);
        else state.selectedTabIds.add(session.id);
        state.selectionAnchorId = session.id;
        renderTabs();
        return;
      }
      // Shift+クリック: アンカーから範囲選択
      if (e.shiftKey) {
        const anchorId = state.selectionAnchorId || state.activeId;
        const ids = state.sessions.map(s => s.id);
        const a = ids.indexOf(anchorId);
        const b = ids.indexOf(session.id);
        if (a < 0 || b < 0) {
          state.selectedTabIds = new Set([session.id]);
        } else {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          state.selectedTabIds = new Set(ids.slice(lo, hi + 1));
        }
        renderTabs();
        return;
      }
      // 通常クリック: 選択をこのタブだけにリセットして、セッション切替
      state.selectedTabIds = new Set([session.id]);
      state.selectionAnchorId = session.id;
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

    // v0.15.0: Notion に保存済みの印。閉じずに残したタブを見分けるため。
    // Notion 側で消されたかどうかは追わない（やっさん指示）。
    if (session.notionUploadedAt) {
      const badge = document.createElement('span');
      badge.className = 'tab-uploaded';
      badge.innerHTML = '<span data-icon="cloud-upload" data-icon-size="11"></span>';
      badge.title = 'Notion に保存済み';
      tab.appendChild(badge);
    }
    tab.appendChild(title);
    tab.appendChild(closeBtn);
    els.tabsList.appendChild(tab);
  }
  // アクティブ線（再利用するため renderTabs を跨いで保持）
  let indicator = els.tabsList.__activeIndicator;
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'tab-active-indicator';
    els.tabsList.__activeIndicator = indicator;
  }
  els.tabsList.appendChild(indicator);

  renderIcons(els.tabsList);
  enablePointerDragSort(els.tabsList, {
    itemSelector: '.tab',
    idAttr: 'id',
    onReorder: reorderSessions,
    // 複数選択中のタブを掴んだら、そのグループ全体をまとめて移動させる
    getDragGroup: (item) => {
      const id = item.dataset.id;
      if (state.selectedTabIds.size >= 2 && state.selectedTabIds.has(id)) {
        // 現在のDOM並び順を尊重（選択解除されたら普通に1個ドラッグ）
        return Array.from(els.tabsList.querySelectorAll('.tab'))
          .filter(el => state.selectedTabIds.has(el.dataset.id));
      }
      return [item];
    },
  });
  // ◀ ▶ ボタンの端っこ到達時グレーアウト
  const activeIdx = state.sessions.findIndex(s => s.id === state.activeId);
  if (els.btnTabPrev) els.btnTabPrev.disabled = activeIdx <= 0;
  if (els.btnTabNext) els.btnTabNext.disabled = activeIdx < 0 || activeIdx >= state.sessions.length - 1;
  renderTitleBar();

  // アクティブ線の位置更新（次フレームでレイアウト確定後に）
  requestAnimationFrame(updateActiveTabIndicator);
}

/* アクティブタブの下をスライドする色線 */
function updateActiveTabIndicator() {
  const bar = els.tabsList && els.tabsList.__activeIndicator;
  if (!bar) return;
  const activeTab = els.tabsList.querySelector('.tab.active');
  if (!activeTab) {
    bar.classList.remove('visible');
    return;
  }
  // offsetParent = #tabs-list（position:relative）からの整数pxで取る
  // → getBoundingClientRect のサブピクセルズレを回避
  const x = activeTab.offsetLeft;
  const w = activeTab.offsetWidth;

  const firstShow = !bar.classList.contains('visible');
  if (firstShow) {
    // 初回は transition 切ってジャンプ → rAF で visible にしてフェードイン
    const savedTransition = bar.style.transition;
    bar.style.transition = 'none';
    bar.style.transform = `translateX(${x}px)`;
    bar.style.width = `${w}px`;
    // reflow を挟んで transition を戻す
    void bar.offsetWidth;
    bar.style.transition = savedTransition;
    requestAnimationFrame(() => bar.classList.add('visible'));
  } else {
    bar.style.transform = `translateX(${x}px)`;
    bar.style.width = `${w}px`;
  }
  bar.classList.toggle('recording', activeTab.classList.contains('recording'));
}

/* 切替時にアクティブタブが見切れないように横スクロール */
function scrollActiveTabIntoView() {
  const scrollEl = document.getElementById('tabs');
  const tab = els.tabsList && els.tabsList.querySelector('.tab.active');
  if (!scrollEl || !tab) return;
  const cRect = scrollEl.getBoundingClientRect();
  const tRect = tab.getBoundingClientRect();
  const margin = 16;
  if (tRect.left < cRect.left + margin) {
    scrollEl.scrollBy({ left: tRect.left - cRect.left - margin, behavior: 'smooth' });
  } else if (tRect.right > cRect.right - margin) {
    scrollEl.scrollBy({ left: tRect.right - cRect.right + margin, behavior: 'smooth' });
  }
}

/** v0.13.31: タブを新規追加した時、末尾まで確実にスクロールする。
 * 新規タブの DOM レイアウト完了が requestAnimationFrame 1 回では間に合わず、
 * scrollActiveTabIntoView の getBoundingClientRect が古い値を返すケースがあった
 * （やっさん指摘「最新のタブの手前で止まる」）。
 * scrollWidth まで一発で行けば、新規タブは必ず末尾なので確実に見える。
 * double RAF + scrollWidth で「DOM レイアウト後の最終位置」へジャンプ。 */
function scrollTabsToEnd() {
  const scrollEl = document.getElementById('tabs');
  if (!scrollEl) return;
  // double RAF で DOM レイアウトが確実に完了してから scrollWidth を取得
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollEl.scrollTo({ left: scrollEl.scrollWidth, behavior: 'smooth' });
    });
  });
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
    snapshotActiveToSession({ fromAutosave: true });
    persistSessions();
  }, AUTOSAVE_INTERVAL_MS);
}

/* ───────── Event wiring ───────── */

els.btnToggle.addEventListener('click', () => state.isRecording ? stopRecording() : startRecording());
els.btnCopyAllPlain.addEventListener('click', copyAllPlain);
els.btnCopyAllMd.addEventListener('click', copyAllMultiformat);
/**
 * クリック＋長押し（タッチ対応）両対応のハンドラを要素に取り付ける。
 * 用途: 保存ボタンの「通常=単体 / Shift+クリック or 長押し=全件」のように
 *       同じUIで主/副アクションを切り替えたいとき。
 *
 * 挙動:
 * - デスクトップ: 通常クリック → onClick、Shift+クリック → onLongPress
 * - タッチ / マウス長押し (〜600ms): onLongPress（触覚フィードバック付き）
 * - ドラッグで10px以上動いたら長押しキャンセル
 * - キーボード(Enter) からのクリックは onClick として扱う
 */
function attachLongPressClick(el, { onClick, onLongPress, threshold = 600, moveTolerance = 10 } = {}) {
  let longFired = false;
  let longTimer = null;
  let downX = 0, downY = 0;

  const cancelLong = () => {
    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // 左クリック/主ボタンのみ
    longFired = false;
    downX = e.clientX; downY = e.clientY;
    cancelLong();
    longTimer = setTimeout(() => {
      longTimer = null;
      longFired = true;
      // 触覚フィードバック（モバイル Chrome 等）
      try { navigator.vibrate && navigator.vibrate(30); } catch {}
      onLongPress && onLongPress(e);
    }, threshold);
  });

  el.addEventListener('pointermove', (e) => {
    if (!longTimer) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > moveTolerance) {
      cancelLong();
    }
  });
  el.addEventListener('pointerup', cancelLong);
  el.addEventListener('pointercancel', cancelLong);
  el.addEventListener('pointerleave', cancelLong);

  el.addEventListener('click', (e) => {
    // 長押しが既に発火していたら、後続のclickは抑止（二重実行防止）
    if (longFired) {
      longFired = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Shift+クリック = 長押しと等価（デスクトップ用ショートカット）
    if (e.shiftKey) {
      onLongPress && onLongPress(e);
      return;
    }
    onClick && onClick(e);
  });
}

// 保存ボタン: 通常=単体セッション、長押し/Shift=全セッション
attachLongPressClick(els.btnSaveJson, {
  onClick: saveSessionAsHtml,
  onLongPress: saveAllSessionsAsHtml,
});
// v0.14.2: Notion アップロード。「HTMLで保存」と同じ クリック/Shift・長押し の操作体系に揃える
if (els.btnNotionUpload) {
  attachLongPressClick(els.btnNotionUpload, {
    onClick: uploadActiveSessionToNotion,
    onLongPress: uploadAllSessionsToNotion,
  });
  els.notionPicker.querySelectorAll('[data-dismiss]').forEach(b => {
    b.addEventListener('click', () => closeNotionPicker(null));
  });
  els.btnNotionPickerOk.addEventListener('click', () => closeNotionPicker(true));
  // 保存先を変えたら、その DB の日付プロパティを取り直す
  els.notionPickerSelect.addEventListener('change', loadNotionPickerSchema);
  els.btnNotionCancel.addEventListener('click', requestNotionCancel);
}
els.btnLoadJson.addEventListener('click', () => els.fileLoad.click());
els.fileLoad.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) loadFromFile(f);
  e.target.value = '';
});
els.btnClearAll.addEventListener('click', clearAllPanes);
els.btnSettings.addEventListener('click', openSettings);
if (els.btnContext) {
  els.btnContext.addEventListener('click', openContextModal);
  els.btnContextSave.addEventListener('click', saveContextModal);
  els.btnContextFromMemo.addEventListener('click', importContextFromMemo);
  els.btnContextAdoptAuto.addEventListener('click', adoptAutoTerms);
  els.contextModal.querySelectorAll('[data-dismiss]').forEach(b => {
    b.addEventListener('click', closeContextModal);
  });
}
if (els.btnNotionTest) els.btnNotionTest.addEventListener('click', testNotionConnection);
if (els.btnNotionForget) els.btnNotionForget.addEventListener('click', forgetNotionTarget);

/* ───────── Onboarding ───────── */
const ONBOARDING_STEPS = [
  {
    target: '#btn-toggle',
    title: '録音開始',
    text: 'ここを押すと文字起こしが始まります。認識中も本文を直接編集できます。新しい認識結果は末尾に自動追加されます。',
  },
  {
    target: '.inner-tab[data-pane="pane-transcript"]',
    title: '文字起こし',
    text: 'リアルタイムで音声がテキスト化されます。「文字起こし整形」をONにすると Gemini が段落分け・句読点を自動調整します。',
  },
  {
    target: '.inner-tab[data-pane="pane-memo"]',
    title: 'メモ',
    text: 'Markdown ショートカット対応（# 見出し / - 箇条書き / [] チェック等）。講義・会議中の気づきを自由に書けます。',
  },
  {
    target: '.inner-tab[data-pane="pane-summary"]',
    title: '要約',
    text: '録音停止後に自動生成されます。「要約を生成」ボタンで手動生成も可能。詳細度は低/中/高から選択できます。',
  },
  {
    target: '.inner-tab[data-pane="pane-chat"]',
    title: '質問',
    text: '資料（文字起こし・メモ・要約）について Gemini に質問できます。「この会議で決まったことは？」「◯◯について言及は？」など。推測はせず、資料に無いことは「分かりません」と答えます。',
  },
  {
    target: '#btn-quick-chat',
    title: 'クイック質問',
    text: '文字起こしを見ながらすぐに質問したい時はこのボタン。下からモーダルが出て、タブを切替えずに問えます。',
  },
  {
    target: '#btn-settings',
    title: '設定',
    text: 'Gemini API キー、フォント・サイズ、要約の詳細度、音声入力モード（Web Speech / Gemini Audio）などをここで調整します。',
  },
  {
    target: '#btn-captions',
    title: '字幕設定',
    text: 'OS レベルの透過字幕オーバーレイ（ネイティブヘルパー dictation-overlay と連携）。Zoom や Meet・他アプリの上に直接字幕が乗ります。フォント・色・縁取り・影・背景・パディング・行間・改行ルール・AI整形などをここで調整。**Windows 専用**で、初回のみインストーラが必要です。',
  },
];

let onboardingIdx = 0;
let onboardingLiftedTarget = null;
let onboardingLiftedPrev = null;

function onboardingLiftTarget(target) {
  onboardingUnliftTarget();
  if (!target) return;
  const computed = getComputedStyle(target);
  onboardingLiftedPrev = {
    position: target.style.position,
    zIndex: target.style.zIndex,
    boxShadow: target.style.boxShadow,
  };
  if (computed.position === 'static') target.style.position = 'relative';
  target.style.zIndex = '210';
  target.style.boxShadow = '0 0 0 3px var(--accent), 0 0 22px 4px rgba(52, 211, 153, 0.6)';
  onboardingLiftedTarget = target;
}

function onboardingUnliftTarget() {
  if (!onboardingLiftedTarget) return;
  const t = onboardingLiftedTarget;
  t.style.position = onboardingLiftedPrev?.position ?? '';
  t.style.zIndex = onboardingLiftedPrev?.zIndex ?? '';
  t.style.boxShadow = onboardingLiftedPrev?.boxShadow ?? '';
  onboardingLiftedTarget = null;
  onboardingLiftedPrev = null;
}

function onboardingPosition() {
  const step = ONBOARDING_STEPS[onboardingIdx];
  if (!step) { closeOnboarding(); return; }
  const target = document.querySelector(step.target);
  const spot = document.getElementById('onboarding-spot');
  const bubble = document.getElementById('onboarding-bubble');
  document.getElementById('onboarding-title').textContent = step.title;
  document.getElementById('onboarding-text').textContent = step.text;
  document.getElementById('onboarding-step').textContent = `${onboardingIdx + 1} / ${ONBOARDING_STEPS.length}`;
  document.getElementById('onboarding-next-btn').textContent =
    onboardingIdx === ONBOARDING_STEPS.length - 1 ? '完了' : '次へ';

  // 対象を前面に持ち上げ（暗幕の上に出して見やすく）
  onboardingLiftTarget(target);

  // spot はほぼ飾り（対象自体をハイライトするため非表示でもOK）
  if (!target) { spot.style.display = 'none'; return; }
  spot.style.display = 'none'; // 対象自身の box-shadow でハイライトするのでスポットは不要

  // html の zoom 値で座標補正（縮拡時に位置ズレを解消）
  const z = parseFloat(document.documentElement.style.zoom) || 1;
  const rect = target.getBoundingClientRect();

  // bubble positioning: 下方に出す、はみ出すなら上方
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bubbleW = Math.min(320, vw - 24);
  bubble.style.maxWidth = (bubbleW / z) + 'px';
  const bubbleHEst = 180;
  let topVisual, leftVisual;
  const gap = 12;
  if (rect.bottom + gap + bubbleHEst < vh) {
    topVisual = rect.bottom + gap;
  } else {
    topVisual = Math.max(12, rect.top - gap - bubbleHEst);
  }
  leftVisual = Math.max(12, Math.min(vw - bubbleW - 12, rect.left + rect.width / 2 - bubbleW / 2));
  // fixed 要素も html zoom の影響を受けるので layout 値に変換
  bubble.style.top = (topVisual / z) + 'px';
  bubble.style.left = (leftVisual / z) + 'px';
}

function startOnboarding() {
  onboardingIdx = 0;
  document.getElementById('onboarding').classList.remove('hidden');
  onboardingPosition();
}
function nextOnboarding() {
  onboardingIdx++;
  if (onboardingIdx >= ONBOARDING_STEPS.length) {
    closeOnboarding();
    return;
  }
  onboardingPosition();
}
function closeOnboarding() {
  onboardingUnliftTarget();
  document.getElementById('onboarding').classList.add('hidden');
}
const btnOnboarding = document.getElementById('btn-onboarding');
if (btnOnboarding) btnOnboarding.addEventListener('click', startOnboarding);

/* v0.13.31: 字幕設定モーダル。
 * 旧仕様：別ウィンドウとして captions.html を開いて字幕表示+設定を兼ねる
 * 新仕様：字幕表示はオーバーレイのみ、字幕アイコン押下でモーダル開く。
 *         モーダル内に captions.html?settingsOnly=1 を iframe で埋め込み、
 *         既存の Native Messaging 連携・設定 UI ロジックをそのまま流用する。 */
const btnCaptions = document.getElementById('btn-captions');
const captionsModal = document.getElementById('captions-modal');
const captionsModalIframe = document.getElementById('captions-modal-iframe');
if (btnCaptions && captionsModal && captionsModalIframe) {
  btnCaptions.title = '字幕設定';
  // chrome.runtime.getURL の引数にクエリ（?）を含めると extension URL として正しく解決されないため、
  // ベース URL を取ってから ?settingsOnly=1 を後付けする。
  const captionsBaseUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('captions.html')
    : 'captions.html';
  const captionsModalSrc = captionsBaseUrl + '?settingsOnly=1';
  btnCaptions.addEventListener('click', () => {
    // 現在のセッションを先に保存（iframe 内 captions.js が transcript フォールバックで読むことがある）
    try { snapshotActiveToSession(); persistSessions(); } catch (_) {}
    // src が違っていれば（旧 URL or 未セット）必ず読み直す。同じならそのまま（state 維持＝
    // Native Messaging 接続を切らない）。CSP 対策の captions-bootstrap.js が外部 JS で
    // 確実に実行されるため、キャッシュバスターは不要になった。
    if (captionsModalIframe.src !== captionsModalSrc) {
      captionsModalIframe.src = captionsModalSrc;
    }
    captionsModal.classList.remove('hidden');
  });
  // 閉じる：data-dismiss / backdrop / .modal-close で発火
  captionsModal.addEventListener('click', (e) => {
    const t = e.target;
    if (t && (t.closest('[data-dismiss]') || t.classList.contains('modal-backdrop'))) {
      captionsModal.classList.add('hidden');
    }
  });
}
document.getElementById('onboarding-next-btn')?.addEventListener('click', nextOnboarding);
document.querySelector('#onboarding .onboarding-skip')?.addEventListener('click', closeOnboarding);
document.querySelector('#onboarding .onboarding-overlay')?.addEventListener('click', closeOnboarding);
window.addEventListener('resize', () => {
  if (!document.getElementById('onboarding').classList.contains('hidden')) onboardingPosition();
  updateActiveTabIndicator();
  if (typeof updateInnerTabsIndicator === 'function') updateInnerTabsIndicator();
});
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

document.querySelectorAll('[data-pane-clear]').forEach(btn => {
  btn.addEventListener('click', () => clearPane(btn.dataset.paneClear));
});

els.btnSettingsSave.addEventListener('click', saveSettingsFromForm);

// 診断ログ: コピー／クリア
document.getElementById('btn-diag-copy')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const text = diagLog.toPlainText() || '（ログなし）';
  try {
    await navigator.clipboard.writeText(text);
    flashButton(btn, 'コピー完了');
  } catch (err) {
    alert('コピー失敗: ' + err.message);
  }
});
document.getElementById('btn-diag-clear')?.addEventListener('click', () => {
  diagLog.clear();
});

// モード切替で Gemini 専用 / Web Speech 専用フィールドの表示/非表示をアニメーション
if (els.modeWebSpeech) {
  els.modeWebSpeech.addEventListener('change', () => {
    applyGeminiOnlyVisibility(true);
    applyWebSpeechOnlyVisibility(true);
  });
}
if (els.modeGemini) {
  els.modeGemini.addEventListener('change', () => {
    applyGeminiOnlyVisibility(true);
    applyWebSpeechOnlyVisibility(true);
  });
}

// v0.13.24: btnWebSpeechDefaults クリックハンドラ削除（UI 撤去・WEB_SPEECH_DEFAULTS 撤去に伴う）。

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
  // 800ms入力アイドル後の自動保存。fromAutosave:true を必ず付ける。
  // これを付けないと paneLastStable がここで毎回 DOM 現在値にリセットされ、
  // タイピングUndoの 20字閾値が永久に発火しなくなる（v0.12.16 修正）。
  editSaveTimer = setTimeout(() => {
    snapshotActiveToSession({ fromAutosave: true });
    persistSessions();
  }, 800);
}
els.confirmed.addEventListener('input', onEdit);
els.memo.addEventListener('input', onEdit);
els.summary.addEventListener('input', onEdit);

/* ───────── Memo Notion風 Markdown エディタ ───────── */

function memoGetCurrentBlock() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  let node = range.startContainer;

  // ケースA: テキストノードが memo 直下 → 自動で div で包んでブロックを作る
  if (node.nodeType === Node.TEXT_NODE && node.parentNode === els.memo) {
    const textNode = node;
    const offset = range.startOffset;
    const div = document.createElement('div');
    els.memo.insertBefore(div, textNode);
    div.appendChild(textNode);
    // カーソル位置を保持
    const r = document.createRange();
    r.setStart(textNode, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    return div;
  }

  // ケースB: memo 自体の直下にカーソル（空の時など）
  if (node === els.memo) {
    let child = range.startContainer.childNodes[range.startOffset - 1] ||
                range.startContainer.childNodes[range.startOffset];
    if (child && child.nodeType === Node.ELEMENT_NODE) return child;
    // ない場合は div を作る
    const div = document.createElement('div');
    div.innerHTML = '<br>';
    els.memo.appendChild(div);
    memoPlaceCaretAtEnd(div);
    return div;
  }

  // 通常ケース: 直下の element まで遡る
  if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  while (node && node !== els.memo && node.parentNode !== els.memo) {
    node = node.parentNode;
  }
  return (node && node !== els.memo) ? node : null;
}

function memoFindTaskItem() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  while (node && node !== els.memo) {
    if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('task-item')) return node;
    node = node.parentNode;
  }
  return null;
}

function memoFindAncestor(tagName) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  while (node && node !== els.memo) {
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === tagName) return node;
    node = node.parentNode;
  }
  return null;
}

function memoPlaceCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function memoPlaceCaretAtStart(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function memoTransformBlock(block, tagName, content) {
  const el = document.createElement(tagName);
  el.textContent = content;
  block.replaceWith(el);
  memoPlaceCaretAtEnd(el);
}

function memoTransformToListItem(block, listTag, content) {
  const prev = block.previousElementSibling;
  let list;
  if (prev && prev.tagName && prev.tagName.toLowerCase() === listTag) {
    list = prev;
  } else {
    list = document.createElement(listTag);
    block.parentNode.insertBefore(list, block);
  }
  const li = document.createElement('li');
  li.textContent = content;
  list.appendChild(li);
  block.remove();
  memoPlaceCaretAtEnd(li);
}

function memoTransformToHr(block) {
  const hr = document.createElement('hr');
  const next = document.createElement('div');
  next.innerHTML = '<br>';
  block.replaceWith(hr);
  hr.parentNode.insertBefore(next, hr.nextSibling);
  memoPlaceCaretAtStart(next);
}

function memoTransformToCheckbox(block, checked, content) {
  // label で包まない（label だと text クリックでもチェックが発火するため）
  const wrap = document.createElement('div');
  wrap.className = 'task-item' + (checked ? ' done' : '');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.contentEditable = 'false';
  const span = document.createElement('span');
  span.textContent = content;
  wrap.appendChild(cb);
  wrap.appendChild(span);
  block.replaceWith(wrap);
  memoPlaceCaretAtEnd(span);
}

function checkMemoMarkdown() {
  const block = memoGetCurrentBlock();
  if (!block) return;
  const tag = (block.tagName || '').toLowerCase();
  if (['h1','h2','h3','li','blockquote','hr','label'].includes(tag)) return;
  const text = block.textContent || '';

  // --- 区切り線 (- 単独や -- 入力中に箇条書きに化けないよう最初に判定)
  if (text === '---') { memoTransformToHr(block); return; }
  // # 見出し
  let m = text.match(/^(#{1,3})\s(.+)$/);
  if (m) { memoTransformBlock(block, `h${m[1].length}`, m[2]); return; }
  // - or * 箇条書き (スペース必須、content 1 文字以上)
  m = text.match(/^[-*]\s(.+)$/);
  if (m) { memoTransformToListItem(block, 'ul', m[1]); return; }
  // ・ 箇条書き（スペース任意、content 1 文字以上）
  m = text.match(/^・\s?(.+)$/);
  if (m) { memoTransformToListItem(block, 'ul', m[1]); return; }
  // 1. 番号リスト
  m = text.match(/^\d+\.\s(.+)$/);
  if (m) { memoTransformToListItem(block, 'ol', m[1]); return; }
  // > 引用
  m = text.match(/^>\s(.+)$/);
  if (m) { memoTransformBlock(block, 'blockquote', m[1]); return; }
  // [ ] / [] / [x] チェックボックス
  m = text.match(/^\[([ xX])?\]\s(.+)$/);
  if (m) {
    const checked = !!(m[1] && m[1].trim());
    memoTransformToCheckbox(block, checked, m[2]);
    return;
  }
}

// state.cheatsheetForced: null=auto, 'shown'=常時表示, 'hidden'=常時非表示
function updateMemoCheatsheetVisibility() {
  const sheet = document.getElementById('memo-cheatsheet');
  if (!sheet) return;
  const helpBtn = document.getElementById('btn-memo-help');
  let show;
  if (state.cheatsheetForced === 'shown') show = true;
  else if (state.cheatsheetForced === 'hidden') show = false;
  else {
    // auto: メモが空の時だけ表示
    show = !els.memo.textContent.trim() && !els.memo.querySelector('*:not(br)');
  }
  sheet.classList.toggle('hidden', !show);
  if (helpBtn) helpBtn.classList.toggle('active', show);
}

function toggleMemoCheatsheet() {
  const sheet = document.getElementById('memo-cheatsheet');
  if (!sheet) return;
  const currentlyShown = !sheet.classList.contains('hidden');
  state.cheatsheetForced = currentlyShown ? 'hidden' : 'shown';
  updateMemoCheatsheetVisibility();
}

// ? ヘルプボタン: チートシートを手動トグル
const btnMemoHelp = document.getElementById('btn-memo-help');
if (btnMemoHelp) {
  btnMemoHelp.addEventListener('click', toggleMemoCheatsheet);
}

let memoIsComposing = false;
els.memo.addEventListener('compositionstart', () => { memoIsComposing = true; });
els.memo.addEventListener('compositionend', () => {
  memoIsComposing = false;
  checkMemoMarkdown();
  updateMemoCheatsheetVisibility();
});
els.memo.addEventListener('input', (e) => {
  updateMemoCheatsheetVisibility();
  if (memoIsComposing) return;
  checkMemoMarkdown();
});

els.memo.addEventListener('keydown', (e) => {
  // Tab / Shift+Tab
  if (e.key === 'Tab') {
    const li = memoFindAncestor('LI');
    if (li) {
      e.preventDefault();
      if (e.shiftKey) {
        // outdent (li)
        const parentList = li.parentNode;
        const grandParent = parentList.parentNode;
        if (grandParent && grandParent.tagName === 'LI') {
          grandParent.parentNode.insertBefore(li, grandParent.nextSibling);
          if (parentList.children.length === 0) parentList.remove();
          memoPlaceCaretAtEnd(li);
        }
      } else {
        // indent (li)
        const prev = li.previousElementSibling;
        if (prev && prev.tagName === 'LI') {
          const parentList = li.parentNode;
          const listTag = parentList.tagName.toLowerCase();
          let nested = Array.from(prev.children).find(c => c.tagName.toLowerCase() === listTag);
          if (!nested) {
            nested = document.createElement(listTag);
            prev.appendChild(nested);
          }
          nested.appendChild(li);
          memoPlaceCaretAtEnd(li);
        }
      }
    } else {
      // リスト外: インデントレベル（CSS padding-left）を増減
      const block = memoGetCurrentBlock();
      if (block) {
        e.preventDefault();
        const INDENT_PX = 24;
        const cur = parseInt(block.style.paddingLeft, 10) || 0;
        const next = e.shiftKey ? Math.max(0, cur - INDENT_PX) : Math.min(INDENT_PX * 8, cur + INDENT_PX);
        block.style.paddingLeft = next ? next + 'px' : '';
      }
    }
    return;
  }

  // Enter: チェックボックス / リスト特別処理
  if (e.key === 'Enter' && !e.shiftKey) {
    // task-item (checkbox): Enter で次の行に div を挿入
    const label = memoFindTaskItem();
    if (label) {
      e.preventDefault();
      const span = label.querySelector('span');
      const isEmpty = !span || span.textContent.trim() === '';
      const newBlock = document.createElement('div');
      newBlock.innerHTML = '<br>';
      label.parentNode.insertBefore(newBlock, label.nextSibling);
      if (isEmpty) label.remove();
      memoPlaceCaretAtStart(newBlock);
      return;
    }

    // 空の li で Enter
    //
    // v0.15.1: 以前はどこで押しても「新しい空行をリスト全体の後ろに置く」という実装で、
    // リストの途中で押すと空行が末尾に飛び、以降の行も下がらなかった（やっさん報告
    // 「メモペインで空行が入れられない」）。入れ子リストでは親の <li> の中に潜り込む
    // 事故も起きていた。
    //
    // 直した挙動:
    //   末尾で押した  → 従来どおりリストを抜けて、その下に空行
    //   途中で押した  → その位置でリストを分割し、間に空行を挟む（以降の行が下がる）
    const li = memoFindAncestor('LI');
    if (li && li.textContent.trim() === '') {
      e.preventDefault();
      const list = li.parentNode;
      const listTag = list.tagName.toLowerCase();

      // 空の li より後ろにある項目（これが「以降の行」）
      const after = [];
      for (let n = li.nextElementSibling; n; n = n.nextElementSibling) after.push(n);

      const newBlock = document.createElement('div');
      newBlock.innerHTML = '<br>';
      li.remove();

      list.parentNode.insertBefore(newBlock, list.nextSibling);

      if (after.length) {
        const rest = document.createElement(listTag);
        for (const el of after) rest.appendChild(el);
        // 番号付きリストは分割で 1 に戻らないよう、続きの番号から始める。
        // 移し終えたあとの list.children.length = 上に残った項目数。
        if (listTag === 'ol') {
          rest.start = (parseInt(list.getAttribute('start'), 10) || 1) + list.children.length;
        }
        newBlock.parentNode.insertBefore(rest, newBlock.nextSibling);
      }

      if (list.children.length === 0) list.remove();
      memoPlaceCaretAtStart(newBlock);
      return;
    }
  }

  // Backspace 先頭でブロック解除（見出し/引用/リスト/チェックをプレーン段落に戻す）
  if (e.key === 'Backspace') {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || range.startOffset !== 0) return;

    const block = memoGetCurrentBlock();
    if (!block) return;
    const tag = (block.tagName || '').toLowerCase();

    // h1/h2/h3/blockquote → div に戻す
    if (['h1','h2','h3','blockquote'].includes(tag)) {
      e.preventDefault();
      const div = document.createElement('div');
      div.textContent = block.textContent;
      if (!div.textContent) div.innerHTML = '<br>';
      block.replaceWith(div);
      memoPlaceCaretAtStart(div);
      return;
    }

    // li → リスト外に出す
    if (tag === 'li') {
      e.preventDefault();
      const li = block;
      const list = li.parentNode;
      const div = document.createElement('div');
      div.textContent = li.textContent;
      if (!div.textContent) div.innerHTML = '<br>';
      list.parentNode.insertBefore(div, list);
      li.remove();
      if (list.children.length === 0) list.remove();
      memoPlaceCaretAtStart(div);
      return;
    }

    // task-item (checkbox label) → div に戻す
    if (block.classList && block.classList.contains('task-item')) {
      e.preventDefault();
      const span = block.querySelector('span');
      const div = document.createElement('div');
      div.textContent = span ? span.textContent : '';
      if (!div.textContent) div.innerHTML = '<br>';
      block.replaceWith(div);
      memoPlaceCaretAtStart(div);
      return;
    }

    // hr の直後で Backspace: hr 削除
    if (block.tagName === 'DIV' && block.previousElementSibling?.tagName === 'HR') {
      e.preventDefault();
      block.previousElementSibling.remove();
      memoPlaceCaretAtStart(block);
      return;
    }
  }
});

// チェックボックスクリックで .done 切替
els.memo.addEventListener('change', (e) => {
  const target = e.target;
  if (target && target.matches && target.matches('.task-item input[type="checkbox"]')) {
    target.closest('.task-item').classList.toggle('done', target.checked);
    snapshotActiveToSession();
    persistSessions();
  }
});

// ペースト時：AI整形ONなら少し待って整形発動
els.confirmed.addEventListener('paste', () => {
  if (!state.settings.aiEnabled || !state.settings.apiKey) return;
  setTimeout(() => { refineUnstructuredInTranscript({ showFeedback: false }); }, 150);
});

// 文字起こし整形コンボ: ノブ=自動ON/OFFトグル、本体=全体を一括ミドル整形（見出し付け）
if (els.btnRefineTranscript) {
  els.btnRefineTranscript.addEventListener('click', async (e) => {
    const hit = e.target.closest('[data-role]');
    const role = hit?.dataset.role;
    if (role === 'toggle') {
      toggleAi();
    } else {
      // 本体クリック: トグルON/OFFに関わらず、全体を上から下までまとめて文脈込みで
      // 再整形＋見出し付け。既に整形済みのテキストも一度に整う。
      if (!state.settings.apiKey) { openSettings(); return; }
      els.btnRefineTranscript.classList.add('firing');
      try {
        await refineWholeTranscript({ showFeedback: true });
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
    // v0.14.2: 保存先ピッカーは Promise で待っているので、Escape でも必ず解決させる
    if (els.notionPicker && !els.notionPicker.classList.contains('hidden')) closeNotionPicker(null);
    if (els.contextModal && !els.contextModal.classList.contains('hidden')) closeContextModal();
    if (!els.silenceDialog.classList.contains('hidden')) {
      hideSilenceDialog();
      resetLongSilenceTimer();
    }
  }
});

els.btnTabNew.addEventListener('click', () => {
  // 新タブ作成時は複数選択をクリア（旧選択のハイライトが残るのを防ぐ）
  state.selectedTabIds = new Set();
  state.selectionAnchorId = null;
  // BG録音対応: 録音は止めず、新セッションを作ってから switchSession で遷移させる
  // （switchSession内でBG→FG/FG→BGの切替処理が走る）
  const wasRecording = state.isRecording;
  if (wasRecording) {
    // createSession({activate:true}) は loadActiveSessionIntoDOM を呼んで pendingChunkEl を消すため、
    // 録音中は「activate:false で作ってから switchSession」で切替処理を正しく通す
    snapshotActiveToSession();
    persistSessions();
    const s = createSession({ activate: false, skipSave: true });
    state.selectedTabIds = new Set([s.id]);
    state.selectionAnchorId = s.id;
    switchSession(s.id);
  } else {
    snapshotActiveToSession();
    persistSessions();
    createSession({ activate: true });
  }
});

/* 左右タブ送り: 現在のタブから前後へ1つ移動 */
function switchAdjacentSession(dir) {
  const idx = state.sessions.findIndex(s => s.id === state.activeId);
  if (idx < 0) return;
  const nextIdx = idx + dir;
  if (nextIdx < 0 || nextIdx >= state.sessions.length) return;
  switchSession(state.sessions[nextIdx].id);
}
els.btnTabPrev?.addEventListener('click', () => switchAdjacentSession(-1));
els.btnTabNext?.addEventListener('click', () => switchAdjacentSession(1));

els.btnEditTitle.addEventListener('click', startTitleEdit);
els.btnRegenTitle.addEventListener('click', regenTitleFromBar);

// タイトルバーのコピーボタン
if (els.btnCopyTitle) {
  els.btnCopyTitle.addEventListener('click', async () => {
    const session = getActiveSession();
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.title || '');
      flashButton(els.btnCopyTitle);
    } catch (err) {
      alert('コピー失敗: ' + err.message);
    }
  });
}

// 要約の詳しさ ドロップダウン（詳細/バランス/概要）
function applySummaryDetailSwitch() {
  if (!els.summaryDetailSelect) return;
  const detail = state.settings.summaryDetail || 'medium';
  els.summaryDetailSelect.value = detail;
}
if (els.summaryDetailSelect) {
  els.summaryDetailSelect.addEventListener('change', () => {
    state.settings.summaryDetail = els.summaryDetailSelect.value;
    saveSettings();
  });
}

els.chatInput.addEventListener('input', resizeChatInput);
els.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendChatMessage();
  }
});
els.btnChatSend.addEventListener('click', sendChatMessage);

/* ───────── クイック質問フロートウィンドウ ───────── */
// ウィンドウの位置は localStorage に保持（開きっぱなしの感覚）
const FLOAT_POS_KEY = 'dictation:quickChatFloatPos';
function loadFloatPos() {
  try { return JSON.parse(localStorage.getItem(FLOAT_POS_KEY) || 'null'); } catch { return null; }
}
function saveFloatPos(x, y) {
  try { localStorage.setItem(FLOAT_POS_KEY, JSON.stringify({ x, y })); } catch {}
}
/**
 * html に zoom が掛かっている時の変換ヘルパ。
 *   - style.left / top : 「ズーム前レイアウト座標」（以下 layout 座標）
 *   - getBoundingClientRect / clientX / window.innerWidth : 「視覚ビューポート座標」
 * 両者は layout = visual / z の関係。
 */
function getAppZoom() {
  const z = parseFloat(document.documentElement.style.zoom);
  return z > 0 ? z : 1;
}

function clampFloatWindow() {
  const win = els.quickChatModal;
  if (!win || !win.classList.contains('positioned')) return;
  const z = getAppZoom();
  const rect = win.getBoundingClientRect(); // visual px
  const margin = 4;
  // 視覚上の可動域（visual px）→ layout px に変換して style.left/top と突き合わせ
  const maxX = (window.innerWidth  - rect.width  - margin) / z;
  const maxY = (window.innerHeight - rect.height - margin) / z;
  const minX = margin / z;
  const minY = margin / z;
  let x = parseFloat(win.style.left) || 0;
  let y = parseFloat(win.style.top) || 0;
  x = Math.max(minX, Math.min(x, maxX));
  y = Math.max(minY, Math.min(y, maxY));
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
}

function openQuickChat() {
  if (!els.quickChatModal) return;
  // 保存された位置を復元
  const pos = loadFloatPos();
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    els.quickChatModal.classList.add('positioned');
    els.quickChatModal.style.left = `${pos.x}px`;
    els.quickChatModal.style.top = `${pos.y}px`;
  }
  renderChatInto(els.quickChatMessages, els.quickChatEmpty, els.quickChatBody);
  // 次フレームで .show を付けてフェードイン（visibility の hidden→visible の猶予）
  requestAnimationFrame(() => {
    els.quickChatModal.classList.add('show');
    requestAnimationFrame(() => {
      clampFloatWindow();
      setTimeout(() => els.quickChatInput?.focus(), 60);
    });
  });
}
function closeQuickChat() {
  if (!els.quickChatModal) return;
  els.quickChatModal.classList.remove('show');
  // visibility: hidden は CSS transition の delay で自動的に追いつく
}
if (els.btnQuickChat) {
  els.btnQuickChat.addEventListener('click', () => {
    // トグル: 開いていたら閉じる
    if (els.quickChatModal?.classList.contains('show')) closeQuickChat();
    else openQuickChat();
  });
}
if (els.quickChatModal) {
  els.quickChatModal.querySelectorAll('[data-dismiss]').forEach(b => {
    b.addEventListener('click', closeQuickChat);
  });

  // ヘッダでウィンドウをドラッグ移動（Photoshop風）
  const header = els.quickChatModal.querySelector('.float-window-header');
  const win = els.quickChatModal;
  if (header && win) {
    let startX = 0, startY = 0;
    let originX = 0, originY = 0;
    let dragging = false;
    header.addEventListener('pointerdown', (e) => {
      // 閉じるボタンはドラッグ開始しない
      if (e.target.closest('[data-dismiss]')) return;
      const z = getAppZoom();
      // まだ中央寄せ（translate）の場合は、現在の視覚位置を layout 座標に変換して固定
      if (!win.classList.contains('positioned')) {
        const rect = win.getBoundingClientRect(); // visual
        win.classList.add('positioned');
        win.style.left = `${rect.left / z}px`;    // layout = visual / z
        win.style.top  = `${rect.top  / z}px`;
      }
      startX = e.clientX;  // visual
      startY = e.clientY;
      originX = parseFloat(win.style.left) || 0;  // layout
      originY = parseFloat(win.style.top)  || 0;
      dragging = true;
      header.classList.add('dragging');
      try { header.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const z = getAppZoom();
      // マウスデルタは visual px、style.left は layout px なので /z で補正
      const dx = (e.clientX - startX) / z;
      const dy = (e.clientY - startY) / z;
      win.style.left = `${originX + dx}px`;
      win.style.top  = `${originY + dy}px`;
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      header.classList.remove('dragging');
      try { header.releasePointerCapture(e.pointerId); } catch {}
      clampFloatWindow();
      const x = parseFloat(win.style.left) || 0;
      const y = parseFloat(win.style.top) || 0;
      saveFloatPos(x, y);
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }
}
// リサイズ時もウィンドウがはみ出さないようクランプ
window.addEventListener('resize', clampFloatWindow);
if (els.quickChatInput) {
  const resizeQuickInput = () => {
    els.quickChatInput.style.height = 'auto';
    els.quickChatInput.style.height = Math.min(160, els.quickChatInput.scrollHeight) + 'px';
  };
  els.quickChatInput.addEventListener('input', resizeQuickInput);
  els.quickChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendQuickChatMessage();
    } else if (e.key === 'Escape') {
      closeQuickChat();
    }
  });
}
if (els.btnQuickChatSend) {
  els.btnQuickChatSend.addEventListener('click', sendQuickChatMessage);
}
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
applySummaryDetailSwitch();
applyPaneOrder();
renderInnerTabs();
if (typeof renderIcons === 'function') renderIcons();
els.zoomRange.value = state.settings.appZoom;
els.zoomPercent.textContent = state.settings.appZoom + '%';
if (els.btnClearAudio) {
  els.btnClearAudio.addEventListener('click', async () => {
    if (!confirm('保持している録音音声をすべて消します。よろしいですか？\n（文字起こしの結果は消えません）')) return;
    try {
      const n = await audioStoreClearAll();
      diagLog.info(`保持していた音声 ${n} 件を手動で消しました`);
    } catch (e) {
      alert('消せませんでした: ' + (e.message || e));
    }
    refreshAudioUsage();
  });
}

initSessions();
// v0.19.0: 期限切れの音声を掃除する。「タブを閉じたら消す」はクラッシュや
// 強制リロードでは走らないので、消し忘れを防ぐ本体はこちら
sweepStoredAudio();
renderTabs();
loadActiveSessionIntoDOM();
updateActionButtons();
startAutoSave();
// 文字起こし・メモ・要約の直接入力（キーボードタイピング）にも Undo/Redo を効かせる
bindPaneTypingUndo();

/* ───────── メモ: 選択範囲の整形（箇条書き→文章化 + 誤字訂正） ─────────
 * メモ内で範囲選択してボタンを押すと、Gemini に送って整形。
 * 訂正箇所は <mark class="mr-diff"> で一時的にハイライト（6秒後にフェード消去）。 */
async function refineMemoSelection() {
  if (!state.settings.apiKey) {
    alert('Gemini API キーが未設定です。設定から登録してください。');
    openSettings();
    return;
  }
  const memo = els.memo;
  if (!memo) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    alert('メモ内で文章を範囲選択してからボタンを押してください。');
    return;
  }
  const range = sel.getRangeAt(0);
  // 選択範囲がメモ内にあるかチェック
  if (!memo.contains(range.commonAncestorContainer) &&
      range.commonAncestorContainer !== memo) {
    alert('メモ内の範囲を選択してください。');
    return;
  }
  const selectedText = (range.toString() || '').trim();
  if (!selectedText) {
    alert('選択範囲が空です。');
    return;
  }
  if (selectedText.length < 5) {
    alert('5文字以上を選択してください。');
    return;
  }

  // Undo スナップショット
  pushUndo(`選択範囲整形 (${selectedText.length}字)`, 'pane-memo');

  // 選択範囲を「処理中…」の inline 要素で置き換える
  const placeholder = document.createElement('span');
  placeholder.className = 'mr-processing';
  placeholder.textContent = '（整形中…）';
  range.deleteContents();
  range.insertNode(placeholder);
  snapshotActiveToSession();
  persistSessions();

  const btn = document.getElementById('btn-memo-refine-selection');
  if (btn) btn.classList.add('firing');
  diagLog.info(`メモ選択整形開始: ${selectedText.length}字`);

  try {
    const refinedHtml = await window.refineMemoSelectionWithGemini({
      apiKey: state.settings.apiKey,
      text: selectedText,
    });
    // プレースホルダを実結果で置換。Gemini は <mark>...</mark> 付きテキストを返す想定。
    // 安全のため mark 以外のタグを除去してからパース。
    const safeHtml = sanitizeSelectionRefineHtml(refinedHtml || selectedText);
    const tmpl = document.createElement('template');
    tmpl.innerHTML = safeHtml.replace(/\n/g, '<br>');
    const frag = tmpl.content.cloneNode(true);
    // mark 要素にフェードアウトクラスをスケジュール
    const marks = frag.querySelectorAll('mark');
    marks.forEach(m => m.classList.add('mr-diff'));
    placeholder.replaceWith(frag);
    // 一定時間後にフェード、消去
    setTimeout(() => {
      memo.querySelectorAll('mark.mr-diff').forEach(m => m.classList.add('mr-diff-fade'));
      setTimeout(() => {
        memo.querySelectorAll('mark.mr-diff').forEach(m => {
          const parent = m.parentNode;
          while (m.firstChild) parent.insertBefore(m.firstChild, m);
          parent.removeChild(m);
          parent.normalize();
        });
        snapshotActiveToSession();
        persistSessions();
      }, 1500);
    }, 6000);
    snapshotActiveToSession();
    persistSessions();
    diagLog.info(`メモ選択整形完了: ${selectedText.length}字→${(refinedHtml || '').length}字`);
  } catch (e) {
    console.warn('[memo refine selection] failed:', e.message || e);
    // プレースホルダを元テキストに戻す
    placeholder.replaceWith(document.createTextNode(selectedText));
    snapshotActiveToSession();
    persistSessions();
    setStatus('error', 'メモ整形失敗: ' + (e.message || '').slice(0, 60));
    setTimeout(() => setStatus('idle', '停止'), 4000);
  } finally {
    if (btn) btn.classList.remove('firing');
  }
}

/** Gemini の返したHTML文字列から許可タグ（mark/br）以外を除去 */
function sanitizeSelectionRefineHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const walker = document.createTreeWalker(tmp, NodeFilter.SHOW_ELEMENT, null);
  const toUnwrap = [];
  const cur = walker.currentNode;
  while (walker.nextNode()) {
    const el = walker.currentNode;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'mark' && tag !== 'br') toUnwrap.push(el);
  }
  for (const el of toUnwrap) {
    const parent = el.parentNode;
    if (!parent) continue;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }
  return tmp.innerHTML;
}

const btnMemoRefineSel = document.getElementById('btn-memo-refine-selection');
if (btnMemoRefineSel) btnMemoRefineSel.addEventListener('click', refineMemoSelection);

/**
 * 横スクロール領域でマウスホイールを回したら左右にスクロールさせる。
 * - 実際に横オーバーフローしてる時だけ効かせる（縦方向の親スクロールを邪魔しない）
 * - トラックパッドが既に deltaX を送ってくる場合はネイティブに任せる
 * - Shiftキー押しながらのホイールも deltaY を使って動くよう対応（Shift+wheel標準）
 */
function enableHorizontalWheelScroll(el) {
  if (!el || el.__hwheelWired) return;
  el.__hwheelWired = true;
  el.addEventListener('wheel', (e) => {
    if (el.scrollWidth <= el.clientWidth) return;
    // トラックパッドの横スワイプ等で deltaX のほうが大きい場合はネイティブ挙動
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    // 縦ホイールを横スクロールに変換
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, { passive: false });
}
// コントロールバー・外タブ・内タブ・ペインヘッダに適用
enableHorizontalWheelScroll(document.getElementById('controls'));
enableHorizontalWheelScroll(document.getElementById('tabs'));
enableHorizontalWheelScroll(document.getElementById('inner-tabs'));
document.querySelectorAll('.pane-header').forEach(enableHorizontalWheelScroll);

/* ペイン別 Undo / Redo ボタンと Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y */
(function bindPaneUndoRedo() {
  // 各ペインヘッダの data-pane-undo / data-pane-redo ボタンをまとめて配線
  document.querySelectorAll('[data-pane-undo]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const paneId = btn.dataset.paneUndo;
      doPaneUndo(paneId);
    });
  });
  document.querySelectorAll('[data-pane-redo]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const paneId = btn.dataset.paneRedo;
      doPaneRedo(paneId);
    });
  });
  updatePaneUndoRedoButtons();

  document.addEventListener('keydown', (e) => {
    const isMod = e.ctrlKey || e.metaKey;
    if (!isMod) return;
    // 編集中フィールドでのネイティブ Undo/Redo は邪魔しない
    const t = e.target;
    const inEditable = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (inEditable) return;
    // Ctrl+Shift+Z or Ctrl+Y → Redo（現在アクティブなペインに対して）
    if ((e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey) || e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      doPaneRedo(state.activePane || 'pane-transcript');
      return;
    }
    // Ctrl+Z → Undo（現在アクティブなペインに対して）
    if (e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      doPaneUndo(state.activePane || 'pane-transcript');
    }
  });
})();

/* ───────── 検索＆置換（Ctrl+F / 検索アイコン） ─────────
 * アクティブなペインの contenteditable / rendered 領域内のテキストを検索・置換する。
 * テキストノードだけを対象にして <mark.search-hit> で囲む方式。
 * 閉じる時は全ての mark を外して親を normalize してきれいに戻す。 */

const SEARCH_TARGETS = {
  'pane-transcript': { sel: '#confirmed',        label: '文字起こし' },
  'pane-memo':       { sel: '#memo',             label: 'メモ' },
  'pane-summary':    { sel: '#summary',          label: '要約' },
  'pane-chat':       { sel: '#chat-messages',    label: '質問（チャット）' },
};

const searchState = {
  open: false,
  query: '',
  caseSensitive: false,
  useRegex: false,
  showReplace: false,
  matches: [],       // <mark> 要素の配列
  currentIdx: -1,
};

function getSearchTargetEl() {
  const cfg = SEARCH_TARGETS[state.activePane] || SEARCH_TARGETS['pane-transcript'];
  return { el: document.querySelector(cfg.sel), label: cfg.label };
}

function clearSearchHighlights(target) {
  if (!target) return;
  const marks = target.querySelectorAll('mark.search-hit');
  marks.forEach(m => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  target.normalize(); // 分裂したテキストノードを結合
}

function openSearchBar() {
  const bar = document.getElementById('search-bar');
  if (!bar) return;
  searchState.open = true;
  bar.classList.remove('hidden');
  const input = document.getElementById('search-input');
  // 既に選択中のテキストがあれば初期値に（ブラウザ標準の挙動に寄せる）
  const sel = window.getSelection();
  if (sel && sel.toString().trim()) {
    input.value = sel.toString().trim();
    searchState.query = input.value;
  }
  updateSearchScopeLabel();
  setTimeout(() => { input.focus(); input.select(); }, 10);
  runSearch();
}

function closeSearchBar() {
  const bar = document.getElementById('search-bar');
  if (!bar) return;
  searchState.open = false;
  bar.classList.add('hidden');
  const { el } = getSearchTargetEl();
  clearSearchHighlights(el);
  searchState.matches = [];
  searchState.currentIdx = -1;
  // 編集を即保存（置換した場合のため）
  snapshotActiveToSession();
  persistSessions();
}

function updateSearchScopeLabel() {
  const scope = document.getElementById('search-scope');
  const { label } = getSearchTargetEl();
  if (scope) scope.textContent = `検索対象：${label}`;
}

function buildSearchRegex(query, { caseSensitive, useRegex }) {
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    if (useRegex) return new RegExp(query, flags);
    const escaped = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    return new RegExp(escaped, flags);
  } catch (e) {
    return null;
  }
}

function runSearch() {
  const { el: target } = getSearchTargetEl();
  if (!target) return;
  clearSearchHighlights(target);
  searchState.matches = [];
  searchState.currentIdx = -1;

  const q = (document.getElementById('search-input').value || '');
  searchState.query = q;
  if (!q) { updateSearchCounter(); return; }

  const re = buildSearchRegex(q, searchState);
  if (!re) { updateSearchCounter('無効な正規表現'); return; }

  // テキストノードを走査して <mark> に包む
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentNode && node.parentNode.nodeName === 'MARK') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.nodeValue;
    const parts = [];
    let lastIdx = 0;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (m.index > lastIdx) parts.push({ t: 'text', v: text.slice(lastIdx, m.index) });
      parts.push({ t: 'mark', v: m[0] });
      lastIdx = m.index + m[0].length;
    }
    if (parts.length === 0) continue;
    if (lastIdx < text.length) parts.push({ t: 'text', v: text.slice(lastIdx) });

    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (p.t === 'text') frag.appendChild(document.createTextNode(p.v));
      else {
        const mk = document.createElement('mark');
        mk.className = 'search-hit';
        mk.textContent = p.v;
        frag.appendChild(mk);
        searchState.matches.push(mk);
      }
    }
    node.parentNode.replaceChild(frag, node);
  }

  if (searchState.matches.length > 0) {
    searchState.currentIdx = 0;
    updateCurrentMatch();
  }
  updateSearchCounter();
}

function updateCurrentMatch() {
  const { matches, currentIdx } = searchState;
  matches.forEach((m, i) => m.classList.toggle('current', i === currentIdx));
  const cur = matches[currentIdx];
  if (cur) cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateSearchCounter(overrideText) {
  const counter = document.getElementById('search-counter');
  if (!counter) return;
  const { matches, currentIdx, query } = searchState;
  if (overrideText) {
    counter.textContent = overrideText;
    counter.classList.add('no-match');
    return;
  }
  if (!query) {
    counter.textContent = '';
    counter.classList.remove('no-match');
    return;
  }
  if (matches.length === 0) {
    counter.textContent = '0件';
    counter.classList.add('no-match');
  } else {
    counter.textContent = `${currentIdx + 1}/${matches.length}`;
    counter.classList.remove('no-match');
  }
}

function searchNext() {
  const n = searchState.matches.length;
  if (n === 0) return;
  searchState.currentIdx = (searchState.currentIdx + 1) % n;
  updateCurrentMatch();
  updateSearchCounter();
}
function searchPrev() {
  const n = searchState.matches.length;
  if (n === 0) return;
  searchState.currentIdx = (searchState.currentIdx - 1 + n) % n;
  updateCurrentMatch();
  updateSearchCounter();
}

function searchReplaceOne() {
  const { matches, currentIdx } = searchState;
  const cur = matches[currentIdx];
  if (!cur) return;
  const repl = document.getElementById('search-replace').value;
  const parent = cur.parentNode;
  parent.replaceChild(document.createTextNode(repl), cur);
  parent.normalize();
  // 保存用スナップショット
  snapshotActiveToSession();
  persistSessions();
  // 再検索。同じ index を保って次に進む
  const savedIdx = currentIdx;
  runSearch();
  if (searchState.matches.length > 0) {
    searchState.currentIdx = Math.min(savedIdx, searchState.matches.length - 1);
    updateCurrentMatch();
    updateSearchCounter();
  }
}
function searchReplaceAll() {
  const n = searchState.matches.length;
  if (n === 0) return;
  const repl = document.getElementById('search-replace').value;
  if (!confirm(`${n}件を「${repl || '（空文字）'}」に置換しますか？\n\nCtrl+Z で戻せます。`)) return;
  // 検索の対象ペインで Undo スタックを積む
  pushUndo(`全置換 (${n}件)`, state.activePane);
  for (const m of searchState.matches) {
    const p = m.parentNode;
    if (!p) continue;
    p.replaceChild(document.createTextNode(repl), m);
  }
  const { el: target } = getSearchTargetEl();
  if (target) target.normalize();
  snapshotActiveToSession();
  persistSessions();
  runSearch();
}

/* ─── UIバインディング ─── */
(function bindSearchBar() {
  const btn = document.getElementById('btn-search');
  if (btn) btn.addEventListener('click', () => {
    if (searchState.open) closeSearchBar();
    else openSearchBar();
  });

  const input = document.getElementById('search-input');
  const replInput = document.getElementById('search-replace');
  const btnPrev = document.getElementById('search-prev');
  const btnNext = document.getElementById('search-next');
  const btnCase = document.getElementById('search-case');
  const btnRegex = document.getElementById('search-regex');
  const btnTog = document.getElementById('search-toggle-replace');
  const btnClose = document.getElementById('search-close');
  const btnReplOne = document.getElementById('search-replace-one');
  const btnReplAll = document.getElementById('search-replace-all');
  const replRow = document.getElementById('search-replace-row');

  if (input) {
    input.addEventListener('input', () => runSearch());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) searchPrev(); else searchNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSearchBar();
      }
    });
  }
  if (replInput) {
    replInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); searchReplaceOne(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearchBar(); }
    });
  }
  if (btnPrev) btnPrev.addEventListener('click', searchPrev);
  if (btnNext) btnNext.addEventListener('click', searchNext);
  if (btnCase) btnCase.addEventListener('click', () => {
    searchState.caseSensitive = !searchState.caseSensitive;
    btnCase.classList.toggle('active', searchState.caseSensitive);
    runSearch();
  });
  if (btnRegex) btnRegex.addEventListener('click', () => {
    searchState.useRegex = !searchState.useRegex;
    btnRegex.classList.toggle('active', searchState.useRegex);
    runSearch();
  });
  if (btnTog && replRow) btnTog.addEventListener('click', () => {
    searchState.showReplace = !searchState.showReplace;
    replRow.classList.toggle('hidden', !searchState.showReplace);
    btnTog.classList.toggle('active', searchState.showReplace);
    if (searchState.showReplace) setTimeout(() => replInput.focus(), 10);
  });
  if (btnClose) btnClose.addEventListener('click', closeSearchBar);
  if (btnReplOne) btnReplOne.addEventListener('click', searchReplaceOne);
  if (btnReplAll) btnReplAll.addEventListener('click', searchReplaceAll);

  // Ctrl+F / Cmd+F — 開いていたらトグルで閉じる、閉じていたら開く
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      if (searchState.open) closeSearchBar();
      else openSearchBar();
    } else if (e.key === 'Escape' && searchState.open) {
      closeSearchBar();
    }
  });

  // 検索バーをドラッグで移動可能に（上のタブバー等と被らないよう自由配置）
  bindSearchBarDrag();

  // ペイン切替時は検索対象が変わるのでハイライトをクリアして再検索
  document.addEventListener('dictation:paneSwitched', () => {
    if (!searchState.open) return;
    updateSearchScopeLabel();
    runSearch();
  });
})();

/**
 * 検索バーをドラッグ可能に。
 * 入力欄やボタンではなくバー本体の余白をつかんで移動できる。
 * 位置は localStorage に保存して次回起動時に復元（タブバーとの重なり回避）。
 */
function bindSearchBarDrag() {
  const bar = document.getElementById('search-bar');
  if (!bar || bar.__dragWired) return;
  bar.__dragWired = true;

  // 保存済み位置を復元
  try {
    const saved = JSON.parse(localStorage.getItem('dictation:searchBarPos') || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      bar.style.left = saved.left + 'px';
      bar.style.top  = saved.top + 'px';
      bar.style.right = 'auto';
    }
  } catch {}

  let dragging = false;
  let startX = 0, startY = 0, originLeft = 0, originTop = 0;

  bar.addEventListener('pointerdown', (e) => {
    // 入力・ボタンはドラッグ対象外（操作と衝突させない）
    if (e.target.closest('input, button, select, textarea')) return;
    if (e.button !== undefined && e.button !== 0) return;
    const z = (parseFloat(document.documentElement.style.zoom) || 1) || 1;
    const rect = bar.getBoundingClientRect();
    // 初回ドラッグ時は right:16px をやめて left 基準に
    bar.style.left = (rect.left / z) + 'px';
    bar.style.top  = (rect.top  / z) + 'px';
    bar.style.right = 'auto';
    startX = e.clientX;
    startY = e.clientY;
    originLeft = rect.left / z;
    originTop  = rect.top  / z;
    dragging = true;
    bar.classList.add('dragging');
    try { bar.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });

  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const z = (parseFloat(document.documentElement.style.zoom) || 1) || 1;
    const dx = (e.clientX - startX) / z;
    const dy = (e.clientY - startY) / z;
    bar.style.left = (originLeft + dx) + 'px';
    bar.style.top  = (originTop  + dy) + 'px';
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    try { bar.releasePointerCapture(e.pointerId); } catch {}
    // ビューポート内に収める
    const r = bar.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, m = 4;
    const z = (parseFloat(document.documentElement.style.zoom) || 1) || 1;
    let left = r.left / z, top = r.top / z;
    left = Math.max(m / z, Math.min((vw - r.width - m) / z, left));
    top  = Math.max(m / z, Math.min((vh - r.height - m) / z, top));
    bar.style.left = left + 'px';
    bar.style.top  = top + 'px';
    // 位置を永続化
    try { localStorage.setItem('dictation:searchBarPos', JSON.stringify({ left, top })); } catch {}
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}
