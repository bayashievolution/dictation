@echo off
chcp 65001 >nul
title dictation update
REM ばっさんディクテーション アプデ用ランチャー
REM
REM ■ なぜ .bat を置くのか
REM   ターミナルを開いてコマンドを思い出す、という工程をなくすため。
REM   実際の処理は WSL 側の update.sh にある（git は WSL の中で動かす必要がある）。
REM
REM ■ なぜ %TEMP% に移動するのか
REM   cmd.exe は UNC パス（\\wsl.localhost\...）を作業ディレクトリにできない。
REM   start.bat と同じ逃げ方をしている。

cd /d "%TEMP%"

REM 既定のディストロが Ubuntu でない場合に備えて、使えるかどうか先に静かに試す
set DISTRO=-d Ubuntu
wsl -d Ubuntu -e true >nul 2>nul
if errorlevel 1 set DISTRO=

wsl %DISTRO% -e bash -lc "bash ~/dictation/update.sh"

echo.
echo ----------------------------------------
echo  Enter を押すか、この窓を閉じてください
echo ----------------------------------------
pause >nul
