/**
 * 閉じたタブの保管庫 (v0.24.160)
 *
 * やっさんの指定（2026-11-18〜19・見本 https://claude.ai/artifact/QW2nLZGryaiJ5jMCJ4BNQs ）:
 *   閉じてしまったタブを戻せるように。雲（Notion に保存）の右に「閉じたタブを復元」のボタン、一覧で選んで戻す。
 *   残す期間は既定 1 週間・設定（保持するデータの取り扱い）で変えられる。録音（音声）は今までどおり閉じたら消す（「残す」にした録音だけ付く）。
 *
 * ■ なぜ IndexedDB か
 *   開いているタブは localStorage（dictation:sessions）に入っている。localStorage は 5MB ほどで頭打ちになり、
 *   長い講義の文字起こしを 1 週間ぶん積むとあふれて、**開いているタブの保存まで失敗する**おそれがある。
 *   閉じたタブは別の入れ物（IndexedDB）に分ける。音声（audio-store.js）・メモの画像（image-store.js）と同じ考え。
 *
 * ■ 入れるもの
 *   セッションのまるごと（文字起こし・メモ・要約・質問・タイトル・文脈・Notion 保存済みの印など）を、閉じた時刻と一緒に。
 *   保存のキー（セッションの id）は変えない。戻すときは同じ id で戻す（「残す」にした録音が同じ id で付いてくる）。
 */
const CLOSED_DB_NAME = 'dictation-closed-tabs';
const CLOSED_DB_VERSION = 1;
const CLOSED_STORE = 'tabs';

/** 期間を過ぎたものを選ぶ（純関数・テスト用） days が 0 なら全部が期限切れ（残さない） */
function closedTabsExpired(list, now, days) {
  const limit = Math.max(0, Number(days) || 0) * 24 * 3600 * 1000;
  return (list || []).filter((r) => !r || !Number.isFinite(r.closedAt) || now - r.closedAt >= limit).map((r) => r && r.id);
}

let _closedDbPromise = null;
function closedTabsOpen() {
  if (_closedDbPromise) return _closedDbPromise;
  _closedDbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) { reject(new Error('IndexedDB が使えません')); return; }
    const req = indexedDB.open(CLOSED_DB_NAME, CLOSED_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CLOSED_STORE)) db.createObjectStore(CLOSED_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB を開けません'));
  });
  _closedDbPromise.catch(() => { _closedDbPromise = null; });   // 開けないまま固定しない
  return _closedDbPromise;
}
function _closedWrap(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

/** 閉じたタブを入れる（同じ id があれば上書き） */
async function closedTabsPut(sessions, closedAt = Date.now()) {
  const db = await closedTabsOpen();
  const os = db.transaction(CLOSED_STORE, 'readwrite').objectStore(CLOSED_STORE);
  // 中身は JSON で写して入れる（DOM の参照や関数が混ざっていても入るように。localStorage に入れているのと同じ形）
  await Promise.all(sessions.map((s) => _closedWrap(os.put({ id: s.id, closedAt, session: JSON.parse(JSON.stringify(s)) }))));
}

/** 一覧（新しく閉じた順） */
async function closedTabsList() {
  const db = await closedTabsOpen();
  const all = await _closedWrap(db.transaction(CLOSED_STORE, 'readonly').objectStore(CLOSED_STORE).getAll());
  return (all || []).sort((a, b) => b.closedAt - a.closedAt);
}

/** 取り出して消す（戻すとき） */
async function closedTabsTake(ids) {
  const db = await closedTabsOpen();
  const os = db.transaction(CLOSED_STORE, 'readwrite').objectStore(CLOSED_STORE);
  const out = [];
  for (const id of ids) {
    const r = await _closedWrap(os.get(id));
    if (r) { out.push(r); await _closedWrap(os.delete(id)); }
  }
  return out;
}

/** 期間を過ぎたものを消す。消した id を返す */
async function closedTabsPrune(days, now = Date.now()) {
  const list = await closedTabsList();
  const gone = closedTabsExpired(list, now, days);
  if (!gone.length) return [];
  const db = await closedTabsOpen();
  const os = db.transaction(CLOSED_STORE, 'readwrite').objectStore(CLOSED_STORE);
  await Promise.all(gone.map((id) => _closedWrap(os.delete(id))));
  return gone;
}

if (typeof module !== 'undefined') module.exports = { closedTabsExpired };
