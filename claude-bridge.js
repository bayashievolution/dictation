/**
 * claude-bridge.js — 後処理を利用者自身の Claude Code に回す (v0.24.0)
 *
 * > 持ってる人は Claude のサブスク料金でおさまるならそれがいいよね
 *
 * **Gemini は置き換えない。** 足すだけ。
 * 使うかどうかは設定で切り替え、繋がらなければ Gemini に戻る。
 *
 * ■ 何を回して、何を回さないか
 *
 * 実測で `claude -p` は1行の整形に 8〜10秒かかる。録音中のチャンク整形は
 * 12〜20秒ごとに走るので**間に合わない**。なので回すのは後処理だけ。
 *
 *   回す   … 要約 / 質問 / タイトル / 全体整形 / メモの選択範囲整形
 *   回さない … 文字起こし・話者判別（音声は Claude の API に入らない）
 *              録音中のチャンク整形・字幕整形（速度が足りない）
 *              文脈の自動抽出（JSON で返す必要がある）
 *
 * ■ プロンプトは作り直さない
 *
 * Gemini 向けに積み上げたプロンプトを**そのまま**使う。
 * 捏造を止める書き方も、「分かりません」を出しすぎない書き方も、
 * 実機で何度も直した結果なので、Claude 用に書き直せば必ず食い違っていく。
 * なので Gemini 用に組み立てた body を、ここで1本のプロンプトに畳む。
 *
 * ■ 繋がらないときは Gemini に戻る。ただし黙らない
 *
 * サーバーが動いていないことは普通に起きる（start.bat を立ち上げていない等）。
 * そこで止めるとアプリが使えなくなるので Gemini に戻すが、
 * **戻したことは必ず画面に出す**。黙って戻すと、サブスクで済ませたいのに
 * 気づかないまま Gemini のトークンを使い続けることになる。
 */

/** 既定の中継先。serve.js が 127.0.0.1:8765 で待っている（ブラウザ版・start.bat の人） */
const CLAUDE_BRIDGE_URL = 'http://127.0.0.1:8765/api/claude';

/**
 * インストール式の口（ネイティブメッセージング）の登録名 (v0.24.21)
 * claude-installer.js の DICTATION_HELPER_NAME と同じ。字幕オーバーレイを将来まとめる前提で
 * Claude 専用の名前にしていない
 */
const CLAUDE_NATIVE_HOST = 'com.dictation.helper';

/** インストールされていないときの文言。fallback / health の両方で使う */
const CLAUDE_NOT_INSTALLED = 'Claude 連携がインストールされていません（設定の「連携アプリをダウンロード」から入れてください）';

/** Claude に回してよい処理。ここに無いものは必ず Gemini */
const CLAUDE_BRIDGE_FEATURES = new Set([
  'whole-refine',   // 文字起こし全体の整形
  'summary',        // 要約
  'chat',           // 質問ペイン
  'title',          // タイトル生成
  'memo-refine',    // メモの選択範囲整形
  'live-refine',    // ライブ整形（録音中の数十秒ぶん）v0.24.52
  'live-heading',   // 見出し追加（数分ぶんをまとめ直して見出しを付ける）v0.24.52
]);

/**
 * Claude で失敗しても Gemini に回さない処理 (v0.24.52)
 *
 * やっさん「切替はせずに行こう　これまで通りエラーは出してもらう」
 * 「とにかく料金はこれ以上高くなるのは避けたい」「最低限Geminiでの文字起こしができていればなんとかなる」。
 * 録音中は数十秒ごとに呼ぶので、連携が切れたまま Gemini に戻すと気づかないうちに課金が積み上がる。
 * 整形できなかった段落は生の文字のまま「再試行待ち」で残り、あとで「今すぐ整形」できる。
 * 要約などは従来どおり Gemini に戻す（1回きりで、無いと困るため）。
 */
const CLAUDE_BRIDGE_NO_FALLBACK = new Set(['live-refine', 'live-heading']);
function claudeBridgeNoFallback(feature) { return CLAUDE_BRIDGE_NO_FALLBACK.has(feature); }

