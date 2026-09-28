// 协调器：任务切分与分发、结果回收、瓦片落盘（断点续算）、自动组图、仪表盘、UDP 发现
//
// 负载类型:
//   mandelbrot（默认）  内置负载：瓦片任务，工作节点进程内渲染，交回 RGBA
//   blender             帧农场：POST /api/job/blender 提交 .blend 工程后生成 exec 帧任务，
//                       工作节点调用本机 blender 渲染并回传 PNG，完成后可自动合成 mp4
//   none                空协调器：等待提交（仅 blender 提交接口）
//
// 编程式用法（测试）:
//   const c = new Coordinator(jobSpec, dir, { staleAfter }); const port = await c.start(0);

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { execFileSync } = require('node:child_process');
const { DEFAULT_JOB, DISCOVER_PORT, DISCOVER_QUERY, DISCOVER_REPLY } = require('./common');
const { encodePNG, boxDownscale } = require('./png');
const { dashboardHTML } = require('./dashboard');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 流式落盘 + 计算 sha256（工程文件可能上百 MB，不能整块进内存）
function streamToFileHash(req, dest) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const ws = fs.createWriteStream(dest);
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 512 * 1024 * 1024) {
        reject(new Error('工程文件超过 512MB'));
        req.destroy();
        return;
      }
      hash.update(c);
      if (!ws.write(c)) req.pause();
    });
    ws.on('drain', () => req.resume());
    req.on('end', () => ws.end());
    req.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', () => resolve({ hash: hash.digest('hex'), size }));
  });
}

const pad4 = n => String(n).padStart(4, '0');
// 任务终结判定: done（成功）或 failed（毒丸，累计失败过多不再重试）
const isFinished = t => t.state === 'done' || t.state === 'failed';

class Coordinator {
  constructor(jobSpec, dir, opts = {}) {
    this.dir = dir;
    this.tilesDir = path.join(dir, 'tiles');
    this.outDir = path.join(dir, 'output');
    this.uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(this.tilesDir, { recursive: true });
    fs.mkdirSync(this.outDir, { recursive: true });
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.workers = new Map();
    this.tasks = [];
    this.assets = new Map(); // hash -> {name, path}
    this.complete = false;
    this.assembling = false;
    this.staleAfter = opts.staleAfter || 15 * 60 * 1000;
    this.server = null;
    this.discoverySock = null;

    if (jobSpec && jobSpec.type === 'none') {
      // 空协调器：等待 POST /api/job/blender 提交
      this.jobKind = 'none';
      this.job = null;
      return;
    }
    if (jobSpec && jobSpec.type === 'exec') {
      this.jobKind = jobSpec.jobKind || 'exec';
      this.buildExecTasks(jobSpec);
      return;
    }
    // 默认: mandelbrot
    this.jobKind = 'mandelbrot';
    this.job = jobSpec || DEFAULT_JOB;
    this.buildTasks();
  }

  // ===== mandelbrot（内置负载） =====

  // 任务切分。瓦片 raw 结果直接落盘，协调器重启时已有的瓦片自动续用。
  buildTasks() {
    const j = this.job;
    const tw = Math.floor(j.width / j.cols);
    const th = Math.floor(j.height / j.rows);
    for (let r = 0; r < j.rows; r++) {
      for (let c = 0; c < j.cols; c++) {
        const base = 'tile_' + String(c).padStart(2, '0') + '_' + String(r).padStart(2, '0');
        const t = {
          id: 't' + String(r * j.cols + c).padStart(2, '0'),
          type: 'tile',
          col: c, row: r, cols: j.cols, rows: j.rows,
          width: tw, height: th,
          xmin: j.xmin + ((j.xmax - j.xmin) * c) / j.cols,
          xmax: j.xmin + ((j.xmax - j.xmin) * (c + 1)) / j.cols,
          ymin: j.ymin + ((j.ymax - j.ymin) * r) / j.rows,
          ymax: j.ymin + ((j.ymax - j.ymin) * (r + 1)) / j.rows,
          maxIter: j.maxIter,
        };
        const file = path.join(this.tilesDir, base + '.png');
        const rawFile = path.join(this.tilesDir, base + '.raw');
        let state = 'pending';
        if (fs.existsSync(rawFile)) {
          state = 'done';
          if (!fs.existsSync(file)) {
            try {
              fs.writeFileSync(file, encodePNG(fs.readFileSync(rawFile), tw, th));
            } catch {}
          }
        }
        this.tasks.push({ task: t, state, file, rawFile, worker: null, assignedAt: 0 });
      }
    }
  }

