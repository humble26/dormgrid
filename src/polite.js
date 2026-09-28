// 性能礼貌策略：
//   - startStatusFeed: 常驻一个 PowerShell 小进程，每几秒输出一行 {idle, ac} JSON
//     （idle = 距上次键鼠输入的秒数；ac = Online/Offline/Unknown 电源状态）
//   - shouldWork: 纯策略函数，决定此刻是否该领新任务
//
// 设计取向：探测不可用时一律放行（fail-open），礼貌模式只影响"领新任务"，
// 正在算的一块瓦片会算完再让路（单块耗时在秒级，无需中途打断）。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// PowerShell 探测脚本（运行时写入临时目录，单文件 exe 场景同样可用）。
// 注意: C# 部分必须保持纯 ASCII，且文件需带 UTF-8 BOM——
// PowerShell 5.1 对无 BOM 文件按 ANSI/GBK 解码，中文注释会被错误配对吞掉代码。
const PS_SCRIPT = `param([int]$Loop = 0)
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class IdleInfo {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")]
  static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint IdleSeconds() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) return 999999u; // fail-open: treat as idle
    return unchecked((uint)Environment.TickCount - li.dwTime) / 1000u;
  }
}
'@
function Read-Status {
  $idle = [IdleInfo]::IdleSeconds()
  $ac = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus.ToString()
  '{{"idle":{0},"ac":"{1}"}}' -f $idle, $ac
}
if ($Loop -gt 0) {
  while ($true) { Write-Output (Read-Status); Start-Sleep -Seconds $Loop }
} else {
  Write-Output (Read-Status)
}`;

function ensureScript() {
  try {
    const p = path.join(os.tmpdir(), 'dormgrid-idle-status.ps1');
    // 带 BOM 写入: 无 BOM 时 Windows PowerShell 5.1 会按 ANSI/GBK 解码
    fs.writeFileSync(p, '\ufeff' + PS_SCRIPT);
    return p;
  } catch {
    return null;
  }
}

function startStatusFeed(intervalSec = 5) {
  if (process.platform !== 'win32') {
    return { latest: () => null, stop: () => {} };
  }
  const script = ensureScript();
  if (!script) return { latest: () => null, stop: () => {} };
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Loop', String(intervalSec)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  let latest = null;
  let buf = '';
  ps.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try { latest = JSON.parse(line); } catch {}
    }
  });
  ps.on('error', () => { latest = null; });
  return {
    latest: () => latest,
    stop: () => { try { ps.kill(); } catch {} },
  };
}

// status: {idle?: number, ac?: string} | null
function shouldWork(status, opts) {
  if (!opts || !opts.polite) return true;
  if (!status) return true; // 探测不可用 → 不设障
  if (typeof status.idle === 'number' && status.idle < (opts.idleAfterSec || 120)) return false;
  if (status.ac === 'Offline') return false; // 电池供电
  return true;
}

module.exports = { startStatusFeed, shouldWork, ensureScript, PS_SCRIPT };
