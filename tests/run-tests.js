// DormGrid 功能验证套件
// 运行: node --test tests/
//
// 覆盖面:
//   1. 单元: PNG 编码器结构/CRC/解压长度、盒滤波降采样
//   2. API 契约: 注册/领任务/交卷/状态、错误路径(400/404/204)、CORS
//   3. 断点续算: 磁盘瓦片续用 + 重启后自动组图
//   4. UDP 自动发现: 单播(必过) + 广播(沙箱可能拦截则跳过)
//   5. 超时任务重新排队
//   6. 端到端: CLI 协调器 + 2 个真实工作节点渲染 2560x1440, 像素级抽查
//   7. 仪表盘页面冒烟

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const { Coordinator } = require('../src/serve');
const { encodePNG, boxDownscale, crc32 } = require('../src/png');
const { renderTile } = require('../src/render');
const { shouldWork, ensureScript } = require('../src/polite');
const { DISCOVER_PORT, DISCOVER_QUERY, DISCOVER_REPLY } = require('../src/common');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dormgrid-tests-'));
const SMALL_JOB = {
  width: 320, height: 180, cols: 4, rows: 2,
  xmin: -2.1, xmax: 1.1, ymin: -0.9, ymax: 0.9, maxIter: 60,
};
const ROOT = path.join(__dirname, '..');
const spawnOpts = { cwd: ROOT, env: process.env };