let _claudeBridgeEnabled = false;

/**
 * 放っておいても治らない失敗を覚えておく (v0.24.9)
 *
 * やっさん報告「これ2回連続で出るのがなんか気になる」。
 * 録音を止めると要約とタイトルを続けて回すので、ログインが切れていると
 * **確実に失敗する呼び出しをもう一度やっていた**。ログが2行になるだけでなく、
 * その分だけ余計に待たされる。
 *
 * ログイン切れは待っても直らないので、一度踏んだらそのセッションでは試さない。
 * 「接続を確認」が通るか、設定を入れ直したら解除する。
 * 通信が切れただけ（start.bat を忘れていた等）はあとで治るので覚えない。
 */
let _claudeBridgeBrokenReason = '';

function claudeBridgeSetEnabled(on) {
  _claudeBridgeEnabled = !!on;
  _claudeBridgeBrokenReason = '';   // 入れ直したらもう一度試す
}
function claudeBridgeIsEnabled() { return _claudeBridgeEnabled; }
function claudeBridgeMarkBroken(reason) { _claudeBridgeBrokenReason = String(reason || ''); }
function claudeBridgeClearBroken() { _claudeBridgeBrokenReason = ''; }
function claudeBridgeBrokenReason() { return _claudeBridgeBrokenReason; }

/** その失敗は待っても直らない種類か (v0.24.9) */
function claudeBridgeIsFatal(error) {
  return /authenticat|OAuth|session expired|unauthorized|401|ログイン/i.test(String(error || ''));
}

/* ───────── 純関数（テストできる形で置く） ───────── */

/**
 * この処理を Claude に回してよいか (v0.24.0)
 *
 * **迷ったら Gemini**。ここで取りこぼしても遅くなるだけだが、
 * 間違って回すと音声が通らなかったり、録音中に詰まったりする。
 */
function claudeBridgeShouldUse({ enabled, feature, body }) {
  if (!enabled) return false;
  if (!claudeBridgeFeatureAllowed(feature)) return false;
  return claudeBridgeBodyIsTextOnly(body);
}

/**
 * その機能は Claude に回してよいか（body を見ない判定）(v0.24.12)
 *
 * 画面に「要約生成中（Claude）」と出すため、**body を作る前に**
 * どちらに回るかを知りたい。機能名だけならその時点で分かる。
 * 実際に回すかは claudeBridgeShouldUse() が body まで見て決めるので、
 * こちらを分岐に使わない（音声が黙って飛ぶのを防ぐ二重の判定を崩さない）。
 */
function claudeBridgeFeatureAllowed(feature) {
  return CLAUDE_BRIDGE_FEATURES.has(feature);
}

/**
 * その body が「文字だけ」か (v0.24.0)
 *
 * 音声や JSON 指定が混じっていたら回さない。
 * 機能名での判定と**二重**にしてあるのは、呼び出し側が feature を
 * 付け忘れたり、あとで body の中身が変わったときに、
 * 音声が黙って Claude に飛ぶのを防ぐため。
 */
function claudeBridgeBodyIsTextOnly(body) {
  if (!body) return false;
  for (const c of body.contents || []) {
    for (const p of (c && c.parts) || []) {
      if (!p) continue;
      if (p.inline_data || p.file_data || p.inlineData || p.fileData) return false;
    }
  }
  const cfg = body.generationConfig || {};
  if (cfg.responseSchema) return false;
  const mime = cfg.responseMimeType || 'text/plain';
  return mime === 'text/plain';
}

/**
 * Gemini 向けの body を、1本のプロンプトに畳む (v0.24.0)
 *
 * system_instruction を先頭に置き、会話をそのまま続ける。
 * 役割の印を付けるのは、質問ペインのように往復があるときに
 * 誰の発言か分からなくなるのを防ぐため。
 */
