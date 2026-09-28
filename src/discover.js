// UDP 广播发现协调器（工作节点与提交客户端共用）

const dgram = require('node:dgram');
const { DISCOVER_PORT, DISCOVER_QUERY, DISCOVER_REPLY } = require('./common');

function discoverCoordinator() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let iv = null;
    const finish = (err, addr) => {
      clearTimeout(timer);
      clearInterval(iv);
      try { sock.close(); } catch {}
      err ? reject(err) : resolve(addr);
    };
    const timer = setTimeout(() => finish(new Error('6 秒内未在局域网发现协调器')), 6000);
    sock.on('error', e => finish(e));
    sock.on('message', (msg, rinfo) => {
      const s = msg.toString();
      if (s.startsWith(DISCOVER_REPLY)) {
        const port = parseInt(s.slice(DISCOVER_REPLY.length).trim(), 10);
        if (port > 0) finish(null, rinfo.address + ':' + port);
      }
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      const q = Buffer.from(DISCOVER_QUERY);
      sock.send(q, DISCOVER_PORT, '255.255.255.255');
      iv = setInterval(() => sock.send(q, DISCOVER_PORT, '255.255.255.255'), 700);
    });
  });
}

module.exports = { discoverCoordinator };
