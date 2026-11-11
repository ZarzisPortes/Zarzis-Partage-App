@echo off
title Zarzis Portes Shared Room
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and install it, then run this again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First start: installing the required packages. This needs internet and takes a minute...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Installation failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo There is no .env file yet. Copy ".env.example" to ".env" and fill it in - see README.md.
  pause
  exit /b 1
)

echo Starting the Shared Room server. Keep this window open.
echo.
node server.js
echo.
echo The server has stopped. Press any key to close this window.
pause >nul
