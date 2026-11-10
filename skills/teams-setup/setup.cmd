@echo off
setlocal
pushd "%~dp0..\.." || exit /b 1

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12 or newer is required. Install it and reopen your terminal.
  popd
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm is required on PATH. Install Node.js and reopen your terminal.
  popd
  exit /b 1
)

echo Installing Teams agent dependencies...
call npm.cmd ci
set "result=%errorlevel%"
if not "%result%"=="0" (
  echo Dependency installation failed. The setup wizard was not started.
  popd
  exit /b %result%
)

call npm.cmd run setup
set "result=%errorlevel%"
popd
exit /b %result%
