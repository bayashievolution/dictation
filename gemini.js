/**
 * dictation — Gemini API クライアント
 * v0.1 話し言葉チャンクを読みやすい文章に整形
 */

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `あなたは講義・会議の音声認識結果を読みやすい文章に整える編集者です。

ルール：
- 「えーと」「あのー」「まぁ」などのフィラー・言い直しを削除
- 句読点「、。」と改行を適切に補完
- 意味を変えず、推測で内容を足さない
- 話題が変わった場合、その段落の冒頭に「## 見出し」形式で簡潔な見出しを付ける
- 文末は直前の文脈に合わせて敬体/常体を統一
- 明らかな誤認識は文脈から自然に補正してよい（話者名・専門用語など）
- 出力は整形後のテキストのみ。前置きや説明は絶対に付けない`;

/* ───────── 録音の文脈（語彙ヒント） v0.16.0 ─────────
 *
 * 講義や会議は分野の語彙がほぼ決まっている。日本語の音声認識でいちばん誤るのは
 * 同音異義語（家庭/課程/過程、期間/機関/器官）と固有名詞で、これは音だけでは
 * 原理的に決められない。「いま何の話をしているか」を先に渡せば正しく選べる。
 * 実例: Web Speech は「Gemini」を「ジムニー」と書いた。語彙を渡せば防げる類の誤り。
 *
 * ただし渡しすぎると、モデルは「聞こえた内容」ではなく「文脈から予想される内容」を
 * 書き始める。音声が不明瞭なときに、言っていないことを自然な文で埋めてしまうのが
 * いちばん危ない壊れ方なので、
 *   - 文脈は「語彙」として渡し、「筋書き」としては渡さない
 *   - 補完禁止をプロンプト側で必ず明示する（buildNoInventionRule）
 * の2点をセットで守る。
 */

/**
 * セッションの文脈を、プロンプトに載せるブロックにする。
 * 中身が何も無ければ空文字列を返す（不要な前置きを増やさない）。
 * @param {object} [ctx] - { field, speakers, terms, topicPath, flow }
 */
function buildContextBlock(ctx) {
  if (!ctx) return '';
  const lines = [];
  const push = (label, v) => {
    const t = (v || '').toString().trim();
    if (t) lines.push(`${label}: ${t.replace(/\s*\n\s*/g, ' / ')}`);
  };
  push('分野・場面', ctx.field);
  push('話者', ctx.speakers);
  push('この場でよく出る語', ctx.terms);
  push('いまの議題', Array.isArray(ctx.topicPath) ? ctx.topicPath.filter(Boolean).join(' > ') : ctx.topicPath);
  push('直前の流れ', ctx.flow);
  if (!lines.length) return '';
  return [
    '【この録音について（表記や語の判断に使う参考情報）】',
    ...lines,
    '※ これは語彙のヒントであって台本ではない。ここに書かれていることを',
    '　 音声より優先したり、書かれている内容を補ったりしないこと。',
  ].join('\n');
}

/** 「聞こえていないことを書かない」を毎回はっきり伝える */
function buildNoInventionRule() {
  return [
    '- 音声に無い内容は絶対に足さない。文脈や参考情報から推測して補完しない',
    '- 聞き取れない箇所は [不明瞭] と書く。それらしい言葉で埋めない',
  ].join('\n');
}

/**
 * チャンクの「切り口」をモデルに正直に伝えるブロックを作る (v0.18.0)
 *
 * v0.17.1 で「この音声は断片です」と教えたら捏造は止まったが、あれは全チャンクに
 * 無条件で言っていた。v0.18.0 で無音位置を狙って切るようになった結果、
 * 大半のチャンクは**文の切れ目で始まり、文の切れ目で終わる**ようになる。
 * それを「断片だ」と言い続けるのは今度はこちらが嘘をついていることになり、
 * 実際には最後まで聞こえている文まで途中で止めさせかねない。
 *
 * なので切り口の実態に合わせて言うことを変える。片側だけ強制的に切れた場合は
 * その側だけ警告する。
 *
 * @param {{startsAtSilence?: boolean, endsAtSilence?: boolean}} [edges]
 *   省略時は「両側とも不明」＝ v0.17.1 と同じ最大限の警告（後方互換）
 */
