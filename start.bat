@echo off
REM dictation 起動用ランチャー
REM Node サーバーを最小化起動 → Chrome 自動起動
REM 終了したいときはタスクバーの「dictation server」を閉じる

cd /d "%TEMP%"
start "dictation server" /MIN cmd /c "node \\wsl.localhost\Ubuntu\home\bayashi\dictation\serve.js & pause"
timeout /t 2 /nobreak >nul
exit
