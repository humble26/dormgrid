#!/usr/bin/env bash
# 把 DormGrid 打包成免装 Node 的单文件 exe（Windows）
# 产物: dist/dormgrid.exe —— 拷到任何 Windows 机器上:
#   dormgrid.exe serve -port 47820          # 当协调器
#   dormgrid.exe work -coordinator IP:47820 # 当工作节点
set -e
cd "$(dirname "$0")/.."
mkdir -p dist

echo "[1/4] esbuild 打包为单文件 CJS ..."
npx esbuild dormgrid.js --bundle --platform=node --outfile=dist/entry.cjs --log-level=warning

echo "[2/4] 生成 SEA blob ..."
node --experimental-sea-config sea-config.json

echo "[3/4] 复制 Node 运行时 ..."
cp "$(command -v node)" dist/dormgrid.exe

echo "[4/4] 注入 blob (postject) ..."
npx postject dist/dormgrid.exe NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite

echo "构建完成: dist/dormgrid.exe ($(du -h dist/dormgrid.exe | cut -f1))"
