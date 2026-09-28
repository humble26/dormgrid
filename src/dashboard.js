// 仪表盘页面：浅色"仪器纸面"主题，瓦片拼图为主视觉，轮询 /api/status，无构建步骤

const dashboardHTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>DormGrid 仪表盘</title>
<style>
  :root {
    --paper:#F4F4F1; --card:#FFFFFF; --ink:#191C1F; --ink-2:#5C6470; --ink-3:#9AA1AB;
    --line:#E4E4DF; --accent:#2E5AAC; --ok:#2E7D4F;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--paper); color:var(--ink);
    font:14px/1.5 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  }
  ::selection { background:#D7E0F2; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .wrap { max-width:1000px; margin:0 auto; padding:26px 28px 48px; }

  header {
    display:flex; justify-content:space-between; align-items:flex-end;
    padding-bottom:16px; border-bottom:1px solid var(--line);
  }
  .wordmark { font-size:17px; font-weight:650; letter-spacing:.2px; }
  .sub { font-size:12px; color:var(--ink-3); margin-top:3px; }
  .figure { text-align:right; font-variant-numeric:tabular-nums; }
  .figure .nums { font-size:30px; font-weight:600; letter-spacing:-.5px; line-height:1.1; }
  .figure .nums .of { color:var(--ink-3); font-weight:400; font-size:20px; margin:0 4px; }
  .figure .nums .tot { color:var(--ink-2); font-size:20px; }
  .figure .nums .chip { color:var(--ok); font-size:13px; font-weight:400; margin-left:10px; }
  .figure .label { font-size:12px; color:var(--ink-3); margin-top:2px; }

  .bar-wrap { height:4px; background:var(--line); border-radius:2px; margin:18px 0 34px; overflow:hidden; }
  .bar { height:100%; width:0; background:var(--accent); transition:width .4s; }

  h2 { font-size:13px; font-weight:600; color:var(--ink); margin:0 0 12px; }
  section + section { margin-top:36px; }

  .grid { display:grid; gap:3px; }
  .tile { aspect-ratio:8/9; background:var(--card); border:1px solid var(--line); border-radius:6px;
          overflow:hidden; position:relative; }
  .tile img { width:100%; height:100%; object-fit:cover; display:block; }
  .tile.pending::after {
    content:"待领取"; color:var(--ink-3); font-size:11px;
    position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  }
  .tile.running { border-color:var(--accent); }
  .tile.running::after {
    content:"计算中"; color:var(--accent); font-size:11px;
    position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    animation:breath 1.6s ease-in-out infinite;
  }
  .tile.failed { border-color:#B03A2E; }
  .tile.failed::after {
    content:"失败"; color:#B03A2E; font-size:11px;
    position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  }
  @keyframes breath { 0%,100% { opacity:.35; } 50% { opacity:1; } }
  @media (prefers-reduced-motion: reduce) {
    .tile.running::after { animation:none; }
    .bar { transition:none; }
  }

  table { border-collapse:collapse; width:100%; font-size:13px; font-variant-numeric:tabular-nums; }
  td,th { padding:9px 14px 9px 0; border-bottom:1px solid var(--line); text-align:left; }
  th { color:var(--ink-3); font-weight:400; font-size:12px; }
  .muted { color:var(--ink-3); }

  .final-frame { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px; }
  .final-frame img { width:100%; display:block; border-radius:6px; }
  .caption { font-size:12px; color:var(--ink-3); margin-top:8px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <div class="wordmark">DormGrid</div>
      <div class="sub">Mandelbrot 分布式渲染</div>
    </div>
    <div class="figure">
      <div class="nums"><span id="done">0</span><span class="of">/</span><span class="tot" id="total">—</span><span class="chip" id="chip"></span></div>
      <div class="label">瓦片完成，在线节点 <span id="nodes">0</span> 个</div>
    </div>
  </header>

  <div class="bar-wrap"><div class="bar" id="bar"></div></div>

  <section class="mosaic">
    <h2>瓦片分工</h2>
    <div class="grid" id="tiles"></div>
  </section>

  <section>
    <h2>工作节点</h2>
    <table>
      <thead><tr><th>节点</th><th>线程</th><th>完成瓦片</th><th>最近心跳</th></tr></thead>
      <tbody id="workers"></tbody>
    </table>
  </section>

  <section id="final"></section>
</div>

<script>
// HTML 转义。节点名由 /api/register 直接来自局域网内任意主机，
// 拼进 innerHTML 前必须转义（& 必须最先替换，否则会二次转义已生成的实体）。
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// 状态值只允许出现在 class 名里，白名单化避免空格/引号破坏 class 属性
function safeState(s){
  return ['pending', 'running', 'done', 'failed'].indexOf(s) >= 0 ? s : 'pending';
}
function refresh(){
  fetch('/api/status').then(function(r){ return r.json(); }).then(function(s){
    document.getElementById('done').textContent = s.done;
    document.getElementById('total').textContent = s.total;
    document.getElementById('nodes').textContent = (s.workers || []).length;
    document.getElementById('chip').textContent = s.complete ? '已完成' : '';
    document.getElementById('bar').style.width = (s.total ? (100 * s.done / s.total) : 0) + '%';

    var tb = document.getElementById('workers');
    tb.innerHTML = '';
    var ws = s.workers || [];
    if (!ws.length) {
      tb.innerHTML = '<tr><td colspan="4" class="muted">还没有节点加入。在另一台机器上运行 node dormgrid.js work 即可加入。</td></tr>';
    }
    ws.forEach(function(w){
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(w.name) + '</td><td>' + w.cores + '</td><td>' + w.tasksDone + '</td><td>' + esc(w.lastSeen) + '</td>';
      tb.appendChild(tr);
    });

    var g = document.getElementById('tiles');
    var tiles = s.tiles || [];
    var cols = tiles.reduce(function(m, t){ return Math.max(m, t.col + 1); }, 4);
    g.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)';
    g.innerHTML = '';
    tiles.forEach(function(t){
      var d = document.createElement('div');
      d.className = 'tile ' + safeState(t.state);
      if (t.state === 'done' && t.file) d.innerHTML = '<img src="' + esc(t.file) + '" alt="">';
      g.appendChild(d);
    });

    document.getElementById('final').innerHTML = (s.complete && s.job !== 'blender')
      ? '<h2>成图</h2><div class="final-frame"><img src="/image.png" alt="最终成图"></div>' +
        '<div class="caption">由 ' + esc(s.total) + ' 块瓦片拼合，图像文件位于协调器 output 目录。</div>'
      : '';
  }).catch(function(){});
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

module.exports = { dashboardHTML };
