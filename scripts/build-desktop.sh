#!/usr/bin/env bash
# 打包桌面端为免安装单文件 exe（其他电脑无需 Node、无需安装，双击即用）
# 产物: desktop/dist/DormGrid-<版本>-portable.exe
set -e
cd "$(dirname "$0")/../desktop"
# 国内镜像: Electron 发行包 + electron-builder 二进制工具
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win portable --publish never
echo "打包完成: desktop/dist/DormGrid-*-portable.exe"
