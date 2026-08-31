/**
 * gemini-files.js — Files API へのアップロード (v0.21.0)
 *
 * 「録音後に全文をもう一度 Gemini に通して、話者判別つきで作り直す」ために、
 * 保管しておいた音声を Google に上げる。
 *
 * ■ なぜ Files API か（インライン送信ではなく）
 *
 * generateContent には音声を base64 で直接埋められるが、base64 は 1.33 倍に
 * 膨らむうえ、リクエスト全体の上限（100MB）を丸ごと1発で使う。
 * Files API に上げれば URI を渡すだけで済み、**同じファイルを何度でも参照できる**
 * （失敗して投げ直すときに再アップロードが要らない）。
 *
 * ■ どのアップロード方式を使うか — 実測で決めた
 *
 * 公式のサンプルはレジューム可能アップロードだが、**ブラウザからは当てにできない**。
 * この方式は1手目の応答ヘッダ `X-Goog-Upload-URL` を読む必要があるのに、
 * 実測した応答の `Access-Control-Expose-Headers` にその名前が無い:
 *
 *   access-control-expose-headers: Content-Length, Date, Server, Transfer-Encoding,
 *                                  X-GUploader-UploadID, X-Goog-Upload-Status, X-Google-Trace, vary
 *
 * 露出されていないヘッダは `res.headers.get()` で null になるので、
 * 成功時にだけ露出される可能性に賭けることになる。**賭けない。**
 *
 * 代わりに multipart（`X-Goog-Upload-Protocol: multipart`）を使う。
 * 結果が応答**本体**の JSON で返るので、ヘッダの露出に一切依存しない。
 * サーバがこの方式を受け付けることは実測で確認済み（プロトコル自体は通り、
 * API キーの検証まで進む）。
 *
 * レジューム可能の利点は「途中で切れても続きから送れる」ことだが、
 * v0.21.0 で音声を約10分ごとの区間に分けたので**1回あたり約5MB**しかない。
 * 切れたら投げ直すほうが、複雑さに見合う。
 *
 * ■ 消すこと
 *
 * 上げたファイルは Google 側で48時間後に自動削除されるが、**待たない**。
 * 使い終わったら明示的に消す（`geminiFileDelete`）。DELETE が CORS で
 * 通ることは実測済み。消せなくても48時間で消えるので、失敗しても止めない。
 */

const GEMINI_FILES_UPLOAD = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_FILES_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** ACTIVE になるまで待つときの間隔と上限 */
const FILE_POLL_MS = 1000;
const FILE_POLL_MAX_MS = 5 * 60 * 1000;

/**
 * 音声を1本アップロードする (v0.21.0)
 *
 * XHR を使うのは **進捗が欲しいから**。fetch にはアップロード側の進捗が無い。
 * 数MBを無言で待たせると「固まった」と思われる。
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {Blob}   args.blob
 * @param {string} [args.displayName]
 * @param {(ratio:number)=>void} [args.onProgress]  0〜1
 * @param {{aborted:boolean}} [args.cancel]  やり直しの中止用（呼び出し側が立てる）
 * @returns {Promise<{name:string, uri:string, mimeType:string, state:string}>}
 */
function geminiFileUpload({ apiKey, blob, displayName, onProgress, cancel }) {
  if (!apiKey) return Promise.reject(new Error('Gemini API キーが設定されていません'));
  if (!blob || !blob.size) return Promise.reject(new Error('アップロードする音声がありません'));

  const boundary = 'dictation-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const mimeType = blob.type || 'audio/webm';
  const meta = JSON.stringify({ file: { display_name: displayName || 'dictation-audio' } });

  // multipart/related の組み立て。JSON パートと音声パートを境界で挟む。
  // Blob をそのまま並べるので、数MBでも文字列にはならない
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--\r\n`,
  ]);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${GEMINI_FILES_UPLOAD}?key=${encodeURIComponent(apiKey)}`);
    xhr.setRequestHeader('X-Goog-Upload-Protocol', 'multipart');
    xhr.setRequestHeader('Content-Type', `multipart/related; boundary=${boundary}`);

    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
    }
    // 中止の見張り。XHR は abort() があるので、途中でも本当に止められる
    let watch = null;
    if (cancel) {
      watch = setInterval(() => {
        if (cancel.aborted) { try { xhr.abort(); } catch {} }
      }, 300);
    }
    const done = () => { if (watch) clearInterval(watch); };

    xhr.onload = () => {
      done();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`アップロードに失敗しました (${xhr.status}): ${String(xhr.responseText || '').slice(0, 300)}`));
        return;
      }
      let data;
      try { data = JSON.parse(xhr.responseText); }
      catch { reject(new Error('アップロードの応答を読めませんでした')); return; }
      const f = data && data.file;
      if (!f || !f.uri) { reject(new Error('アップロードの応答にファイルの URI がありません')); return; }
      resolve({ name: f.name || '', uri: f.uri, mimeType: f.mimeType || mimeType, state: f.state || 'PROCESSING' });
    };
    xhr.onerror = () => { done(); reject(new Error('アップロードに失敗しました（通信エラー）')); };
    xhr.onabort = () => { done(); reject(new Error('中止しました')); };
    xhr.send(body);
  });
}

/**
 * ファイルが使える状態（ACTIVE）になるまで待つ
 *
 * 上げた直後は PROCESSING で、そのまま generateContent に渡すと弾かれる。
 * FAILED になったら待っても変わらないので、その場で諦める。
 */
async function geminiFileWaitActive({ apiKey, name, cancel }) {
  if (!name) return null;
  const url = `${GEMINI_FILES_BASE}/${name}?key=${encodeURIComponent(apiKey)}`;
  const until = Date.now() + FILE_POLL_MAX_MS;
  for (;;) {
    if (cancel && cancel.aborted) throw new Error('中止しました');
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`ファイルの状態を確認できません (${res.status})`);
    }
    const f = await res.json();
    if (f.state === 'ACTIVE') return f;
    if (f.state === 'FAILED') {
      throw new Error('アップロードした音声を Google 側で処理できませんでした');
    }
    if (Date.now() > until) throw new Error('アップロードした音声が使える状態になりません（時間切れ）');
    await new Promise(r => setTimeout(r, FILE_POLL_MS));
  }
}

/**
 * 上げたファイルを消す。**使い終わったら必ず呼ぶ。**
 *
 * 48時間で自動削除されるとはいえ、置いておく理由が無い。
 * 失敗しても呼び出し側は止めない（自動削除が残っているので、実害は
 * 「48時間残る」だけ。そのために画面を止める価値は無い）。
 */
async function geminiFileDelete({ apiKey, name }) {
  if (!apiKey || !name) return false;
  try {
    const res = await fetch(`${GEMINI_FILES_BASE}/${name}?key=${encodeURIComponent(apiKey)}`,
      { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
