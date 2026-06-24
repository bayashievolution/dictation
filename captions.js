/**
 * dictation — ライブ字幕ウィンドウ
 *
 * 聴覚障害のある方向けの OSD。サイドパネル（母艦）が録音・整形した transcript を
 * localStorage 経由でポーリング・storage イベントで同期して大きく表示する。
 *
 * 設計:
 * - 別ウィンドウとして chrome-extension://.../captions.html で開く
 * - 母艦は dictation:sessions / dictation:activeTab を localStorage に書いているので
 *   こちらは読み取り専用で購読する
 * - 字幕スタイルは dictation:captionsSettings に保存
 * - 字幕ボックスの位置・サイズは dictation:captionsBox に保存
 */

const SESSIONS_KEY = 'dictation:sessions';
const ACTIVE_TAB_KEY = 'dictation:activeTab';
const SETTINGS_KEY = 'dictation:captionsSettings';
const BOX_KEY = 'dictation:captionsBox';
// v0.13.17: LIVE_INTERIM_KEY（v0.13.9 で追加）は cap-para-interim 撤去に伴い不要化。削除済み。
// v0.13.31: 字幕用バッファキー（app.js が 30 字 slice 単位で書く）。
// 存在すれば transcript ではなくこちらを字幕表示に使う（完全分離）。
const CAPTION_BUFFER_KEY = 'dictation:liveCaption';

const DEFAULT_SETTINGS = {
  fontSize: 64,
  fontFamily: "'Noto Sans JP', sans-serif",
  fontWeight: 600,
  color: '#ffffff',
  bgColor: '#000000',
  bgAlpha: 70,            // 0-100
  strokeOn: false,
  strokeColor: '#000000',
  strokeWidth: 2,
  shadowOn: true,
  shadowColor: '#000000',
  shadowBlur: 6,
  // v0.13.31: オーバーレイ背景の角丸（px）。0=直角〜32=丸め強。dictation-overlay v0.4+ で反映予定。
  borderRadius: 8,
  // v0.13.31: 字幕背景のマージン（dictation-overlay .caption の padding、px）。
  // 横（左右）・縦（上下）を別々に。dictation-overlay v0.4+ で反映予定。
  paddingX: 24,
  paddingY: 10,
  lineHeightTenth: 14,    // 1.4 を 14 で保持（range が整数のため、行間=line-height）
  // v0.13.31: ブロック間隔（段落間 margin-bottom em x 10）。0=段落がぴったり詰まる。
  blockGapTenth: 0,
  // v0.13.31: AI 字幕整形のサブ設定。文節途中で改行する時「→」継続マークを付けるか。
  osdContinuationMark: true,
  // v0.13.31: AI 字幕整形の改行文字数はメイン設定（dictation:settings の webspeechSliceChars）を
  // 流用するため、captions 側では持たない（やっさん指摘で重複撤去）。
  paraCount: 2,
  // v0.13.31: スクロールする行数（バッチサイズ）。1=1段落ずつ流れる、N=N段落溜まってから一気にN行流す。
  scrollLineCount: 1,
  // v0.13.31: 旧 followLive（新しい発話で自動スクロール）はライブキャプションウィンドウ廃止に伴い撤去。
  // 字幕表示はオーバーレイのみで、字幕窓（#cap-box）は使わないため意味がなくなった。

  // 配信モード（OBS向け）
  broadcastMode: false,
  keyColor: '#ff00ff',    // クロマキー用。マゼンタが既定（文字・影に通常含まれない色）

  // OSD関連
  osdAi: false,           // AIで文節区切り整形するか
  transition: 'fade',     // 'none' | 'fade' | 'slide-right' | 'slide-left' | 'scroll'

  // 字幕表示モード (v0.13.12〜)
  // 'block' = 段落単位で最新N段落（既定・既存挙動）
  // 'stream' = 行単位で下から積み上げてスクロール感を出す
  displayMode: 'block',
  streamLineCount: 4,           // ストリーム時の表示行数（2〜8）
  streamLineMaxChars: 28,       // 句読点なしで強制改行する文字数（15〜50）
  streamLineIntervalMs: 300,    // 行追加の間隔（150〜800）
  streamPacketSize: 1,          // 1行ずつ or 2行まとめて
};
const STREAM_DEFAULTS = {
  streamLineCount: 4,
  streamLineMaxChars: 28,
  streamLineIntervalMs: 300,
  streamPacketSize: 1,
};

const DEFAULT_BOX = {
  left: null,   // null = デフォルト位置を使う
  top: null,
  width: null,
  height: null,
};

