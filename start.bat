@echo off
REM dictation 起動用ランチャー
REM Node サーバーを最小化起動 → Chrome 自動起動
REM 終了したいときはタスクバーの「dictation server」を閉じる

cd /d "%TEMP%"

REM ── 古いサーバーが残っていたら止める (v0.24.11) ──
REM
REM update.bat はファイルを入れ替えるが、**走っている node は入れ替わらない**。
REM この窓は /MIN で開くので、古いのが生きていると
REM 「ポート 8765 が既に使われています」が最小化されたまま見えず、
REM 起動したつもりで古いままになる（やっさんが実際にここで詰まった）。
REM 起動のたびにポートを掴んでいるプロセスを止めておく。
REM （node.exe を全部止めるのは危険なので、**8765 を LISTENING している PID だけ**）
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":8765" ^| findstr /c:"LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
)

start "dictation server" /MIN cmd /c "node \\wsl.localhost\Ubuntu\home\bayashi\dictation\serve.js & pause"
timeout /t 2 /nobreak >nul
exit
