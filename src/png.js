// 零依赖 PNG 编码器：RGBA 像素缓冲 -> PNG 文件
// 只需支持写，不需要解码器；瓦片用 Up 滤波保证渐变压缩率。

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 2; // filter: Up
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const up = y > 0 ? rgba[prev + x] : 0;
      raw[o + 1 + x] = (rgba[row + x] - up) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 简单盒滤波降采样（用于成图预览）
function boxDownscale(rgba, w, h, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  const fx = w / tw;
  const fy = h / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * fy);
    const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * fy));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * fx);
      const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * w + x) * 4;
          r += rgba[o];
          g += rgba[o + 1];
          b += rgba[o + 2];
          n++;
        }
      }
      const o2 = (ty * tw + tx) * 4;
      out[o2] = r / n;
      out[o2 + 1] = g / n;
      out[o2 + 2] = b / n;
      out[o2 + 3] = 255;
    }
  }
  return out;
}

module.exports = { encodePNG, boxDownscale, crc32 };
