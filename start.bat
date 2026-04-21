@echo off
REM dictation 起動用ランチャー
REM ローカルHTTPサーバー経由で Chrome に表示（マイク許可を永続化するため）

cd /d "%TEMP%"
node "\\wsl.localhost\Ubuntu\home\bayashi\dictation\serve.js"
pause
