@echo off
chcp 65001 >nul
rem Ярлик для ноутбука: відкриває захищений SSH-тунель до сервера і дашборд у браузері.
rem Скопіюйте цей файл на робочий стіл. За потреби змініть адресу сервера нижче.
set SERVER=lihih@ssh.n8nawsautobot.pp.ua
set REMOTE_PORT=3000
set LOCAL_PORT=3210
title Parsing - з'єднання з сервером

rem Якщо тунель уже відкрито - просто відкриваємо браузер.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:%LOCAL_PORT%/api/health | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  start "" http://127.0.0.1:%LOCAL_PORT%
  exit /b
)

echo Підключення до %SERVER% ...
echo Це вікно тримає з'єднання: не закривайте його, поки працюєте з дашбордом.
echo.
rem Браузер відкриється за кілька секунд, коли тунель буде готовий.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%LOCAL_PORT%/api/health | Out-Null; Start-Process http://127.0.0.1:%LOCAL_PORT%; exit } catch { Start-Sleep 1 } }"
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L %LOCAL_PORT%:127.0.0.1:%REMOTE_PORT% %SERVER%
echo.
echo З'єднання закрито.
pause