function claudeBridgePromptFromBody(body) {
  const sys = (((body && body.system_instruction) || {}).parts || [])
    .map(p => p && p.text).filter(Boolean).join('\n').trim();

  const turns = [];
  for (const c of (body && body.contents) || []) {
    const text = ((c && c.parts) || []).map(p => p && p.text).filter(Boolean).join('\n').trim();
    if (!text) continue;
    if (c.role === 'model') turns.push(`【これまでのあなたの回答】\n${text}`);
    else turns.push(text);
  }
  return [sys, turns.join('\n\n')].filter(Boolean).join('\n\n').trim();
}

/**
 * 全体を囲っているコードフェンスを外す (v0.24.0)
 *
 * Claude Code は Markdown を返すとき、本文ごと ```markdown … ``` で
 * 包むことがある（通し確認で実際に出た）。そのまま貼ると、
 * 要約ペインにフェンスの記号が表示される。
 *
 * **外すのは「全体が1つのフェンスに入っているとき」だけ。** 本文の途中に
 * あるコードブロックは中身なので触らない。
 */
function claudeBridgeUnfence(text) {
  const t = String(text || '').trim();
  const m = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(t);
  if (!m) return t;
  // 中にさらにフェンスがあるなら、全体を囲っているのではなく本物のコードブロック
  if (m[1].includes('```')) return t;
  return m[1].trim();
}

/* ───────── インストール式の口（v0.24.21） ───────── */

/** 拡張として開いていて、ネイティブメッセージングが使えるか（ブラウザ版では false） */
function claudeNativeAvailable() {
  return typeof chrome !== 'undefined' && !!chrome.runtime
    && typeof chrome.runtime.sendNativeMessage === 'function' && !!chrome.runtime.id;
}

/**
 * ブラウザが返すエラーを分ける (v0.24.21)
 * 文言は Chromium のもの（native_message_process_host.cc）。
 */
function claudeNativeErrorKind(message) {
  const m = String(message || '');
  if (/not found/i.test(m)) return 'not-installed';     // Specified native messaging host not found.
  if (/forbidden/i.test(m)) return 'other-extension';   // Access to the specified native messaging host is forbidden.
  return 'broken';                                       // Native host has exited. / Error when communicating ...
}

function claudeNativeErrorText(kind, raw) {
  if (kind === 'not-installed') return CLAUDE_NOT_INSTALLED;
  if (kind === 'other-extension') {
    return 'Claude 連携が別の場所の拡張用に入っています（設定の「連携アプリをダウンロード」から入れ直してください）';
  }
  return 'Claude 連携の補助プログラムが動きませんでした（Node.js が消えた等。入れ直すと直ることがあります）: ' + String(raw || '');
}

/** 1通送って1通受け取る。**例外は投げない** */
function claudeNativeSend(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(CLAUDE_NATIVE_HOST, msg, (reply) => {
        const le = chrome.runtime.lastError;
        if (le) {
          const kind = claudeNativeErrorKind(le.message);
          resolve({ ok: false, kind, error: claudeNativeErrorText(kind, le.message) });
          return;
        }
        resolve(reply && typeof reply === 'object' ? reply : { ok: false, kind: 'broken', error: '返事が空でした' });
      });
    } catch (e) {
      resolve({ ok: false, kind: 'broken', error: claudeNativeErrorText('broken', e && e.message) });
    }
  });
}

/**
 * つなぎっぱなしの口で1通送って1通受け取る (v0.24.53)。**例外は投げない**
 *
 * sendNativeMessage は1回ごとにホストを起動して終わらせるので、ホストの中で claude を
 * 立たせておけない。connectNative なら口を開いている間ホストが生きていて、
 * claude も同じ会話のまま次の依頼を待てる（claude-runner.js の runClaudeSession）。
 *
 * 返事は id で依頼と対応させる。古いホストは id を返さないが、1本ずつ順に処理するので
 * 一番古い依頼への返事とみなしてよい（そのときは毎回 claude を起動し直すだけで、動きはする）。
 */
let _claudePort = null;
let _claudePortSeq = 0;

function claudeNativePortAvailable() {
  return claudeNativeAvailable() && typeof chrome.runtime.connectNative === 'function';
}