  // ===== exec 负载（blender 帧农场等命令行任务） =====

  buildExecTasks(spec) {
    // spec: { jobKind:'blender', assets:[{name,path}], tasks:[{id,label,exe,args,output,col,row}], fps, frameStart, staleAfter }
    this.job = spec;
    this.fps = spec.fps || 24;
    this.frameStart = spec.frameStart || 1;
    if (spec.staleAfter) this.staleAfter = spec.staleAfter;
    const assetRefs = (spec.assets || []).map(a => {
      const buf = fs.readFileSync(a.path);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      this.assets.set(hash, { name: a.name, path: a.path });
      return { hash, name: a.name };
    });
    for (const t of spec.tasks) {
      const task = { ...t, type: 'exec', assets: assetRefs };
      const file = path.join(this.tilesDir, 'tile_' + t.id + '.png');
      const state = fs.existsSync(file) ? 'done' : 'pending';
      this.tasks.push({ task, state, file, rawFile: null, worker: null, assignedAt: 0 });
    }
  }

  async handleBlenderSubmit(req, res, u) {
    // 竞态防护: uploading 标记覆盖"流式上传中"的窗口，防止并发提交双份入队
    if (this.tasks.length || this.submitting) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '协调器已有任务或正在接收提交。如需渲染新工程，请重启协调器并用 -job none 启动。' }));
    }
    this.submitting = true;
    try {
      return await this.doBlenderSubmit(req, res, u);
    } finally {
      this.submitting = false;
    }
  }

  async doBlenderSubmit(req, res, u) {
    const frames = u.searchParams.get('frames') || '1-10';
    const fps = parseInt(u.searchParams.get('fps') || '24', 10) || 24;
    const m = /^(\d+)-(\d+)$/.exec(frames);
    if (!m || Number(m[1]) > Number(m[2]) || Number(m[2]) - Number(m[1]) + 1 > 2000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'frames 需为 start-end（起<=止，单次不超过 2000 帧）' }));
    }
    const start = Number(m[1]);
    const end = Number(m[2]);

    const dest = path.join(this.uploadsDir, 'blend-' + Date.now() + '.blend');
    let hash;
    try {
      ({ hash } = await streamToFileHash(req, dest));
    } catch (e) {
      fs.rmSync(dest, { force: true }); // 中断的上传不留半截文件
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
    const name = 'scene.blend';
    this.assets.set(hash, { name, path: dest });
    this.jobKind = 'blender';
    this.fps = fps;
    this.frameStart = start;
    this.staleAfter = 45 * 60 * 1000; // 单帧可能渲很久，超时窗口放大

    let idx = 0;
    for (let n = start; n <= end; n++) {
      // 渲染走 --python-expr 而不是 -o/-f：Blender 5.x 会忽略 -o 前缀（落到其默认临时目录
      // C:\tmp），python-expr 直接把 render.filepath 设为精确目标路径，跨版本可靠
      const task = {
        id: 'f' + pad4(n),
        type: 'exec',
        exe: 'blender',
        label: '帧 ' + n,
        col: idx % 8,
        row: Math.floor(idx / 8),
        args: ['-b', '{asset:' + name + '}', '--python-expr',
          "import bpy;s=bpy.context.scene;s.frame_set(" + n + ");s.render.image_settings.file_format='PNG';s.render.filepath=r'{out}frame_" + pad4(n) + ".png';bpy.ops.render.render(write_still=True)"],
        output: 'frame_' + pad4(n) + '.png',
        assets: [{ hash, name }],
      };
      this.tasks.push({
        task,
        state: fs.existsSync(path.join(this.tilesDir, 'tile_' + task.id + '.png')) ? 'done' : 'pending',
        file: path.join(this.tilesDir, 'tile_' + task.id + '.png'),
        rawFile: null,
        worker: null,
        assignedAt: 0,
      });
      idx++;
    }
    console.log('[提交] Blender 工程: ' + (end - start + 1) + ' 帧 (' + start + '-' + end + '), sha256 ' + hash.slice(0, 12) + '..., fps ' + fps);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: this.tasks.length, asset: { hash, name } }));
  }

  // ===== 通用 =====

  requeueStale() {
    const now = Date.now();
    for (const ts of this.tasks) {
      if (ts.state === 'running' && now - ts.assignedAt > this.staleAfter) {
        console.log('[队列] 任务 ' + ts.task.id + ' 超时未交卷，重新排队');
        ts.state = 'pending';
        ts.worker = null;
      }
    }
  }

  touch(workerID) {
    const w = this.workers.get(workerID);
    if (w) w.lastSeen = new Date().toTimeString().slice(0, 8);
  }

  // 编程式启动，resolve 实际端口（支持 port=0 随机端口）
  start(port, addr = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.route(req, res));
      this.server.once('error', reject);
      this.server.listen(port, addr, () => {
        this.server.removeListener('error', reject);
        this.server.on('error', e => console.error('[协调器] 运行错误: ' + e.message));
        const actual = this.server.address().port;
        this.startDiscovery(actual);
        // 修复点: 上次运行瓦片已齐全但未来得及组图时（如组图前被杀），重启后自动补组图
        if (this.tasks.length && this.tasks.every(isFinished)) this.assemble();
        resolve(actual);
      });
    });
  }

  async stop() {
    if (this.discoverySock) {
      try { this.discoverySock.close(); } catch {}
      this.discoverySock = null;
    }
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise(resolve => s.close(() => resolve()));
  }

  async route(req, res) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname;
      if (p.startsWith('/api/')) {
        // CORS: 允许浏览器访客节点与本地工具直接调用 API
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return res.end();
        }
      }
      if (p === '/api/register' && req.method === 'POST') return await this.handleRegister(req, res);
      if (p === '/api/task' && req.method === 'GET') return this.handleTask(res, u.searchParams.get('worker') || '');
      if (p.startsWith('/api/result/') && req.method === 'POST') {
        return await this.handleResult(req, res, p.slice('/api/result/'.length), u.searchParams.get('worker') || '');
      }
      if (p.startsWith('/api/fail/') && req.method === 'POST') {
        return this.handleFail(res, p.slice('/api/fail/'.length), u.searchParams.get('worker') || '', u.searchParams.get('reason') || '');
      }
      if (p === '/api/job/blender' && req.method === 'POST') return await this.handleBlenderSubmit(req, res, u);
      if (p.startsWith('/api/asset/') && req.method === 'GET') return this.handleAsset(res, p.slice('/api/asset/'.length));
      if (p === '/api/status') return this.handleStatus(res);
      if (p === '/image.png') return this.handleImage(res);
      if (p.startsWith('/tiles/')) return this.serveTile(res, p.slice('/tiles/'.length));
      if (p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(dashboardHTML);
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      console.error('[HTTP] 处理失败:', e.message);
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e.message || e));
    }
  }

  async handleRegister(req, res) {
    const body = await readBody(req, 64 * 1024);
    let info = {};
    try { info = JSON.parse(body.toString('utf8') || '{}'); } catch {}
    const id = crypto.randomBytes(4).toString('hex');
    // 上限约束: 注册信息来自局域网任意机器，防异常大值撑爆内存/日志
    this.workers.set(id, {
      id,
      name: String(info.name || '未命名').slice(0, 40),
      cores: Math.min(4096, Math.max(1, Number(info.cores) || 1)),
      exes: (Array.isArray(info.exes) ? info.exes : []).map(s => String(s).slice(0, 40)).filter(Boolean).slice(0, 8),
      tasksDone: 0,
      lastSeen: new Date().toTimeString().slice(0, 8),
    });
    console.log('[节点] 上线: ' + info.name + ' (' + info.cores + ' 线程' + (this.workers.get(id).exes.length ? ', 能力: ' + this.workers.get(id).exes.join('/') : '') + ') => ' + id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ worker_id: id }));
  }

  handleTask(res, workerID) {
    this.touch(workerID);
    this.requeueStale();
    const w = this.workers.get(workerID);
    const exes = w ? w.exes : [];
    for (const ts of this.tasks) {
      if (ts.state !== 'pending') continue;
      // 能力匹配: exec 任务只派给声明了对应可执行文件的节点
      if (ts.task.exe && !exes.includes(ts.task.exe)) continue;
      ts.state = 'running';
      ts.worker = workerID;
      ts.assignedAt = Date.now();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ts.task));
    }
    res.writeHead(204);
    res.end();
  }

  async handleResult(req, res, taskID, workerID) {
    const ts = this.tasks.find(t => t.task.id === taskID);
    if (!ts || ts.state === 'done') {
      res.writeHead(404);
      return res.end('unknown task');
    }
    if (ts.task.type === 'exec') {
      // 外部进程负载: 回传的是输出文件字节（如一帧 PNG）
      const body = await readBody(req, 256 * 1024 * 1024);
      if (!body.length) {
        res.writeHead(400);
        return res.end('empty payload');
      }
      fs.writeFileSync(ts.file, body);
    } else {
      // mandelbrot 瓦片: 定长 RGBA
      const expect = ts.task.width * ts.task.height * 4;
      const body = await readBody(req, expect + 1024);
      if (body.length !== expect) {
        res.writeHead(400);
        return res.end('size mismatch: ' + body.length + ' != ' + expect);
      }
      fs.writeFileSync(ts.rawFile, body);
      fs.writeFileSync(ts.file, encodePNG(body, ts.task.width, ts.task.height));
    }
    ts.state = 'done';
    const w = this.workers.get(workerID);
    if (w) {
      w.tasksDone++;
      w.lastSeen = new Date().toTimeString().slice(0, 8);
    }
    // 降噪: 不再逐个任务刷"回收"日志，改为四分位进度里程碑
    const doneCount = this.tasks.filter(x => x.state === 'done').length;
    const step = Math.max(1, Math.ceil(this.tasks.length / 4));
    if (doneCount % step === 0 || doneCount === this.tasks.length) {
      console.log('[进度] ' + doneCount + '/' + this.tasks.length + ' 已完成');
    }
    if (this.tasks.every(isFinished)) this.assemble();
    res.writeHead(204);
    res.end();
  }

  handleFail(res, taskID, workerID, reason) {
    const ts = this.tasks.find(t => t.task.id === taskID);
    if (!ts) {
      res.writeHead(404);
      return res.end('unknown task');
    }
    if (ts.state === 'running') {
      ts.fails = (ts.fails || 0) + 1;
      if (ts.fails >= 5) {
        // 毒丸: 确定性故障不应被多节点无限重试（会持续空转拖垮网格），到 cap 即判失败
        ts.state = 'failed';
        ts.worker = null;
        console.log('[失败] 任务 ' + taskID + ' 累计失败 ' + ts.fails + ' 次，标记为失败，不再重试');
      } else {
        ts.state = 'pending';
        ts.worker = null;
        console.log('[失败] 任务 ' + taskID + ' 由 ' + (workerID || '?').slice(0, 16) + ' 上报 (' + String(reason || '未知原因').slice(0, 120) + ')，已重新排队 (' + ts.fails + '/5)');
      }
    }
    res.writeHead(204);
    res.end();
  }

  handleAsset(res, hash) {
    const a = this.assets.get(hash);
    if (!a || !fs.existsSync(a.path)) {
      res.writeHead(404);
      return res.end('unknown asset');
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(a.path).pipe(res);
  }

  handleStatus(res) {
    // 兜底: 瓦片已齐全但 complete 未标记时（例如状态查询先于自动组图），补组图
    if (!this.complete && !this.assembling && this.tasks.length && this.tasks.every(isFinished)) {
      this.assemble();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      job: this.jobKind,
      complete: this.complete,
      done: this.tasks.filter(t => t.state === 'done').length,
      failed: this.tasks.filter(t => t.state === 'failed').length,
      total: this.tasks.length,
      workers: [...this.workers.values()],
      tiles: this.tasks.map(ts => ({
        id: ts.task.id,
        col: ts.task.col || 0,
        row: ts.task.row || 0,
        label: ts.task.label || '',
        state: ts.state,
        file: ts.state === 'done' ? '/tiles/' + path.basename(ts.file) : '',
      })),
      poster: this.jobKind === 'blender' && this.complete && this.tasks.length
        ? '/tiles/' + path.basename(this.tasks[0].file)
        : '',
    }));
  }

  handleImage(res) {
    const p = path.join(this.outDir, 'mandelbrot.png');
    if (!fs.existsSync(p)) {
      res.writeHead(404);
      return res.end('尚未完成组装');
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    fs.createReadStream(p).pipe(res);
  }

  serveTile(res, name) {
    const p = path.join(this.tilesDir, path.basename(name));
    if (!fs.existsSync(p)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    fs.createReadStream(p).pipe(res);
  }

  // 全部任务到齐后：按负载类型组图
  assemble() {
    if (this.assembling || this.complete) return;
    if (this.jobKind === 'blender') return this.assembleExec();
    return this.assembleMandelbrot();
  }

  assembleMandelbrot() {
    this.assembling = true;
    const j = this.job;
    const full = Buffer.alloc(j.width * j.height * 4);
    const tw = Math.floor(j.width / j.cols);
    const th = Math.floor(j.height / j.rows);
    let ok = 0;
    for (const ts of this.tasks) {
      try {
        const raw = fs.readFileSync(ts.rawFile);
        for (let y = 0; y < th; y++) {
          raw.copy(
            full,
            ((ts.task.row * th + y) * j.width + ts.task.col * tw) * 4,
            y * tw * 4,
            (y + 1) * tw * 4
          );
        }
        ok++;
      } catch {
        console.log('[组图] 瓦片缺失: ' + ts.task.id);
      }
    }
    fs.writeFileSync(path.join(this.outDir, 'mandelbrot.png'), encodePNG(full, j.width, j.height));
    const pw = 640;
    const ph = Math.round((j.height * pw) / j.width);
    fs.writeFileSync(
      path.join(this.outDir, 'preview.png'),
      encodePNG(boxDownscale(full, j.width, j.height, pw, ph), pw, ph)
    );
    this.complete = true;
    console.log('[组图] 完成: output/mandelbrot.png (' + ok + '/' + this.tasks.length + ' 瓦片)');
  }

  assembleExec() {
    this.assembling = true;
    const outDir = path.join(this.outDir, 'frames');
    fs.mkdirSync(outDir, { recursive: true });
    const manifest = {
      job: 'blender',
      fps: this.fps,
      frames: [],
    };
    for (const ts of this.tasks) {
      if (ts.state !== 'done') continue; // 失败的任务不参与组图
      try {
        const dst = path.join(outDir, ts.task.output);
        fs.copyFileSync(ts.file, dst);
        manifest.frames.push({ id: ts.task.id, output: ts.task.output, label: ts.task.label });
      } catch {
        console.log('[组图] 帧缺失: ' + ts.task.id);
      }
    }
    fs.writeFileSync(path.join(this.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // 有 ffmpeg 就自动合成 mp4；没有则交付 PNG 序列 + manifest
    let video = null;
    try {
      execFileSync('ffmpeg', [
        '-y', '-framerate', String(this.fps),
        '-start_number', String(this.frameStart),
        '-i', path.join(outDir, 'frame_%04d.png'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        path.join(this.outDir, 'movie.mp4'),
      ], { stdio: 'ignore', timeout: 15 * 60 * 1000 });
      video = 'output/movie.mp4';
    } catch {
      console.log('[组图] 未找到 ffmpeg 或合成失败，仅交付 PNG 序列与 manifest');
    }
    this.complete = true;
    console.log('[组图] Blender 渲染完成: output/frames/ (' + this.tasks.length + ' 帧)' + (video ? ' + ' + video : ''));
  }

  startDiscovery(httpPort) {
    const sock = dgram.createSocket('udp4');
    sock.on('error', e => console.log('[发现] UDP 不可用(不影响 -coordinator 直连): ' + e.message));
    sock.on('message', (msg, rinfo) => {
      if (msg.toString() === DISCOVER_QUERY) {
        sock.send(DISCOVER_REPLY + ' ' + httpPort, rinfo.port, rinfo.address);
      }
    });
    sock.bind(DISCOVER_PORT, () => console.log('[发现] UDP 应答已启动 (端口 ' + DISCOVER_PORT + ')'));
    this.discoverySock = sock;
  }
}

async function run(opts) {
  const jobSpec = opts.job === 'none' || opts.job === 'blender' ? { type: 'none' } : DEFAULT_JOB;
  const c = new Coordinator(jobSpec, opts.dir);
  let actual;
  try {
    actual = await c.start(opts.port, opts.addr);
  } catch (e) {
    console.error('[协调器] 启动失败: ' + e.message);
    process.exit(1);
  }
  const resumed = c.tasks.filter(t => t.state === 'done').length;
  console.log('[协调器] 就绪: ' + c.tasks.length + ' 块任务待分配 (磁盘续用 ' + resumed + ' 块)');
  if (opts.job === 'blender') console.log('[协调器] 等待提交 Blender 工程: node dormgrid.js submit blender -blend 场景.blend -frames 1-240');
  console.log('[协调器] 仪表盘: http://localhost:' + actual);
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address + ':' + actual);
    }
  }
  if (addrs.length) {
    console.log('[协调器] 局域网地址: ' + addrs.join('  ') + '   (副机填任一 IP:端口 即可加入)');
  }
}

module.exports = { run, Coordinator };
