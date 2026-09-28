// Mandelbrot 瓦片渲染器：按行带切给多个线程并行，结果按序拼回 RGBA 缓冲。
// 颜色用余弦调色板 + 平滑迭代数，纯确定性计算，跨机器结果一致。

const { Worker } = require('node:worker_threads');
const os = require('node:os');

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { x0, x1, y0, y1, width, height, rowStart, rowEnd, maxIter } = workerData;
const buf = Buffer.alloc((rowEnd - rowStart) * width * 4);
const dx = (x1 - x0) / width;
const dy = (y1 - y0) / height;
let off = 0;
for (let py = rowStart; py < rowEnd; py++) {
  const ci = y0 + (py + 0.5) * dy;
  for (let px = 0; px < width; px++) {
    const cr = x0 + (px + 0.5) * dx;
    let zr = 0, zi = 0, i = 0;
    while (zr * zr + zi * zi <= 4 && i < maxIter) {
      const t = zr * zr - zi * zi + cr;
      zi = 2 * zr * zi + ci;
      zr = t;
      i++;
    }
    if (i >= maxIter) {
      buf[off++] = 0; buf[off++] = 0; buf[off++] = 0; buf[off++] = 255;
      continue;
    }
    const mod = Math.sqrt(zr * zr + zi * zi);
    const l2 = Math.max(Math.log2(mod), 1.0000001);
    let mu = i + 1 - Math.log2(l2);
    if (mu < 0) mu = 0;
    const t2 = mu * 0.015;
    buf[off++] = 255 * (0.5 + 0.5 * Math.cos(6.283185307 * t2));
    buf[off++] = 255 * (0.5 + 0.5 * Math.cos(6.283185307 * (t2 + 0.1)));
    buf[off++] = 255 * (0.5 + 0.5 * Math.cos(6.283185307 * (t2 + 0.2)));
    buf[off++] = 255;
  }
}
parentPort.postMessage(buf, [buf.buffer]);
`;

function renderTile(task, threads) {
  const n = Math.max(1, Math.min(threads || os.availableParallelism(), task.height));
  const per = Math.ceil(task.height / n);
  const bands = [];
  for (let k = 0; k * per < task.height; k++) {
    bands.push({ rowStart: k * per, rowEnd: Math.min(task.height, (k + 1) * per) });
  }
  return Promise.all(
    bands.map(band => new Promise((resolve, reject) => {
      const w = new Worker(WORKER_SRC, {
        eval: true,
        workerData: {
          ...band,
          x0: task.xmin, x1: task.xmax,
          y0: task.ymin, y1: task.ymax,
          width: task.width, height: task.height,
          maxIter: task.maxIter,
        },
      });
      w.on('message', msg => resolve(Buffer.from(msg)));
      w.on('error', reject);
    }))
  ).then(parts => Buffer.concat(parts));
}

module.exports = { renderTile };
