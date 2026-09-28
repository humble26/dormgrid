// DormGrid 协议常量与默认任务定义（协调器与工作节点共用）

// 内置负载：Mandelbrot 分布式渲染。
// 宽高比与复平面范围保持 16:9，保证像素是正方形。
const DEFAULT_JOB = {
  width: 2560,
  height: 1440,
  cols: 8,
  rows: 4,
  xmin: -2.1,
  xmax: 1.1,
  ymin: -0.9,
  ymax: 0.9,
  maxIter: 1500,
};

const DEFAULT_HTTP_PORT = 47820;
const DISCOVER_PORT = 47823;
const DISCOVER_QUERY = 'DORMGRID_DISCOVER_V1';
const DISCOVER_REPLY = 'DORMGRID_HERE_V1';

module.exports = {
  DEFAULT_JOB,
  DEFAULT_HTTP_PORT,
  DISCOVER_PORT,
  DISCOVER_QUERY,
  DISCOVER_REPLY,
};