function tmpDir(name) {
  const d = path.join(TMP_ROOT, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function startCoord(dir, job = SMALL_JOB, opts = {}) {
  const c = new Coordinator(job, dir, opts);
  const port = await c.start(0, '127.0.0.1');
  return { c, port };
}

async function register(port, name) {
  const r = await api(port, 'POST', '/api/register', { name, cores: 4 });
  assert.equal(r.status, 200);
  return (await r.json()).worker_id;
}

async function registerWithExes(port, name, exes) {
  const r = await api(port, 'POST', '/api/register', { name, cores: 4, exes });
  assert.equal(r.status, 200);
  return (await r.json()).worker_id;
}

function api(port, method, p, body) {
  return fetch('http://127.0.0.1:' + port + p, {
    method,
    body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
}

function syntheticTile(w, h, seed) {
  const n = w * h * 4;
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) % 251;
  return b;
}

// 完整 PNG 解码（8-bit RGBA，支持全部 5 种行滤波）——既解自家产物，也解真 Blender 的输出
function decodeOwnPNG(buf) {
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const bpp = 4;
  const out = Buffer.alloc(w * h * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[rowStart + x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { w, h, rgba: out };
}

// ============ 1. 单元 ============

test('PNG 编码器：魔数/结构/每块 CRC/IDAT 解压长度', () => {
  const w = 3, h = 2;
  const png = encodePNG(Buffer.alloc(w * h * 4, 128), w, h);
  assert.equal(png.readUInt32BE(0), 0x89504e47, 'PNG 魔数');
  assert.equal(png[4], 0x0d);
  assert.equal(png[5], 0x0a);

  let off = 8, dims = null, seenIEND = false;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    const crc = png.readUInt32BE(off + 8 + len);
    assert.equal(crc, crc32(png.subarray(off + 4, off + 8 + len)), 'chunk ' + type + ' CRC 校验');
    if (type === 'IHDR') dims = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') seenIEND = true;
    off += 12 + len;
  }
  assert.deepEqual(dims, { w, h, depth: 8, color: 6 }, 'IHDR 尺寸与位深');
  assert.ok(seenIEND, 'IEND 存在');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (w * 4 + 1) * h, '解压后原始长度');
  for (let y = 0; y < h; y++) assert.equal(raw[y * (w * 4 + 1)], 2, '滤波类型 Up');
});

test('boxDownscale：2x2 -> 1x1 均值正确', () => {
  const px = Buffer.from([
    10, 20, 30, 255, 20, 40, 60, 255,
    30, 60, 90, 255, 40, 80, 120, 255,
  ]);
  const out = boxDownscale(px, 2, 2, 1, 1);
  assert.equal(out[0], 25);
  assert.equal(out[1], 50);
  assert.equal(out[2], 75);
  assert.equal(out[3], 255);
});

// ============ 2. API 契约 ============

test('协调器 API：注册/领任务/交卷/状态/错误路径/CORS', async t => {
  const dir = tmpDir('api');
  const { c, port } = await startCoord(dir);
  t.after(() => c.stop());

  const wid = await register(port, 't-node');
  assert.ok(wid, '应分配 worker_id');

  // 领任务: 瓦片尺寸 = 320/4 x 180/2 = 80x90
  const r1 = await api(port, 'GET', '/api/task?worker=' + wid);
  assert.equal(r1.status, 200);
  const task = await r1.json();
  assert.equal(task.width, 80);
  assert.equal(task.height, 90);

  let st = await (await api(port, 'GET', '/api/status')).json();
  assert.equal(st.total, 8);
  assert.equal(st.done, 0);
  assert.equal(st.tiles.filter(x => x.state === 'running').length, 1);

  // 领光全部 8 块
  for (let i = 0; i < 7; i++) {
    const r = await api(port, 'GET', '/api/task?worker=' + wid);
    assert.equal(r.status, 200);
  }
  assert.equal((await api(port, 'GET', '/api/task?worker=' + wid)).status, 204, '无任务返回 204');

  // 错误尺寸 -> 400
  assert.equal((await api(port, 'POST', '/api/result/' + task.id + '?worker=' + wid, Buffer.alloc(10))).status, 400);
  // 正确交卷
  assert.equal((await api(port, 'POST', '/api/result/' + task.id + '?worker=' + wid, syntheticTile(80, 90, 1))).status, 204);
  // 重复交卷 -> 404
  assert.equal((await api(port, 'POST', '/api/result/' + task.id + '?worker=' + wid, syntheticTile(80, 90, 1))).status, 404);
  // 未知任务 -> 404
  assert.equal((await api(port, 'POST', '/api/result/nope?worker=' + wid, Buffer.alloc(80 * 90 * 4))).status, 404);

  // 状态 done=1, 瓦片文件为合法 PNG
  const stRes = await api(port, 'GET', '/api/status');
  st = await stRes.json();
  assert.equal(st.done, 1);
  const t00 = st.tiles.find(x => x.id === task.id);
  assert.equal(t00.state, 'done');
  const tilePath = path.join(dir, 'tiles', path.basename(t00.file));
  assert.ok(fs.existsSync(tilePath), '瓦片 PNG 落盘');
  assert.equal(fs.readFileSync(tilePath).readUInt32BE(0), 0x89504e47);

  // CORS: 为浏览器访客节点预留
  assert.equal(stRes.headers.get('access-control-allow-origin'), '*', 'API 应带 CORS 头');
  assert.equal((await api(port, 'OPTIONS', '/api/status')).status, 204, 'OPTIONS 预检应通过');

  // 其余全部交卷 -> 触发自动组图
  for (const tile of st.tiles) {
    if (tile.state === 'done') continue;
    const r = await api(port, 'POST', '/api/result/' + tile.id + '?worker=' + wid, syntheticTile(80, 90, tile.col * 10 + tile.row));
    assert.equal(r.status, 204);
  }
  let complete = false;
  for (let i = 0; i < 50; i++) {
    if ((await (await api(port, 'GET', '/api/status')).json()).complete) { complete = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(complete, '全部交卷后应自动组图并标记 complete');
  const img = decodeOwnPNG(fs.readFileSync(path.join(dir, 'output', 'mandelbrot.png')));
  assert.equal(img.w, 320);
  assert.equal(img.h, 180);
  assert.equal(img.rgba.length, 320 * 180 * 4);
  assert.ok(fs.existsSync(path.join(dir, 'output', 'preview.png')), '预览图生成');
});

// ============ 3. 断点续算 + 重启自动组图 ============

test('协调器重启：磁盘瓦片续用并自动完成组图', async t => {
  const dir = tmpDir('resume');
  {
    // 第一次运行: 交齐全部瓦片(直接落盘), 模拟"组图前协调器被杀"
    const { c, port } = await startCoord(dir);
    const wid = await register(port, 'a');
    for (let i = 0; i < 8; i++) {
      const r = await api(port, 'GET', '/api/task?worker=' + wid);
      const task = await r.json();
      await api(port, 'POST', '/api/result/' + task.id + '?worker=' + wid, syntheticTile(task.width, task.height, i));
    }
    await c.stop();
  }
  {
    // 第二次运行: 不交任何新结果, 应自动发现瓦片齐全并组图
    const c2 = new Coordinator(SMALL_JOB, dir);
    const port2 = await c2.start(0, '127.0.0.1');
    t.after(() => c2.stop());
    let complete = false;
    for (let i = 0; i < 50; i++) {
      if ((await (await api(port2, 'GET', '/api/status')).json()).complete) { complete = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(complete, '重启后应自动组图并标记 complete（磁盘续用）');
    assert.ok(fs.existsSync(path.join(dir, 'output', 'mandelbrot.png')));
  }
});

test('部分完成后重启：剩余任务可继续, 已完成瓦片不重算', async t => {
  const dir = tmpDir('resume2');
  {
    const { c, port } = await startCoord(dir);
    const wid = await register(port, 'a');
    const r = await api(port, 'GET', '/api/task?worker=' + wid);
    const task = await r.json();
    await api(port, 'POST', '/api/result/' + task.id + '?worker=' + wid, syntheticTile(task.width, task.height, 9));
    await c.stop();
  }
  const c2 = new Coordinator(SMALL_JOB, dir);
  const port2 = await c2.start(0, '127.0.0.1');
  t.after(() => c2.stop());
  const st = await (await api(port2, 'GET', '/api/status')).json();
  assert.equal(st.done, 1, '重启后已完成瓦片应被续用');
  assert.equal(st.total, 8);
  // 剩余 7 块可正常领取并交卷
  const wid2 = await register(port2, 'b');
  for (let i = 0; i < 7; i++) {
    const r = await api(port2, 'GET', '/api/task?worker=' + wid2);
    assert.equal(r.status, 200);
    const task = await r.json();
    await api(port2, 'POST', '/api/result/' + task.id + '?worker=' + wid2, syntheticTile(task.width, task.height, i + 20));
  }
  let complete = false;
  for (let i = 0; i < 50; i++) {
    if ((await (await api(port2, 'GET', '/api/status')).json()).complete) { complete = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(complete, '续算后应完成组图');
});

// ============ 4. UDP 自动发现 ============

test('UDP 自动发现（单播）：应答包含实际 HTTP 端口', async t => {
  const dir = tmpDir('disc');
  const { c, port } = await startCoord(dir);
  t.after(() => c.stop());
  const reply = await new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { s.close(); } catch {} reject(new Error('2 秒内无应答')); }, 2000);
    s.on('message', m => { clearTimeout(timer); try { s.close(); } catch {} resolve(m.toString()); });
    s.send(Buffer.from(DISCOVER_QUERY), DISCOVER_PORT, '127.0.0.1');
  });
  assert.ok(reply.startsWith(DISCOVER_REPLY), '应答前缀正确');
  assert.ok(reply.includes(String(port)), '应答应携带实际 HTTP 端口 ' + port);
});

test('UDP 自动发现（广播）：沙箱拦截则跳过', async t => {
  const dir = tmpDir('bcast');
  const { c } = await startCoord(dir);
  t.after(() => c.stop());
  const reply = await new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { s.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 2000);
    s.on('message', m => finish(m.toString()));
    s.on('error', () => finish(null));
    s.bind(() => {
      s.setBroadcast(true);
      s.send(Buffer.from(DISCOVER_QUERY), DISCOVER_PORT, '255.255.255.255');
    });
  });
  if (!reply) return t.skip('广播被沙箱/防火墙拦截（单播路径已验证，真实局域网可用）');
  assert.ok(reply.startsWith(DISCOVER_REPLY));
});

// ============ 5. 超时重排 ============

test('超时任务重新排队（staleAfter=200ms）', async t => {
  const dir = tmpDir('stale');
  const { c, port } = await startCoord(dir, SMALL_JOB, { staleAfter: 200 });
  t.after(() => c.stop());
  const wid = await register(port, 'slow');
  const r1 = await api(port, 'GET', '/api/task?worker=' + wid);
  const t1 = await r1.json();
  await new Promise(r => setTimeout(r, 500));
  const r2 = await api(port, 'GET', '/api/task?worker=' + wid);
  assert.equal(r2.status, 200, '超时后应重新派发而非 204');
  const t2 = await r2.json();
  assert.equal(t2.id, t1.id, '重新派发的应是同一块（未交卷）任务');
});

// ============ 6. 端到端（真实渲染） ============

test('端到端：CLI 协调器 + 2 工作节点渲染 2560x1440 并像素抽查', { timeout: 120000 }, async t => {
  const dir = tmpDir('e2e');
  const port = 47881;
  const coord = spawn(process.execPath, ['dormgrid.js', 'serve', '-port', String(port), '-dir', dir], spawnOpts);
  const w1 = spawn(process.execPath, ['dormgrid.js', 'work', '-coordinator', '127.0.0.1:' + port, '-name', 'et-1', '-threads', '0', '-no-polite'], spawnOpts);
  const w2 = spawn(process.execPath, ['dormgrid.js', 'work', '-coordinator', '127.0.0.1:' + port, '-name', 'et-2', '-threads', '0', '-no-polite'], spawnOpts);
  t.after(() => { for (const p of [coord, w1, w2]) { try { p.kill(); } catch {} } });

  let ok = false;
  for (let i = 0; i < 90; i++) {
    try {
      const j = await (await fetch('http://127.0.0.1:' + port + '/api/status')).json();
      if (j.complete) { ok = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.ok(ok, '90 秒内完成渲染与组图');

  const img = decodeOwnPNG(fs.readFileSync(path.join(dir, 'output', 'mandelbrot.png')));
  assert.equal(img.w, 2560, '成图宽度');
  assert.equal(img.h, 1440, '成图高度');

  // 像素抽查: 复平面 (-0.5, 0) 位于心形内部 -> 纯黑
  const cx = Math.round(((-0.5 + 2.1) / 3.2) * 2560);
  const cy = Math.round(((0 + 0.9) / 1.8) * 1440);
  const o = (cy * 2560 + cx) * 4;
  assert.deepEqual([img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]], [0, 0, 0], '集合内部应为纯黑');
  // 左上角 (-2.1, -0.9) 附近属于外部 -> 应着色
  const s2 = img.rgba[0] + img.rgba[1] + img.rgba[2];
  assert.notEqual(s2, 0, '左上角应为外部着色');
});

// ============ 7. 仪表盘冒烟 ============

test('仪表盘页面与静态路由', async t => {
  const dir = tmpDir('dash');
  const { c, port } = await startCoord(dir);
  t.after(() => c.stop());
  const html = await (await fetch('http://127.0.0.1:' + port + '/')).text();
  assert.ok(html.includes('DormGrid'), '标题存在');
  assert.ok(html.includes('/api/status'), '轮询逻辑存在');
  assert.equal((await fetch('http://127.0.0.1:' + port + '/nope')).status, 404, '未知路径 404');
  assert.equal((await fetch('http://127.0.0.1:' + port + '/image.png')).status, 404, '未组图时 image.png 404');
});

// ============ 8. 性能策略（克制模式） ============

test('让路策略：用户活动/电池让路，探测不可用与全力模式放行', () => {
  const P = { polite: true, idleAfterSec: 120 };
  assert.equal(shouldWork({ idle: 10, ac: 'Online' }, P), false, '用户刚动过键鼠');
  assert.equal(shouldWork({ idle: 300, ac: 'Online' }, P), true, '空闲 5 分钟');
  assert.equal(shouldWork({ idle: 300, ac: 'Offline' }, P), false, '电池供电');
  assert.equal(shouldWork({ ac: 'Online' }, P), true, '无 idle 字段时不误伤');
  assert.equal(shouldWork(null, P), true, '探测不可用时不设障 (fail-open)');
  assert.equal(shouldWork({ idle: 10 }, { polite: false, idleAfterSec: 120 }), true, '全力模式不让路');
});

test('渲染确定性：线程数不影响输出（逐字节一致）', async () => {
  const task = { width: 160, height: 90, xmin: -2.1, xmax: 1.1, ymin: -0.9, ymax: 0.9, maxIter: 80 };
  const a = await renderTile(task, 1);
  const b = await renderTile(task, 8);
  assert.equal(a.length, 160 * 90 * 4);
  assert.ok(a.equals(b), '1 线程与 8 线程结果逐字节一致');
});

test('空闲探测脚本：单次输出可解析（仅 Windows）', { timeout: 40000 }, async t => {
  if (process.platform !== 'win32') return t.skip('仅 Windows');
  const script = ensureScript();
  assert.ok(script, '探测脚本应能写入临时目录');
  const out = await new Promise((resolve, reject) => {
    require('node:child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 30000, encoding: 'utf8' },
      (e, stdout) => (e ? reject(e) : resolve(stdout))
    );
  });
  const line = out.split('\n').map(s => s.trim()).find(s => s.startsWith('{'));
  assert.ok(line, '应有 JSON 输出');
  const j = JSON.parse(line);
  assert.ok(typeof j.idle === 'number' && j.idle >= 0, 'idle 为非负数');
  assert.ok(['Online', 'Offline', 'Unknown'].includes(j.ac), 'ac 取值合法');
});

// ============ 9. SEA 单文件 exe ============

test('SEA 单文件 exe：协调器 + 工作节点端到端渲染', { timeout: 150000 }, async t => {
  const exe = path.join(ROOT, 'dist', 'dormgrid.exe');
  if (!fs.existsSync(exe)) return t.skip('未构建 exe —— 先运行 bash scripts/build-exe.sh');
  const dir = tmpDir('sea');
  // 端口按 PID 派生: 上次运行残留的僵尸进程占住固定端口时不会连累本次
  const port = 47000 + (process.pid % 300);
  const coord = spawn(exe, ['serve', '-port', String(port), '-dir', dir]);
  const w1 = spawn(exe, ['work', '-coordinator', '127.0.0.1:' + port, '-name', 'sea-1', '-threads', '0', '-no-polite']);
  t.after(() => { for (const p of [coord, w1]) { try { p.kill(); } catch {} } });
  // 诊断缓冲: 失败时把子进程输出尾部附进断言消息，避免"莫名超时"无从排查
  const tail = p => {
    let s = '';
    p.stdout.on('data', d => { s = (s + d).slice(-1200); });
    p.stderr.on('data', d => { s = (s + d).slice(-1200); });
    return () => s;
  };
  const coordTail = tail(coord);
  const workerTail = tail(w1);

  let lastStatus = null;
  let ok = false;
  for (let i = 0; i < 140; i++) {
    try {
      lastStatus = await (await fetch('http://127.0.0.1:' + port + '/api/status')).json();
      if (lastStatus.complete) { ok = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.ok(
    ok,
    '140 秒内完成渲染\n最后状态: ' + JSON.stringify(lastStatus) +
    '\ncoord 输出尾部: ' + coordTail() +
    '\nworker 输出尾部: ' + workerTail()
  );
  const img = decodeOwnPNG(fs.readFileSync(path.join(dir, 'output', 'mandelbrot.png')));
  assert.equal(img.w, 2560);
  assert.equal(img.h, 1440);
  const cx = Math.round(((-0.5 + 2.1) / 3.2) * 2560);
  const cy = Math.round(((0 + 0.9) / 1.8) * 1440);
  const o = (cy * 2560 + cx) * 4;
  assert.deepEqual([img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]], [0, 0, 0], '集合内部应为纯黑');
});

// ============ 10. Blender 帧农场 ============

test('Blender 提交契约：帧解析/重复提交 409/资产哈希/能力匹配', async t => {
  const dir = tmpDir('bl');
  const c = new Coordinator({ type: 'none' }, dir);
  const port = await c.start(0, '127.0.0.1');
  t.after(() => c.stop());

  const blend = path.join(TMP_ROOT, 'scene.blend');
  fs.writeFileSync(blend, Buffer.from('FAKE-BLEND-' + 'x'.repeat(1000)));

  // 非法帧范围
  assert.equal((await fetch('http://127.0.0.1:' + port + '/api/job/blender?frames=bad', { method: 'POST', body: 'x' })).status, 400);
  assert.equal((await fetch('http://127.0.0.1:' + port + '/api/job/blender?frames=9-1', { method: 'POST', body: 'x' })).status, 400);

  // 正常提交 3 帧
  const r = await fetch('http://127.0.0.1:' + port + '/api/job/blender?frames=1-3&fps=12', { method: 'POST', body: fs.readFileSync(blend) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.tasks, 3);
  assert.equal(j.asset.hash.length, 64);

  // 重复提交 -> 409
  assert.equal((await fetch('http://127.0.0.1:' + port + '/api/job/blender?frames=1-3', { method: 'POST', body: 'x' })).status, 409);

  // 资产下载字节一致
  const got = Buffer.from(await (await fetch('http://127.0.0.1:' + port + '/api/asset/' + j.asset.hash)).arrayBuffer());
  assert.ok(got.equals(fs.readFileSync(blend)), '资产下载字节一致');

  // 能力匹配: 无 blender 的节点领不到 exec 任务
  const noCap = await register(port, 'nocap');
  assert.equal((await api(port, 'GET', '/api/task?worker=' + noCap)).status, 204, '无能力节点领不到 exec 任务');
  const cap = await registerWithExes(port, 'cap', ['blender']);
  const tr = await api(port, 'GET', '/api/task?worker=' + cap);
  assert.equal(tr.status, 200);
  const task = await tr.json();
  assert.equal(task.type, 'exec');
  assert.equal(task.exe, 'blender');
  assert.equal(task.id, 'f0001');
  assert.equal(task.output, 'frame_0001.png');
  assert.equal(task.assets[0].hash, j.asset.hash);
});

test('Blender 帧农场 e2e：fake-blender 渲 3 帧 -> PNG 序列 + manifest', { timeout: 90000 }, async t => {
  const dir = tmpDir('bl-e2e');
  const port = 47300 + (process.pid % 300);
  const fakeBlender = path.join(ROOT, 'tools', 'fake-blender.js');
  const coord = spawn(process.execPath, ['dormgrid.js', 'serve', '-port', String(port), '-dir', dir, '-job', 'blender'], spawnOpts);
  const w1 = spawn(process.execPath, ['dormgrid.js', 'work', '-coordinator', '127.0.0.1:' + port, '-name', 'bl-1',
    '-threads', '0', '-no-polite', '-blender', fakeBlender, '-workdir', path.join(dir, 'workroot')], spawnOpts);
  t.after(() => { for (const p of [coord, w1]) { try { p.kill(); } catch {} } });

  for (let i = 0; i < 40; i++) {
    try { await fetch('http://127.0.0.1:' + port + '/api/status'); break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  const blend = path.join(TMP_ROOT, 'scene.blend');
  const sub = await fetch('http://127.0.0.1:' + port + '/api/job/blender?frames=1-3&fps=12', { method: 'POST', body: fs.readFileSync(blend) });
  assert.equal(sub.status, 200);

  let ok = false;
  for (let i = 0; i < 60; i++) {
    try {
      const s = await (await fetch('http://127.0.0.1:' + port + '/api/status')).json();
      if (s.complete && s.total === 3) { ok = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(ok, '60 秒内完成 3 帧');

  for (const f of ['frame_0001.png', 'frame_0002.png', 'frame_0003.png']) {
    const p = path.join(dir, 'output', 'frames', f);
    assert.ok(fs.existsSync(p), f + ' 存在');
    assert.equal(fs.readFileSync(p).readUInt32BE(0), 0x89504e47, f + ' 是合法 PNG');
  }
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'output', 'manifest.json'), 'utf8'));
  assert.equal(man.fps, 12);
  assert.equal(man.frames.length, 3);
});

test('Blender 真机渲染（本机装了 Blender 才跑）：Suzanne 1 帧', { timeout: 300000 }, async t => {
  // 探测顺序: 环境变量 DORMGRID_BLENDER > 标准安装路径
  let blenderPath = process.env.DORMGRID_BLENDER || null;
  try {
    const base = 'C:\\Program Files\\Blender Foundation';
    for (const v of fs.readdirSync(base)) {
      const p = path.join(base, v, 'blender.exe');
      if (fs.existsSync(p)) blenderPath = p;
    }
  } catch {}
  if (!blenderPath) return t.skip('本机未安装 Blender');

  const dir = tmpDir('bl-real');
  const blendFile = path.join(TMP_ROOT, 'monkey.blend');
  await new Promise((resolve, reject) => {
    require('node:child_process').execFile(
      blenderPath, ['-b', '-P', path.join(ROOT, 'tests', 'fixtures', 'make-cube.py')],
      { timeout: 120000, env: { ...process.env, BLEND_OUT: blendFile } },
      e => (e ? reject(new Error('生成 .blend 失败: ' + e.message)) : resolve())
    );
  });

  const port = 47600 + (process.pid % 150);
  const coord = spawn(process.execPath, ['dormgrid.js', 'serve', '-port', String(port), '-dir', dir, '-job', 'blender'], spawnOpts);
  const w1 = spawn(process.execPath, ['dormgrid.js', 'work', '-coordinator', '127.0.0.1:' + port, '-name', 'bl-real',
    '-threads', '0', '-no-polite', '-blender', blenderPath, '-workdir', path.join(dir, 'workroot')], spawnOpts);
  t.after(() => { for (const p of [coord, w1]) { try { p.kill(); } catch {} } });

  for (let i = 0; i < 40; i++) {
    try { await fetch('http://127.0.0.1:' + port + '/api/status'); break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  const sub = await fetch('http://127.0.0.1:' + port + '/api/job/blender?frames=1-1&fps=24', { method: 'POST', body: fs.readFileSync(blendFile) });
  assert.equal(sub.status, 200);

  let ok = false;
  for (let i = 0; i < 240; i++) {
    try {
      const s = await (await fetch('http://127.0.0.1:' + port + '/api/status')).json();
      if (s.complete && s.total === 1) { ok = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.ok(ok, '240 秒内完成真实渲染');
  const frame = path.join(dir, 'output', 'frames', 'frame_0001.png');
  assert.ok(fs.existsSync(frame), '帧 PNG 落盘');
  const img = decodeOwnPNG(fs.readFileSync(frame));
  assert.equal(img.w, 480);
  assert.equal(img.h, 270);
});
