/**
 * audio-store.js — 録音音声の一時保管 (v0.19.0)
 *
 * 「録音後に全文をもう一度 Gemini に通して、話者判別つきで作り直す」ための
 * 音声を置いておく場所。live の文字起こしは従来どおりチャンクごとに進むので、
 * ここは**やり直しを選んだときだけ**使う。
 *
 * ■ なぜ IndexedDB か
 *
 * 90分の録音は 64kbps でも約43MB になる。他の選択肢は全部これより悪い:
 *
 *   localStorage        … 文字列専用・数MB上限。論外
 *   ローカルフォルダ指定 … File System Access API は Android Chrome に無い。
 *                          スマホ対応の道を最初に塞ぐ
 *   Google ドライブ     … OAuth が要る・毎回数十MBをアップロード・ネット必須。
 *                          やり直しは端末から送るだけなので、外に出す必要がない
 *
 * IndexedDB は Blob をそのまま入れられて、許可ダイアログも設定も要らず、
 * 拡張でも Android Chrome でも iOS Safari でも同じコードで動く。
 *
 * ■ 消えることを構造で保証する
 *
 * 「録音の保存はダメ（文字起こしはOK）」という同意の場面は普通にあるので、
 * **既定は保持しない**。保持する場合も、消し忘れが起きない作りにする:
 *
 *   - タブ（セッション）が無くなった音声は、設定に関係なく必ず消す
 *   - 「タブを閉じたら消す」はクラッシュや強制リロードでは走らないので、
 *     **起動時の掃除**を本体にする（audioStoreSweep）
 *   - 未知の設定値は「消す」側に倒す（保持する側に倒さない）
 *
 * ■ 正直に書いておくこと
 *
 * この保管は「端末に残すか」だけを制御する。Gemini モードは live の時点で
 * すでに音声を Google に送っている。やり直しを実行すればさらに全体を
 * アップロードする（Google 側で48時間後に自動削除される）。
 * IndexedDB からの削除はレコードを消すもので、ディスク上の領域が
 * 上書きされることまでは保証しない。
 */

const AUDIO_DB_NAME = 'dictation-audio';
const AUDIO_DB_VERSION = 1;
const AUDIO_STORE = 'chunks';

/** 「やり直しが終わったら消す」を選んでも、やり直さなかった場合の歯止め */
const AUDIO_REPASS_BACKSTOP_MS = 24 * 60 * 60 * 1000;

/**
 * この音声を消すべきか (v0.19.0)
 *
 * 純関数にしてあるのは、ここを間違えると「消したはずの録音が残る」という
 * 一番まずい壊れ方をするため。判断を1か所に集めてテストできるようにする。
 *
 * @param {object} args
 * @param {string} args.retention        設定値
 * @param {number} args.savedAt          保存した時刻
 * @param {number} args.now              いまの時刻
 * @param {boolean} args.sessionExists   その音声のセッション（タブ）がまだあるか
 * @param {number} [args.repassDoneAt]   やり直しが完了した時刻（未実施なら falsy）
 * @returns {boolean} true = 消す
 */
function audioRetentionExpired({ retention, savedAt, now, sessionExists, repassDoneAt }) {
  // タブが無くなった音声は、どの設定でも必ず消す。
  // 到達する手段が無いのに残しているのは、ただの置き忘れ
  if (!sessionExists) return true;

  const age = now - savedAt;
  switch (retention) {
    case 'off':
      // 保持設定そのものがオフ。設定を切った時点で残っている分も消えてほしい
      return true;
    case 'repass':
      // やり直しが済んだら用済み。走らせないまま放置された場合の歯止めも置く
      return !!repassDoneAt || age >= AUDIO_REPASS_BACKSTOP_MS;
    case 'close':
      return false;                    // セッションが消えたときだけ（上で処理済み）
    case '1d':
      return age >= 24 * 60 * 60 * 1000;
    case '7d':
      return age >= 7 * 24 * 60 * 60 * 1000;
    case 'manual':
      return false;
    default:
      // 設定が壊れている・未知の値。**保持する側に倒さない**
      return true;
  }
}

/** 「保持中: 43.2 MB」のような表示用 */
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ───────── IndexedDB ───────── */

let _audioDbPromise = null;

