@echo off
chcp 65001 >nul
setlocal
title Parsing - встановлення
rem Встановлює Parsing на цей комп'ютер: завантажує проєкт, налаштовує базу, створює ярлик.
rem Запускати подвійним клацанням. Повторний запуск оновлює проєкт.
rem Вмикає автозапуск сервера під час входу у Windows (вимкнути: npm run shortcut -- --no-autostart).
rem SUPABASE_REF - ідентифікатор проєкту Supabase (20 символів з адреси проєкту); можна лишити порожнім.
set SUPABASE_REF=
set BRANCH=ccr-2acbc8a5-l1bgjn
set DIR=%USERPROFILE%\Parsing

where git >nul 2>nul
if errorlevel 1 goto need_git
where node >nul 2>nul
if errorlevel 1 goto need_node
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
if errorlevel 1 goto need_node

if exist "%DIR%\.git" goto update
echo Завантажую проєкт у %DIR% ...
git clone -b %BRANCH% https://github.com/relaxcyber/Parsing.git "%DIR%"
if errorlevel 1 goto failed
goto deps

:update
echo Оновлюю проєкт у %DIR% ...
rem Працюючий сервер тримає файли залежностей, і npm install не зміг би їх замінити.
if exist "%DIR%\scripts\launch.mjs" node "%DIR%\scripts\launch.mjs" --stop >nul 2>nul
rem npm install інколи переписує package-lock.json, і тоді git pull відмовляється оновлювати.
git -C "%DIR%" checkout -- package-lock.json >nul 2>nul
git -C "%DIR%" pull --ff-only
if errorlevel 1 goto failed

:deps
cd /d "%DIR%"
echo Встановлюю залежності, це може тривати кілька хвилин ...
call npm install
if errorlevel 1 goto failed

if exist .env goto shortcut
if "%SUPABASE_REF%"=="" goto setup_plain
call npm run setup -- --supabase %SUPABASE_REF%
if errorlevel 1 goto failed
goto shortcut

:setup_plain
call npm run setup
if errorlevel 1 goto failed

:shortcut
call npm run shortcut
if errorlevel 1 goto failed
echo Запускаю дашборд, перший запуск триває довше ...
call npm run launch
if errorlevel 1 goto failed
echo.
echo Готово. Сервер тепер запускається сам після ввімкнення комп'ютера:
echo дашборд відкривається за адресою http://127.0.0.1:3000 або ярликом Parsing.
pause
exit /b 0

:need_git
echo Не знайдено Git. Встановлюю ...
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
goto rerun

:need_node
echo Не знайдено Node.js 22.12 або новішого. Встановлюю ...
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
goto rerun

:rerun
echo.
echo Після встановлення закрийте це вікно і запустіть цей файл ще раз.
pause
exit /b 1

:failed
echo.
echo Сталася помилка - дивіться повідомлення вище.
pause
exit /b 1
