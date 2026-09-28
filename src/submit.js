// Blender 工程提交客户端：把 .blend 文件 POST 给协调器（流式上传，不整块进内存）

const fs = require('node:fs');
const { Readable } = require('node:stream');
const { discoverCoordinator } = require('./discover');

async function run(opts) {
  let base;
  if (opts.coordinator) {
    base = 'http://' + opts.coordinator;
  } else {
    console.log('未指定 -coordinator，正在 UDP 广播发现协调器 ...');
    base = 'http://' + (await discoverCoordinator());
  }
  console.log('协调器:', base);

  const q = new URLSearchParams({ frames: opts.frames, fps: String(opts.fps || 24) });
  const res = await fetch(base + '/api/job/blender?' + q, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Readable.toWeb(fs.createReadStream(opts.blend)),
    duplex: 'half', // Node fetch 传流式 body 时必须显式声明
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('提交失败 (HTTP ' + res.status + '):', j.error || '未知错误');
    process.exit(1);
  }
  console.log('已提交: ' + j.tasks + ' 帧, 工程 sha256 ' + j.asset.hash.slice(0, 12) + '...');
  console.log('渲染完成后，协调器 output/frames/ 下会出现帧序列与 manifest.json（有 ffmpeg 则自动合成 movie.mp4）');
}

module.exports = { run };
