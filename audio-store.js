/**
 * audio-store.js — 録音音声の一時保管 (v0.19.0 / v0.21.0)
 *
 * 「保管した録音をまとめて Gemini に通し、話者付きで書き起こす」ための
 * 音声を置いておく場所。live の文字起こしは従来どおりチャンクごとに進むので、
 * ここは**話者判別をかけたときだけ**使う。
 *
 * ■ なぜ IndexedDB か
 *
 * 90分の録音は 64kbps でも約43MB になる。他の選択肢は全部これより悪い:
 *
 *   localStorage        … 文字列専用・数MB上限。論外
 *   ローカルフォルダ指定 … File System Access API は Android Chrome に無い。
 *                          スマホ対応の道を最初に塞ぐ
 *   Google ドライブ     … OAuth が要る・毎回数十MBをアップロード・ネット必須。
 *                          話者判別は端末から送るだけなので、外に出す必要がない
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
 * すでに音声を Google に送っている。話者判別を実行すればさらに全体を
 * アップロードする（Google 側で48時間後に自動削除される）。
 * IndexedDB からの削除はレコードを消すもので、ディスク上の領域が
 * 上書きされることまでは保証しない。
 *
 * ■ v0.21.0: 保管の単位を作り直した（v0.19.0 は再生できない形で貯めていた）
 *
 * v0.19.0 は live 送信用のチャンク（`stop()` で切った完結した webm）を
 * そのまま貯めて、話者判別のときに `new Blob([...])` で繋ぐつもりでいた。
 * **これは繋がらない。**
 *
 * MediaRecorder を `stop()` して `start()` し直すと、次の録音は
 * **独立した webm ファイル**として始まる。つまり EBML ヘッダから始まる。
 * それを単純に連結すると、1本のファイルの中に EBML ヘッダが何十個も
 * 並んだバイト列になる。さらに配信録画の Segment はサイズ不明
 * （最後まで＝ファイル終端まで、の意味）で書かれているので、
 * デコーダは2本目以降を「1本目の Segment の中身」として読もうとする。
 * 素直に読めるのは**最初の12〜20秒だけ**になる。
 *
 * 直し方は「貯め方を変える」。live 用とは別に、**もう1つ MediaRecorder を
 * 同じストリームに掛け、`start(timeslice)` で回す**。timeslice で出てくる
 * かけらは1本の録音の続きなので、順に連結すれば正しい webm になる
 * （これが MediaRecorder の本来の使い方）。
 *
 * ■ さらに「区間」に分ける
 *
 * 1本にまとめると、90分＝約43MB・約17万トークンの音声を一度に投げることになり、
 * 応答も数万字になる。長い出力ほど途中で崩れるし、失敗したとき全部やり直しになる。
 *
 * そこで保管の時点で**約10分ごとの区間**に分ける（`seg`）。区間の切れ目は
 * live 側と同じ無音検出を使うので、`stop → start` の 40ms の空白は無音に落ちる。
 * 話者判別は区間ごとに投げ、前の区間の話者一覧と末尾を渡して繋ぐ。
 */

const AUDIO_DB_NAME = 'dictation-audio';
const AUDIO_DB_VERSION = 2;
const AUDIO_STORE = 'chunks';

/** 「話者判別が終わったら消す」を選んでも、かけなかった場合の歯止め */
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
 * @param {number} [args.repassDoneAt]   話者判別が完了した時刻（未実施なら falsy）
 *   ※ 名前が repass のままなのは、すでに保存されているセッションと設定値を
 *      読めなくしないため。画面の表記は「話者判別」に統一してある
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
      // 話者判別が済んだら用済み。かけないまま放置された場合の歯止めも置く
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
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        const os = db.createObjectStore(AUDIO_STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('sessionId', 'sessionId', { unique: false });
        return;
      }
      // v1 → v2: v1 のレコードは stop/start で切った独立した webm なので、
      // 繋いでも再生できない（冒頭の解説を参照）。持っていても使い道が無いうえ、
      // 録音は残らないほうが既定なので**捨てる**。
      if ((ev.oldVersion || 0) < 2) {
        try { req.transaction.objectStore(AUDIO_STORE).clear(); } catch { /* 空でも進む */ }
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
 * かけらを1つ保存する (v0.21.0)
 *
 * ここに来るのは `start(timeslice)` が吐いたかけらで、**単体では再生できない**。
 * 同じ `seg` のものを `seq` 順に繋いで初めて1本の webm になる。
 *
 * @param {string} sessionId
 * @param {Blob} blob
 * @param {number} seq  区間の中での順番
 * @param {number} seg  区間番号（約10分ごとに増える）
 */
async function audioStorePut(sessionId, blob, seq, seg) {
  const db = await audioStoreOpen();
  return _wrap(_tx(db, 'readwrite').add({
    sessionId, seq, blob,
    seg: Number.isFinite(seg) ? seg : 0,
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

/**
 * そのセッションの音声を、区間ごとに1本の Blob へ繋いで返す（話者判別用） (v0.21.0)
 *
 * 区間の中では `seq` 順に繋ぐ。**区間をまたいで繋いではいけない**
 * （区間ごとに独立した webm なので、繋ぐと最初の区間しか読めなくなる）。
 *
 * @returns {Promise<Array<{seg:number, blob:Blob, bytes:number}>>} seg の昇順
 */
async function audioStoreGetSegments(sessionId) {
  const db = await audioStoreOpen();
  const rows = await _wrap(_tx(db, 'readonly').index('sessionId').getAll(sessionId));
  if (!rows.length) return [];
  return groupAudioSegments(rows).map(g => ({
    seg: g.seg,
    blob: new Blob(g.parts, { type: g.type }),
    bytes: g.bytes,
  }));
}

/**
 * レコードを区間ごとにまとめる (v0.21.0)
 *
 * Blob を作らない純関数にしてあるのは、並べ替えを間違えると
 * **音が入れ替わった文字起こし**という気づきにくい壊れ方をするため。
 *
 * @param {Array<{seg?:number, seq:number, blob:*, bytes?:number, type?:string}>} rows
 * @returns {Array<{seg:number, parts:*[], bytes:number, type:string}>}
 */
function groupAudioSegments(rows) {
  const bySeg = new Map();
  for (const r of rows || []) {
    // seg を持たないレコード（v1 の残り）は 0 番として扱う
    const seg = Number.isFinite(r.seg) ? r.seg : 0;
    const g = bySeg.get(seg) || { seg, rows: [], bytes: 0, type: r.type || 'audio/webm' };
    g.rows.push(r);
    g.bytes += r.bytes || 0;
    bySeg.set(seg, g);
  }
  return Array.from(bySeg.values())
    .sort((a, b) => a.seg - b.seg)
    .map(g => {
      g.rows.sort((a, b) => a.seq - b.seq);
      return { seg: g.seg, parts: g.rows.map(r => r.blob), bytes: g.bytes, type: g.type };
    });
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
 * @param {Map<string, number>} [args.repassDoneAt]        セッションID → 話者判別の完了時刻
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