function buildChunkEdgeRule(edges) {
  const head = edges && edges.startsAtSilence === true;
  const tail = edges && edges.endsAtSilence === true;

  if (head && tail) {
    return [
      '■ この音声の切り出しについて',
      'これは長い録音の一部ですが、**前後とも無音の切れ目で区切られています。**',
      '聞こえた範囲はそれ自体でひとまとまりになっているはずです。',
      '- 聞こえたとおりに書く。前後を推測して足さない',
    ].join('\n');
  }

  const lines = ['■ 最重要：この音声は「断片」です'];
  if (!head && !tail) {
    lines.push(
      'これは長い録音を機械的に切り出したものです。',
      '**文の途中から始まり、文の途中で終わることがあります。それが正常な入力です。**',
    );
  } else if (!head) {
    lines.push(
      'これは長い録音を機械的に切り出したもので、**文の途中から始まっている可能性があります。**',
      '（終わりのほうは無音の切れ目なので、最後まで聞こえているはずです）',
    );
  } else {
    lines.push(
      'これは長い録音を機械的に切り出したもので、**文の途中で終わっている可能性があります。**',
      '（始まりは無音の切れ目なので、頭から聞こえているはずです）',
    );
  }
  if (!head) {
    lines.push(
      '- 途中から始まっていても、聞こえたとおりに書く。前を推測して補わない',
      '  （例: 音声が「はないので大丈夫ですが」で始まるなら、そのまま書く。',
      '   「実害」などの頭を勝手に足さない）',
    );
  }
  if (!tail) {
    lines.push(
      '- 途中で終わっていても、**続きを作らない**。聞こえたところで止める',
      '  （文として不完全なまま終わってよい。整った文にするために言葉を足さない）',
    );
  }
  return lines.join('\n');
}

/**
 * 生チャンクを Gemini で整形する
 * @param {object} args
 * @param {string} args.apiKey - Gemini API キー
 * @param {string} args.context - 直前の整形済み文脈（2-3段落）
 * @param {string} args.newChunk - 整形したい生の音声認識テキスト
 * @returns {Promise<string>} 整形後テキスト
 */
/**
 * 非同期スリープ（リトライ間隔用）
 */
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Gemini generateContent の薄い呼び出し。
 * - 429(レート制限) / 5xx / Failed to fetch は指数バックオフでリトライ
 * - 4xx系（401, 400など）は即時throw
 * - 応答が空（finishReason付き）も throw（呼び出し側でneeds-retry化）
 */
/**
 * モデル由来の汚染（思考モード漏れ・繰り返しハルシネーション・メタテキスト）を
 * 出力テキストから剥がすサニタイザ。
 *
 * 対処する既知パターン:
 *  - 【思考開始】...【思考終了】 ブロック
 *  - 【思考開始】のみで終了マーカーなし（ハルシネーションで壊れた応答）
 *  - 「音声内容の確認:」「詳細な確認と整形:」等のメタ見出し
 *  - 「- 「xxx」 -> 「yyy」」形式の思考的箇条書き
 *  - 「最終的な整形案:」マーカー（以降を採用）
 *  - 「のののの…」「を、からしに、を、からしに…」等の繰り返しループ
 */
