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
- 話題が変わった場合、その段落の冒頭に `## 見出し` 形式で簡潔な見出しを付ける
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

window.refineWithGemini = refineWithGemini;
