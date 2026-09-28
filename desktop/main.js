// DormGrid 桌面端主进程：
// - 角色管理：协调器 / 工作节点均以子进程运行（ELECTRON_RUN_AS_NODE 让 electron 复用为纯 Node）
// - 控制窗口（本文件渲染 control.html）+ 仪表盘窗口（直接加载协调器的 Web UI）
// - --e2e：无人值守验证模式，自动起协调器+两节点，渲染完成后截图并写 e2e-result.json 退出

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const E2E = process.argv.includes('--e2e');
const DEFAULT_PORT = 47820;

// 内核与数据目录:
//   开发模式 —— 内核就是仓库根目录，数据也写在仓库根目录（tiles/ output/）
//   打包模式 —— 内核随包携带（resources/kernel），数据写 %APPDATA%/<app>/grid，
//               避免便携版从临时解压目录运行时把数据散落在临时目录里
const kernelDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'kernel') : ROOT);
const workDir = () => (app.isPackaged ? path.join(app.getPath('userData'), 'grid') : ROOT);
const e2eDir = () => path.join(os.tmpdir(), 'dormgrid-e2e');

app.disableHardwareAcceleration();

let controlWin = null;
let dashWin = null;
let coordProc = null;
let coordPort = 0;
const workers = new Map(); // name -> ChildProcess
let statusTimer = null;

function sendLog(channel, text) {
  if (!controlWin || controlWin.isDestroyed()) return;
  // 一次 data 事件可能携带多行，逐行发送让界面按行做重要级别标注；
  // 去重也必须逐行做——子进程日志自带 "[协调器]"/"[节点名]" 前缀，块内每行都可能带
  const short = channel.split(':').pop();
  for (const raw of text.split('\n')) {
    let s = raw.trim();
    if (!s) continue;
    if (s.startsWith('[' + short + ']')) s = s.slice(short.length + 2).trim();
    if (!s) continue;
    controlWin.webContents.send('log', {
      channel,
      text: s,
      t: new Date().toTimeString().slice(0, 8),
    });
  }
}

// 停止子进程用整树击杀: 子进程（工作节点）可能还有 blender 等孙进程在跑，
// 普通 kill 只杀直接子进程，孙进程会变孤儿继续占用 CPU
function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {}
  }
  try { process.kill(pid); } catch {}
}

function nodeChild(args) {
  return spawn(process.execPath, args, {
    cwd: kernelDir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
}

async function fetchStatus(port, timeoutMs = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch('http://127.0.0.1:' + port + '/api/status', { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function broadcastState() {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('state', {
      coordinator: !!coordProc,
      port: coordPort,
      workers: [...workers.keys()],
    });
  }
}

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    const st = coordProc ? await fetchStatus(coordPort) : null;
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send('status', st || { offline: true });
    }
  }, 2000);
}

async function startCoordinator(port, job) {
  if (coordProc) return { ok: false, error: '协调器已在运行' };
  coordPort = Number(port) || DEFAULT_PORT;
  const args = ['dormgrid.js', 'serve', '-port', String(coordPort), '-addr', '0.0.0.0', '-dir', workDir()];
  if (job === 'blender') args.push('-job', 'blender');
  coordProc = nodeChild(args);
  coordProc.stdout.on('data', d => sendLog('协调器', d.toString().trim()));
  coordProc.stderr.on('data', d => sendLog('协调器', '[err] ' + d.toString().trim()));
  coordProc.on('exit', code => {
    sendLog('协调器', '进程退出 (code=' + code + ')');
    coordProc = null;
    broadcastState();
  });
  for (let i = 0; i < 40; i++) {
    if (!coordProc) {
      return { ok: false, error: '协调器启动即退出（端口可能被占用），请查看日志' };
    }
    if (await fetchStatus(coordPort, 800)) {
      startStatusPolling();
      broadcastState();
      return { ok: true, port: coordPort };
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok: false, error: '协调器 10 秒内未就绪，请查看日志' };
}

async function stopCoordinator() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (coordProc) {
    killTree(coordProc.pid);
    coordProc = null;
  }
  if (dashWin && !dashWin.isDestroyed()) {
    try { dashWin.close(); } catch {}
  }
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('status', { offline: true });
  }
  broadcastState();
  return { ok: true };
}

function startWorker(name, addr, perf) {
  if (workers.has(name)) return { ok: false, error: '同名节点已在运行' };
  const args = ['dormgrid.js', 'work', '-name', name];
  if (addr && addr.trim()) args.push('-coordinator', addr.trim());
  if (perf === 'full') args.push('-threads', '0', '-no-polite'); // 默认克制模式
  const p = nodeChild(args);
  workers.set(name, p);
  p.stdout.on('data', d => sendLog('节点:' + name, d.toString().trim()));
  p.stderr.on('data', d => sendLog('节点:' + name, '[err] ' + d.toString().trim()));
  p.on('exit', code => {
    sendLog('节点:' + name, '进程退出 (code=' + code + ')');
    workers.delete(name);
    broadcastState();
  });
  broadcastState();
  return { ok: true };
}

