#!/bin/bash
# 立方战术 · Mac 一键启动（双击本文件即可）
# 检测 Node.js -> 按需 npm install -> npm run build -> 启动服务端 -> 打开浏览器
cd "$(dirname "$0")" 2>/dev/null || exit 1

echo ""
echo "  ============================================"
echo "     立方战术 · 正在准备启动..."
echo "  ============================================"
echo ""

# ---------- 0) 自动定位项目目录 ----------
# 兼容：整个文件夹一起用；或只把本文件拖到桌面/其它地方也能找回项目
is_root() { [ -f "$1/package.json" ] && [ -f "$1/server/server.js" ]; }

ROOT=""
CANDIDATES=(
  "$PWD"
  "$HOME/Desktop"
  "$HOME/Downloads"
  "$HOME/Documents"
)
for base in "${CANDIDATES[@]}"; do
  [ -d "$base" ] || continue
  if is_root "$base"; then ROOT="$base"; break; fi
  while IFS= read -r cand; do
    if is_root "$cand"; then ROOT="$cand"; break 2; fi
  done < <(find "$base" -maxdepth 2 -name package.json -print 2>/dev/null | sed 's#/package.json$##')
done

if [ -z "$ROOT" ]; then
  echo "  [提示] 没有找到项目文件（package.json / server / src 等）。"
  echo ""
  echo "  请确认："
  echo "    1. 已将压缩包「完整解压」到一个文件夹（不要直接在压缩包里双击运行）；"
  echo "    2. 双击的是解压后文件夹里的「一键启动.command」，而不是单独复制到桌面的这个文件；"
  echo "    3. 项目文件夹里应能看到 package.json、server、src、dist 等文件/文件夹。"
  echo ""
  read -r -p "  按回车键关闭... " _
  exit 1
fi
cd "$ROOT" || exit 1
echo "  项目目录：$ROOT"
echo ""

# ---------- 1) 检测 Node.js / npm ----------
if ! command -v node >/dev/null 2>&1; then
  echo "  [提示] 没有检测到 Node.js。"
  echo "  请先到 https://nodejs.org/ 下载并安装 LTS 版本，装好后重新双击本文件。"
  open "https://nodejs.org/" 2>/dev/null || true
  echo ""
  read -r -p "  按回车键关闭... " _
  exit 1
fi
echo "  [1/4] Node.js 已就绪  $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  echo "  [提示] 检测到 Node.js，但没有 npm，请重装 Node.js LTS 版本。"
  read -r -p "  按回车键关闭... " _
  exit 1
fi

# ---------- 2) 按需安装依赖 ----------
if [ -f node_modules/express/package.json ]; then
  echo "  [2/4] 依赖已存在，跳过 npm install"
else
  echo "  [2/4] 首次运行，正在安装依赖（首次约需 1-3 分钟，请耐心等待）..."
  if ! npm install --no-audit --no-fund; then
    echo "  [警告] npm install 报告了错误。"
  fi
  if [ ! -f node_modules/express/package.json ]; then
    echo "  [错误] 依赖安装失败，找不到 node_modules/express。"
    echo "  常见原因：网络无法访问 npm 源。可尝试执行下面这条换成国内镜像后重试："
    echo "      npm config set registry https://registry.npmmirror.com"
    read -r -p "  按回车键关闭... " _
    exit 1
  fi
  echo "  [提示] 依赖已就绪，继续启动。"
fi

# ---------- 3) 构建前端 ----------
echo "  [3/4] 正在构建前端（npm run build）..."
if ! npm run build; then
  if [ -f dist/index.html ]; then
    echo "  [提示] 构建有警告，已使用 dist 内现有产物继续启动。"
  else
    echo "  [错误] 构建失败，请检查上面的报错信息。"
    read -r -p "  按回车键关闭... " _
    exit 1
  fi
fi
if [ ! -f dist/index.html ]; then
  echo "  [错误] 构建完成但没有生成 dist/index.html，请把上面的报错截图发给开发者。"
  read -r -p "  按回车键关闭... " _
  exit 1
fi

# ---------- 4) 启动服务端并等待就绪 ----------
SERVER_PID=""
if curl -s -o /dev/null -m 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
  echo "  [4/4] 服务端已在运行，直接打开浏览器"
else
  echo "  [4/4] 正在启动服务端..."
  node server/server.js &
  SERVER_PID=$!
  READY=0
  for _i in $(seq 1 60); do
    if curl -s -o /dev/null -m 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
      READY=1
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "  [错误] 服务端进程意外退出。"
      read -r -p "  按回车键关闭... " _
      exit 1
    fi
    sleep 1
  done
  if [ "$READY" -ne 1 ]; then
    echo "  [错误] 等待服务端启动超时，请查看上面的报错信息。"
    read -r -p "  按回车键关闭... " _
    exit 1
  fi
fi

open "http://localhost:3000" 2>/dev/null || true

echo ""
echo "  ============================================"
echo "     🎮 游戏已启动！默认浏览器已自动打开"
echo "     本机访问： http://localhost:3000"
echo "     局域网地址：请看上方终端里的绿色提示"
echo "     PC 大厅右上角点【退出游戏】= 关闭游戏进程并返回桌面"
echo "     关闭本窗口（或按 Ctrl + C）也可停止游戏"
echo "  ============================================"
echo ""

# 保持终端打开：服务端留在前台，关窗口 / Ctrl+C 即停服务
if [ -n "$SERVER_PID" ]; then
  trap 'kill "$SERVER_PID" 2>/dev/null || true' INT TERM EXIT
  wait "$SERVER_PID"
  # v5：服务端正常退出（含 PC 大厅【退出游戏】）时给一句明确提示
  echo ""
  echo "  游戏进程已退出（可能由 PC 大厅【退出游戏】触发）。可关闭本窗口。"
else
  echo "  服务端由另一个窗口运行，本窗口可直接关闭。"
  read -r -p "  按回车键关闭... " _
fi
