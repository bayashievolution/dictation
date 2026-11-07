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

REM パスを書き固めない (v0.24.12)。%~dp0 = この .bat が置いてある場所。
REM serve.js は必ず隣にあるので、どこに置いても、誰の PC でも動く。
REM （以前は \\wsl.localhost\Ubuntu\home\bayashi\... と書いてあったので、
REM   このフォルダを移しただけで動かなくなっていた）
set "SERVEJS=%~dp0serve.js"

REM /k にしてあるのは、node が落ちたときに理由を読めるようにするため。
REM 窓を閉じればサーバーも止まる（これまでと同じ）
start "dictation server" /MIN cmd /k node "%SERVEJS%"
timeout /t 2 /nobreak >nul
exit
