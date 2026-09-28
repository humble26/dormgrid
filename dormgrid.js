#!/usr/bin/env node
// DormGrid —— 宿舍志愿计算网格
// 用法: node dormgrid.js serve|work|submit [参数]
// 双击 exe（无参数）时进入交互菜单（src/menu.js），避免控制台一闪而过

function flag(args, name, def) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return def;
}

function usage() {
  console.log(
    'DormGrid —— 宿舍志愿计算网格\n' +
    '\n用法:\n' +
    '  node dormgrid.js serve [-port 47820] [-dir .] [-job auto|blender]\n' +
    '                                    启动协调器（默认内置 Mandelbrot；blender = 等待提交工程）\n' +
    '  node dormgrid.js work  [-coordinator host:port] [-name 节点名]\n' +
    '                        [-threads 0] [-no-polite] [-blender 路径]\n' +
    '                                    启动工作节点（省略地址则 UDP 广播自动发现）\n' +
    '  node dormgrid.js submit blender -blend 场景.blend -frames 1-120 [-fps 24]\n' +
    '                                    向协调器提交 Blender 渲染任务\n' +
    '\nBlender 农场示例:\n' +
    '  机器A:  node dormgrid.js serve -job blender\n' +
    '  其他机器: node dormgrid.js work -coordinator A机IP:47820\n' +
    '  任意机器: node dormgrid.js submit blender -blend scene.blend -frames 1-120\n' +
    '  完成后:  A机 output/frames/ 帧序列 + manifest.json（有 ffmpeg 则自动合成 movie.mp4）\n' +
    '\n单机演示:\n' +
    '  node dormgrid.js serve\n' +
    '  node dormgrid.js work -coordinator 127.0.0.1:47820 -name 节点1\n' +
    '  node dormgrid.js work -coordinator 127.0.0.1:47820 -name 节点2\n' +
    '  浏览器打开 http://127.0.0.1:47820 查看进度与成图\n'
  );
}

function runServe(args) {
  require('./src/serve').run({
    port: parseInt(flag(args, '-port', '47820'), 10),
    addr: flag(args, '-addr', '0.0.0.0'),
    dir: flag(args, '-dir', '.'),
    job: flag(args, '-job', 'auto'), // auto=内置 Mandelbrot；none/blender=空协调器等待提交
  });
}

function runWork(args) {
  return require('./src/work').run({
    coordinator: flag(args, '-coordinator', ''),
    name: flag(args, '-name', ''),
    threads: flag(args, '-threads', ''),
    polite: !args.includes('-no-polite'),
    blender: flag(args, '-blender', ''),
    workdir: flag(args, '-workdir', ''),
  });
}

function runSubmit(args) {
  const kind = args[0] || '';
  if (kind !== 'blender') {
    console.error('submit 需要 blender 子命令，例如:\n' +
      '  node dormgrid.js submit blender -blend scene.blend -frames 1-120');
    process.exit(2);
  }
  const blend = flag(args, '-blend', '');
  if (!blend) {
    console.error('缺少 -blend 场景.blend');
    process.exit(2);
  }
  return require('./src/submit').run({
    coordinator: flag(args, '-coordinator', ''),
    blend,
    frames: flag(args, '-frames', '1-10'),
    fps: flag(args, '-fps', '24'),
  });
}

const cmd = process.argv[2];
const args = process.argv.slice(3);

if (cmd === 'serve') {
  runServe(args);
} else if (cmd === 'work') {
  runWork(args);
} else if (cmd === 'submit') {
  runSubmit(args);
} else if (cmd) {
  usage();
  process.exit(2);
} else if (process.stdin.isTTY || process.env.DORMGRID_MENU === '1') {
  // 有控制台但无参数（双击场景）→ 交互菜单; DORMGRID_MENU=1 供脚本/测试强制走菜单
  require('./src/menu').run({
    serve: () => runServe(args),
    work: o => runWork(['-coordinator', o.coordinator || '']),
  });
} else {
  usage();
}