/* ───────── 設定ロード/セーブ ───────── */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}
function loadBox() {
  try {
    const raw = localStorage.getItem(BOX_KEY);
    if (raw) return { ...DEFAULT_BOX, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_BOX };
}
function saveBox(b) {
  try { localStorage.setItem(BOX_KEY, JSON.stringify(b)); } catch {}
}

let settings = loadSettings();
let box = loadBox();

/* ───────── 要素参照 ───────── */
const els = {
  body: document.body,
  canvas: document.getElementById('cap-canvas'),
  box: document.getElementById('cap-box'),
  text: document.getElementById('cap-box-text'),
  boxScroll: document.getElementById('cap-box-scroll'),
  status: document.getElementById('cap-status'),
  sessionTitle: document.getElementById('cap-session-title'),
  btnSettings: document.getElementById('cap-btn-settings'),
  btnFullscreen: document.getElementById('cap-btn-fullscreen'),
  btnFit: document.getElementById('cap-btn-fit'),
  btnOsd: document.getElementById('cap-btn-osd'),
  btnOverlay: document.getElementById('cap-btn-overlay'),
  btnResetPos: document.getElementById('cap-btn-reset-pos'),
  settings: document.getElementById('cap-settings'),
  settingsClose: document.getElementById('cap-settings-close'),
  inFontSize: document.getElementById('cap-font-size'),
  outFontSize: document.getElementById('cap-font-size-out'),
  inFontFamily: document.getElementById('cap-font-family'),
  inFontWeight: document.getElementById('cap-font-weight'),
  inColor: document.getElementById('cap-color'),
  inBgColor: document.getElementById('cap-bg-color'),
  inBgAlpha: document.getElementById('cap-bg-alpha'),
  outBgAlpha: document.getElementById('cap-bg-alpha-out'),
  inStrokeOn: document.getElementById('cap-stroke-on'),
  inStrokeColor: document.getElementById('cap-stroke-color'),
  inStrokeWidth: document.getElementById('cap-stroke-width'),
  outStrokeWidth: document.getElementById('cap-stroke-width-out'),
  inShadowOn: document.getElementById('cap-shadow-on'),
  inShadowColor: document.getElementById('cap-shadow-color'),
  inShadowBlur: document.getElementById('cap-shadow-blur'),
  outShadowBlur: document.getElementById('cap-shadow-blur-out'),
  inBorderRadius: document.getElementById('cap-border-radius'),
  outBorderRadius: document.getElementById('cap-border-radius-out'),
  inPaddingX: document.getElementById('cap-padding-x'),
  outPaddingX: document.getElementById('cap-padding-x-out'),
  inPaddingY: document.getElementById('cap-padding-y'),
  outPaddingY: document.getElementById('cap-padding-y-out'),
  inLineHeight: document.getElementById('cap-line-height'),
  // v0.13.31: 旧 output id="cap-lh-out" は、HTML 修正で id="cap-line-height-out" にリネーム済み
  outLineHeight: document.getElementById('cap-line-height-out') || document.getElementById('cap-lh-out'),
  // v0.13.31: ブロック間隔（旧「行間」位置の UI、リネーム）
  inBlockGap: document.getElementById('cap-block-gap'),
  outBlockGap: document.getElementById('cap-block-gap-out'),
  // v0.13.31: AI 字幕整形のサブ設定（条件付きフィールド）
  inOsdContinuationMark: document.getElementById('cap-osd-continuation-mark'),
  osdAiOnlyFields: document.getElementById('cap-osd-ai-only-fields'),
  inParaCount: document.getElementById('cap-para-count'),
  inScrollLineCount: document.getElementById('cap-scroll-line-count'),
  // v0.13.31: inFollowLive は撤去（cap-follow-live 要素削除に伴う）。
  inBroadcast: document.getElementById('cap-broadcast-mode'),
  inKeyColor: document.getElementById('cap-key-color'),
  keyColorName: document.getElementById('cap-key-color-name'),
  inOsdAi: document.getElementById('cap-osd-ai'),
  inTransition: document.getElementById('cap-transition'),
  btnReset: document.getElementById('cap-btn-reset'),
  // ストリームモード関連 (v0.13.12)
  inDisplayMode: document.getElementById('cap-display-mode'),
  inStreamLineCount: document.getElementById('cap-stream-line-count'),
  inStreamMaxChars: document.getElementById('cap-stream-max-chars'),
  outStreamMaxChars: document.getElementById('cap-stream-max-chars-out'),
  inStreamInterval: document.getElementById('cap-stream-interval'),
  inStreamPacket: document.getElementById('cap-stream-packet'),
  btnStreamDefaults: document.getElementById('cap-stream-defaults'),
};

/* ───────── ユーティリティ ───────── */

function hexToRgba(hex, alphaPct) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return `rgba(0,0,0,${(alphaPct|0)/100})`;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${(alphaPct|0)/100})`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ───────── 設定適用 ───────── */

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty('--cap-font-size', settings.fontSize + 'px');
  root.style.setProperty('--cap-font-family', settings.fontFamily);
  root.style.setProperty('--cap-font-weight', String(settings.fontWeight));
  root.style.setProperty('--cap-font-color', settings.color);
  root.style.setProperty('--cap-bg-color', hexToRgba(settings.bgColor, settings.bgAlpha));
  root.style.setProperty('--cap-line-height', String(settings.lineHeightTenth / 10));
  // v0.13.31: ブロック間隔（段落間 margin-bottom em）
  const gapEm = (Number(settings.blockGapTenth) || 0) / 10;
  root.style.setProperty('--cap-block-gap', gapEm + 'em');

  // シャドウ
  if (settings.shadowOn) {
    root.style.setProperty('--cap-text-shadow', `0 2px ${settings.shadowBlur}px ${settings.shadowColor}`);
  } else {
    root.style.setProperty('--cap-text-shadow', 'none');
  }

  // 縁取り
  if (settings.strokeOn) {
    root.style.setProperty('--cap-stroke', `${settings.strokeWidth}px ${settings.strokeColor}`);
  } else {
    root.style.setProperty('--cap-stroke', 'none');
  }

  // 配信モード
  root.style.setProperty('--cap-key-color', settings.keyColor);
  document.body.classList.toggle('broadcast-mode', !!settings.broadcastMode);
  updateKeyColorName();

  // ネイティブオーバーレイにスタイルだけ更新を送る（接続中なら）
  if (typeof sendOverlayStyleUpdate === 'function') sendOverlayStyleUpdate();
}

/** キー色の名前表示を更新（よくある色は日本語で） */
function updateKeyColorName() {
  if (!els.keyColorName) return;
  const c = (settings.keyColor || '').toLowerCase();
  const names = {
    '#ff00ff': 'マゼンタ（推奨）',
    '#00ff00': 'グリーン',
    '#00ffff': 'シアン',
    '#ff0000': 'レッド',
    '#0000ff': 'ブルー',
  };
  els.keyColorName.textContent = names[c] || 'カスタム';
}

/** 配信モードONを押した瞬間に、OBS向けの最適プリセットを適用。
 * v0.13.31: 縁取り強制 OFF を撤去（やっさん指示「OBSモードにすると縁取りがキャンセルされる」）。
 * 縁取りはユーザーが必要に応じて手動 ON/OFF できる。 */
function applyBroadcastPreset() {
  // シャドウ=純黒・厚めに
  settings.shadowOn = true;
  settings.shadowColor = '#000000';
  settings.shadowBlur = Math.max(settings.shadowBlur, 8);
  // 文字色が暗い色なら白に寄せる（キー色マゼンタとの対比）
  const color = (settings.color || '').toLowerCase();
  if (color === '#000000' || color === settings.keyColor.toLowerCase()) {
    settings.color = '#ffffff';
  }
}

function applyBox() {
  const b = box;
  // 位置
  if (Number.isFinite(b.left)) els.box.style.left = b.left + 'px';
  else els.box.style.left = '';
  if (Number.isFinite(b.top)) els.box.style.top = b.top + 'px';
  else els.box.style.top = '';
  // サイズ（未指定なら inline style をクリアしてCSS デフォルトに戻す）
  els.box.style.width = Number.isFinite(b.width) ? (b.width + 'px') : '';
  els.box.style.height = Number.isFinite(b.height) ? (b.height + 'px') : '';
  // left を直接指定したら translate を外す（デフォルトは中央寄せのために使われている）
  if (Number.isFinite(b.left)) {
    els.box.style.transform = 'none';
    els.box.style.bottom = '';
  } else {
    els.box.style.transform = '';
    els.box.style.bottom = '';
  }
}

function resetBox() {
  box = { ...DEFAULT_BOX };
  saveBox(box);
  // inline styleを明示的に全部クリア → CSS 側の %幅・中央寄せ translate に戻る
  els.box.style.left = '';
  els.box.style.top = '';
  els.box.style.width = '';
  els.box.style.height = '';
  els.box.style.transform = '';
  els.box.style.bottom = '';
  applyBox();
}

/* ───────── 設定UIバインディング ───────── */

function reflectSettingsToUI() {
  els.inFontSize.value = settings.fontSize;
  els.outFontSize.textContent = settings.fontSize + 'px';
  els.inFontFamily.value = settings.fontFamily;
  els.inFontWeight.value = settings.fontWeight;
  els.inColor.value = settings.color;
  els.inBgColor.value = settings.bgColor;
  els.inBgAlpha.value = settings.bgAlpha;
  els.outBgAlpha.textContent = settings.bgAlpha + '%';
  els.inStrokeOn.checked = settings.strokeOn;
  els.inStrokeColor.value = settings.strokeColor;
  els.inStrokeWidth.value = settings.strokeWidth;
  els.outStrokeWidth.textContent = settings.strokeWidth + 'px';
  els.inShadowOn.checked = settings.shadowOn;
  els.inShadowColor.value = settings.shadowColor;
  els.inShadowBlur.value = settings.shadowBlur;
  els.outShadowBlur.textContent = settings.shadowBlur + 'px';
  if (els.inBorderRadius) {
    // v0.13.31: 範囲外（0〜32）の旧値は既定 8 にフォールバック
    let v = Number(settings.borderRadius ?? 8);
    if (!Number.isFinite(v) || v < 0 || v > 32) v = 8;
    els.inBorderRadius.value = String(v);
    els.outBorderRadius.textContent = v + 'px';
    settings.borderRadius = v;
  }
  if (els.inPaddingX) {
    let v = Number(settings.paddingX ?? 24);
    if (!Number.isFinite(v) || v < 0 || v > 60) v = 24;
    els.inPaddingX.value = String(v);
    if (els.outPaddingX) els.outPaddingX.textContent = v + 'px';
    settings.paddingX = v;
  }
  if (els.inPaddingY) {
    let v = Number(settings.paddingY ?? 10);
    if (!Number.isFinite(v) || v < 0 || v > 40) v = 10;
    els.inPaddingY.value = String(v);
    if (els.outPaddingY) els.outPaddingY.textContent = v + 'px';
    settings.paddingY = v;
  }
  els.inLineHeight.value = settings.lineHeightTenth;
  els.outLineHeight.textContent = (settings.lineHeightTenth / 10).toFixed(1);
  // v0.13.31: ブロック間隔（範囲外は 0 にクランプ）
  if (els.inBlockGap) {
    let v = Number(settings.blockGapTenth ?? 0);
    if (!Number.isFinite(v) || v < 0 || v > 25) v = 0;
    els.inBlockGap.value = String(v);
    settings.blockGapTenth = v;
    if (els.outBlockGap) els.outBlockGap.textContent = (v / 10).toFixed(1);
  }
  // v0.13.31: AI 字幕整形サブ設定（→ 継続マーク）
  if (els.inOsdContinuationMark) els.inOsdContinuationMark.checked = settings.osdContinuationMark !== false;
  // v0.13.31: AI 字幕整形 ON/OFF に応じてサブ設定セクションの is-hidden をトグル
  if (els.osdAiOnlyFields) els.osdAiOnlyFields.classList.toggle('is-hidden', !settings.osdAi);
  els.inParaCount.value = String(settings.paraCount);
  if (els.inScrollLineCount) {
    // v0.13.31: 範囲外（1〜3 以外）の旧値は 1 にフォールバック
    let v = Number(settings.scrollLineCount ?? 1);
    if (![1, 2, 3].includes(v)) v = 1;
    els.inScrollLineCount.value = String(v);
    settings.scrollLineCount = v;
  }
  // v0.13.31: inFollowLive 反映は撤去（要素削除に伴う）。
  if (els.inBroadcast) els.inBroadcast.checked = !!settings.broadcastMode;
  if (els.inKeyColor) els.inKeyColor.value = settings.keyColor;
  if (els.inOsdAi) els.inOsdAi.checked = !!settings.osdAi;
  if (els.inTransition) els.inTransition.value = settings.transition || 'fade';
  // ストリーム関連 (v0.13.12)
  if (els.inDisplayMode) els.inDisplayMode.value = settings.displayMode || 'block';
  if (els.inStreamLineCount) els.inStreamLineCount.value = String(settings.streamLineCount ?? 4);
  if (els.inStreamMaxChars) els.inStreamMaxChars.value = String(settings.streamLineMaxChars ?? 28);
  if (els.outStreamMaxChars) els.outStreamMaxChars.textContent = String(settings.streamLineMaxChars ?? 28) + '字';
  if (els.inStreamInterval) els.inStreamInterval.value = String(settings.streamLineIntervalMs ?? 300);
  if (els.inStreamPacket) els.inStreamPacket.value = String(settings.streamPacketSize ?? 1);
  applyDisplayModeVisibility();
}

function applyDisplayModeVisibility() {
  const block = document.getElementById('cap-block-only-fields');
  const stream = document.getElementById('cap-stream-only-fields');
  const isFlow = (settings.displayMode === 'stream' || settings.displayMode === 'flow');
  if (block) block.classList.toggle('hidden', isFlow);
  if (stream) stream.classList.toggle('hidden', !isFlow);
}

/** v0.13.15: 字幕窓のリサイズ／フォントサイズ変更で、自動行スクロール時の
 *  1行文字数が変わるので、表示を再計算する */
let _streamResizeTimer = null;
function scheduleStreamRelayout() {
  if (settings.displayMode !== 'flow') return;
  if (_streamResizeTimer) clearTimeout(_streamResizeTimer);
  _streamResizeTimer = setTimeout(() => {
    _streamResizeTimer = null;
    // 全リセットして、現在の transcript から末尾を取り直す
    streamReset();
    renderLatest();
  }, 250);
}

/* ───────── ストリームモード（行スクロール） v0.13.12 ─────────
 * 文字起こしウィンドウのスクロール感を字幕で再現する。
 * - 句読点優先で行分割、長すぎたら streamLineMaxChars で強制改行
 * - pending キューに溜めて streamLineIntervalMs ごとに 1〜2行ずつフラッシュ
 * - 表示は最新 streamLineCount 行のみ。古い行は画面上方に押し出される
 * - interim はキューとは別に最下行のライブ表示として薄く描画
 */
let _streamDisplayed = []; // 画面表示中の行
let _streamPending = [];   // フラッシュ待ちの行
let _streamFlushTimer = null;
let _streamLastSourceText = ''; // 直前に処理した transcript 全テキスト（差分検出用）
let _streamLastSessionId = null;

function streamReset() {
  _streamDisplayed = [];
  _streamPending = [];
  _streamLastSourceText = '';
  _streamLastSessionId = null;
  if (_streamFlushTimer) {
    clearTimeout(_streamFlushTimer);
    _streamFlushTimer = null;
  }
}

/** v0.13.15: 字幕窓の幅とフォントサイズから「1行に入る文字数」を動的算出。
 *  Window リサイズや fontSize 変更にも追従する。 */
function calcAutoMaxChars() {
  const el = els.text;
  if (!el) return 28;
  const w = el.clientWidth || el.offsetWidth || 1500;
  const fontSize = Number(settings.fontSize) || 64;
  // 全角ベースで概算。漢字＋ひらがな混在の実測平均で 0.95 を係数に。
  // 余白として両端 12px ずつくらい引く（パディングは要素内側で吸収済みだが念のため）。
  const usable = Math.max(80, w - 16);
  const charsPerLine = Math.floor(usable / (fontSize * 0.95));
  return Math.max(8, Math.min(80, charsPerLine));
}

/** 句読点優先で行分割。長すぎたら maxChars で強制改行。 */
function splitIntoStreamLines(text, maxChars) {
  if (!text) return [];
  const out = [];
  // 句読点を含めて区切る（句読点を行末に残す）
  // 日本語：。．、，？！  英語：.,!?
  const SENT_RE = /([^。．、，？！\?\!\.\,]*[。．、，？！\?\!\.\,])/g;
  const sentences = [];
  let lastIdx = 0;
  for (const m of text.matchAll(SENT_RE)) {
    sentences.push(m[1]);
    lastIdx = m.index + m[1].length;
  }
  if (lastIdx < text.length) {
    sentences.push(text.slice(lastIdx));
  }
  for (const s of sentences) {
    const t = s.replace(/[\r\n]+/g, ' ').trim();
    if (!t) continue;
    if (t.length <= maxChars) {
      out.push(t);
    } else {
      for (let i = 0; i < t.length; i += maxChars) {
        out.push(t.slice(i, i + maxChars));
      }
    }
  }
  return out;
}

function streamScheduleFlush() {
  if (_streamFlushTimer) return;
  if (_streamPending.length === 0) return;
  const interval = Math.max(150, Math.min(800, Number(settings.streamLineIntervalMs) || 300));
  _streamFlushTimer = setTimeout(() => {
    _streamFlushTimer = null;
    streamFlushOnce();
  }, interval);
}

function streamFlushOnce() {
  if (_streamPending.length === 0) return;
  const packet = Math.max(1, Math.min(2, Number(settings.streamPacketSize) || 1));
  const take = Math.min(packet, _streamPending.length);
  for (let i = 0; i < take; i++) {
    _streamDisplayed.push(_streamPending.shift());
  }
  const max = Math.max(2, Math.min(8, Number(settings.streamLineCount) || 4));
  while (_streamDisplayed.length > max) _streamDisplayed.shift();
  // 描画は renderLatest 経由（pending 中も interim を反映できるように）
  renderStreamView();
  if (_streamPending.length > 0) streamScheduleFlush();
}

/** session の transcript 全テキストを取り出す */
function extractSessionPlainText(session) {
  if (!session) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = session.transcript || '';
  // .paragraph ベースで取りつつ、なければ素のテキスト
  const paras = tmp.querySelectorAll('.paragraph');
  if (paras.length) {
    return Array.from(paras).map(p => {
      const h2 = p.querySelector('h2');
      const body = p.querySelector('.p-body');
      if (body) return (body.textContent || '').trim();
      if (h2) return (p.textContent || '').replace(h2.textContent, '').trim();
      return (p.textContent || '').trim();
    }).filter(Boolean).join('\n\n');
  }
  return (tmp.textContent || '').trim();
}

/** v0.13.15: 1行最大文字数を取得。auto モードなら字幕窓幅から動的算出 */
function getStreamMaxChars() {
  // displayMode が 'flow' なら自動算出。'stream' は従来どおり手動値を尊重
  if (settings.displayMode === 'flow') return calcAutoMaxChars();
  return Math.max(15, Math.min(50, Number(settings.streamLineMaxChars) || 28));
}

/** transcript 全文 → 行リストのうち、まだ画面に出ていない新規行だけ pending に追加 */
function streamIngestFromSession(session) {
  // セッション切替 or 初回 → 履歴をリセットして「末尾だけ」表示
  // （字幕表示開始時に過去ログがドカっと出る問題対策・v0.13.15）
  if (_streamLastSessionId !== session.id) {
    streamReset();
    _streamLastSessionId = session.id;
    const fullText = extractSessionPlainText(session);
    if (fullText) {
      const maxChars = getStreamMaxChars();
      const allLines = splitIntoStreamLines(fullText, maxChars);
      const displayCount = Math.max(2, Math.min(8, Number(settings.streamLineCount) || 4));
      // 末尾の displayCount 行だけを「既に表示済み」として開始する。
      // それより古い行は流さない（ドカ感を防ぐ）。
      _streamDisplayed = allLines.slice(-displayCount);
      _streamLastSourceText = fullText;
    }
    return;
  }
  const fullText = extractSessionPlainText(session);
  if (!fullText) return;
  if (fullText === _streamLastSourceText) return;
  // 直前に処理した本文の続きから行分割
  let delta = '';
  if (fullText.startsWith(_streamLastSourceText)) {
    delta = fullText.slice(_streamLastSourceText.length);
  } else {
    // transcript が組み変わったら（編集されたら）一旦リセット
    _streamDisplayed = [];
    _streamPending = [];
    delta = fullText;
  }
  _streamLastSourceText = fullText;
  const maxChars = getStreamMaxChars();
  const newLines = splitIntoStreamLines(delta, maxChars);
  if (newLines.length > 0) {
    _streamPending.push(...newLines);
    streamScheduleFlush();
  }
}

function renderStreamView() {
  // v0.13.17: cap-para-interim 撤去（v0.13.9 undo）に伴い、ストリームモードでも
  // interim 末尾追加は行わない。displayed 行のみ描画。
  const lines = _streamDisplayed.slice();
  const html = lines.map((line, idx) => {
    const isLast = idx === lines.length - 1;
    const cls = 'cap-para cap-stream-line' + (isLast ? ' latest' : '');
    return `<p class="${cls}">${escapeHtml(line)}</p>`;
  }).join('');
  renderTextIntoBox(html);
}

function commit() {
  saveSettings(settings);
  applySettings();
}

function bindSettingsUI() {
  els.inFontSize.addEventListener('input', () => {
    settings.fontSize = Number(els.inFontSize.value);
    els.outFontSize.textContent = settings.fontSize + 'px';
    commit();
  });
  els.inFontFamily.addEventListener('change', () => { settings.fontFamily = els.inFontFamily.value; commit(); });
  els.inFontWeight.addEventListener('change', () => { settings.fontWeight = Number(els.inFontWeight.value); commit(); });
  els.inColor.addEventListener('input', () => { settings.color = els.inColor.value; commit(); });
  els.inBgColor.addEventListener('input', () => { settings.bgColor = els.inBgColor.value; commit(); });
  els.inBgAlpha.addEventListener('input', () => {
    settings.bgAlpha = Number(els.inBgAlpha.value);
    els.outBgAlpha.textContent = settings.bgAlpha + '%';
    commit();
  });
  els.inStrokeOn.addEventListener('change', () => { settings.strokeOn = els.inStrokeOn.checked; commit(); });
  els.inStrokeColor.addEventListener('input', () => { settings.strokeColor = els.inStrokeColor.value; commit(); });
  els.inStrokeWidth.addEventListener('input', () => {
    settings.strokeWidth = Number(els.inStrokeWidth.value);
    els.outStrokeWidth.textContent = settings.strokeWidth + 'px';
    commit();
  });
  els.inShadowOn.addEventListener('change', () => { settings.shadowOn = els.inShadowOn.checked; commit(); });
  els.inShadowColor.addEventListener('input', () => { settings.shadowColor = els.inShadowColor.value; commit(); });
  els.inShadowBlur.addEventListener('input', () => {
    settings.shadowBlur = Number(els.inShadowBlur.value);
    els.outShadowBlur.textContent = settings.shadowBlur + 'px';
    commit();
  });
  if (els.inBorderRadius) {
    els.inBorderRadius.addEventListener('input', () => {
      // v0.13.31: 角丸（px）。0〜32 にクランプ。dictation-overlay 側に Native Messaging で送信。
      const v = Math.max(0, Math.min(32, Number(els.inBorderRadius.value) || 0));
      settings.borderRadius = v;
      els.outBorderRadius.textContent = v + 'px';
      commit();
    });
  }
  if (els.inPaddingX) {
    els.inPaddingX.addEventListener('input', () => {
      const v = Math.max(0, Math.min(60, Number(els.inPaddingX.value) || 0));
      settings.paddingX = v;
      if (els.outPaddingX) els.outPaddingX.textContent = v + 'px';
      commit();
    });
  }
  if (els.inPaddingY) {
    els.inPaddingY.addEventListener('input', () => {
      const v = Math.max(0, Math.min(40, Number(els.inPaddingY.value) || 0));
      settings.paddingY = v;
      if (els.outPaddingY) els.outPaddingY.textContent = v + 'px';
      commit();
    });
  }
  if (els.inBlockGap) {
    els.inBlockGap.addEventListener('input', () => {
      const v = Math.max(0, Math.min(25, Number(els.inBlockGap.value) || 0));
      settings.blockGapTenth = v;
      if (els.outBlockGap) els.outBlockGap.textContent = (v / 10).toFixed(1);
      commit();
    });
  }
  if (els.inOsdContinuationMark) {
    els.inOsdContinuationMark.addEventListener('change', () => {
      settings.osdContinuationMark = !!els.inOsdContinuationMark.checked;
      commit();
    });
  }
  els.inLineHeight.addEventListener('input', () => {
    settings.lineHeightTenth = Number(els.inLineHeight.value);
    els.outLineHeight.textContent = (settings.lineHeightTenth / 10).toFixed(1);
    commit();
  });
  els.inParaCount.addEventListener('change', () => {
    settings.paraCount = Number(els.inParaCount.value);
    commit();
    renderLatest();
  });
  if (els.inScrollLineCount) {
    els.inScrollLineCount.addEventListener('change', () => {
      // v0.13.31: スクロールする行数（バッチサイズ）。範囲は 1〜3。
      const v = Math.max(1, Math.min(3, Number(els.inScrollLineCount.value) || 1));
      settings.scrollLineCount = v;
      commit();
      renderLatest();
    });
  }
  // v0.13.31: inFollowLive バインドは撤去（要素削除に伴う）。

  // 配信モードトグル
  if (els.inBroadcast) {
    els.inBroadcast.addEventListener('change', () => {
      settings.broadcastMode = els.inBroadcast.checked;
      if (settings.broadcastMode) {
        applyBroadcastPreset(); // シャドウ厚め、縁取りOFF等
        reflectSettingsToUI();  // プリセット反映でUI更新
      }
      commit();
    });
  }
  if (els.inKeyColor) {
    els.inKeyColor.addEventListener('input', () => {
      settings.keyColor = els.inKeyColor.value;
      commit();
    });
  }

  els.btnReset.addEventListener('click', () => {
    if (!confirm('字幕の表示設定をすべて初期値に戻しますか？')) return;
    settings = { ...DEFAULT_SETTINGS };
    reflectSettingsToUI();
    commit();
  });

  els.btnSettings.addEventListener('click', () => els.settings.classList.toggle('hidden'));
  els.settingsClose.addEventListener('click', () => els.settings.classList.add('hidden'));

  els.btnFullscreen.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (e) { console.warn('fullscreen failed', e); }
  });

  // ウィンドウフィット: 字幕ボックスをウィンドウ全体に広げて中央配置
  if (els.btnFit) {
    els.btnFit.addEventListener('click', fitBoxToWindow);
  }

  // OSDモード: UIを全部隠して字幕だけ大きく表示（右クリックで復帰）
  if (els.btnOsd) {
    els.btnOsd.addEventListener('click', enterOsdMode);
  }

  // OSD AI整形
  if (els.inOsdAi) {
    els.inOsdAi.addEventListener('change', () => {
      settings.osdAi = els.inOsdAi.checked;
      // v0.13.31: サブ設定セクションの出入りアニメ（design-system C 準拠）
      if (els.osdAiOnlyFields) els.osdAiOnlyFields.classList.toggle('is-hidden', !settings.osdAi);
      commit();
      renderLatest(); // 即反映
    });
  }

  // トランジション種別
  if (els.inTransition) {
    els.inTransition.addEventListener('change', () => {
      settings.transition = els.inTransition.value;
      commit();
      applyTransitionMode();
    });
  }

  // 字幕表示モード（block / stream）
  if (els.inDisplayMode) {
    els.inDisplayMode.addEventListener('change', () => {
      settings.displayMode = els.inDisplayMode.value;
      commit();
      applyDisplayModeVisibility();
      streamReset();        // モード切替時にストリーム状態を初期化
      renderLatest();
    });
  }
  if (els.inStreamLineCount) {
    els.inStreamLineCount.addEventListener('change', () => {
      settings.streamLineCount = Math.max(2, Math.min(8, Number(els.inStreamLineCount.value) || 4));
      commit();
      renderLatest();
    });
  }
  if (els.inStreamMaxChars) {
    els.inStreamMaxChars.addEventListener('input', () => {
      settings.streamLineMaxChars = Math.max(15, Math.min(50, Number(els.inStreamMaxChars.value) || 28));
      if (els.outStreamMaxChars) els.outStreamMaxChars.textContent = settings.streamLineMaxChars + '字';
      commit();
      streamReset();
      renderLatest();
    });
  }
  if (els.inStreamInterval) {
    els.inStreamInterval.addEventListener('change', () => {
      settings.streamLineIntervalMs = Math.max(150, Math.min(800, Number(els.inStreamInterval.value) || 300));
      commit();
    });
  }
  if (els.inStreamPacket) {
    els.inStreamPacket.addEventListener('change', () => {
      settings.streamPacketSize = Math.max(1, Math.min(2, Number(els.inStreamPacket.value) || 1));
      commit();
    });
  }
  if (els.btnStreamDefaults) {
    els.btnStreamDefaults.addEventListener('click', () => {
      Object.assign(settings, STREAM_DEFAULTS);
      reflectSettingsToUI();
      commit();
      streamReset();
      renderLatest();
    });
  }

  els.btnResetPos.addEventListener('click', () => {
    if (!confirm('字幕ボックスの位置とサイズを初期値に戻しますか？')) return;
    resetBox();
  });
}

/* ───────── ウィンドウフィット ───────── */
function fitBoxToWindow() {
  const margin = 0;
  const w = window.innerWidth - margin * 2;
  const h = window.innerHeight - margin * 2;
  box = { left: margin, top: margin, width: w, height: h };
  saveBox(box);
  applyBox();
}

/* ───────── OSDモード（親ウィンドウ内で字幕以外を隠す） ───────── */
function enterOsdMode() {
  document.body.classList.add('osd-mode');
  // ウィンドウ全体にフィットさせた状態で表示
  fitBoxToWindow();
  // 初回だけヒントを出す
  showOsdHintBriefly();
  // 右クリック / Esc で抜ける
  document.addEventListener('contextmenu', exitOsdOnContext, true);
  document.addEventListener('keydown', exitOsdOnKey);
}
function exitOsdMode() {
  document.body.classList.remove('osd-mode');
  document.removeEventListener('contextmenu', exitOsdOnContext, true);
  document.removeEventListener('keydown', exitOsdOnKey);
}
function exitOsdOnContext(e) {
  if (!document.body.classList.contains('osd-mode')) return;
  e.preventDefault();
  exitOsdMode();
}
function exitOsdOnKey(e) {
  if (e.key === 'Escape' && document.body.classList.contains('osd-mode')) {
    exitOsdMode();
  }
}
function showOsdHintBriefly() {
  let hint = document.getElementById('cap-osd-hint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'cap-osd-hint';
    hint.className = 'cap-osd-hint';
    hint.innerHTML = '<strong>OSDモード</strong><br>右クリック or Esc で通常表示に戻る';
    document.body.appendChild(hint);
  }
  hint.classList.remove('fade-out');
  hint.classList.add('show');
  clearTimeout(hint._t);
  hint._t = setTimeout(() => {
    hint.classList.add('fade-out');
    setTimeout(() => hint.classList.remove('show', 'fade-out'), 600);
  }, 2600);
}

/* ───────── トランジション設定反映（CSS変数/クラスで切替） ───────── */
function applyTransitionMode() {
  const modes = ['none', 'fade', 'slide-right', 'slide-left', 'scroll'];
  const chosen = modes.includes(settings.transition) ? settings.transition : 'fade';
  els.box && modes.forEach(m => els.box.classList.remove('trans-' + m));
  if (els.box) els.box.classList.add('trans-' + chosen);
}

/* ───────── AI OSD 整形（TV字幕風） ─────────
 * Gemini に依頼して、文節区切り・長文途中改行時の「→」付与・見出し除去を
 * 行う。生テキストから最新N段落を抽出し、変化があった時だけ API を叩く。 */

let _osdAiCache = { inputHash: null, output: null, inFlight: false, debounceTimer: null };

function hashStr(s) {
  // 簡易ハッシュ（同一入力を検出できればいい）
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h + '.' + s.length;
}

/** 入力テキストをGeminiに投げてOSD整形。キャッシュ済みならそのまま返す */
async function formatOsdWithAi(rawText) {
  if (!rawText || !rawText.trim()) return '';
  if (!settings.osdAi) return rawText;
  const apiKey = (function() {
    try {
      const raw = localStorage.getItem('dictation:settings');
      if (!raw) return '';
      const s = JSON.parse(raw);
      return s.apiKey || '';
    } catch { return ''; }
  })();
  if (!apiKey) return rawText;
  if (typeof window.formatForOSDWithGemini !== 'function') return rawText;

  const h = hashStr(rawText);
  if (_osdAiCache.inputHash === h && _osdAiCache.output != null) return _osdAiCache.output;
  if (_osdAiCache.inFlight) return _osdAiCache.output || rawText; // 前回結果を暫定表示

  _osdAiCache.inFlight = true;
  try {
    // v0.13.31: 改行文字数はメイン設定（dictation:settings の webspeechSliceChars）から読む。
    // 字幕バッファに流す時の slice サイズと AI 整形の改行幅を一致させて、設定の重複を避ける。
    let mainLineLength = 30;
    try {
      const raw = localStorage.getItem('dictation:settings');
      if (raw) {
        const s = JSON.parse(raw);
        const n = Number(s && s.webspeechSliceChars);
        if (Number.isFinite(n) && n >= 10 && n <= 100) mainLineLength = n;
      }
    } catch (_) { /* fallback to 30 */ }
    const out = await window.formatForOSDWithGemini({
      apiKey,
      text: rawText,
      // - lineLength: メイン設定の Web Speech 改行文字数を流用
      // - continuationMark: 文節途中の改行に「→」を追加するか（既定 true）
      lineLength: mainLineLength,
      continuationMark: settings.osdContinuationMark !== false,
    });
    _osdAiCache.inputHash = h;
    _osdAiCache.output = out || rawText;
    return _osdAiCache.output;
  } catch (e) {
    console.warn('OSD AI整形失敗:', e.message || e);
    return rawText;
  } finally {
    _osdAiCache.inFlight = false;
  }
}

/* ───────── ドラッグ・リサイズ ───────── */

function bindBoxInteractions() {
  let dragging = false;
  let resizing = null;  // 'br' | 'tl' | 'tr' | 'bl' | null
  let startX = 0, startY = 0;
  let startLeft = 0, startTop = 0, startWidth = 0, startHeight = 0;

  els.box.addEventListener('pointerdown', (e) => {
    // リサイズハンドル優先
    const handle = e.target.closest('.cap-resize');
    const rect = els.box.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    startWidth = rect.width; startHeight = rect.height;

    if (handle) {
      resizing = handle.dataset.resize;
      els.box.classList.add('resizing');
    } else {
      // 本体つかみ = ドラッグ移動
      dragging = true;
    }
    try { els.box.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    e.stopPropagation();
  });

  els.box.addEventListener('pointermove', (e) => {
    if (!dragging && !resizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const MIN_W = 120, MIN_H = 50;

    if (dragging) {
      let nl = startLeft + dx;
      let nt = startTop + dy;
      // ビューポート内に収める
      nl = Math.max(0, Math.min(vw - startWidth, nl));
      nt = Math.max(0, Math.min(vh - startHeight, nt));
      els.box.style.transform = 'none';
      els.box.style.bottom = '';
      els.box.style.left = nl + 'px';
      els.box.style.top = nt + 'px';
    } else if (resizing) {
      let newLeft = startLeft, newTop = startTop, newW = startWidth, newH = startHeight;
      if (resizing === 'br') { newW = startWidth + dx; newH = startHeight + dy; }
      else if (resizing === 'tl') { newLeft = startLeft + dx; newTop = startTop + dy; newW = startWidth - dx; newH = startHeight - dy; }
      else if (resizing === 'tr') { newTop = startTop + dy; newW = startWidth + dx; newH = startHeight - dy; }
      else if (resizing === 'bl') { newLeft = startLeft + dx; newW = startWidth - dx; newH = startHeight + dy; }
      newW = Math.max(MIN_W, newW);
      newH = Math.max(MIN_H, newH);
      // 左側を縮めたいときは left を上書き
      if (resizing === 'tl' || resizing === 'bl') newLeft = Math.max(0, Math.min(startLeft + startWidth - MIN_W, newLeft));
      if (resizing === 'tl' || resizing === 'tr') newTop = Math.max(0, Math.min(startTop + startHeight - MIN_H, newTop));
      els.box.style.transform = 'none';
      els.box.style.bottom = '';
      els.box.style.left = newLeft + 'px';
      els.box.style.top = newTop + 'px';
      els.box.style.width = newW + 'px';
      els.box.style.height = newH + 'px';
    }
  });

  const endDrag = (e) => {
    if (!dragging && !resizing) return;
    dragging = false;
    resizing = null;
    els.box.classList.remove('resizing');
    try { els.box.releasePointerCapture(e.pointerId); } catch {}
    // 位置・サイズを保存
    const rect = els.box.getBoundingClientRect();
    box = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    saveBox(box);
  };
  els.box.addEventListener('pointerup', endDrag);
  els.box.addEventListener('pointercancel', endDrag);
}

/* ───────── セッションの読取・表示 ───────── */

function loadActiveSession() {
  try {
    const sessionsRaw = localStorage.getItem(SESSIONS_KEY);
    const activeRaw = localStorage.getItem(ACTIVE_TAB_KEY);
    if (!sessionsRaw) return null;
    const sessions = JSON.parse(sessionsRaw);
    if (!Array.isArray(sessions) || sessions.length === 0) return null;
    let activeId = null;
    if (activeRaw) {
      // activeTab は文字列のID そのまま、もしくはJSON化かもしれないので両対応
      try { activeId = JSON.parse(activeRaw); } catch { activeId = activeRaw; }
    }
    return sessions.find(s => s.id === activeId) || sessions[sessions.length - 1];
  } catch (e) {
    console.warn('loadActiveSession failed', e);
    return null;
  }
}

/**
 * 対象セッションの transcript HTML から「最新 N 段落の文字列」を取り出して字幕に表示。
 */
/** 前回レンダリングしたテキストを保持してトランジション判定に使う */
let _lastRenderedText = '';

/** v0.13.31: 字幕バッファのスクロール演出用 state */
let _lastShownSliceTs = []; // 前回表示した slice の ts リスト（新規行判定用）
// バグ修正：以前は _pendingSliceCount += (liveBuf.length - _lastBufLength) で
// バッチサイズを判定していたが、liveBuf は CAPTION_BUFFER_MAX=10 で頭打ちになるため
// 10 件溜まった後 delta=0 になりスクロールが永久停止する問題があった。
// 修正版：「前回表示した最大 ts」より新しい slice の数を毎回 ts ベースで再計算する。

/** v0.13.31: 字幕バッファ（app.js が 30 字 slice 単位で書く配列）を読む */
function loadCaptionBuffer() {
  try {
    const raw = localStorage.getItem(CAPTION_BUFFER_KEY);
    if (!raw) return null;
    const buf = JSON.parse(raw);
    return Array.isArray(buf) && buf.length > 0 ? buf : null;
  } catch (_) { return null; }
}

function renderLatest() {
  const session = loadActiveSession();
  if (!session) {
    renderTextIntoBox('');
    els.sessionTitle.textContent = '';
    setStatus('idle', '待機');
    return;
  }
  els.sessionTitle.textContent = session.title || '';

  // ストリーム/自動行スクロールモード：
  // 'stream' (v0.13.12) = 手動最大文字数で分割
  // 'flow' (v0.13.15) = 字幕窓幅から動的に1行文字数を算出して分割
  // どちらも下から積み上げの「文字起こしペイン的なスクロール感」
  if (settings.displayMode === 'stream' || settings.displayMode === 'flow') {
    streamIngestFromSession(session);
    renderStreamView();
    // v0.13.31: 旧 followLive ガード撤去（オーバーレイ運用で字幕窓は非表示なので
    // boxScroll は実質 no-op だが、displayMode=stream/flow が将来再有効化された時のために
    // 無条件スクロールに変更）。
    requestAnimationFrame(() => {
      const sc = els.boxScroll;
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
    const updated = Number(session.updatedAt) || 0;
    const live = Date.now() - updated < 15000;
    setStatus(live ? 'listening' : 'idle', live ? '● 受信中' : '● 待機');
    return;
  }

  // v0.13.31: 字幕バッファ優先（完全分離 + バッチング + スクロール演出）。
  // app.js が 30 字 slice 単位で書く dictation:liveCaption を読み、存在すれば
  // それを字幕に反映。文字起こしペインの transcript（自然 final 単位）は触らない。
  //
  // バッチング：scrollLineCount に達するまで表示更新を待つ（早送り感）。
  // スクロール演出：新規スライスは .enter クラスを付与してアニメーション。
  const liveBuf = loadCaptionBuffer();
  if (liveBuf && liveBuf.length > 0) {
    const n = Math.max(1, Math.min(5, settings.paraCount || 2));
    const scrollN = Math.max(1, Math.min(3, settings.scrollLineCount || 1));

    // 「前回表示した最大 ts」より新しい slice の数を ts ベースで再計算。
    // liveBuf.length は CAPTION_BUFFER_MAX=10 で頭打ちになるため、length 差分では駄目。
    const lastShownTs = _lastShownSliceTs.length > 0
      ? Math.max.apply(null, _lastShownSliceTs.map(Number))
      : 0;
    const unseenCount = lastShownTs > 0
      ? liveBuf.filter(s => Number(s.ts) > lastShownTs).length
      : liveBuf.length;

    // 初回表示でなければ、scrollN 個溜まるまで表示更新を待つ
    const isFirstShow = _lastShownSliceTs.length === 0;
    if (!isFirstShow && unseenCount < scrollN) {
      // バッチング待ち：表示はそのまま（return せずステータスだけ更新）
      const updated = Number(liveBuf[liveBuf.length - 1].ts) || 0;
      const live = Date.now() - updated < 15000;
      setStatus(live ? 'listening' : 'idle', live ? '● 受信中' : '● 待機');
      return;
    }

    const latest = liveBuf.slice(-n);

    if (settings.osdAi) {
      // v0.13.31: 字幕バッファに対する AI OSD 整形（やっさん指示で動作復活）。
      // 旧実装は transcript ベースでしか走っていなかったので、字幕バッファ完全分離後に
      // 「動かない」状態になっていた。最新 N 件のスライスを結合して Gemini に渡し、
      // 結果（文節改行 + → 継続マーク）を一括描画する。
      // この経路ではスクロール演出（.enter）は使わず、整形済みテキストを丸ごと差替え。
      const rawText = latest.map(s => String(s.text || '')).filter(Boolean).join('\n');
      scheduleOsdAiRender(rawText);
      const immediate = (_osdAiCache.output && _osdAiCache.inputHash === hashStr(rawText))
        ? _osdAiCache.output
        : rawText;
      renderTextIntoBox(textToOsdHtml(immediate));
    } else {
      // 通常パス：slice ごとの段落 + スクロール演出
      const html = latest.map((slice, idx) => {
        const isLast = idx === latest.length - 1;
        const isNew = !_lastShownSliceTs.includes(slice.ts);
        const cls = 'cap-para' + (isLast ? ' latest' : '') + (isNew ? ' enter' : '');
        return `<p class="${cls}" data-slice-ts="${slice.ts}">${escapeHtml(String(slice.text || ''))}</p>`;
      }).join('');
      renderTextIntoBox(html);
    }
    _lastShownSliceTs = latest.map(s => Number(s.ts));

    const updated = Number(liveBuf[liveBuf.length - 1].ts) || 0;
    const live = Date.now() - updated < 15000;
    setStatus(live ? 'listening' : 'idle', live ? '● 受信中' : '● 待機');
    return;
  } else {
    // バッファが空（録音停止後等）なら state をリセット
    _lastShownSliceTs = [];
  }

  // 以下、既存のブロックモード（最新N段落表示、transcript ベース）。
  // 字幕バッファが空（録音停止中・Gemini Audio モード等）の時のフォールバック。
  // transcript は HTML 文字列。DOM として parse して .paragraph を拾う
  const tmp = document.createElement('div');
  tmp.innerHTML = session.transcript || '';

  let paras = Array.from(tmp.querySelectorAll('.paragraph'));
  if (paras.length === 0 && tmp.textContent.trim()) {
    paras = tmp.textContent.trim().split(/\n{2,}/).map(t => {
      const d = document.createElement('div');
      d.textContent = t;
      return d;
    });
  }

  const n = Math.max(1, Math.min(5, settings.paraCount || 2));
  const latest = paras.slice(-n);

  // v0.13.17: v0.13.9 で追加した cap-para-interim による interim ライブ表示は撤去。
  // 「字幕末尾に interim を流すと頻繁更新でパチパチ書き換わって読みづらい」
  // というやっさん指摘の根本原因。CLAUDE.md ルール8の正しい undo として削除。
  // 文字起こしペインの #interim（v0.4 以前から、yhpain）はそのまま残る。

  if (latest.length === 0) {
    renderTextIntoBox('');
  } else if (settings.osdAi) {
    // AI OSD整形: 生テキスト抽出→Gemini→整形後を描画（デバウンス）
    const rawText = latest.map(p => cleanRawParagraphText(p)).filter(Boolean).join('\n\n');
    scheduleOsdAiRender(rawText);
    const immediate = (_osdAiCache.output && _osdAiCache.inputHash === hashStr(rawText))
      ? _osdAiCache.output
      : rawText;
    renderTextIntoBox(textToOsdHtml(immediate));
  } else {
    // 通常モード: 段落構造を保って表示
    const html = latest.map((p, idx) => {
      const isLast = idx === latest.length - 1;
      const cls = 'cap-para' + (isLast ? ' latest' : '');
      const h2 = p.querySelector && p.querySelector('h2');
      if (h2) {
        const heading = escapeHtml(h2.textContent.trim());
        const bodyEl = p.querySelector('.p-body');
        const bodyText = escapeHtml((bodyEl ? bodyEl.textContent : (p.textContent || '').replace(h2.textContent, '')).trim());
        return `<p class="${cls}"><strong>${heading}</strong><br>${bodyText}</p>`;
      }
      const text = escapeHtml((p.textContent || '').trim());
      return `<p class="${cls}">${text}</p>`;
    }).join('');
    renderTextIntoBox(html);
  }

  // v0.13.31: 旧 followLive ガード撤去。
  requestAnimationFrame(() => {
    const sc = els.boxScroll;
    if (sc) sc.scrollTop = sc.scrollHeight;
  });

  const updated = Number(session.updatedAt) || 0;
  const live = Date.now() - updated < 15000;
  setStatus(live ? 'listening' : 'idle', live ? '● 受信中' : '● 待機');
}

/** 1段落分のテキストを綺麗に取り出す（見出しを除外、メタ文を除去） */
function cleanRawParagraphText(p) {
  const h2 = p.querySelector && p.querySelector('h2');
  let src = '';
  if (h2) {
    const bodyEl = p.querySelector('.p-body');
    src = bodyEl ? bodyEl.textContent : ((p.textContent || '').replace(h2.textContent, ''));
  } else {
    src = p.textContent || '';
  }
  return (src || '')
    .replace(/（文字起こし中…）|\(音声不明瞭[^)]*\)|\[文字起こし失敗[^\]]*\]|（音声不明瞭・再試行可）/g, '')
    .trim();
}

/** AI整形結果のテキスト（改行・→記号を含む）を表示用HTMLに変換。
 * v0.13.31: 各行を独立した <p class="cap-para"> として描画することで、
 * ブロック間隔（段落間 margin）・paraCount（最新 N 段落表示）が効くようにする。
 * 1 個の <p> 内 <br> 改行だと両設定が無効化される問題を修正。 */
function textToOsdHtml(text) {
  if (!text) return '';
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  // paraCount で最新 N 行に絞る（settings の値、1〜5）
  const n = Math.max(1, Math.min(5, Number(settings.paraCount) || 2));
  const displayLines = lines.slice(-n);
  return displayLines.map((line, idx) => {
    const isLast = idx === displayLines.length - 1;
    const cls = 'cap-para' + (isLast ? ' latest' : '');
    // 行末の「→」継続マーカーを <span> で装飾
    const html = escapeHtml(line).replace(/→$/, '<span class="osd-cont">→</span>');
    return `<p class="${cls}">${html}</p>`;
  }).join('');
}

/** renderTextIntoBox: トランジションを適用してテキスト領域を更新 */
function renderTextIntoBox(html) {
  if (!els.text) return;
  if (html === _lastRenderedText) return;          // 無変化ならスキップ
  _lastRenderedText = html;

  const tType = settings.transition || 'fade';
  if (tType === 'none') {
    els.text.innerHTML = html;
  } else {
    // CSS アニメーションを一度リセット→適用（再トリガ）
    els.text.classList.remove('anim-in');
    void els.text.offsetWidth;
    els.text.innerHTML = html;
    els.text.classList.add('anim-in');
  }

  // ネイティブオーバーレイへも送信（接続中ならデバウンスで送る）
  if (typeof scheduleOverlayCaption === 'function') {
    scheduleOverlayCaption(htmlToCaptionText(html));
  }
}

/** 字幕HTMLをネイティブ送信用のプレーンテキストに変換
 *  - <br> → \n
 *  - <p> 区切り → \n\n
 *  - <span class="osd-cont">→</span> → そのまま「→」
 */
function htmlToCaptionText(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // <br> を改行に
  tmp.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  // 段落区切り
  const paras = tmp.querySelectorAll('p');
  if (paras.length === 0) {
    return (tmp.textContent || '').replace(/\u00a0/g, ' ');
  }
  const lines = [];
  paras.forEach(p => {
    // 見出し付き段落: <strong>見出し</strong>\n本文 形式に
    const strong = p.querySelector('strong');
    let t;
    if (strong) {
      const heading = (strong.textContent || '').trim();
      // strongを取り除いた残り
      const clone = p.cloneNode(true);
      const s2 = clone.querySelector('strong');
      if (s2) s2.remove();
      const body = (clone.textContent || '').replace(/^\s*\n+/, '').trim();
      t = heading ? (body ? `${heading}\n${body}` : heading) : body;
    } else {
      t = (p.textContent || '').trim();
    }
    if (t) lines.push(t);
  });
  return lines.join('\n\n');
}

/** AI整形リクエストを 1.2秒 デバウンス */
function scheduleOsdAiRender(rawText) {
  if (_osdAiCache.debounceTimer) clearTimeout(_osdAiCache.debounceTimer);
  _osdAiCache.debounceTimer = setTimeout(async () => {
    const out = await formatOsdWithAi(rawText);
    if (settings.osdAi) {
      renderTextIntoBox(textToOsdHtml(out));
      // v0.13.31: 旧 followLive ガード撤去。
      {
        requestAnimationFrame(() => {
          const sc = els.boxScroll;
          if (sc) sc.scrollTop = sc.scrollHeight;
        });
      }
    }
  }, 1200);
}

function setStatus(mode, label) {
  els.status.className = 'cap-status ' + mode;
  els.status.textContent = label;
}

/* ───────── 同期（localStorage 購読） ───────── */

function bindSync() {
  // 同一オリジンの別ページ（サイドパネル index.html）での localStorage.setItem が storage イベントとしてここに届く
  window.addEventListener('storage', (e) => {
    // v0.13.31: 字幕バッファ（CAPTION_BUFFER_KEY）の更新も即時反映
    if (e.key === SESSIONS_KEY || e.key === ACTIVE_TAB_KEY || e.key === CAPTION_BUFFER_KEY) {
      renderLatest();
    }
  });
  // 保険のため、1秒ごとのポーリングも（storageイベントは別タブに対してしか発火しないが、
  // どのタイミングでも確実に最新が出るように）
  setInterval(renderLatest, 1000);
}

// v0.13.17: loadLiveInterim 関数を削除（v0.13.9 cap-para-interim の undo に伴う）。
// LIVE_INTERIM_KEY も使われなくなったので冒頭の定数も削除する。

/* ───────── ネイティブオーバーレイ連携 (dictation-overlay v0.2.0) ─────────
 * Chrome Native Messaging で別プロセス（ネイティブ字幕ウィンドウ）に
 * 字幕テキストとスタイルを送り、OSレベルの透過オーバーレイで表示する。
 * 仕様書：~/dictation-overlay/NATIVE_MESSAGING_SPEC.md (v0.2.0)
 */

const NATIVE_HOST = 'com.bayashi.dictation_overlay';
const OVERLAY_DEBOUNCE_MS = 80;       // 仕様の 50〜100ms 推奨の中央値

const overlayState = {
  port: null,
  connected: false,                    // ready 受信後 true
  version: null,
  platform: null,
  capabilities: [],
  monitors: [],
  clickThrough: true,                  // 起動時のデフォルトはネイティブ側で ON
  lastError: null,
  intentionalClose: false,             // 拡張側から exit/disconnect を意図的に出した直後 true
                                       // disconnect ハンドラがこれを見て「予期せず切断」との
                                       // 区別をつける（仕様 Q2 案 B）。
  lastGoodbyeReason: null,             // ネイティブから受信した最後の goodbye.reason
                                       // 'exit_requested' / 'user_close' (overlay v0.3.0+)
  position: null,                      // {x, y, width, height, monitor, localX, localY}
                                       // position_changed 受信で更新 (overlay v0.3.0+)
};

function isOverlayConnected() {
  return !!overlayState.port && overlayState.connected;
}
function hasOverlayCapability(cap) {
  return overlayState.capabilities.includes(cap);
}

/** ネイティブ向け settings ペイロード組み立て（仕様 4.2 show_caption に準拠）*/
function buildOverlaySettings() {
  return {
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    fontWeight: Number(settings.fontWeight) || 600,
    color: settings.color,
    bgColor: settings.broadcastMode ? settings.keyColor : settings.bgColor,
    bgAlpha: settings.broadcastMode ? 100 : settings.bgAlpha,
    shadowOn: !!settings.shadowOn,
    shadowColor: settings.shadowColor,
    shadowBlur: Number(settings.shadowBlur) || 0,
    // v0.13.31: broadcastMode で強制 false にしていた処理を撤去（やっさん指示）。
    // ユーザー設定通り送る。
    strokeOn: !!settings.strokeOn,
    strokeColor: settings.strokeColor,
    strokeWidth: Number(settings.strokeWidth) || 2,
    lineHeightTenth: Number(settings.lineHeightTenth) || 14,
    // v0.13.31: dictation-overlay 担当 v0.3.14 で対応済み。`Number(x) || 0` だと
    // 未設定（undefined）時に 0 が送られて overlay 側で fallback できなかったので、
    // `?? 既定値` でロード時欠落を埋める。やっさんが意図的に 0 にしたケースも保持される。
    borderRadius: Math.max(0, Math.min(32, Number(settings.borderRadius ?? 8))),
    // ブロック間隔（段落間 margin-bottom em x 10、0〜25）
    blockGapTenth: Math.max(0, Math.min(25, Number(settings.blockGapTenth ?? 0))),
    // 字幕背景のマージン（.caption の padding、px）
    paddingX: Math.max(0, Math.min(60, Number(settings.paddingX ?? 24))),
    paddingY: Math.max(0, Math.min(40, Number(settings.paddingY ?? 10))),
  };
}

/** ユーザーがボタンを押して開始した接続かどうか（失敗時のアラート表示判定用）*/
let _overlayUserInitiated = false;

/** v0.13.31: オーバーレイ側に「字幕表示 ON」を 3 秒だけ表示するためのタイマー。
 * dictation-overlay の起動時ハードコード「dictation-overlay ready」を上書きする目的。 */
let _overlayReadyToastTimer = null;

function connectNativeOverlay(opts = {}) {
  if (opts.userInitiated) _overlayUserInitiated = true;
  console.log('[overlay] connectNativeOverlay called', { userInitiated: !!opts.userInitiated });
  if (overlayState.port) {
    console.log('[overlay] already has port, abort connect');
    return;
  }
  if (!chrome?.runtime?.connectNative) {
    overlayState.lastError = 'Native Messaging API が利用できません（拡張機能を再読み込みしてください）';
    console.warn('[overlay]', overlayState.lastError);
    onOverlayDisconnected();
    return;
  }
  try {
    overlayState.port = chrome.runtime.connectNative(NATIVE_HOST);
    overlayState.port.onMessage.addListener(handleNativeMessage);
    overlayState.port.onDisconnect.addListener(handleNativeDisconnect);
    overlayState.lastError = null;
    overlayState.connected = false;    // ready 受信を待つ
    console.log('[overlay] connectNative() ok, waiting for ready...');
    // 接続中インジケータをすぐ出す
    showOverlayToast('ネイティブオーバーレイに接続中…');
    updateOverlayUI();
  } catch (e) {
    overlayState.port = null;
    overlayState.lastError = e?.message || String(e);
    console.error('[overlay] connectNative threw:', e);
    onOverlayDisconnected();
  }
}

/** トースト：右上に1.8秒だけ出して消す（成功・失敗・接続中いずれも） */
function showOverlayToast(message, kind = 'info') {
  let el = document.getElementById('cap-overlay-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cap-overlay-toast';
    el.className = 'cap-overlay-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `cap-overlay-toast show ${kind}`;
  clearTimeout(showOverlayToast._t);
  showOverlayToast._t = setTimeout(() => {
    el.className = 'cap-overlay-toast';
  }, kind === 'error' ? 4500 : 1800);
}

function disconnectOverlay() {
  if (!overlayState.port) return;
  // 「意図的終了」マーカー：disconnect ハンドラがエラー扱いしないように
  overlayState.intentionalClose = true;
  // 仕様 4.2 exit を明示送信。ネイティブ側はこれで「拡張クラッシュではない」と判別できる。
  // Phase 3 で Bye が追加されたら handleNativeMessage で受信予定。
  try { overlayState.port.postMessage({ type: 'exit' }); } catch (_) {}
  try { overlayState.port.disconnect(); } catch (_) {}
  overlayState.port = null;
  overlayState.connected = false;
  onOverlayDisconnected();
}

function handleNativeMessage(msg) {
  console.log('[overlay] ←', msg);
  if (!msg || typeof msg !== 'object') {
    console.warn('[overlay] invalid msg, ignored');
    return;
  }
  switch (msg.type) {
    case 'ready':
      overlayState.connected = true;
      overlayState.version = msg.version || '?';
      overlayState.platform = msg.platform || '?';
      overlayState.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities : [];
      overlayState.lastError = null;
      console.log('[overlay] ready: connected=true', overlayState);
      showOverlayToast(`✓ オーバーレイ接続 v${overlayState.version} (${overlayState.platform})`, 'success');
      // モニタ情報を要求（multi-monitor 対応時のみ）
      if (hasOverlayCapability('multi-monitor')) {
        try { overlayState.port.postMessage({ type: 'list_monitors' }); } catch (e) { console.warn('list_monitors send failed', e); }
      }
      updateOverlayUI();
      // v0.13.31: オーバーレイ側のハードコード初期テキスト「dictation-overlay ready」
      // を「字幕表示 ON」に上書き、5 秒後に hide_caption で fade-out して消す。
      // overlay v0.3.9+ が hide_caption 受信時に 220ms の fade-out を実装済み（overlay 担当依頼1）。
      try { overlayState.port.postMessage({ type: 'show_caption', text: '字幕表示 ON', settings: buildOverlaySettings() }); } catch (_) {}
      if (_overlayReadyToastTimer) clearTimeout(_overlayReadyToastTimer);
      _overlayReadyToastTimer = setTimeout(() => {
        _overlayReadyToastTimer = null;
        if (!isOverlayConnected()) return;
        try { overlayState.port.postMessage({ type: 'hide_caption' }); } catch (_) {}
        // 直近の本文字幕があれば再フラッシュ（show 受信で overlay 側が fading-out クラスを剥がして再表示）
        flushOverlayCaption();
      }, 5000);
      // 接続直後に保留中字幕があれば優先的に送信（3 秒トーストを上書きする）
      flushOverlayCaption();
      break;
    case 'pong':
      break;
    case 'error':
      overlayState.lastError = `${msg.code || 'error'}: ${msg.message || ''}`;
      console.warn('[overlay error]', msg);
      showOverlayToast(`オーバーレイエラー：${msg.code || 'error'}`, 'error');
      updateOverlayUI();
      break;
    case 'click_through':
      overlayState.clickThrough = !!msg.enabled;
      updateOverlayUI();
      break;
    case 'monitor_list':
      overlayState.monitors = Array.isArray(msg.monitors) ? msg.monitors : [];
      console.log('[overlay] monitors:', overlayState.monitors);
      updateOverlayUI();
      break;
    case 'position_changed':
      // overlay v0.3.0+：ユーザーがドラッグで字幕窓を動かした時に
      // 150ms デバウンスで自動送出される。x/y/width/height は仮想デスクトップ
      // 物理ピクセル（HiDPI スケール済、負値あり）。
      onOverlayPositionChanged(msg);
      break;
    case 'goodbye':
      // overlay v0.3.0+：ネイティブが自発的に終了する直前に送る予告（Q2 案 A）。
      // reason: 'exit_requested'（拡張からの exit 受信で終了）
      //       | 'user_close'（システムトレイ「オーバーレイを終了」で終了 v0.3.1+）
      // 受信した時点で「次の onDisconnect は意図的」とマークし、reason を保存。
      console.log(`[overlay] goodbye received reason=${msg.reason} → mark intentional close`);
      overlayState.intentionalClose = true;
      overlayState.lastGoodbyeReason = msg.reason || null;
      break;
    default:
      console.log('[overlay] unknown msg type, ignored:', msg.type);
      break;
  }
}

function handleNativeDisconnect() {
  const err = chrome.runtime.lastError;
  const wasIntentional = overlayState.intentionalClose;
  const goodbyeReason = overlayState.lastGoodbyeReason;
  overlayState.intentionalClose = false;       // 1ショットで消費
  overlayState.lastGoodbyeReason = null;
  console.warn('[overlay] disconnect', {
    err,
    lastErrorMessage: err?.message,
    hadPort: !!overlayState.port,
    wasConnected: overlayState.connected,
    wasIntentional,
    goodbyeReason,
  });
  overlayState.port = null;
  overlayState.connected = false;
  // 意図的終了なら lastError は表示しない（拡張側都合の正常切断）
  overlayState.lastError = wasIntentional ? null : (err?.message || null);
  if (wasIntentional) {
    // 意図的切断：reason に応じて分岐
    if (goodbyeReason === 'user_close') {
      // システムトレイ「オーバーレイを終了」（拡張は知らない世界の操作）
      showOverlayToast('オーバーレイがトレイメニューから終了されました', 'info');
    } else if (_overlayUserInitiated) {
      // 拡張側の「切断」ボタンから（exit_requested or 旧ルート）
      showOverlayToast('オーバーレイを切断しました', 'info');
    }
    // それ以外（reason 不明の意図的）は静かに終わる
  } else {
    // 予期せぬ切断：lastError があるなら必ず警告（ユーザ起因かどうか問わず）
    if (overlayState.lastError) {
      showOverlayToast(
        `オーバーレイが予期せず切断：${overlayState.lastError}`,
        'error'
      );
    } else if (_overlayUserInitiated) {
      showOverlayToast('オーバーレイ切断', 'error');
    }
  }
  _overlayUserInitiated = false;
  onOverlayDisconnected();
}

function onOverlayDisconnected() {
  overlayState.version = null;
  overlayState.platform = null;
  overlayState.capabilities = [];
  overlayState.monitors = [];
  overlayState.position = null;
  // clickThrough は保持（次回接続まで前回値を保持）
  updateOverlayUI();
}

/* ───── 字幕送信（デバウンス付） ───── */

let _overlayDebounceTimer = null;
let _overlayPendingText = '';

function sendOverlayCaption(text, settingsObj) {
  if (!isOverlayConnected()) return;
  try {
    overlayState.port.postMessage({
      type: 'show_caption',
      text: text || '',
      settings: settingsObj || buildOverlaySettings(),
    });
  } catch (e) {
    console.warn('overlay send failed', e);
  }
}

function scheduleOverlayCaption(text) {
  _overlayPendingText = text || '';
  if (_overlayDebounceTimer) clearTimeout(_overlayDebounceTimer);
  _overlayDebounceTimer = setTimeout(() => {
    _overlayDebounceTimer = null;
    sendOverlayCaption(_overlayPendingText, buildOverlaySettings());
  }, OVERLAY_DEBOUNCE_MS);
}

function flushOverlayCaption() {
  if (_overlayDebounceTimer) {
    clearTimeout(_overlayDebounceTimer);
    _overlayDebounceTimer = null;
  }
  sendOverlayCaption(_overlayPendingText, buildOverlaySettings());
}

/** スタイル設定だけを送る（applySettings から呼ばれる）*/
function sendOverlayStyleUpdate() {
  if (!isOverlayConnected()) return;
  try {
    overlayState.port.postMessage({ type: 'update_style', settings: buildOverlaySettings() });
  } catch (e) {
    console.warn('update_style failed', e);
  }
}

/** クリックスルー切替（仕様 4.2 set_click_through）*/
function setOverlayClickThrough(enabled) {
  if (!isOverlayConnected()) return;
  if (!hasOverlayCapability('click-through')) {
    console.warn('overlay does not support click-through');
    return;
  }
  try {
    overlayState.port.postMessage({ type: 'set_click_through', enabled: !!enabled });
  } catch (e) {
    console.warn('click_through send failed', e);
  }
}

/** モニタ移動（仕様 4.2 set_monitor）*/
function setOverlayMonitor(index) {
  if (!isOverlayConnected()) return;
  if (!hasOverlayCapability('multi-monitor')) return;
  try {
    overlayState.port.postMessage({ type: 'set_monitor', index: Number(index) });
  } catch (e) {
    console.warn('set_monitor failed', e);
  }
}

/** position_changed 受信ハンドラ（overlay v0.3.0+ / Q1 サンプル準拠）
 *  仕様：x/y/width/height は仮想デスクトップ物理ピクセル
 *  - monitors と組合わせて「どのモニタの何ピクセル位置か」を逆引き
 *  - HiDPI を考慮するなら scale_factor で logical px に換算
 */
function onOverlayPositionChanged(evt) {
  if (!evt || typeof evt !== 'object') return;
  const m = overlayState.monitors.find(
    mi => evt.x >= mi.x && evt.x < mi.x + mi.width
       && evt.y >= mi.y && evt.y < mi.y + mi.height
  );
  const localX = m ? evt.x - m.x : evt.x;
  const localY = m ? evt.y - m.y : evt.y;
  overlayState.position = {
    x: evt.x,
    y: evt.y,
    width: evt.width,
    height: evt.height,
    monitorIndex: m ? m.index : null,
    localX,
    localY,
    scaleFactor: m ? m.scale_factor : 1,
  };
  console.log('[overlay] position_changed', overlayState.position);
  updateOverlayUI();
}

function sendOverlayTestCaption() {
  if (!isOverlayConnected()) {
    alert('ネイティブオーバーレイが見つかりません。\n設定パネルの「字幕表示」をONにしてください。');
    return;
  }
  scheduleOverlayCaption('テスト字幕です。\nネイティブオーバーレイ接続OK →\n継続行サンプル');
  flushOverlayCaption();
}

/** v0.13.31: テスト字幕送信を消す（hide_caption） */
function clearOverlayTestCaption() {
  if (!isOverlayConnected()) return;
  scheduleOverlayCaption('');
  flushOverlayCaption();
}

/* ───── UI 反映 ───── */

function updateOverlayUI() {
  // ツールバーのオーバーレイボタン
  if (els.btnOverlay) {
    els.btnOverlay.classList.toggle('connected', isOverlayConnected());
    els.btnOverlay.title = isOverlayConnected()
      ? `デスクトップオーバーレイ 接続中 (v${overlayState.version || '?'}) — クリックで切断`
      : 'デスクトップオーバーレイに接続（OSレベル透過字幕）';
  }

  // 設定パネルの「ネイティブオーバーレイ連携」セクション
  const stat = document.getElementById('cap-overlay-status');
  const ctBtn = document.getElementById('cap-overlay-clickthrough');
  const monSel = document.getElementById('cap-overlay-monitor');
  // v0.13.31: テスト字幕は ボタン → トグルスイッチに変更
  const testToggleEl = document.getElementById('cap-overlay-test-toggle');
  const toggleEl = document.getElementById('cap-overlay-toggle');
  const dlLink = document.getElementById('cap-overlay-install');

  if (stat) {
    if (isOverlayConnected()) {
      const caps = overlayState.capabilities.join(', ') || '-';
      let lines = [
        `接続中 v${overlayState.version} (${overlayState.platform})`,
        `capabilities: ${caps}`,
      ];
      // position_changed (overlay v0.3.0+) を受信していたら現在位置を表示
      if (overlayState.position) {
        const p = overlayState.position;
        const posLabel = p.monitorIndex != null
          ? `モニタ #${p.monitorIndex} (${p.localX}, ${p.localY}) ${p.width}×${p.height}`
          : `仮想 (${p.x}, ${p.y}) ${p.width}×${p.height}`;
        lines.push(`位置: ${posLabel}`);
      }
      stat.textContent = lines.join('\n');
      stat.className = 'cap-overlay-status connected';
    } else {
      stat.textContent = overlayState.lastError ? `未接続：${overlayState.lastError}` : '未接続';
      stat.className = 'cap-overlay-status disconnected';
    }
  }
  if (toggleEl) {
    // v0.13.31: トグル化（チェック=接続中）。状態変化は change イベントで処理。
    toggleEl.checked = isOverlayConnected();
  }
  if (testToggleEl) {
    testToggleEl.disabled = !isOverlayConnected();
    // 切断したら自動的に OFF（テスト字幕も消える前提）
    if (!isOverlayConnected() && testToggleEl.checked) testToggleEl.checked = false;
  }
  if (ctBtn) {
    const supported = hasOverlayCapability('click-through');
    ctBtn.disabled = !isOverlayConnected() || !supported;
    ctBtn.checked = !!overlayState.clickThrough;
  }
  if (monSel) {
    const supported = hasOverlayCapability('multi-monitor');
    monSel.disabled = !isOverlayConnected() || !supported || overlayState.monitors.length === 0;
    if (overlayState.monitors.length > 0) {
      const desired = overlayState.monitors.map(m => `${m.index}:${m.name}`).join('|');
      if (monSel.dataset.signature !== desired) {
        monSel.innerHTML = '';
        for (const m of overlayState.monitors) {
          const opt = document.createElement('option');
          opt.value = String(m.index);
          opt.textContent = `${m.index}: ${m.name} ${m.width}x${m.height}${m.is_primary ? ' (主)' : ''}`;
          monSel.appendChild(opt);
        }
        monSel.dataset.signature = desired;
      }
    } else {
      monSel.innerHTML = '<option value="">（モニタ情報なし）</option>';
      monSel.dataset.signature = '';
    }
  }
  if (dlLink) {
    dlLink.style.display = isOverlayConnected() ? 'none' : '';
  }
}

