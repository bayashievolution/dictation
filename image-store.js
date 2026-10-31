/**
 * image-store.js — メモに貼った画像の保管 (v0.22.0)
 *
 * メモは「軽快でシンプル」を狙っていて、画像を入れるメニューは**あえて置いていない**。
 * ただし contenteditable の標準機能で Ctrl+V の画像が貼れてしまう。
 * これは便利なので**裏技として残す**、というのがやっさんの判断。
 *
 * ■ そのままだと危険だった（v0.22.0 で直した）
 *
 * v0.21.4 までは、貼った画像が `<img src="data:image/png;base64,...">` として
 * **そのまま localStorage に入っていた**。
 *
 *   スクショ1枚          200KB〜2MB
 *   base64 にすると      さらに 1.33 倍
 *   localStorage の上限  **全タブ合わせて約5MB**
 *
 * つまりスクショ2〜3枚で満杯になる。満杯になると persistSessions() が丸ごと
 * 失敗し、**その回の変更が全タブぶん保存されない**。v0.21.2 で気づけるように
 * したが、そもそも入れないほうがよい。
 *
 * ■ 直し方
 *
 *   1. 貼るときに縮小する（長辺 1600px / WebP）。数MB → 数百KB
 *   2. 画像の本体は **IndexedDB** に置く。localStorage には id だけ
 *
 * 保存される HTML はこうなる（src を持たない）:
 *
 *     <img data-img-id="im_..." style="width:420px">
 *
 * 画面に出すときに blob: の URL を差し込み（hydrate）、
 * HTML で保存するときは data: に戻して**1枚のファイルで完結**させる。
 *
 * ■ 出口ごとの扱い（正直に書いておく）
 *
 *   HTML保存    … data: で埋め込むので残る
 *   Notion      … **送れない**。画像ブロックは外部URLかアップロード済みファイルしか
 *                 受け付けないので、代わりに「画像は送れません」という段落を置く
 *   コピー      … 消える（テキストだけ）
 */

const IMAGE_DB_NAME = 'dictation-images';
const IMAGE_DB_VERSION = 1;
const IMAGE_STORE = 'images';

/** 縮小の目安。これより長辺が大きければ縮める */
const IMAGE_MAX_EDGE = 1600;
/** WebP の品質。0.85 は見た目の劣化がほぼ分からず、サイズがよく落ちる */
const IMAGE_QUALITY = 0.85;
/**
 * これを超える貼り付けは受け取らない。
 * 巨大な画像を canvas に載せるとタブごと固まることがあるので、**その前に断る**。
 */
const IMAGE_MAX_INPUT_BYTES = 24 * 1024 * 1024;
/** 縮小しても超えていたら、貼れたことにしない（保管庫が太りすぎる） */
const IMAGE_MAX_STORED_BYTES = 4 * 1024 * 1024;

/* ───────── 純関数（テストできる形で置く） ───────── */

/**
 * 縮小後の寸法を決める (v0.22.0)
 *
 * 長辺を maxEdge に合わせる。**拡大はしない**（小さい画像をぼかさない）。
 */
function planImageResize({ width, height, maxEdge }) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const max = Number.isFinite(maxEdge) && maxEdge > 0 ? maxEdge : IMAGE_MAX_EDGE;
  if (w <= 0 || h <= 0) return { width: 0, height: 0, scaled: false };
  const longEdge = Math.max(w, h);
  if (longEdge <= max) return { width: w, height: h, scaled: false };
  const r = max / longEdge;
  return { width: Math.max(1, Math.round(w * r)), height: Math.max(1, Math.round(h * r)), scaled: true };
}

/**
 * 貼り付けられたものを見て、どう反応するかを決める (v0.22.0)
 *
 * やっさんの要望:
 * > 想定より様々なことが Ctrl+V される可能性があるから
 * > pdf は埋め込めない（あくまで軽快シンプルを目指している）にしても
 * > 想定して反応は示したいよね　バグって落ちたりとかは絶対に避けたい
 *
 * なので「知らない種類が来たら何もしない」ではなく、**必ずどれかに分類する**。
 * 迷ったら 'text'（＝ブラウザの標準の貼り付けに任せる）に倒す。
 * 標準に任せておけば、少なくとも壊れない。
 *
 * @param {Array<{kind:string, type:string}>} items  clipboardData.items 相当
 * @returns {{action:'image'|'reject'|'text', mime?:string, why?:string}}
 */