function _stripThinkingArtifacts(text) {
  if (!text) return text;
  let t = text;
  const originalLen = t.length;
  const events = [];

  // 1. 【思考開始】〜【思考終了】 ブロック削除
  const thinkBlockRe = /【思考[^】]*】[\s\S]*?【思考[^】]*(?:終了|終わり|ここまで|end)[^】]*】\s*:?／?/g;
  if (thinkBlockRe.test(t)) {
    t = t.replace(thinkBlockRe, '');
    events.push('思考ブロック除去');
  }

  // 2. 「最終的な整形案」マーカーがあればそれ以降を本文採用、手前は原則破棄
  const finalRe = /(?:最終(?:的な?)?(?:整形案|出力|回答|結果|テキスト)|【出力】|【回答】|【整形結果】)\s*[:：]?\s*\n?/;
  const fm = t.match(finalRe);
  if (fm) {
    const idx = t.indexOf(fm[0]);
    const before = t.slice(0, idx).trim();
    const after  = t.slice(idx + fm[0].length).trim();
    // 手前が思考メタのみなら捨てる、そうでなければ連結
    if (/音声内容の確認|詳細な確認|これで.*(?:ルール|問題)|問題なさそう/.test(before) || before.length < 40) {
      t = after;
    } else {
      t = before + '\n' + after;
    }
    events.push('最終マーカー採用');
  }

  // 3. 【思考開始】だけあって終了マーカーがない場合 → 開始以降を切り捨て
  if (/【思考/.test(t)) {
    t = t.replace(/【思考[^】]*】[\s\S]*$/, '').trim();
    events.push('思考開始以降を切り捨て');
  }

  // 4. メタ見出し行（「音声内容の確認:」等）を削除
  const metaHeadRe = /^\s*(?:音声内容の確認|詳細な確認と整形|これで(?:ルール|問題)[^\n]*(?:確認|問題)|問題なさそう。?|ルールを適用して整形する。?|最終的な整形案)\s*[:：]?\s*$/gm;
  if (metaHeadRe.test(t)) {
    t = t.replace(metaHeadRe, '');
    events.push('メタ見出し除去');
  }

  // 5. 思考の箇条書き "- 「xxx」 -> 「yyy」" を削除
  const bulletRe = /^\s*-\s*「[^」]*」\s*(?:->|→)\s*「[^」]*」\s*$/gm;
  if (bulletRe.test(t)) {
    t = t.replace(bulletRe, '');
    events.push('思考箇条書き除去');
  }

  // 6. 繰り返しハルシネーション検出: 1〜20文字の短句が15回以上連続
  //    「のののの...」「を、からしに、を、からしに...」「ああああ...」等
  const repeatRe = /(.{1,20}?)\1{14,}/g;
  const repeatMatches = t.match(repeatRe);
  if (repeatMatches) {
    t = t.replace(repeatRe, (m, p1) => {
      const sample = p1.replace(/\s+/g, '').slice(0, 12);
      return `\n…[モデルが「${sample}」を繰り返して出力破綻。区間省略]…\n`;
    });
    events.push(`繰り返し検出×${repeatMatches.length}`);
  }

  // 7. 連続改行の圧縮
  t = t.replace(/\n{3,}/g, '\n\n');
  t = t.trim();

  // 8. 健全性: サニタイズで大きく削られた/ほぼ空になった場合は診断ログで通知
  if (window.diagLog && (events.length > 0 || Math.abs(t.length - originalLen) > 100)) {
    window.diagLog.info(`Gemini出力クリーニング: ${events.join(', ')} (${originalLen}→${t.length}字)`);
  }

  // 空になったら空文字を返す → 呼び出し側でneeds-retry扱い
  if (t.length < 3) return '';
  // 繰り返し検出「省略」マーカーしか残らなかった場合も空扱い
  if (/^(?:…\[[^\]]*\]…\s*)+$/.test(t)) return '';
  return t;
}

