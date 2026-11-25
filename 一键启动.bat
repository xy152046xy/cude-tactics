cd /d "%~dp0"
@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 立方战术 - 一键启动
REM ===========================================================================
REM  立方战术 一键启动（Windows）
REM  第一行 cd /d "%~dp0"：无论从哪个目录双击，都先切到本脚本所在目录。
REM  本脚本依次执行：npm install -> npm run build -> node server/server.js，
REM  并在等待服务就绪后自动打开默认浏览器；所有失败分支均有 pause，不会闪退。
REM ===========================================================================

echo.
echo   ============================================
echo      立方战术 - 正在准备启动...
echo   ============================================
echo.

set "HERE=%~dp0"

REM ---------- 0) 自动定位项目目录 ----------
REM 兼容三种用法：整个文件夹里双击 / 只把本文件拖到桌面 / 把项目文件夹拖到本文件上
set "ROOT="
if exist "%~1\package.json" if exist "%~1\server\server.js" if exist "%~1\shared\rules.js" set "ROOT=%~1"
if not defined ROOT call :scan "%HERE%"
REM 读取真实桌面路径（兼容 OneDrive 等重定向）
set "DESKTOP="
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" /v Desktop 2^>nul') do set "DESKTOP=%%b"
if defined DESKTOP call set "DESKTOP=%DESKTOP%"
if not defined ROOT if defined DESKTOP if exist "!DESKTOP!" call :scan "!DESKTOP!"
if not defined ROOT if exist "%USERPROFILE%\Desktop"          call :scan "%USERPROFILE%\Desktop"
if not defined ROOT for /d %%d in ("%USERPROFILE%\OneDrive*") do if exist "%%d\Desktop" call :scan "%%d\Desktop"
if not defined ROOT if exist "%USERPROFILE%\Downloads"        call :scan "%USERPROFILE%\Downloads"
if not defined ROOT if exist "%USERPROFILE%\Documents"        call :scan "%USERPROFILE%\Documents"
if not defined ROOT goto :no_project
cd /d "!ROOT!"
set "ROOTDIR=!ROOT!"
if "!ROOTDIR:~-1!"=="\" set "ROOTDIR=!ROOTDIR:~0,-1!"
echo   项目目录：!ROOTDIR!
echo.

REM ---------- 1) 检测 Node.js ----------
where node >nul 2>nul
if errorlevel 1 goto :no_node
for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
echo   [1/4] Node.js 已就绪  !NODE_VER!

where npm >nul 2>nul
if errorlevel 1 goto :no_npm

set "HAS_CURL=1"
where curl >nul 2>nul || set "HAS_CURL="

REM ---------- 2) 按需安装依赖（npm install） ----------
if exist "node_modules\express\package.json" goto :deps_ok
echo   [2/4] 首次运行，正在安装依赖（首次约需 1-3 分钟，请耐心等待）...
call npm install --no-audit --no-fund
if not exist "node_modules\express\package.json" goto :fail_install
goto :do_build
:deps_ok
echo   [2/4] 依赖已存在，跳过 npm install

REM ---------- 3) 构建前端（npm run build） ----------
:do_build
echo   [3/4] 正在构建前端（npm run build）...
call npm run build
set "BUILD_RC=!errorlevel!"
if not exist "dist\index.html" goto :fail_build
if not "!BUILD_RC!"=="0" echo   [提示] 构建有警告，已使用 dist 内现有产物继续启动。

REM ---------- 4) 启动服务端（node server/server.js） ----------
if defined HAS_CURL (
  curl -s -o nul -m 2 http://127.0.0.1:3000/health >nul 2>&1
  if not errorlevel 1 (
    echo   [4/4] 服务端已在运行，直接打开浏览器
    goto :open
  )
)

echo   [4/4] 正在启动服务端（会新开一个最小化窗口，请勿关闭）...
REM v5：正常退出（含 PC 大厅点【退出游戏】）时自动关闭本窗口，回到桌面；
REM     仅当 node 异常退出（errorlevel 1）才停住窗口，方便查看报错。
start "立方战术 - 服务端（关闭即停止游戏）" /D "!ROOTDIR!" /MIN cmd /c "node server/server.js & if errorlevel 1 (echo. & echo 服务端异常退出，请把上面的报错发给开发者。 & pause)"

