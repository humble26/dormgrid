@echo off
chcp 65001 >nul
title DormGrid Worker
set /p ADDR=Coordinator address (host:port, empty = auto discover):
if "%ADDR%"=="" (node "%~dp0dormgrid.js" work) else (node "%~dp0dormgrid.js" work -coordinator %ADDR%)
pause
