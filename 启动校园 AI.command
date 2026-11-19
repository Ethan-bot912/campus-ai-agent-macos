#!/bin/sh

cd "$(dirname "$0")" || exit 1
electron_app="$PWD/node_modules/electron/dist/Electron.app"

if [ ! -x "$electron_app/Contents/MacOS/Electron" ]; then
  printf '%s\n' '请先按 README.md 的 macOS 步骤安装依赖和 Electron。' >&2
  exit 1
fi

exec /usr/bin/open -n -a "$electron_app" --args "$PWD"
