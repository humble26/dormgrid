// 交互菜单：双击 exe / 无参数启动时使用。
// 控制台程序双击后跑完（或报错）窗口会立刻关闭，看起来像"闪退"，
// 所以这里必须在启动、出错、收工三个时机都把窗口留住。
//
// 不用 rl.question() 逐个等待：管道快速输入时 line 事件可能在下一个
// question 注册前就触发导致丢行，这里自己缓冲所有行再逐条消费。

const readline = require('node:readline');

// 行缓冲读取器: ask() 返回一行文本，stdin 关闭(EOF)后返回 null
function makeReader() {
  const pending = [];
  let waiting = null;
  let closed = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const settle = l => {
    if (waiting) { const w = waiting; waiting = null; w(l); } else pending.push(l);
  };
  rl.on('line', settle);
  rl.on('close', () => { closed = true; settle(null); });
  return {
    ask(prompt) {
      process.stdout.write(prompt);
      if (pending.length) return Promise.resolve(pending.shift());
      if (closed) return Promise.resolve(null);
      return new Promise(resolve => { waiting = resolve; });
    },
    close: () => rl.close(),
  };
}

// 等一次回车再退出；stdin 已关闭（管道/EOF）时直接退，不卡死。
// Windows 下 readline 句柄关闭中立刻 process.exit 会触发 libuv 断言，延迟退出绕开。
function pauseExit(code) {
  const r = makeReader();
  r.ask('\n按回车键退出 ...').then(() => setTimeout(() => process.exit(code), 100));
}

// 运行期兜底：报错后停留窗口让用户看到原因，而不是一闪而过
function installCrashGuard() {
  const onErr = e => {
    console.error('\n[出错] ' + (e && e.stack ? e.stack : e));
    pauseExit(1);
  };
  process.on('uncaughtException', onErr);
  process.on('unhandledRejection', onErr);
}

async function run(opts) {
  installCrashGuard();
  const io = makeReader();
  console.log('DormGrid —— 宿舍志愿计算网格\n');
  console.log('  1) 启动协调器   本机当主控，浏览器打开仪表盘看进度与成图');
  console.log('  2) 加入集群     本机当工作节点，算完自动收工');
  console.log('');
  let choice = ((await io.ask('请选择 [1=协调器 2=工作节点，直接回车=1] ')) || '').trim().toLowerCase() || '1';
  while (choice !== '1' && choice !== '2' && choice !== 'q') {
    choice = ((await io.ask('没看懂，请输入 1、2 或 q: ')) || '').trim().toLowerCase() || '1';
  }
  if (choice === 'q') {
    io.close();
    return;
  }
  if (choice === '1') {
    io.close();
    console.log('\n(浏览器打开下方仪表盘地址查看进度; 停止: 直接关掉本窗口或 Ctrl+C)\n');
    opts.serve({});
    return;
  }
  const addr = ((await io.ask('协调器地址 host:port（直接回车 = 局域网自动发现）')) || '').trim();
  io.close();
  console.log('');
  try {
    await opts.work({ coordinator: addr });
  } catch (e) {
    console.error('[出错] ' + (e && e.message ? e.message : e));
  }
  pauseExit(0); // 收工后停留窗口展示汇总
}

module.exports = { run };