function claudeNativePortSend(msg, waitMs) {
  return new Promise((resolve) => {
    let port = _claudePort;
    if (!port) {
      try {
        port = chrome.runtime.connectNative(CLAUDE_NATIVE_HOST);
      } catch (e) {
        resolve({ ok: false, kind: 'broken', error: claudeNativeErrorText('broken', e && e.message) });
        return;
      }
      const waiters = new Map();
      port._waiters = waiters;
      _claudePort = port;
      port.onMessage.addListener((reply) => {
        let id = reply && reply.id;
        if (id == null || !waiters.has(id)) id = waiters.keys().next().value;
        const w = waiters.get(id);
        if (!w) return;
        waiters.delete(id);
        w(reply && typeof reply === 'object' ? reply : { ok: false, kind: 'broken', error: '返事が空でした' });
      });
      port.onDisconnect.addListener(() => {
        const le = chrome.runtime.lastError;
        const raw = (le && le.message) || 'Native host has exited.';
        const kind = claudeNativeErrorKind(raw);
        if (_claudePort === port) _claudePort = null;
        for (const w of waiters.values()) w({ ok: false, kind, error: claudeNativeErrorText(kind, raw) });
        waiters.clear();
      });
    }
    const id = ++_claudePortSeq;
    // ホストが黙ったまま固まったときの保険。ホスト側の時間切れより少し長く待つ
    const timer = setTimeout(() => {
      if (port._waiters.delete(id)) resolve({ ok: false, kind: 'broken', error: `${Math.round(waitMs / 1000)}秒待っても返事がありませんでした` });
    }, waitMs);
    port._waiters.set(id, (r) => { clearTimeout(timer); resolve(r); });
    try {
      port.postMessage({ ...msg, id });
    } catch (e) {
      port._waiters.delete(id);
      clearTimeout(timer);
      if (_claudePort === port) _claudePort = null;
      resolve({ ok: false, kind: 'broken', error: claudeNativeErrorText('broken', e && e.message) });
    }
  });
}

/* ───────── 中継を叩く ───────── */

/**
 * ブリッジに投げる。**例外は投げない。** 失敗は戻り値で返す
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
async function claudeBridgeRun(prompt, { url = CLAUDE_BRIDGE_URL, signal, effort, timeoutMs, session = false } = {}) {
  if (!prompt || !prompt.trim()) return { ok: false, error: 'プロンプトが空です' };
  // v0.24.23: 呼び出しごとの調整（リアルタイム要約だけが使う）。古いホストは黙って無視する
  // v0.24.53: session … 会話を切らずに呼ぶ（ライブ整形・見出し追加）。古いホスト・サーバーは無視して毎回起動する
  const tune = {
    ...(effort ? { effort } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(session ? { session: true } : {}),
  };

  /* v0.24.21: 拡張ならインストール式の口を先に使う。
   * 入っていないときだけ、これまでの中継（start.bat）を試す。start.bat で使っていた人が
   * インストールするまでの間も動くように。どちらも無ければ「インストールされていません」と言う
   * （「start.bat を起動して」と言うと、黒い窓に戻れと言っていることになる） */
  if (claudeNativeAvailable()) {
    const r = session && claudeNativePortAvailable()
      ? await claudeNativePortSend({ type: 'run', prompt, ...tune }, (timeoutMs || 180000) + 15000)
      : await claudeNativeSend({ type: 'run', prompt, ...tune });
    if (r.ok) return { ok: true, text: claudeBridgeUnfence(r.text), seconds: r.seconds, via: 'native' };
    if (r.kind !== 'not-installed') return { ok: false, error: r.error };
    const viaHttp = await claudeBridgeRunHttp(prompt, { url, signal, tune });
    if (viaHttp.ok || !viaHttp.unreachable) return viaHttp;
    return { ok: false, error: CLAUDE_NOT_INSTALLED };
  }
  return claudeBridgeRunHttp(prompt, { url, signal, tune });
}