async function _callGemini(body, apiKey, { maxRetries = 2, retryBaseMs = 800, skipSanitize = false } = {}) {
  // 思考モードの出力混入を防ぐため、明示的に無効化。
  // thinkingBudget:0 だけだとまれに漏れるので includeThoughts:false も併用。
  if (!body.generationConfig) body.generationConfig = {};
  if (body.generationConfig.thinkingConfig === undefined) {
    body.generationConfig.thinkingConfig = {
      thinkingBudget: 0,
      includeThoughts: false,
    };
  }
  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`Gemini API エラー (${res.status}): ${errText.slice(0, 300)}`);
        err.status = res.status;
        // 429 / 500 / 502 / 503 / 504 はリトライ候補
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          lastErr = err;
          if (window.diagLog) window.diagLog.info(`Gemini リトライ ${attempt+1}/${maxRetries} (status=${res.status})`);
          await _sleep(retryBaseMs * Math.pow(2, attempt) + Math.random() * 200);
          continue;
        }
        throw err;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const reason = data?.candidates?.[0]?.finishReason || '';
      if (!text) {
        // SAFETY / RECITATION は即 throw（再試行しても同じ結果）
        // それ以外（STOP 空・OTHER 等）はリトライしてみる
        const err = new Error(`Gemini 応答が空です（finishReason: ${reason || 'unknown'}）`);
        err.finishReason = reason;
        if (reason !== 'SAFETY' && reason !== 'RECITATION' && attempt < maxRetries) {
          lastErr = err;
          if (window.diagLog) window.diagLog.info(`Gemini リトライ ${attempt+1}/${maxRetries} (empty, reason=${reason || 'none'})`);
          await _sleep(retryBaseMs * Math.pow(2, attempt) + Math.random() * 200);
          continue;
        }
        throw err;
      }
      // 思考モードの漏れを保険サニタイズ。
      // v0.16.1: JSON を期待する呼び出しでは通さない。このサニタイザは散文向けで、
      // 「同じ短句が15回以上続いたら省略マーカーに置換」する処理を含むため、
      // 構造が決まっている JSON に当てると壊れて parse できなくなる。
      if (skipSanitize) return text;
      const cleaned = _stripThinkingArtifacts(text);
      if (cleaned !== text && window.diagLog) {
        window.diagLog.info(`Gemini 思考トークンを後処理で除去 (${text.length}→${cleaned.length}字)`);
      }
      return cleaned;
    } catch (e) {
      // ネットワーク層のエラー（TypeError: Failed to fetch 等）もリトライ候補
      if ((e.name === 'TypeError' || /Failed to fetch|NetworkError/i.test(e.message || '')) && attempt < maxRetries) {
        lastErr = e;
        if (window.diagLog) window.diagLog.info(`Gemini リトライ ${attempt+1}/${maxRetries} (network)`);
        await _sleep(retryBaseMs * Math.pow(2, attempt) + Math.random() * 200);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Gemini 呼び出し失敗（リトライ上限）');
}

async function refineWithGemini({ apiKey, context, newChunk, sessionContext, joinFragments = false, maxOutputTokens = 2048 }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  if (!newChunk || !newChunk.trim()) return '';

  // 極端に短いチャンク（15文字未満）はそのまま生テキストを返す。
  // Gemini が空レスを返しやすく、整形しても情報が増えない。
  if (newChunk.trim().length < 15) {
    return newChunk.trim();
  }

  // v0.16.0: 文脈（語彙）を渡す。Web Speech の誤認識（例「Gemini」→「ジムニー」）は
  // ここで直せることがあるので、音声モードだけでなく整形にも効かせる。
  const ctxBlock = buildContextBlock(sessionContext);

  // v0.17.2: 短チャンクの統合で使う。入力が「同じ連続発話を機械的に切った断片の並び」
  // であることを教え、文の途中で切れた断片どうしを繋ぎ直させる。
  //
  // v0.17.1 で音声側に「断片を完成させるな」と入れた結果、捏造は止まった代わりに
  // 「になっていましたが、今回は…」のような頭の欠けた段落がそのまま残るようになった。
  // ここで繋ぐのは、**両方の断片が実際に手元にある**再構成であって創作ではない。
  // その区別をプロンプトで明示しないと、片側しか無いものまで補われてしまう。
  const fragmentBlock = joinFragments ? [
    '【入力の性質】',
    '以下は、同じ連続した発話を一定時間で機械的に区切った断片の並びです。',
    '空行で区切られた各断片は、文の途中で切れていることがあります。',
    '- 文の途中で切れている断片どうしは、**つないで元の1文に戻す**こと',
    '  （例:「…前回はカタカナ」＋「になっていましたが、今回は…」',
    '   →「…前回はカタカナになっていましたが、今回は…」）',
    '- つないでよいのは、**両方の断片が実際にここにある場合だけ**。',
    '  片方しか無いものに言葉を足して文を完成させてはいけない',
    '  （先頭が「になっていましたが」で始まり、その前の断片が無いなら、そのまま残す）',
    '',
  ] : [];

  const userPrompt = [
    ...(ctxBlock ? [ctxBlock, ''] : []),
    ...fragmentBlock,
    '【直前の整形済み文脈】',
    context || '（なし：これが最初のチャンクです）',
    '',
    '【新しい生チャンク（整形対象）】',
    newChunk,
  ].join('\n');

  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens,
      responseMimeType: 'text/plain',
    },
  };

  const text = await _callGemini(body, apiKey);
  return text.trim();
}

// キーは「シンプルさ」の意味:
//   low  = シンプルさ低 → 詳細（議事録風）
//   medium = 中間（バランス）
//   high = シンプルさ高 → 最もシンプル（キーワードのみ）
const SUMMARY_PROMPTS = {
  low: `あなたは講義・会議の文字起こしから詳細な議事録を作成する編集者です。

以下のルールで網羅的な要約を作ってください（詳細な議事録・復習用途）：
- 冒頭に「# 概要」として 8〜12 行で全体像と背景
- 「## 主要ポイント」として論点を箇条書きで 10 項目以上、各項目は詳しく
- 「## 議論の流れ」として発言や議論の推移を段落で順に記述
- 「## 決定事項」「## 次のアクション」「## 検討課題」「## 背景・経緯」などを適切に追加
- 重要な発言は「〜」で引用してよい
- 話題や話者が変わったら段落を分ける
- 元の内容を出来る限り網羅的に含める（推測や創作はしない）
- 「えーと」等のフィラーは無視
- 出力は Markdown 形式。前置きや説明は付けない`,

  medium: `あなたは講義・会議の文字起こしをバランスよく要約する編集者です。

以下のルールで要約してください：
- 冒頭に 3〜5 行の「# 概要」セクション
- 次に「## 主要ポイント」として箇条書きで重要トピックを 5〜8 個、各ポイントは前後の文脈を補って読みやすく
- 必要なら「## 決定事項」「## 次のアクション」「## 論点」など適切な見出しを追加
- 元の内容に忠実に、推測や創作はしない
- 「えーと」等のフィラーは無視
- 出力は Markdown 形式。前置きや説明は付けない`,

  high: `あなたは講義・会議の文字起こしから最小限の要点だけを抽出する編集者です。

以下のルールで極めてシンプルな要約を作ってください：
- 冒頭に「# 概要」として 2〜3 行で全体像
- 「## キーワード」として重要語句・固有名詞・数値を箇条書きで 5〜10 項目
- 必要なら「## 決定事項」を簡潔に
- 接続詞・装飾は極力省く、体言止めと短文を多用
- 元の内容に忠実に、推測や創作はしない
- 「えーと」等のフィラーは無視
- 出力は Markdown 形式。前置きや説明は付けない`,
};