function stopWorkers() {
  for (const [, p] of workers) killTree(p.pid);
  workers.clear();
  broadcastState();
  return { ok: true };
}

function createControl() {
  controlWin = new BrowserWindow({
    width: 1040,
    height: 740,
    backgroundColor: '#0f1420',
    autoHideMenuBar: true,
    title: 'DormGrid 桌面端',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  controlWin.loadFile('control.html');
  controlWin.webContents.on('did-finish-load', broadcastState);
  controlWin.on('closed', () => { controlWin = null; });
}

function openDashboard() {
  if (!coordProc) return { ok: false, error: '协调器未运行' };
  if (dashWin && !dashWin.isDestroyed()) {
    dashWin.focus();
    return { ok: true };
  }
  dashWin = new BrowserWindow({
    width: 1300,
    height: 880,
    backgroundColor: '#0f1420',
    autoHideMenuBar: true,
    title: 'DormGrid 仪表盘',
  });
  dashWin.loadURL('http://127.0.0.1:' + coordPort);
  dashWin.on('closed', () => { dashWin = null; });
  return { ok: true };
}

ipcMain.handle('coord:start', (_e, payload) => startCoordinator(payload && payload.port, payload && payload.job));
ipcMain.handle('coord:stop', () => stopCoordinator());
ipcMain.handle('worker:start', (_e, payload) => startWorker(payload.name, payload.addr, payload.perf));
ipcMain.handle('worker:stop', () => stopWorkers());
ipcMain.handle('dashboard:open', () => openDashboard());
ipcMain.handle('output:open', () => {
  const out = path.join(workDir(), 'output');
  fs.mkdirSync(out, { recursive: true });
  return shell.openPath(out);
});

app.on('before-quit', () => {
  if (statusTimer) clearInterval(statusTimer);
  for (const [, p] of workers) killTree(p.pid);
  if (coordProc) killTree(coordProc.pid);
});

app.on('window-all-closed', () => app.quit());

// —— 无人值守 E2E 模式（开发模式与打包后的 exe 均可运行，用于验证分发产物本身） ——
async function runE2E() {
  const result = { ok: false, steps: [], ts: new Date().toISOString(), mode: app.isPackaged ? 'packaged' : 'dev' };
  const artifacts = e2eDir();
  fs.mkdirSync(artifacts, { recursive: true });
  let failSafe = null;
  const finish = () => {
    if (failSafe) clearTimeout(failSafe);
    fs.writeFileSync(path.join(artifacts, 'e2e-result.json'), JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  };
  const fail = msg => {
    result.error = msg;
    finish();
  };
  failSafe = setTimeout(() => fail('E2E 总超时 (180s)'), 180000);
  try {
    // E2E 必须验证一次全新渲染：清掉上次运行留下的瓦片与成图，防止走断点续算捷径
    fs.rmSync(path.join(workDir(), 'tiles'), { recursive: true, force: true });
    fs.rmSync(path.join(workDir(), 'output'), { recursive: true, force: true });
    result.steps.push({ step: 'clean-workdir', ok: true });

    createControl();
    const r1 = await startCoordinator(DEFAULT_PORT);
    result.steps.push({ step: 'start-coordinator', ok: r1.ok, detail: r1 });
    if (!r1.ok) return fail('协调器启动失败');

    const w1 = startWorker('e2e-node-1', '127.0.0.1:' + DEFAULT_PORT, 'full');
    const w2 = startWorker('e2e-node-2', '127.0.0.1:' + DEFAULT_PORT, 'full');
    result.steps.push({ step: 'start-workers', ok: w1.ok && w2.ok });
    if (!(w1.ok && w2.ok)) return fail('工作节点启动失败');

    let st = null;
    for (let i = 0; i < 120; i++) {
      st = await fetchStatus(DEFAULT_PORT, 2000);
      if (st && st.complete) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    result.steps.push({ step: 'render-complete', ok: !!(st && st.complete), done: st && st.done, total: st && st.total });
    if (!(st && st.complete)) return fail('渲染未在 120 秒内完成');

    const r3 = openDashboard();
    result.steps.push({ step: 'open-dashboard', ok: r3.ok });
    await new Promise(r => setTimeout(r, 5000));

    const shot1 = await controlWin.webContents.capturePage();
    fs.writeFileSync(path.join(artifacts, 'e2e-control.png'), shot1.toPNG());
    const shot2 = await dashWin.webContents.capturePage();
    fs.writeFileSync(path.join(artifacts, 'e2e-dashboard.png'), shot2.toPNG());
    result.steps.push({ step: 'screenshots', ok: true });

    const png = fs.readFileSync(path.join(workDir(), 'output', 'mandelbrot.png'));
    result.steps.push({
      step: 'output-png',
      ok: png.length > 0 && png.readUInt32BE(0) === 0x89504e47,
      bytes: png.length,
    });

    result.ok = result.steps.every(s => s.ok);
    stopWorkers();
    await stopCoordinator();
    finish();
  } catch (e) {
    result.error = String((e && e.stack) || e);
    finish();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (E2E) runE2E();
    else createControl();
  });
}
