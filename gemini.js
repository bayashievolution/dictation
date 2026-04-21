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

/**
 * 生チャンクを Gemini で整形する
 * @param {object} args
 * @param {string} args.apiKey - Gemini API キー
 * @param {string} args.context - 直前の整形済み文脈（2-3段落）
 * @param {string} args.newChunk - 整形したい生の音声認識テキスト
 * @returns {Promise<string>} 整形後テキスト
 */
async function refineWithGemini({ apiKey, context, newChunk }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  if (!newChunk || !newChunk.trim()) return '';

  const userPrompt = [
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
      maxOutputTokens: 2048,
      responseMimeType: 'text/plain',
    },
  };

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API エラー (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`Gemini 応答が空です（finishReason: ${reason}）`);
  }
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

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API エラー (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('要約の応答が空です');
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

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API エラー (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('タイトルの応答が空です');

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

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API エラー (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`Gemini 応答が空です（finishReason: ${reason}）`);
  }
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
async function transcribeAudioWithGemini({ apiKey, audioBlob, contextHint }) {
  if (!apiKey) throw new Error('Gemini API キーが設定されていません');
  if (!audioBlob || audioBlob.size === 0) return '';

  const base64 = await blobToBase64(audioBlob);

  const instruction = [
    'あなたは日本語音声認識と整形を同時に行う編集者です。',
    '以下のルールに従って、入力音声を文字起こしし、読みやすく整形してください。',
    '- 句読点と改行を適切に補完',
    '- フィラー（えー、あー、まぁ、んー）を削除',
    '- 言い直しは自然な文に整える',
    '- 明らかに不明瞭で推定困難な部分は [不明瞭] と表記',
    '- 話題の切れ目では段落を分ける',
    '- 出力は整形済みテキストのみ、前置き・説明は不要',
    '- 音声が無音・ノイズのみ・意味ある発話ゼロなら、空文字列のみ返す',
  ].join('\n');

  const userParts = [];
  if (contextHint) {
    userParts.push({ text: `【直前の文脈（参考）】\n${contextHint}\n\n【次の音声を文字起こしして】` });
  } else {
    userParts.push({ text: '以下の音声を日本語で文字起こしし、整形してください。' });
  }
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

  const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini Audio エラー (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return (text || '').trim();
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

window.refineWithGemini = refineWithGemini;
window.summarizeWithGemini = summarizeWithGemini;
window.generateTitleWithGemini = generateTitleWithGemini;
window.chatWithGemini = chatWithGemini;
window.transcribeAudioWithGemini = transcribeAudioWithGemini;
