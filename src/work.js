// 工作节点：发现/注册协调器 -> 领任务 -> 渲染 -> 交卷 -> 循环，直到整图完成
//
// 任务类型:
//   tile  内置 Mandelbrot 瓦片，进程内多线程渲染
//   exec  外部命令行任务（如 blender 帧渲染）：
//         1. 确保资产（.blend 等）已按哈希缓存到本地
//         2. 展开参数占位符 {asset:name} / {out}
//         3. 调用本机对应可执行文件，回传输出文件；失败则上报 /api/fail 重新排队
//
// 性能设置:
//   -threads N     渲染线程数。默认: 克制模式取核心数一半(至少 2)，0 = 全部核心
//   -no-polite     关闭空闲让路（默认开启: 用户在动/用电池时暂停领新任务）
//   -blender PATH  本机 blender 路径（默认自动探测；路径以 .js 结尾时用当前 Node 运行，供测试注入）
//   -workdir DIR   资产缓存与任务目录（默认系统临时目录下 dormgrid-worker/）

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { DISCOVER_PORT, DISCOVER_QUERY, DISCOVER_REPLY } = require('./common');
const { renderTile } = require('./render');
const { startStatusFeed, shouldWork } = require('./polite');
const { discoverCoordinator } = require('./discover');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 探测本机 blender：-blender 显式指定 > 环境变量 > 常见安装路径
function resolveBlender(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.DORMGRID_BLENDER) candidates.push(process.env.DORMGRID_BLENDER);
  try {
    const base = 'C:\\Program Files\\Blender Foundation';
    for (const v of fs.readdirSync(base)) {
      const p = path.join(base, v, 'blender.exe');
      if (fs.existsSync(p)) candidates.push(p);
    }
  } catch {}
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  return null;
}

// 在跑的子进程登记表: 节点退出（正常/异常/Ctrl+C）时终结未完成的渲染子进程，
// 避免 blender 成为孤儿进程继续满负荷占用 CPU
const liveChildren = new Set();
process.on('exit', () => {
  for (const c of liveChildren) { try { c.kill(); } catch {} }
});

function runProcess(cmd, args, cwd) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    liveChildren.add(p);
    let errTail = '';
    let outTail = '';
    p.stderr.on('data', d => {
      errTail = (errTail + d.toString()).slice(-1500);
    });
    p.stdout.on('data', d => {
      outTail = (outTail + d.toString()).slice(-1500);
    });
    p.on('error', e => { liveChildren.delete(p); resolve({ code: -1, err: String(e.message), out: outTail }); });
    p.on('close', code => { liveChildren.delete(p); resolve({ code, err: errTail, out: outTail }); });
  });
}

async function ensureAsset(base, asset, workRoot) {
  // 防路径穿越: 文件名来自协调器下发，只取 basename 且拒绝 '..'
  const name = path.basename(String(asset.name || ''));
  if (!name || name !== String(asset.name || '')) throw new Error('非法资产文件名');
  const dir = path.join(workRoot, 'assets', asset.hash);
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(base + '/api/asset/' + asset.hash);
  if (!res.ok) throw new Error('资产下载失败 HTTP ' + res.status);
  const tmp = file + '.part';
  const hasher = crypto.createHash('sha256');
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (src) {
      for await (const c of src) {
        hasher.update(c);
        yield c;
      }
    },
    fs.createWriteStream(tmp)
  );
  if (hasher.digest('hex') !== asset.hash) {
    fs.rmSync(tmp, { force: true });
    throw new Error('资产校验失败（sha256 不匹配）');
  }
  fs.renameSync(tmp, file);
  return file;
}

