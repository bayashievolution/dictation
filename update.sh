#!/bin/bash
# アプデを1発でやる。update.bat（Windows 側）から呼ばれる。
#
# ■ なぜ用意したか
#
# やっさんはターミナルの常用者ではなく、久しぶりに触ると
# 「Ubuntu の開き方」からやり直しになる（本人から2回同じ相談があった）。
# 手順を覚えてもらうのではなく、覚えなくて済む形にする。
#
# ■ なぜ全体を main() に入れているか
#
# **このスクリプト自身が git pull で書き換わる。** bash はスクリプトを
# 実行しながら少しずつ読むので、途中で中身が変わると残りの解釈がずれて
# 壊れる。関数にしておけば呼ぶ前に全部読み終わっているので、入れ替わっても
# 影響しない。
#
# ■ テスト
#
# DICT_DIR で対象を差し替えられるようにしてある（tests/t-update-sh.js）。

main() {
  DIR="${DICT_DIR:-$HOME/dictation}"
  BRANCH='claude/dictation-app-status-ra7l70'   # main には入っていない。変わったらここも変える

  echo "=== ばっさんディクテーション アプデ ==="
  echo

  if [ ! -d "$DIR/.git" ]; then
    echo "✗ $DIR が見つかりません。"
    echo "  フォルダを移動した場合は、この画面をそのままコピーして相談してください。"
    return 1
  fi
  cd "$DIR" || return 1

  before=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json | head -1)
  echo "いまの版: ${before:-不明}"
  echo

  # 手で直したファイルがあれば、ここで必ず止める。
  # git が知らないファイル（Untracked）は pull で消えないので無視してよい。
  dirty=$(git status --porcelain --untracked-files=no)
  if [ -n "$dirty" ]; then
    echo "✗ 手で直したファイルが残っています。消える可能性があるので中断しました。"
    echo
    echo "$dirty"
    echo
    echo "  この画面をそのままコピーして相談してください。"
    return 1
  fi

  echo "1/3 取ってきています..."
  if ! git fetch origin "$BRANCH"; then
    echo
    echo "✗ 取ってこられませんでした（ネットワークか認証）。"
    echo "  時間をおいて試すか、この画面をコピーして相談してください。"
    return 1
  fi

  echo "2/3 ブランチを合わせています..."
  # main を見ていると何回 pull しても新しくならない。久しぶりに触るときの一番の罠
  if ! git checkout "$BRANCH"; then
    echo
    echo "✗ ブランチを切り替えられませんでした。この画面をコピーして相談してください。"
    return 1
  fi

  echo "3/3 更新しています..."
  # --ff-only: 枝分かれしていたら勝手に混ぜずに止める。
  # 黙ってマージコミットを作ると、次に何が起きているか誰にも分からなくなる
  if ! git merge --ff-only "origin/$BRANCH"; then
    echo
    echo "✗ 手元と配布側が枝分かれしています。勝手に混ぜずに止めました。"
    echo "  この画面をそのままコピーして相談してください。"
    return 1
  fi

  after=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' manifest.json | head -1)
  echo
  echo "=================================="
  if [ "$before" = "$after" ]; then
    echo "  もう最新でした（${after}）"
  else
    echo "  ${before:-不明} → ${after} になりました"
  fi
  echo "=================================="
  echo
  echo "あとは Chrome 側の作業です:"
  echo
  echo "  1. chrome://extensions を開く"
  echo "  2. 「ばっさんディクテーション (β)」のカードの ↻ を押す"
  echo "  3. カードの数字が ${after} になっていれば成功"
  echo "  4. サイドパネルを一度閉じて開き直す"
  echo
  echo "  ※ ブラウザ版（start.bat）で使っている場合は、"
  echo "     dictation server のウィンドウを閉じて start.bat を再実行し、"
  echo "     ページを Ctrl+Shift+R で開き直してください。"
  echo
  return 0
}

main