async function claudeBridgeRunHttp(prompt, { url = CLAUDE_BRIDGE_URL, signal, tune = {} } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...tune }),
      signal,
    });
  } catch (e) {
    // サーバーが動いていない、が圧倒的に多い。そう言う
    return {
      ok: false,
      unreachable: true,
      error: 'Claude Code の中継に繋がりません（start.bat でサーバーを起動してください）',
    };
  }
  let data = null;
  try { data = await res.json(); } catch { /* 下で拾う */ }
  if (!res.ok || !data || !data.ok) {
    return { ok: false, error: (data && data.error) || `中継がエラーを返しました (${res.status})` };
  }
  return { ok: true, text: claudeBridgeUnfence(data.text), seconds: data.seconds, via: 'http' };
}

/** 中継が生きているか。claude は起動しないので速い */
/**
 * Gemini に戻したとき、画面に出す文言 (v0.24.6)
 *
 * ■ なぜ直したか
 *
 * これまでは理由によらず
 * 「Claude に繋がらないので Gemini で処理しました」の一種類だった。
 * だが実際には「中継は動いているが claude 側で失敗」もある。
 * start.bat が動いているのに「繋がらない」と出るのは**嘘**で、
 * 直しようが無くなる（やっさんが実際にこれで詰まった）。
 *
 * ■ なぜ理由をそのまま貼らないか
 *
 * 状態表示は `max-width: 360px` で、超えると末尾が…で切れる（実測）。
 * サーバーが返す理由をそのまま繋ぐと**胝心な末尾から消える**ので、
 * 数えられる原因については短い言い切りに置き換える。
 * 生の理由は診断ログに残るので失われない。
 */
/**
 * Gemini に回さなかったときの文言 (v0.24.52)
 * 理由の部分は claudeBridgeFallbackMessage と同じにして、言い回しがずれないようにする。
 * 「Gemini で処理」と出すと、実際には処理していないので嘘になる
 */
function claudeBridgeNoFallbackMessage(error) {
  const m = claudeBridgeFallbackMessage(error);
  const hit = m.match(/^(.*?)ので\s*Gemini で処理(?:しました)?(（[^）]*）)?$/);
  if (!hit) return `${m}（Gemini には回していません）`;
  return `${hit[1]}ので整形せずに残しました${hit[2] || ''}`;
}

function claudeBridgeFallbackMessage(error) {
  const e = String(error == null ? '' : error);
  if (!e.trim()) return 'Claude で処理できなかったので Gemini で処理しました';
  if (e.includes('インストールされていません')) {
    return 'Claude 連携が未インストールなので Gemini で処理';
  }
  if (e.includes('別の場所の拡張用')) {
    return 'Claude 連携を入れ直す必要があるので Gemini で処理';
  }
  if (e.includes('補助プログラムが動きませんでした')) {
    return 'Claude 連携の補助プログラムが動かないので Gemini で処理';
  }
  if (e.includes('繋がりません')) {
    return '中継に繋がらないので Gemini で処理（start.bat を起動）';
  }
  // 実際に起きたやつ (v0.24.8)。診断ログに残っていた生の文言:
  //   Failed to authenticate: OAuth session expired and could not be refreshed
  // `claude -p` は非対話なので、ここでログインを促すことができない。
  // 放っておいても治らない種類なので、**何をすればいいか**を言う
  if (/authenticat|OAuth|session expired|ログイン|credential|unauthorized|401/i.test(e)) {
    return 'Claude のログインが切れているので Gemini で処理';
  }
  if (/claude を実行できません|ENOENT|not found|見つかりません/i.test(e)) {
    return 'claude を実行できないので Gemini で処理しました';
  }
  if (e.includes('返事がありませんでした')) {
    return 'Claude が時間内に返さないので Gemini で処理';
  }
  if (e.includes('長すぎます')) {
    return '長すぎて Claude に送れないので Gemini で処理';
  }
  // 分類できないとき。**生の理由をここに貼らない** (v0.24.7)。
  // 一度は貼ってみたが、やっさんから
  // 「ログを画面にずっと出すのはちょっとね　押したらエラーの詳細が出るとか」。
  // 状態表示は「今何が起きているか」を一目で言う場所で、
  // stderr を流す場所ではない。詳細は押したときだけ出す。
  return 'Claude で処理できなかったので Gemini で処理しました';
}