/**
 * 文字起こしテキストから要約を生成
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.transcript - 要約対象の全文
 * @param {string} [args.title] - セッションタイトル（文脈補助）
 * @returns {Promise<string>} Markdown形式の要約
 */
async function summarizeWithGemini({ apiKey, transcript, title, detail }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  if (!transcript || !transcript.trim()) throw new Error('要約対象のテキストがありません');

  const level = SUMMARY_PROMPTS[detail] ? detail : 'medium';
  const instruction = SUMMARY_PROMPTS[level];

  const userPrompt = [
    title ? `【セッションタイトル】${title}` : '',
    '【文字起こし全文】',
    transcript,
  ].filter(Boolean).join('\n\n');

  // シンプルさに応じて温度と最大トークンを調整
  //   low(詳細) = 多く、 high(シンプル) = 少なく
  const cfg = {
    low:    { temperature: 0.4, maxOutputTokens: 8192 },  // 詳細
    medium: { temperature: 0.4, maxOutputTokens: 4096 },
    high:   { temperature: 0.3, maxOutputTokens: 1024 },  // シンプル
  }[level];

  const body = {
    system_instruction: {
      parts: [{ text: instruction }],
    },
    contents: [
      { role: 'user', parts: [{ text: userPrompt }] },
    ],
    generationConfig: {
      temperature: cfg.temperature,
      topP: 0.9,
      maxOutputTokens: cfg.maxOutputTokens,
      responseMimeType: 'text/plain',
    },
  };

  const text = await _callGemini(body, apiKey);
  return text.trim();
}

/**
 * 文字起こし・要約から短いタイトルを生成
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} [args.summary] - 要約（あれば優先参照）
 * @param {string} [args.transcript] - 文字起こし
 * @returns {Promise<string>} 5〜20文字程度のタイトル
 */
async function generateTitleWithGemini({ apiKey, summary, transcript }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  const source = (summary && summary.trim()) || (transcript && transcript.trim()) || '';
  if (!source) throw new Error('タイトル生成の素材がありません');

  const instruction = [
    'あなたは会議・講義の記録に短いタイトルを付ける編集者です。',
    '以下のルールを絶対に守り、タイトルを1つだけ、1行で返します。',
    '- **1行**で書く（改行を絶対に入れない）',
    '- 10〜20文字の体言止めで、内容を端的に表す',
    '- 20文字を超えないように要点を絞る',
    '- 候補を複数書かない（1つだけ）',
    '- 装飾（「」・##・**・` など）や説明・前置きを一切付けない',
    '- 日付・時刻を含めない',
    '- 出力はタイトル文字列そのもののみ',
  ].join('\n');

  const userPrompt = [
    summary ? '【要約】\n' + summary.slice(0, 2000) : '',
    transcript ? '【文字起こし（冒頭）】\n' + transcript.slice(0, 1200) : '',
  ].filter(Boolean).join('\n\n');

  const body = {
    system_instruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens: 256,
      responseMimeType: 'text/plain',
    },
  };

  const raw = await _callGemini(body, apiKey);

  // AI が誤って改行や装飾を含めても安全に1行のタイトル文字列に整形する
  let cleaned = raw.trim()
    .replace(/^```[\w]*\n?|\n?```$/g, '')   // コードフェンス
    .replace(/^\*\*|\*\*$/g, '')             // 太字マーカー
    .replace(/^#+\s*/, '')                   // 見出し記号
    .replace(/^[「『"']+|["'」』]+$/g, '')    // 囲み
    .replace(/\r/g, '')
    .trim();

  // 改行が混ざったら最長行を採用。候補列挙防止。
  const lines = cleaned.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length > 1) {
    // 最長の行をタイトルとして採用（短すぎる行の混入を防ぐ）
    cleaned = lines.sort((a, b) => b.length - a.length)[0];
  } else if (lines.length === 1) {
    cleaned = lines[0];
  }

  return cleaned
    .replace(/^[「『"']+|["'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 40)
    .trim();
}

/**
 * 資料（文字起こし・メモ・要約）に基づいて質問に答えるチャット
 * @param {object} args
 * @param {string} args.apiKey
 * @param {object} args.contextSources - { transcript, memo, summary }
 * @param {Array} args.history - これまでの会話 [{role: 'user'|'assistant', content}]
 * @param {string} args.question - 新しい質問
 * @returns {Promise<string>} 回答（Markdown）
 */
async function chatWithGemini({ apiKey, contextSources, history, question }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  if (!question || !question.trim()) throw new Error('質問が空です');

  const ctx = contextSources || {};
  const contextText = [
    ctx.summary    ? '【要約】\n' + ctx.summary         : '',
    ctx.memo       ? '【メモ】\n' + ctx.memo            : '',
    ctx.transcript ? '【文字起こし】\n' + ctx.transcript : '',
  ].filter(Boolean).join('\n\n');

  const instruction = [
    'あなたは以下の資料（会議/講義の文字起こし、メモ、要約）に基づいて質問に答えるアシスタントです。',
    '',
    'ルール：',
    '- 資料に書かれていることだけに基づいて答える（推測や外部知識は使わない）',
    '- 資料から答えが導けない場合は「資料からは分かりません」と正直に答える',
    '- 日本語で、Markdownで簡潔に。長い文より要点を箇条書きで',
    '- 回答の根拠となる部分を必要に応じて引用してよい',
    '',
    '【参照可能な資料】',
    contextText || '（資料なし。資料がない旨を答える）',
  ].join('\n');

  const contents = [];
  for (const msg of (history || [])) {
    if (msg.thinking) continue;
    const role = msg.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: msg.content }] });
  }
  contents.push({ role: 'user', parts: [{ text: question }] });

  const body = {
    system_instruction: { parts: [{ text: instruction }] },
    contents,
    generationConfig: {
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 2048,
      responseMimeType: 'text/plain',
    },
  };

  const text = await _callGemini(body, apiKey);
  return text.trim();
}

