#!/usr/bin/env node
// 假 blender：模拟 blender 的无头渲染接口，供没有安装 Blender 的机器做链路验证。
// 支持的参数（与真 blender 对齐的子集）: <资产路径...> -f N -o <前缀>#### -F PNG -t T
// 行为: 等待约 100ms（模拟工作量），向前缀展开 #### 后的路径写一张确定性 PNG。

const fs = require('node:fs');
const path = require('node:path');
const { encodePNG } = require('../src/png');

const argv = process.argv.slice(2);
function flagVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

// 新版任务模板: --python-expr 里带 filepath=r'<精确目标路径>'，从中提取
let file = null;
const exprIdx = argv.indexOf('--python-expr');
if (exprIdx >= 0) {
  const m = /filepath=r'([^']+)'/.exec(argv[exprIdx + 1] || '');
  if (m) file = m[1];
}
// 兼容旧模板: -f N -o 前缀####
if (!file) {
  const f = Number(flagVal('-f'));
  const out = flagVal('-o');
  if (Number.isFinite(f) && out && out.includes('####')) {
    file = out.replace('####', String(f).padStart(4, '0') + '.png');
  }
}
if (!file) {
  console.error("fake-blender: 需要 --python-expr（内含 filepath=r'...'）或 -f N 与 -o 前缀####");
  process.exit(1);
}

const w = 160, h = 90;
const seed = (file.length * 13 + 7) % 997;
const buf = Buffer.alloc(w * h * 4);
for (let i = 0; i < buf.length; i += 4) {
  buf[i] = (seed + i) % 256;
  buf[i + 1] = (seed * 3 + i) % 256;
  buf[i + 2] = (seed * 7 + i) % 256;
  buf[i + 3] = 255;
}

setTimeout(() => {
  require('node:fs').mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(buf, w, h));
  console.log('fake-blender: -> ' + file);
}, 100);
