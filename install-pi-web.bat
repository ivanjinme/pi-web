@echo off
setlocal EnableExtensions
chcp 65001 >nul
title weclio-web 一键安装

set "NODE_PACKAGE=OpenJS.NodeJS.LTS"
set "PI_WEB_PACKAGE=@weclio/pi-web@latest"
set "NPM_REGISTRY=https://registry.npmmirror.com/"
set "NODE_EXE="
set "NPM_CMD="

echo ========================================
echo          weclio-web 一键安装
echo ========================================
echo.

echo [1/4] 检查 Node.js...
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"

if defined NODE_EXE if defined NPM_CMD (
    "%NODE_EXE%" -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0] > 22 || (v[0] === 22 && v[1] >= 19) ? 0 : 1)"
    if not errorlevel 1 goto :node_ready
)

echo [2/4] 正在安装或更新 Node.js LTS...
where winget >nul 2>&1
if errorlevel 1 (
    echo.
    echo 当前 Node.js 不可用或版本低于 22.19.0，且未找到 winget。
    echo 请更新 Windows 的“应用安装程序”，或前往 https://nodejs.org/ 安装 Node.js LTS。
    goto :error
)

echo.
winget install --id "%NODE_PACKAGE%" -e --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo.
    echo Node.js 安装失败，请检查网络后重试。
    goto :error
)

set "NODE_EXE="
set "NPM_CMD="
if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if exist "C:\Program Files\nodejs\npm.cmd" set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
for /f "delims=" %%I in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"

if not defined NODE_EXE goto :node_missing
if not defined NPM_CMD goto :node_missing

"%NODE_EXE%" -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0] > 22 || (v[0] === 22 && v[1] >= 19) ? 0 : 1)"
if errorlevel 1 (
    echo.
    echo Node.js 版本低于 22.19.0，请更新后重试。
    goto :error
)

goto :node_ready

:node_missing
echo.
echo Node.js 已安装，但当前窗口未找到 node 或 npm。
echo 请关闭此窗口后重新运行脚本。
goto :error

:node_ready
if not defined NODE_EXE goto :node_missing
if not defined NPM_CMD goto :node_missing

echo [3/4] 正在安装 weclio-web...
echo.
rem 仅本次安装使用国内镜像，不修改用户的全局 npm 配置。
call "%NPM_CMD%" install --global "%PI_WEB_PACKAGE%" --registry="%NPM_REGISTRY%"
if errorlevel 1 (
    echo.
    echo weclio-web 安装失败，请检查网络后重试。
    goto :error
)

for /f "usebackq delims=" %%I in (`call "%NPM_CMD%" prefix -g`) do set "NPM_GLOBAL_PREFIX=%%I"
set "WECLIO_WEB_CMD=%NPM_GLOBAL_PREFIX%\weclio-web.cmd"

if not exist "%WECLIO_WEB_CMD%" (
    echo.
    echo weclio-web 已安装，但未找到启动命令。
    echo 请重新打开 PowerShell 后运行：weclio-web
    goto :error
)

echo [4/4] 安装完成
echo.
echo ========================================
echo              安装成功！
echo ========================================
echo.
echo Node.js 版本：
"%NODE_EXE%" -v
echo.
echo weclio-web 已安装。
echo.

choice /C YN /N /M "现在启动 weclio-web 吗？[Y/N] "
if errorlevel 2 goto :done

call "%WECLIO_WEB_CMD%"
goto :done

:error
echo.
pause
exit /b 1

:done
echo.
echo 以后可在 PowerShell 中运行：weclio-web
echo.
pause
