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

/** 既定の中継先。serve.js が 127.0.0.1:8765 で待っている */
const CLAUDE_BRIDGE_URL = 'http://127.0.0.1:8765/api/claude';

/** Claude に回してよい処理。ここに無いものは必ず Gemini */
const CLAUDE_BRIDGE_FEATURES = new Set([
  'whole-refine',   // 文字起こし全体の整形
  'summary',        // 要約
  'chat',           // 質問ペイン
  'title',          // タイトル生成
  'memo-refine',    // メモの選択範囲整形
]);

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
  if (!CLAUDE_BRIDGE_FEATURES.has(feature)) return false;
  return claudeBridgeBodyIsTextOnly(body);
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

/* ───────── 中継を叩く ───────── */

/**
 * ブリッジに投げる。**例外は投げない。** 失敗は戻り値で返す
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
async function claudeBridgeRun(prompt, { url = CLAUDE_BRIDGE_URL, signal } = {}) {
  if (!prompt || !prompt.trim()) return { ok: false, error: 'プロンプトが空です' };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal,
    });
  } catch (e) {
    // サーバーが動いていない、が圧倒的に多い。そう言う
    return {
      ok: false,
      error: 'Claude Code の中継に繋がりません（start.bat でサーバーを起動してください）',
    };
  }
  let data = null;
  try { data = await res.json(); } catch { /* 下で拾う */ }
  if (!res.ok || !data || !data.ok) {
    return { ok: false, error: (data && data.error) || `中継がエラーを返しました (${res.status})` };
  }
  return { ok: true, text: claudeBridgeUnfence(data.text), seconds: data.seconds };
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
function claudeBridgeFallbackMessage(error) {
  const e = String(error == null ? '' : error);
  if (!e.trim()) return 'Claude で処理できなかったので Gemini で処理しました';
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
    return { ok: false, needsLogin: false, unknown: false,
             text: '中継に繋がりません。start.bat でサーバーを起動してください' };
  }
  const a = h.auth || {};
  if (a.ok && a.loggedIn === true) {
    return { ok: true, needsLogin: false, unknown: false,
             text: `使えます（ログイン済み${h.invocation ? ' / ' + h.invocation : ''}）` };
  }
  if (a.ok && a.loggedIn === false) {
    return { ok: false, needsLogin: true, unknown: false,
             text: 'Claude にログインしていません。login.bat でサインインしてください' };
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
  try {
    const res = await fetch(url + '/health');
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}