function audioStoreOpen() {
  if (_audioDbPromise) return _audioDbPromise;
  _audioDbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) { reject(new Error('IndexedDB が使えません')); return; }
    const req = indexedDB.open(AUDIO_DB_NAME, AUDIO_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        const os = db.createObjectStore(AUDIO_STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB を開けません'));
  });
  // 失敗したら次回もう一度試せるようにする（開けないまま固定しない）
  _audioDbPromise.catch(() => { _audioDbPromise = null; });
  return _audioDbPromise;
}

function _tx(db, mode) {
  return db.transaction(AUDIO_STORE, mode).objectStore(AUDIO_STORE);
}

function _wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * チャンクを1つ保存する
 * @param {string} sessionId
 * @param {Blob} blob
 * @param {number} seq  そのセッションの中での順番（結合時に使う）
 */
async function audioStorePut(sessionId, blob, seq) {
  const db = await audioStoreOpen();
  return _wrap(_tx(db, 'readwrite').add({
    sessionId, seq, blob,
    bytes: blob.size,
    type: blob.type || 'audio/webm',
    savedAt: Date.now(),
  }));
}

/** セッションごとの保持状況（件数・バイト数・保存時刻） */
async function audioStoreSummary() {
  const db = await audioStoreOpen();
  const rows = await _wrap(_tx(db, 'readonly').getAll());
  const bySession = new Map();
  for (const r of rows) {
    const cur = bySession.get(r.sessionId)
      || { sessionId: r.sessionId, count: 0, bytes: 0, savedAt: r.savedAt, type: r.type };
    cur.count++;
    cur.bytes += r.bytes || 0;
    // savedAt はそのセッションでいちばん古い保存時刻（＝録音開始に近い）
    if (r.savedAt < cur.savedAt) cur.savedAt = r.savedAt;
    bySession.set(r.sessionId, cur);
  }
  const sessions = Array.from(bySession.values()).sort((a, b) => a.savedAt - b.savedAt);
  return {
    sessions,
    totalBytes: sessions.reduce((s, x) => s + x.bytes, 0),
    totalCount: sessions.reduce((s, x) => s + x.count, 0),
  };
}

/** そのセッションの音声を1つの Blob に繋いで返す（やり直し用） */
async function audioStoreGetBlob(sessionId) {
  const db = await audioStoreOpen();
  const rows = await _wrap(_tx(db, 'readonly').index('sessionId').getAll(sessionId));
  if (!rows.length) return null;
  rows.sort((a, b) => a.seq - b.seq);
  return new Blob(rows.map(r => r.blob), { type: rows[0].type || 'audio/webm' });
}

/** そのセッションの音声を消す。消した件数を返す */
async function audioStoreDeleteSession(sessionId) {
  const db = await audioStoreOpen();
  const os = _tx(db, 'readwrite');
  const keys = await _wrap(os.index('sessionId').getAllKeys(sessionId));
  for (const k of keys) os.delete(k);
  return keys.length;
}

/** 全部消す */
async function audioStoreClearAll() {
  const db = await audioStoreOpen();
  const os = _tx(db, 'readwrite');
  const n = await _wrap(os.count());
  await _wrap(os.clear());
  return n;
}

/**
 * 期限切れを掃除する。**起動時に必ず呼ぶこと。**
 *
 * 「タブを閉じたら消す」はクラッシュや強制リロードでは走らないので、
 * こちらが消し忘れを防ぐ本体になる。
 *
 * @param {object} args
 * @param {string} args.retention              設定値
 * @param {Set<string>|Array<string>} args.liveSessionIds  いま存在するセッションID
 * @param {Map<string, number>} [args.repassDoneAt]        セッションID → やり直し完了時刻
 * @returns {Promise<{deletedSessions: number, deletedBytes: number}>}
 */
async function audioStoreSweep({ retention, liveSessionIds, repassDoneAt }) {
  const live = liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds || []);
  const done = repassDoneAt instanceof Map ? repassDoneAt : new Map();
  const now = Date.now();
  const { sessions } = await audioStoreSummary();

  let deletedSessions = 0, deletedBytes = 0;
  for (const s of sessions) {
    const expired = audioRetentionExpired({
      retention,
      savedAt: s.savedAt,
      now,
      sessionExists: live.has(s.sessionId),
      repassDoneAt: done.get(s.sessionId),
    });
    if (!expired) continue;
    await audioStoreDeleteSession(s.sessionId);
    deletedSessions++;
    deletedBytes += s.bytes;
  }
  return { deletedSessions, deletedBytes };
}
