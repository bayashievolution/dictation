# dictation — PROJECT_DESIGN.md

講義・会議中の音声をリアルタイム文字起こし＆AI段落整形して、常時参照できるデスクトップアプリ。

## 目的

- 講義/会議中に「今なんて言った？」「どんな流れ？」に即応
- Word ディクテーションの壁文字問題（句読点なし・言い直し混入）を Gemini API で整形して解消
- Notion AIミーティングノート（月¥3000）の代替をほぼ無料で実現

## ターゲット環境

- Windows 11（ノートPC1枚運用、講義中）
- ブラウザ：Chrome（Web Speech API用）※初期バージョン
- デスクトップ：Electron（後期バージョン）

## 技術スタック

| レイヤー | 採用 | 理由 |
|---|---|---|
| 文字起こし | Web Speech API | 無料、ブラウザ組込、日本語対応 |
| AI整形 | Gemini 2.5 Flash | 無料枠が潤沢、高速 |
| デスクトップ化 | Electron | タスクトレイ/最前面/ホットキー対応 |
| UI | Vanilla JS + HTML/CSS | 軽量、依存なし |
| セッション保存 | localStorage (初期) → JSON file (Electron期) | クラッシュ時レジューム |

## 段階実装プラン

各段階で動作確認できる単位に分解。動かない状態で次の変更を重ねない。

1. **Step1**: Web Speech API生出力を表示（Chromeで動作確認）
2. **Step2**: Gemini API連携＋無音検出で段落整形
3. **Step3**: Electron化＋最前面/半透明/タスクトレイ/ホットキー
4. **Step4**: セッション自動保存＋クラッシュ時レジューム
5. **Step5**: 無音継続で停止確認ダイアログ
6. **Step6**: コピペ一発ボタン＋Markdownエクスポート

## DOM構造

```
#app
├── #titlebar          ... アプリ名・最前面/半透明/最小化/閉じるボタン
├── #controls           ... 録音開始/停止、コピー、エクスポート
├── #status             ... 録音中/停止中/整形中インジケータ
├── #transcript         ... メインビュー（スクロール）
│   ├── .paragraph     ... 整形済み段落（複数）
│   └── #interim       ... 未確定バッファ（薄文字、最下部）
└── #dialog             ... 無音停止確認用モーダル
```

## 状態モデル

### アプリ状態 `appState`

| 変数名 | 取り得る値 | 説明 |
|---|---|---|
| `recording` | `idle` / `listening` / `paused` / `stopped` | 録音状態 |
| `alwaysOnTop` | `true` / `false` | 最前面表示トグル |
| `transparent` | `true` / `false` | 半透明トグル |
| `silenceTimer` | `null` / timerId | 無音検出タイマー |
| `lastSpeechAt` | `Date` / `null` | 最後に音声が入った時刻 |

### 状態遷移

```
idle → (録音開始) → listening
listening → (無音60秒) → 停止確認ダイアログ表示 → paused or listening
listening → (停止ボタン) → stopped
stopped → (録音開始) → listening
```

### 転写データ構造 `transcript`

```js
{
  sessionId: string,
  startedAt: ISO datetime,
  paragraphs: [
    { id, rawText, refinedText, heading?, finalizedAt }
  ],
  interim: string  // 未確定バッファ
}
```

## 整形ロジック（Gemini連携）

### トリガー

- **無音検出**：Web Speech API の `result` で確定したテキストが入り、その後N秒（初期値: 3秒）無音が続いたら、そのチャンクを Gemini に送る
- **強制整形**：手動ボタンで残りバッファを即整形

### プロンプト設計

```
あなたは話し言葉を読みやすい文章に整える編集者です。
以下の直前の文脈と、新しい発話チャンクを渡します。
新しいチャンクを以下のルールで整形してください：
- 言い直し・フィラー（えー、あー、まぁ）を削除
- 句読点と改行を適切に補完
- 敬体/常体を直前段落に合わせる
- 話題が変わった場合、見出し（## 〜）を付ける
- 意味を変えない（推測で補足しない）

【直前の文脈】（2-3段落）
{context}

【新しい発話チャンク】
{newChunk}

【出力】整形後テキストのみ返す。見出しがあれば冒頭に ## 見出し\n で付ける。
```

### 整形結果の扱い

- 整形結果を `.paragraph` として追記
- 未整形バッファ `#interim` は整形完了と同時にクリア
- **整形中も録音は継続**（非同期処理）

## ボタン/操作の挙動

| 操作 | 挙動 |
|---|---|
| ▶ 録音開始 | Web Speech API起動、`recording=listening` |
| ⏸ 一時停止 | 録音停止（次再開で継続）、`recording=paused` |
| ⏹ 停止 | 録音停止＋残りバッファ強制整形、`recording=stopped` |
| 📋 コピー | 整形済み全文をクリップボードにコピー（見出し付きMarkdown） |
| 💾 エクスポート | `.md` ファイルとしてダウンロード |
| 📌 最前面 | `alwaysOnTop` トグル（Electron期以降） |
| 👻 半透明 | `transparent` トグル（Electron期以降） |
| Ctrl+Shift+D | ウィンドウ表示/非表示トグル（Electron期） |

## イベントハンドラの優先順位

1. `Escape` キー：録音中ならダイアログキャンセル、それ以外は無視
2. ウィンドウ閉じる：録音中なら「保存して閉じる？」ダイアログ
3. タスクトレイ最小化：録音継続、ウィンドウのみ非表示

## セッション保存

- **タイミング**：段落整形完了ごと、および30秒ごとに自動保存
- **保存先**：
  - Step1-2: `localStorage`（キー: `dictation:session:<sessionId>`）
  - Step3以降: `%APPDATA%/dictation/sessions/<sessionId>.json`
- **レジューム**：起動時に最新セッションを検出、「前回の続きを開く？」ダイアログ

## デザイン方針

### 世界観

- **実用ツール寄り**（ポップ要素控えめ）
- 講義中に目に優しいダークテーマ
- 読みやすさ最優先（Noto Sans JP、行間広め、フォントサイズ大きめ）

### 配色（初期）

- 背景: `#1a1a1f`（ダークグレー）
- 整形済み本文: `#e8e8eb`（オフホワイト）
- 未確定バッファ: `#6b6b73`（薄グレー、fade-in演出）
- 見出し: `#7dd3fc`（ライトシアン、読みやすい強調色）
- アクセント: `#34d399`（録音中インジケータ、グリーン）

### 半透明モード

- `background: rgba(26,26,31, 0.7)` + `backdrop-filter: blur(8px)`
- ウィンドウ全体を半透明に（Electron `transparent: true` + `vibrancy`）

## 試行錯誤ログ

> 実装中に試して却下した案・ハマった点を時系列で積む（堂々巡り防止）

（空）

## 更新履歴

- 2026-04-21: 初版作成（案A採用、段階実装プラン確定）