/**
 * 音声 Blob（webm）を Gemini で文字起こし＋軽く整形
 * @param {object} args
 * @param {string} args.apiKey
 * @param {Blob} args.audioBlob
 * @param {string} [args.contextHint]
 * @returns {Promise<string>}
 */
async function transcribeAudioWithGemini({ apiKey, audioBlob, contextHint, sessionContext, edges }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  if (!audioBlob || audioBlob.size === 0) return '';

  const base64 = await blobToBase64(audioBlob);

  const instruction = [
    'あなたは日本語音声認識と整形を同時に行う編集者です。',
    '以下のルールに従って、入力音声を文字起こしし、読みやすく整形してください。',
    '',
    buildChunkEdgeRule(edges),
    '',
    '■ 整形のルール',
    '- 句読点と改行を適切に補完',
    '- フィラー（えー、あー、まぁ、んー）を削除',
    '- 言い直しは自然な文に整える（ただし言っていない言葉を足さないこと）',
    '- 話題の切れ目では段落を分ける',
    '- 出力は整形済みテキストのみ、前置き・説明は不要',
    '- 音声が無音・ノイズのみ・意味ある発話ゼロなら、空文字列のみ返す',
    buildNoInventionRule(),
  ].join('\n');

  const userParts = [];
  const ctxBlock = buildContextBlock(sessionContext);
  const head = [];
  if (ctxBlock) head.push(ctxBlock, '');
  if (contextHint) {
    head.push(
      '【直前の文脈（表記の参考のみ。ここから話を続けて書かないこと）】',
      contextHint,
      '',
      '【次の音声を文字起こしして】',
    );
  } else {
    head.push('以下の音声を日本語で文字起こしし、整形してください。');
  }
  userParts.push({ text: head.join('\n') });
  userParts.push({ inline_data: { mime_type: audioBlob.type || 'audio/webm', data: base64 } });

  const body = {
    system_instruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: {
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens: 2048,
      responseMimeType: 'text/plain',
    },
  };

  // 音声文字起こしは finishReason 空＝本当に無音の場合があるので、
  // _callGemini の「空レスでリトライ」を無効化して即空文字列を返す
  try {
    const text = await _callGemini(body, apiKey, { maxRetries: 1 });
    return (text || '').trim();
  } catch (e) {
    // finishReason 空のとき（純粋な無音）は空文字列扱い
    if (e.message && /応答が空/.test(e.message) && !e.finishReason) return '';
    if (e.finishReason === 'STOP' || e.finishReason === 'OTHER') return '';
    throw e;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * OSD（テレビ字幕風）向けに字幕バッファのテキストを整形する。
 * v0.13.31 改：字幕バッファ（dictation:liveCaption）から最新 N 行を読み込んで整形する形に変更。
 * 文字数はほぼ変えず、文節の途中改行であれば → を付ける。
 * 文脈から話題を推測して整形に生かすが、飛躍した推測は禁止。
 */
async function formatForOSDWithGemini({ apiKey, text, lineLength = 30, continuationMark = true }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  if (!text || !text.trim()) return '';

  // v0.13.31: やっさん指示で大幅にシンプル化。
  // - 文節・句読点ベースの改行ロジックは廃止
  // - 改行は **指定文字数（lineLength）で固定**
  // - 文節中の改行を検知した場合のみ、オプションで「→」を付加
  const N = Math.max(10, Math.min(100, Number(lineLength) || 30));
  // v0.13.31: 「→」の判定をシンプル化。
  // 句読点（、。！？）で終わる行 = 自然な区切り → 「→」不要
  // それ以外で改行された行 = 単語/文節の途中 → 「→」を付加
  // やっさん指摘：「なるほ\nど」「ホワイトベー\nス」のように単語途中で切れた時に
  // 「→」が付いていないケースがあった。判定ロジックを明確化することで安定化。
  const continuationLines = continuationMark
    ? [
        '- **行末が句読点（、。！？）でない場合は、その行末に必ず「→」を付ける**（単語・文節の途中で改行されている合図）。',
        '- 行末が句読点（、。！？）で終わっている場合は「→」を付けない（自然な区切り）。',
      ]
    : ['- 「→」継続マークは付けない（OFF 設定）'];

  const instruction = [
    'あなたは聴覚障害のある方向けのTV字幕編集者です。',
    '以下の文字起こしテキストを、TV字幕用にシンプルに整形してください。',
    '',
    '【最重要ルール】',
    `- 各行を **${N} 字で固定改行**してください（${N} 字に達したら必ず改行、文節や単語の境界は気にしない）。`,
    '- **文字を増減させない**：要約・短縮・補足・フィラー削除・誤字訂正は一切禁止。発話内容をそのまま保持。',
    '- 句読点も入力のまま維持。新たに追加・削除しない。',
    '',
    '【継続マーク（→）】',
    ...continuationLines,
    '',
    '【メタ表記の扱い】',
    '- 「## 見出し」等の Markdown 見出し記号は削除（本文だけ残す）。',
    '- 「（文字起こし中…）」「（音声不明瞭）」等のメタ表記は削除。',
    '',
    '【出力】',
    '- 整形後の字幕テキストのみ。前置き・説明・コードブロックは一切付けない。',
  ].join('\n');

  const body = {
    system_instruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: [{ text: text.slice(0, 2400) }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 1024,
      responseMimeType: 'text/plain',
    },
  };

  const out = await _callGemini(body, apiKey, { maxRetries: 1 });
  return (out || '').trim();
}

/**
 * メモ内の選択範囲を整形する。
 * 箇条書きなら文章化、誤字脱字誤用を訂正。
 * 元→整形後の差分が分かるよう、変更箇所を <mark class="mr-diff">...</mark> で
 * 包んだ HTML を返すよう Gemini に指示。
 */
async function refineMemoSelectionWithGemini({ apiKey, text }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  if (!text || !text.trim()) return '';

  const instruction = [
    'あなたは日本語の文章編集者です。',
    '以下のメモテキストを次のルールで整形してください。',
    '',
    'ルール:',
    '- 箇条書きは文章にまとめ直す（冗長な繰り返しは削除、文脈で繋ぐ）',
    '- 誤字・脱字・変換ミス・誤用を訂正',
    '- 意味や事実は変えない、勝手に情報を足さない',
    '- 句読点「、。」と改行を自然な位置に',
    '- 固有名詞・専門用語・数字はそのまま維持',
    '- 丁寧体/常体は入力に合わせる',
    '',
    '【重要】訂正したり書き換えたりした部分は、必ず <mark> タグで囲むこと。',
    '例: もと「きょうはいい天気」→ 整形後「今日は<mark>いい</mark>天気です。」',
    '訂正していない部分は <mark> を付けないこと。',
    '',
    '出力は整形後テキストのみ。前置き・説明・コードブロック・```等は付けないこと。',
  ].join('\n');

  const body = {
    system_instruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 4096,
      responseMimeType: 'text/plain',
    },
  };

  const out = await _callGemini(body, apiKey, { maxRetries: 1 });
  return (out || '').trim();
}

/**
 * 文字起こしの途中経過から「語彙」と「いまの議題」を拾う (v0.16.1)
 *
 * メモが空でも文脈を効かせるための自動抽出。ただし素朴にやると危ない。
 *
 * ■ 自己強化ループという罠
 * 文字起こし自体に誤変換が含まれる。頻度で語を拾うと、序盤の誤り（例「期間」→
 * 「機関」）をそのまま語彙として送り返し、**以降ずっとその誤りを書き続ける**。
 * 誤りが自分を強化する。
 * → 頻度カウントではなく、モデルに「この分野の用語として正しい表記」を
 *   判断させる。明らかな誤変換は直した形で返させる。
 *
 * ■ 出力は JSON
 * terms は語だけ（文を入れない）。topicPath は 親>子>孫 の最大3階層。
 *
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.transcript - これまでの文字起こし（末尾側を渡す想定）
 * @param {string} [args.memoOutline] - メモの見出し・箇条書き（あれば最優先の手がかり）
 * @param {string[]} [args.knownTerms] - すでに確定している語（やっさんが書いたもの）
 * @returns {Promise<{terms:string[], topicPath:string[], flow:string}>}
 */
async function extractContextWithGemini({ apiKey, transcript, memoOutline, knownTerms }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  const body_text = (transcript || '').trim();
  if (body_text.length < 200) return { terms: [], topicPath: [], flow: '' };

  const instruction = [
    'あなたは会議・講義の記録から「用語」と「議題の位置」を抜き出す担当です。',
    '出力は JSON のみ。前置き・説明・コードフェンスは付けない。',
    '',
    '形式:',
    '{"terms": ["語1","語2"], "topicPath": ["大項目","中項目","小項目"], "flow": "一文"}',
    '',
    'terms のルール:',
    '- この分野の専門用語・固有名詞・人名・製品名だけ。最大20語',
    '- 文や説明を入れない。語だけ（各20字以内）',
    '- **音声認識の誤変換と思われるものは、正しい表記に直して入れる**',
    '  （例「機関」と書かれていても、文脈から「期間」が正しいならそう直す）',
    '- 一般語（会議、今日、みなさん、それ等）は入れない',
    '',
    'topicPath のルール:',
    '- いま話している議題の位置を、大→中→小の最大3階層で。分かる範囲でよく、1〜2階層でもよい',
    '- 記録に無い議題を創作しない',
    '',
    'flow のルール:',
    '- 話がどう移ってきたかを一文で。例「制度の説明から具体的な事例の話に移った」',
    '',
    '判断材料が足りなければ、その項目は空配列・空文字列にする。憶測で埋めない。',
  ].join('\n');

  const parts = [];
  if (memoOutline && memoOutline.trim()) {
    parts.push('【事前に人が書いた見出し（最も信頼できる手がかり）】', memoOutline.trim(), '');
  }
  if (knownTerms && knownTerms.length) {
    parts.push('【すでに登録済みの語（重複して返さなくてよい）】', knownTerms.join('、'), '');
  }
  parts.push('【これまでの記録】', body_text);

  const body = {
    system_instruction: { parts: [{ text: instruction }] },
    contents: [{ role: 'user', parts: [{ text: parts.join('\n') }] }],
    generationConfig: {
      temperature: 0.1,          // 抽出なので揺れは要らない
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  };

  const raw = await _callGemini(body, apiKey, { maxRetries: 1, skipSanitize: true });
  let out;
  try {
    out = JSON.parse((raw || '').trim());
  } catch (e) {
    console.warn('[context] JSON として読めませんでした:', (raw || '').slice(0, 200));
    return { terms: [], topicPath: [], flow: '' };
  }

  // モデルの出力はそのまま信じない。形と長さをこちらで詰める
  const terms = Array.isArray(out.terms) ? out.terms : [];
  const topicPath = Array.isArray(out.topicPath) ? out.topicPath : [];
  return {
    terms: terms.map(t => String(t || '').trim()).filter(t => t && t.length <= 20).slice(0, 20),
    topicPath: topicPath.map(t => String(t || '').trim()).filter(Boolean).slice(0, 3),
    flow: String(out.flow || '').trim().slice(0, 120),
  };
}

window.extractContextWithGemini = extractContextWithGemini;
window.refineWithGemini = refineWithGemini;
window.summarizeWithGemini = summarizeWithGemini;
window.generateTitleWithGemini = generateTitleWithGemini;
window.chatWithGemini = chatWithGemini;
window.transcribeAudioWithGemini = transcribeAudioWithGemini;
window.formatForOSDWithGemini = formatForOSDWithGemini;
window.refineMemoSelectionWithGemini = refineMemoSelectionWithGemini;
