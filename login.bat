@echo off
chcp 65001 >nul
title claude login
REM Claude Code のログインをやり直すためのランチャー (v0.24.8)
REM
REM ■ なぜ要るのか
REM   claude の OAuth は期限切れになる。切れると dictation の Claude 連携は
REM   黙って Gemini に落ちる（画面には「ログインが切れている」と出る）。
REM   claude -p は非対話なので、その場でログインを促せない。
REM
REM ■ update.bat と同じ逃げ方
REM   cmd.exe は UNC パス（\\wsl.localhost\...）を作業ディレクトリにできない。

cd /d "%TEMP%"

echo.
echo  Claude Code にサインインします。
echo  ブラウザが開いたら、そのまま進めてください。
echo.

REM serve.js と同じ順で探す。Windows 側に claude があればそれ、無ければ WSL 側
where claude >nul 2>nul
if errorlevel 1 goto wsl

claude auth login
goto done

:wsl
set DISTRO=-d Ubuntu
wsl -d Ubuntu -e true >nul 2>nul
if errorlevel 1 set DISTRO=
wsl %DISTRO% -e bash -lc "claude auth login"

:done
echo.
echo  ----------------------------------------
echo   終わったら dictation の設定で
echo   「接続を確認」を押してください
echo  ----------------------------------------
pause >nul