function bindOverlayBridge() {
  // ツールバーのトグル
  if (els.btnOverlay) {
    els.btnOverlay.addEventListener('click', () => {
      if (isOverlayConnected()) disconnectOverlay();
      else connectNativeOverlay({ userInitiated: true });
    });
  }

  // v0.13.31: 設定パネル「字幕表示」トグル（旧「接続」ボタンの置き換え）
  const toggleEl = document.getElementById('cap-overlay-toggle');
  if (toggleEl) toggleEl.addEventListener('change', () => {
    if (toggleEl.checked) connectNativeOverlay({ userInitiated: true });
    else disconnectOverlay();
  });

  // v0.13.31: テスト字幕送信トグル（ON で送信、OFF で消す）
  const testToggleEl = document.getElementById('cap-overlay-test-toggle');
  if (testToggleEl) testToggleEl.addEventListener('change', () => {
    if (testToggleEl.checked) sendOverlayTestCaption();
    else clearOverlayTestCaption();
  });

  // クリックスルー
  const ctBtn = document.getElementById('cap-overlay-clickthrough');
  if (ctBtn) ctBtn.addEventListener('change', (e) => {
    setOverlayClickThrough(!!e.target.checked);
  });

  // モニタ選択
  const monSel = document.getElementById('cap-overlay-monitor');
  if (monSel) monSel.addEventListener('change', (e) => {
    const idx = Number(e.target.value);
    if (Number.isFinite(idx)) setOverlayMonitor(idx);
  });

  // インストーラ DL リンク（暫定：Phase 4 で正式整備）
  const dlLink = document.getElementById('cap-overlay-install');
  if (dlLink) dlLink.addEventListener('click', (e) => {
    e.preventDefault();
    alert('インストーラはまだ準備中です（dictation-overlay Phase 4 で対応予定）。\n\n現状は dictation-overlay リポジトリの README に従って手動セットアップしてください。');
  });

  // ページを離れるときは disconnect
  window.addEventListener('beforeunload', () => {
    disconnectOverlay();
  });

  updateOverlayUI();
}

