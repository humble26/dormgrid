#!/usr/bin/env bash
# 单机演示：1 个协调器 + 2 个工作节点（模拟两台机器）
set -e
cd "$(dirname "$0")/.."
node dormgrid.js serve &
node dormgrid.js work -coordinator 127.0.0.1:47820 -name node-1 &
node dormgrid.js work -coordinator 127.0.0.1:47820 -name node-2 &
wait
