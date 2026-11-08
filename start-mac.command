#!/bin/bash
# Mac：在 Finder 雙擊這個檔案就會啟動大樓（第一次被擋的話，右鍵 →「打開」）
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "需要先安裝 Node.js 18.17 以上：https://nodejs.org/（或 brew install node）"
  read -r -p "按 Enter 關閉" _; exit 1
fi
if [ ! -d node_modules ]; then
  npm install || { read -r -p "npm install 失敗，按 Enter 關閉" _; exit 1; }
fi
PORT=$(node -p "try { require('./tower.config.json').port || 7777 } catch (e) { 7777 }")
echo "大樓啟動中……這個視窗開著，大樓就一直在；關掉這個視窗，大樓就停。"
(sleep 4; open "http://localhost:$PORT") &
npm start
