// 渲染进程安全桥：只暴露必要的 IPC 方法
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dormgrid', {
  startCoordinator: payload => ipcRenderer.invoke('coord:start', payload),
  stopCoordinator: () => ipcRenderer.invoke('coord:stop'),
  startWorker: payload => ipcRenderer.invoke('worker:start', payload),
  stopWorkers: () => ipcRenderer.invoke('worker:stop'),
  openDashboard: () => ipcRenderer.invoke('dashboard:open'),
  openOutput: () => ipcRenderer.invoke('output:open'),
  onLog: cb => ipcRenderer.on('log', (_e, d) => cb(d)),
  onStatus: cb => ipcRenderer.on('status', (_e, d) => cb(d)),
  onState: cb => ipcRenderer.on('state', (_e, d) => cb(d)),
});
