#!/bin/sh
# 全テストを走らせる。使い方: sh tests/run.sh
#
# SRC を渡すと別の版に当てられる（修正前のコードに当てて、ちゃんと落ちるか確かめる用）:
#   git archive <旧コミット> | tar -x -C /tmp/old && SRC=/tmp/old/ sh tests/run.sh
cd "$(dirname "$0")/.." || exit 1
fail=0
for t in tests/t-*.js; do
  if node "$t" >/tmp/t.out 2>&1; then
    echo "✅ $(basename "$t")"
  else
    echo "❌ $(basename "$t")"
    grep '✕' /tmp/t.out | head -5
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "\nすべて通過" || echo "\n失敗あり"
exit $fail