async function run(opts) {
  // —— 性能设置解析 ——
  const cores = os.availableParallelism();
  const polite = opts.polite !== false;
  let threads = cores;
  if (opts.threads !== undefined && String(opts.threads).trim() !== '') {
    const n = parseInt(opts.threads, 10);
    if (Number.isFinite(n) && n >= 0) threads = n === 0 ? cores : Math.min(n, cores);
  } else if (polite) {
    threads = Math.max(2, Math.ceil(cores / 2));
  }
  const policy = { polite, idleAfterSec: 120 };
  const workRoot = opts.workdir || path.join(os.tmpdir(), 'dormgrid-worker');

  // —— 能力探测: 本机 blender ——
  const blenderPath = resolveBlender(opts.blender);
  const exes = blenderPath ? ['blender'] : [];
  if (opts.blender && !blenderPath) {
    console.error('指定的 -blender 路径不存在: ' + opts.blender);
    process.exit(1);
  }

  let base;
  if (opts.coordinator) {
    base = 'http://' + opts.coordinator;
  } else {
    console.log('未指定 -coordinator，正在 UDP 广播发现协调器 ...');
    let addr;
    try {
      addr = await discoverCoordinator();
    } catch (e) {
      console.error('自动发现失败:', e.message);
      console.error('提示: 也可以 -coordinator 主机IP:47820 直连');
      process.exit(1);
    }
    base = 'http://' + addr;
  }
  console.log('协调器:', base);

  // 注册（带重试与超时）: 协调器可能还在启动，连接拒绝/短暂挂起都应等待重试而不是静默死亡
  const name = opts.name || os.hostname();
  let id = null;
  for (let attempt = 0; !id; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const reg = await fetch(base + '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cores: threads, exes }),
        signal: ctl.signal,
      }).then(r => r.json());
      id = reg.worker_id;
    } catch (e) {
      if (attempt % 5 === 0) console.log('等待协调器就绪（' + (e.cause && e.cause.code ? e.cause.code : e.message) + '）...');
    } finally {
      clearTimeout(timer);
    }
    if (!id) await sleep(1000);
  }
  console.log('节点 [' + name + '] 已注册 (id=' + id + ')' + (exes.length ? '，能力: ' + exes.join('/') + ' => ' + blenderPath : ''));
  console.log(
    '性能模式: ' + (polite ? '克制' : '全力') + ' — ' + threads + '/' + cores + ' 线程' +
    (polite ? '，用户活动或电池供电时让路' : '')
  );

  const feed = polite ? startStatusFeed(5) : null;
  let done = 0;
  let yielded = 0;
  let consecutiveFails = 0; // 熔断计数: 连续失败达到上限说明存在确定性故障，节点自动停止
  const MAX_CONSECUTIVE_FAILS = 5;
  const start = Date.now();
  let idle = 0;
  for (;;) {
    // —— 礼貌让路: 用户在动/电池时不领新活（正在算的一块会算完） ——
    if (feed && !shouldWork(feed.latest(), policy)) {
      if (yielded++ % 20 === 0) console.log('检测到用户活动或电池供电，让路中 ...'); // 每 60 秒提醒一次，避免刷屏
      await sleep(3000);
      continue;
    }
    yielded = 0;

    let task = null;
    try {
      const res = await fetch(base + '/api/task?worker=' + id);
      if (res.status === 200) task = await res.json();
    } catch (e) {
      console.error('联系协调器失败:', e.message, '—— 2 秒后重试');
      await sleep(2000);
      continue;
    }
    if (!task) {
      try {
        const st = await fetch(base + '/api/status').then(r => r.json());
        if (st.complete && st.total > 0) break;
        if (st.job === 'none' && idle > 0 && idle % 225 === 0) {
          console.log('协调器尚未提交任务，继续等待 ...');
        }
      } catch {}
      if (idle++ % 75 === 0) console.log('暂无任务，等待派发 ...'); // 每 60 秒提醒一次
      await sleep(800);
      continue;
    }
    idle = 0;

    // ===== 外部命令行任务（blender 帧渲染等） =====
    if (task.type === 'exec') {
      const t0 = Date.now();
      const taskDir = path.join(workRoot, 'tasks', task.id);
      let r = null; // 进程结果提到 try 外，失败诊断时可用
      try {
        let lastAsset = null;
        for (const a of task.assets || []) lastAsset = await ensureAsset(base, a, workRoot);
        fs.mkdirSync(taskDir, { recursive: true });
        const argv = task.args.map(s =>
          s
            .replace('{out}', taskDir + path.sep)
            .replace(/\{asset:([^}]+)\}/g, (_, assetName) => {
              const meta = (task.assets || []).find(x => x.name === assetName);
              return meta ? path.join(workRoot, 'assets', meta.hash, path.basename(meta.name)) : s;
            })
        );
        if (task.exe === 'blender') {
          argv.push('-t', String(threads)); // blender 渲染线程跟随性能模式
          // Blender 的 -o 参数会把反斜杠序列当转义吞掉（如 \f、\t、\n），
          // 导致输出被写到错误位置（exit=0 但文件失踪）。路径必须用正斜杠。
          for (let i = 0; i < argv.length; i++) argv[i] = argv[i].replace(/\\/g, '/');
        }
        const cmd = blenderPath.endsWith('.js') ? process.execPath : blenderPath; // .js 注入用于测试
        const finalArgv = blenderPath.endsWith('.js') ? [blenderPath, ...argv] : argv;
        const r = await runProcess(cmd, finalArgv, taskDir);
        const outFile = path.join(taskDir, task.output);
        if (r.code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
          const up = await fetch(base + '/api/result/' + task.id + '?worker=' + id, {
            method: 'POST',
            body: fs.readFileSync(outFile),
          });
          if (!up.ok) throw new Error('交卷 HTTP ' + up.status);
          done++;
          consecutiveFails = 0;
          console.log('[' + name + '] ' + (task.label || task.id) + ' 完成, 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
          fs.rmSync(taskDir, { recursive: true, force: true });
        } else {
          throw new Error('exit=' + r.code + (r.err ? ' ' + r.err.trim().split('\n').pop() : ''));
        }
      } catch (e) {
        consecutiveFails++;
        const hint = (r && r.out) ? (r.out.split('\n').map(s => s.trim()).filter(Boolean).pop() || '') : '';
        console.error('[' + name + '] 任务 ' + task.id + ' 失败(连续第 ' + consecutiveFails + ' 次): ' + e.message + (hint ? ' | blender: ' + hint : ''));
        try {
          await fetch(base + '/api/fail/' + task.id + '?worker=' + id + '&reason=' + encodeURIComponent(e.message.slice(0, 200)), { method: 'POST' });
        } catch {}
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          // 熔断: 连续失败说明是确定性故障（路径/工程/环境问题），
          // 无限重试会持续满负荷空转。节点主动停止，保护宿主机。
          console.error('[' + name + '] 连续失败 ' + consecutiveFails + ' 次，节点自动停止以免空转拖垮电脑。请排查后重新加入网格。');
          break;
        }
        await sleep(Math.min(1000 * Math.pow(2, consecutiveFails - 1), 10000)); // 指数退避
      }
      continue;
    }

    // ===== 内置 Mandelbrot 瓦片 =====
    const t0 = Date.now();
    const pix = await renderTile(task, threads);
    const up = await fetch(base + '/api/result/' + task.id + '?worker=' + id, {
      method: 'POST',
      body: pix,
    });
    if (!up.ok) {
      console.error('交卷失败 (HTTP ' + up.status + ')，重试本块');
      await sleep(500);
      continue;
    }
    done++;
    // 降噪: 秒级小任务（如 Mandelbrot 瓦片）不逐个刷完成日志，只报有分量的事
    // （外部命令行任务如 Blender 帧渲染每帧都报——单帧有实际等待价值）
    if (task.type === 'exec' || Date.now() - t0 >= 3000) {
      console.log('[' + name + '] ' + (task.label ? task.label + ' ' : '瓦片 ' + task.id + ' ') + '完成, 用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    }
  }
  if (feed) feed.stop();
  console.log('节点 [' + name + '] 收工: 共完成 ' + done + ' 个任务, 总用时 ' + ((Date.now() - start) / 1000).toFixed(1) + 's');
}

module.exports = { run };