/**
 * 「接続を確認」の結果を文言にする (v0.24.9)
 *
 * 以前は「中継は動いています」だけを緱で出していたので、
 * **ログインが切れていても「動いています」と出ていた**。
 * それで要約を回して初めて失敗するので、確かめた意味が無かった。
 *
 * @returns {{ok:boolean, text:string, needsLogin:boolean}}
 */
function claudeBridgeHealthMessage(health) {
  const h = health || {};
  if (!h.ok) {
    // v0.24.21: インストール式の口が返した理由があればそれを出す
    return { ok: false, needsLogin: false, unknown: false,
             text: h.error || '中継に繋がりません。start.bat でサーバーを起動してください' };
  }
  const a = h.auth || {};
  if (a.ok && a.loggedIn === true) {
    // サーバーの版も出す (v0.24.11)。拡張のカードの数字と見比べれば、
    // 「ファイルは新しいがサーバーが古い」をその場で見分けられる
    const parts = [h.invocation,
      h.version ? (h.via === 'native' ? '連携 ' : 'サーバー ') + h.version : ''].filter(Boolean);
    // v0.24.23: 連携が古い（リアルタイム要約を速くする調整を知らない）なら、入れ直しを促す。
    // 使えないわけではないので ok のまま
    // v0.24.53: 会話を切らずに使う（session）を知らない版も古いとみなす。ライブ整形が毎回 claude を起動し直して遅い
    const stale = !(Array.isArray(h.features) && h.features.includes('effort') && h.features.includes('session'));
    const fix = !stale ? ''
      : h.via === 'native'
        ? '。連携が古い版です。ライブ整形・ライブ要約を速くするため、「連携アプリをダウンロード」から入れ直してください'
        : '。サーバーが古い版です。ライブ整形・ライブ要約を速くするため、start.bat を起動し直してください';
    return { ok: true, needsLogin: false, unknown: false, stale,
             text: `使えます（ログイン済み${parts.length ? ' / ' + parts.join(' / ') : ''}）${fix}` };
  }
  if (a.ok && a.loggedIn === false) {
    return { ok: false, needsLogin: true, unknown: false,
             text: h.via === 'native'
               ? 'Claude にログインしていません。連携アプリ（dictation-claude-setup.bat）をもう一度ダブルクリックするとサインインできます'
               : 'Claude にログインしていません。login.bat でサインインしてください' };
  }
  // 応答に auth が無い = 古い serve.js が動いたまま (v0.24.10)
  //
  // **これを「理由不明」と出してしまっていた。**
  // update.bat でファイルは新しくなるが、走っている node は入れ替わらない。
  // start.bat を閉じて起動し直す必要がある。分かっているのだからそう言う
  if (!h.auth) {
    return { ok: false, needsLogin: false, unknown: true,
             text: 'サーバーが古いままです。start.bat を一度閉じて起動し直してください' };
  }
  // ログイン状態が読めなかった。**使えるとは言わないが、壊れているとも言えない**
  return { ok: false, needsLogin: false, unknown: true,
           text: 'claude を確かめられません: ' + String(a.error || '理由不明').slice(0, 60) };
}

async function claudeBridgeHealth({ url = CLAUDE_BRIDGE_URL } = {}) {
  // v0.24.21: 拡張ならインストール式の口を先に見る。入っていなければ start.bat の中継を見る
  if (claudeNativeAvailable()) {
    const r = await claudeNativeSend({ type: 'health' });
    if (r.ok || r.kind !== 'not-installed') return r;
    const viaHttp = await claudeBridgeHealthHttp({ url });
    return viaHttp.ok ? viaHttp : r;
  }
  return claudeBridgeHealthHttp({ url });
}

async function claudeBridgeHealthHttp({ url = CLAUDE_BRIDGE_URL } = {}) {
  try {
    const res = await fetch(url + '/health');
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}
