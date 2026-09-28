// Blender 输出路径行为调试：分别用反斜杠与正斜杠 -o 各渲一帧，打印 Saved 行与产物位置
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BLENDER = process.env.BLENDER || 'E:\\blender\\blender.exe';
const TMP = require('node:os').tmpdir();
const BLEND = path.join(TMP, 'blfarm', 'monkey.blend');
const BASE = path.join(TMP, 'blfarm2', 'dbg');

function run(label, outArg) {
  return new Promise(resolve => {
    fs.mkdirSync(path.dirname(outArg.replace(/####.*$/, '')), { recursive: true });
    const p = spawn(BLENDER, ['-b', BLEND, '-f', '1', '-o', outArg, '-F', 'PNG', '-t', '4'], { windowsHide: true });
    let all = '';
    p.stdout.on('data', d => { all += d; });
    p.stderr.on('data', d => { all += d; });
    p.on('close', code => {
      const lines = all.split('\n').map(s => s.trim()).filter(l => /saved|error|warning/i.test(l));
      console.log('--- ' + label + ' (exit=' + code + ') ---');
      console.log('  -o 参数: ' + outArg);
      console.log(lines.slice(-3).map(l => '  ' + l).join('\n') || '  (无 Saved/Error 行)');
      resolve();
    });
  });
}

(async () => {
  await run('反斜杠', path.join(BASE, 'back', 'frame_####'));
  await run('正斜杠', BASE + '/fwd/frame_####');
  for (const dir of ['back', 'fwd']) {
    const p = path.join(BASE, dir);
    console.log(dir + '/: ' + (fs.existsSync(p) ? fs.readdirSync(p).join(', ') : '(目录不存在)'));
  }
  if (fs.existsSync('C:/tmp')) console.log('C:/tmp: ' + fs.readdirSync('C:/tmp').join(', '));
})();