/* v0.13.31: number-stepper のクリックハンドラ（app.js wireNumberSteppers と同等の移植）。
 * iframe（captions.html）内の <button class="number-stepper-btn"> 用。 */
function wireCapNumberSteppers() {
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

/* ───────── init ───────── */

function init() {
  // v0.13.31: icons.js による SVG 挿入（chevron-up/down 等）。
  // 続けて number-stepper のクリックハンドラも wire（captions 内独自実装）。
  if (typeof window.renderIcons === 'function') window.renderIcons();
  wireCapNumberSteppers();
  reflectSettingsToUI();
  applySettings();
  applyBox();
  applyTransitionMode();
  bindSettingsUI();
  bindBoxInteractions();
  bindSync();
  bindOverlayBridge();
  renderLatest();
  // v0.13.15: 字幕窓のリサイズで auto モードの 1行文字数が変わるので再計算
  window.addEventListener('resize', scheduleStreamRelayout);
  // 字幕ボックス自体のリサイズ（ユーザーがドラッグでサイズ変更）にも追従
  if (typeof ResizeObserver !== 'undefined' && els.text) {
    try {
      const ro = new ResizeObserver(() => scheduleStreamRelayout());
      ro.observe(els.text);
    } catch (e) { /* 古いブラウザは無視 */ }
  }
  document.title = '字幕（ライブキャプション）';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
