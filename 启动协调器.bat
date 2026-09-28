@echo off
chcp 65001 >nul
title DormGrid Coordinator
echo [DormGrid] 启动协调器 ... 仪表盘: http://localhost:47820
node "%~dp0dormgrid.js" serve
pause
