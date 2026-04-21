@echo off
REM dictation 起動用ランチャー
REM UNC パス（\\wsl.localhost\...）対策のため、electron へパスを明示的に渡す

electron \\wsl.localhost\Ubuntu\home\bayashi\dictation