if not defined HAS_CURL (
  echo   [提示] 系统没有 curl，改用固定等待 8 秒
  timeout /t 8 /nobreak >nul
  goto :open
)

set /a TRIES=0
:wait
set /a TRIES+=1
curl -s -o nul -m 2 http://127.0.0.1:3000/health >nul 2>&1
if not errorlevel 1 goto :open
if !TRIES! GEQ 60 goto :timeout
timeout /t 1 /nobreak >nul
goto :wait

:open
start "" http://localhost:3000
echo.
echo   ============================================
echo      [OK] 游戏已启动！默认浏览器已自动打开
echo     本机访问： http://localhost:3000
echo      局域网地址：请看「服务端」窗口里的绿色提示
echo      PC 大厅右上角点【退出游戏】= 关闭游戏进程并返回桌面
echo      关闭「服务端」窗口 / 按 Ctrl + C 也可停止游戏
echo   ============================================
echo.
echo   按任意键关闭本窗口（不会停止服务端）...
pause >nul
exit /b 0

:no_project
echo   [提示] 没有找到项目文件（package.json / server / src 等）。
echo.
echo   请确认：
echo     1. 已将压缩包「完整解压」到一个文件夹（不要直接在压缩包里双击运行）；
echo     2. 双击的是解压后文件夹里的「一键启动.bat」，而不是单独复制到桌面的这个文件；
echo     3. 项目文件夹里应能看到 package.json、server、src、dist 等文件/文件夹。
echo.
echo   如果项目已经解压到别处，请进入该文件夹再双击「一键启动.bat」；
echo   也可以直接把整个项目文件夹拖到这个「一键启动.bat」图标上松开。
echo.
pause >nul
exit /b 1

:no_node
echo   [提示] 没有检测到 Node.js。
echo   请先到官网 https://nodejs.org/ 下载并安装 LTS 版本，
echo   安装时勾选 "Add to PATH"，装好后重新双击本文件。
echo.
start "" https://nodejs.org/
echo   按任意键关闭...
pause >nul
exit /b 1

:no_npm
echo   [提示] 检测到 Node.js，但没有 npm。请重装 Node.js LTS 版本。
pause >nul
exit /b 1

:fail_install
echo.
echo   [错误] 依赖安装失败。
echo   常见原因：网络无法访问 npm 源、或公司/校园网代理限制。
echo   可在命令行执行下面这条换成国内镜像后，重新双击本文件：
echo       npm config set registry https://registry.npmmirror.com
echo.
pause >nul
exit /b 1

:fail_build
echo.
echo   [错误] 前端构建失败（没有生成 dist\index.html）。
echo   请把上面的报错信息截图发给开发者。
echo.
pause >nul
exit /b 1

:timeout
echo   [错误] 等待服务端超时，请查看「服务端」窗口里的报错信息。
pause >nul
exit /b 1

REM ---------- 子程序：在某个目录下最多找两层，定位项目根 ----------
:scan
if defined ROOT goto :eof
set "BASE=%~1"
if "!BASE:~-1!"=="\" set "BASE=!BASE:~0,-1!"
call :probe "!BASE!"
if defined ROOT goto :eof
for /d %%d in ("!BASE!\*") do (
  if not defined ROOT call :probe "%%d"
)
if defined ROOT goto :eof
for /d %%d in ("!BASE!\*") do (
  for /d %%e in ("%%d\*") do (
    if not defined ROOT call :probe "%%e"
  )
)
goto :eof

REM ---------- 子程序：判断某个目录是否是项目根 ----------
:probe
if defined ROOT goto :eof
set "P=%~1"
if "!P:~-1!"=="\" set "P=!P:~0,-1!"
if not exist "!P!\package.json" goto :eof
if not exist "!P!\server\server.js" goto :eof
if not exist "!P!\shared\rules.js" goto :eof
set "ROOT=!P!"
goto :eof
