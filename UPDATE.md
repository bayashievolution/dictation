# アップデートのしかた

久しぶりに触るとき用の手順です。**ターミナルに慣れていなくても、上から順に
コピーして貼るだけ**で終わるように書いてあります。

---

## 0. 前提（1回だけ確認すればよいこと）

| | |
|---|---|
| リポジトリの場所 | WSL の Ubuntu の `~/dictation`（Windows からは `\\wsl.localhost\Ubuntu\home\bayashi\dictation`） |
| ターミナル | Windows のスタートメニューから **Ubuntu** を開く |
| 拡張の種類 | 「パッケージ化されていない拡張機能」（フォルダをそのまま読んでいる） |

**この拡張は β 版です。**（`ばっさんディクテーション (β)`）
安定版を別に入れている場合、ここを更新しても安定版は変わりません。

> 拡張がどのフォルダを読んでいるか分からなくなったら:
> `chrome://extensions` を開く → β 版の「**詳細**」→「**読み込み元**」に出ています。

---

## 1. 最新のコードを取ってくる

**Ubuntu のターミナル**を開いて、次を上から順に貼ります。

```bash
cd ~/dictation
git status
```

出た文字で、進んでよいかが分かります。**下の2つは進んでよい形です。**

```
nothing to commit, working tree clean
```

```
Untracked files:
        .claude/
nothing added to commit but untracked files present
```

`Untracked files:`（＝git がまだ知らないファイル）だけなら、**`git pull` で
消えることはありません**。そのまま次へ進んでください。

> **止めたほうがよいのはこちら。**
>
> ```
> Changes not staged for commit:
>         modified:   app.js
> ```
>
> `modified:` が並んだら、そこで止めてください。**手で直したものが消える
> 可能性があります。** そのまま画面をコピーして相談してください。

```bash
git fetch origin
git checkout claude/dictation-app-status-ra7l70
git pull
```

### ⚠ ブランチに注意

開発は **`claude/dictation-app-status-ra7l70`** というブランチで進んでいます。
`main` にはまだ入っていないので、**`main` のまま `git pull` しても何も新しくなりません。**
上の `git checkout` を必ず通してください。

いま自分がどのブランチにいるかは、これで分かります。

```bash
git branch --show-current
```

---

## 2. Chrome に反映する

### 拡張（サイドパネル）で使っている場合

1. Chrome のアドレス欄に `chrome://extensions` と入れて開く
2. β 版のカードにある **↻（更新）** ボタンを押す
3. カードの **バージョン番号**が上がっていれば成功
4. サイドパネルを一度閉じて開き直す

> ↻ が見当たらないときは、右上の「**デベロッパー モード**」をオンにしてください。

### ブラウザ版（`start.bat` で起動している場合）

1. 「dictation server」のウィンドウを閉じる
2. `start.bat` を実行し直す
3. ブラウザのページを **Ctrl + Shift + R**（強制リロード）で開き直す

---

## 3. 更新できたか確かめる

| 使い方 | 見るところ |
|---|---|
| 拡張 | `chrome://extensions` のカードのバージョン番号 |
| ブラウザ版 | ページで **Ctrl + U**（ソース表示）→ 末尾の `?v=` の数字 |

`manifest.json` の `version` と `index.html` の `?v=` は**常に同じ値**にしてあるので、
どちらを見ても同じ番号になります。

---

## 4. 困ったとき

| 症状 | 見るところ |
|---|---|
| 更新したのに前のまま | ブランチが `main` のままではないか（`git branch --show-current`） |
| 画面は新しいのに動きが古い | Chrome のキャッシュ。**Ctrl + Shift + R** で強制リロード |
| `git pull` でエラー | 手で直したファイルが残っている可能性。画面をそのままコピーして相談 |
| 拡張が読み込めない | `chrome://extensions` に赤い「エラー」ボタンが出ていないか |

**うまくいかないときは、ターミナルの表示をそのまま貼ってください。**
推測で直そうとするより、そのほうが早く終わります。