function classifyPaste(items) {
  const list = Array.from(items || []);
  // 画像が1つでもあれば画像として扱う。
  // スクショは image/png だけ、Web からのコピーは text/html と image が両方来る。
  // **画像を優先する**（HTML 側には遠隔の URL しか入っていないことが多いため）
  const img = list.find(i => i && i.kind === 'file' && /^image\//.test(i.type || ''));
  if (img) {
    // SVG は中にスクリプトを書けるので受け取らない。メモに貼る価値もほぼ無い
    if (/svg/i.test(img.type)) return { action: 'reject', mime: img.type, why: 'svg' };
    return { action: 'image', mime: img.type };
  }
  const file = list.find(i => i && i.kind === 'file' && i.type);
  if (file) return { action: 'reject', mime: file.type, why: 'file' };
  // 種類の分からないファイル（type が空）も、貼り付けとしては受け取らない
  const unknownFile = list.find(i => i && i.kind === 'file');
  if (unknownFile) return { action: 'reject', mime: '', why: 'file' };
  return { action: 'text' };
}

/** 受け取らなかったときに画面へ出す一言。**何が起きたかと、どうすればよいかを言う** */
function describePasteReject({ mime, why }) {
  if (why === 'svg') return 'SVG は貼り付けできません（PNG などに変換してから貼ってください）';
  const kind = (mime || '').split('/').pop().toUpperCase();
  if (/pdf/i.test(mime || '')) {
    return 'PDF はメモに貼り付けできません（メモは軽さを優先しています。画像なら貼れます）';
  }
  return kind
    ? `${kind} ファイルはメモに貼り付けできません（貼れるのは文字と画像です）`
    : 'このファイルはメモに貼り付けできません（貼れるのは文字と画像です）';
}

/** 保存する HTML から、差し込んだ src を外す。**blob: の URL を保存しないため** */
function stripManagedImageSrc(html) {
  if (!html || html.indexOf('data-img-id') < 0) return html || '';
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const root = doc.getElementById('r');
  root.querySelectorAll('img[data-img-id]').forEach(img => img.removeAttribute('src'));
  return root.innerHTML;
}

/** その HTML が参照している画像 id を集める（掃除に使う） */
function collectImageIds(html) {
  const out = new Set();
  if (!html) return out;
  const re = /data-img-id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.add(m[1]);
  return out;
}

/* ───────── IndexedDB ───────── */

let _imgDbPromise = null;

function imageStoreOpen() {
  if (_imgDbPromise) return _imgDbPromise;
  _imgDbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) { reject(new Error('IndexedDB が使えません')); return; }
    const req = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB を開けません'));
  });
  _imgDbPromise.catch(() => { _imgDbPromise = null; });
  return _imgDbPromise;
}

function _imgTx(db, mode) {
  return db.transaction(IMAGE_STORE, mode).objectStore(IMAGE_STORE);
}
function _imgWrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function newImageId() {
  return 'im_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function imageStorePut(id, blob) {
  const db = await imageStoreOpen();
  await _imgWrap(_imgTx(db, 'readwrite').put({
    id, blob, bytes: blob.size, type: blob.type || 'image/webp', savedAt: Date.now(),
  }));
  return id;
}

async function imageStoreGet(id) {
  const db = await imageStoreOpen();
  const row = await _imgWrap(_imgTx(db, 'readonly').get(id));
  return row ? row.blob : null;
}

async function imageStoreSummary() {
  const db = await imageStoreOpen();
  const rows = await _imgWrap(_imgTx(db, 'readonly').getAll());
  return { count: rows.length, bytes: rows.reduce((n, r) => n + (r.bytes || 0), 0) };
}

/**
 * どのメモからも参照されていない画像を消す。**起動時に呼ぶ。**
 *
 * メモから画像を消しただけでは保管庫に残る（取り消しで戻せるようにするため、
 * その場では消さない）。参照されなくなったものを、あとからまとめて片付ける。
 */
async function imageStoreSweep(usedIds) {
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds || []);
  const db = await imageStoreOpen();
  const os = _imgTx(db, 'readwrite');
  const keys = await _imgWrap(os.getAllKeys());
  let deleted = 0;
  for (const k of keys) {
    if (used.has(k)) continue;
    os.delete(k);
    deleted++;
  }
  return deleted;
}

async function imageStoreClearAll() {
  const db = await imageStoreOpen();
  const os = _imgTx(db, 'readwrite');
  const n = await _imgWrap(os.count());
  await _imgWrap(os.clear());
  return n;
}

/* ───────── 縮小 ───────── */

/**
 * 貼り付けられた画像を、保管してよいサイズに落とす (v0.22.0)
 *
 * ■ 触らないもの
 *
 *   GIF … 縮小すると**アニメーションが1コマになる**。黙って壊すより、
 *         そのまま入れて上限で弾かれるほうがまだ分かりやすい
 *   すでに小さいもの … 再エンコードすると劣化するだけで得が無い
 *
 * ■ 失敗しても投げない
 *
 * 壊れた画像・見たことのない形式・canvas が使えない、のどれでも
 * **元の Blob を返す**。ここで例外を投げると貼り付け操作そのものが
 * 落ちてしまう。落とさないことを最優先にする。
 *
 * @returns {Promise<{blob: Blob, scaled: boolean, from: number, to: number}>}
 */
async function downscaleImage(blob, { maxEdge = IMAGE_MAX_EDGE, quality = IMAGE_QUALITY } = {}) {
  const keep = { blob, scaled: false, from: blob.size, to: blob.size };
  if (!blob || !blob.size) return keep;
  if (/gif/i.test(blob.type || '')) return keep;

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return keep;   // 読めない画像。触らずに返す
  }
  try {
    const plan = planImageResize({ width: bitmap.width, height: bitmap.height, maxEdge });
    // 縮小が要らず、もともと小さいならそのまま
    if (!plan.scaled && blob.size <= 400 * 1024) return keep;

    const canvas = document.createElement('canvas');
    canvas.width = plan.width || bitmap.width;
    canvas.height = plan.height || bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return keep;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const out = await new Promise(res => canvas.toBlob(res, 'image/webp', quality));
    // toBlob が null を返す（WebP 非対応など）／かえって大きくなったなら元を使う
    if (!out || !out.size || out.size >= blob.size) return keep;
    return { blob: out, scaled: true, from: blob.size, to: out.size };
  } catch {
    return keep;
  } finally {
    try { bitmap.close(); } catch { /* close 非対応でも問題ない */ }
  }
}

/** Blob → data: URL（HTML保存で1枚のファイルに収めるときに使う） */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
