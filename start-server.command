#!/bin/bash
# Mac: double-click this file to start the Shared Room.
# (First time only: right-click it > Open > Open, because it was downloaded.)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First start: installing the required packages (needs internet, about a minute)..."
  npm install --omit=dev || { echo "Installation failed."; read -n 1 -s -r -p "Press any key to close..."; exit 1; }
fi

if [ ! -f .env ]; then
  echo "There is no .env file yet. Copy .env.example to .env and fill it in - see README.md."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

echo "Starting the Shared Room server. Keep this window open."
echo
# caffeinate stops the Mac from falling asleep while the server runs
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i node server.js
else
  node server.js
fi
echo
read -n 1 -s -r -p "The server has stopped. Press any key to close..."
