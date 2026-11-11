'use strict'
// 预加载脚本：向渲染进程暴露受控 API

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  listPlatforms: () => ipcRenderer.invoke('platforms:list'),
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  detect: () => ipcRenderer.invoke('accounts:detect'),
  importAccounts: (platform) => ipcRenderer.invoke('accounts:import', platform),
  login: (platform) => ipcRenderer.invoke('accounts:login', platform),
  switchAccount: (id, opts) => ipcRenderer.invoke('accounts:switch', id, opts),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  batchAccounts: (payload) => ipcRenderer.invoke('accounts:batch', payload),
  renameAccount: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
  refreshQuota: (id) => ipcRenderer.invoke('quota:refresh', id),
  refreshAllQuota: () => ipcRenderer.invoke('quota:refreshAll'),
  checkin: (id) => ipcRenderer.invoke('checkin:one', id),
  checkinAll: (platform) => ipcRenderer.invoke('checkin:all', platform),
  refreshCheckinStatus: () => ipcRenderer.invoke('checkin:status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSchedulerEvent: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('scheduler:event', listener)
    return () => ipcRenderer.removeListener('scheduler:event', listener)
  },
  listSessions: (platform) => ipcRenderer.invoke('sessions:list', platform),
  exportSessions: (p) => ipcRenderer.invoke('sessions:export', p),
  importSessions: (p) => ipcRenderer.invoke('sessions:import', p),
  getVaultSettings: () => ipcRenderer.invoke('vault:settings:get'),
  setVaultSettings: (p) => ipcRenderer.invoke('vault:settings:set', p),
  listAgents: () => ipcRenderer.invoke('agents:list'),
  exportAgents: (p) => ipcRenderer.invoke('agents:export', p),
  importAgents: (p) => ipcRenderer.invoke('agents:import', p),
  getShortcut: () => ipcRenderer.invoke('shortcut:get'),
  setShortcut: (p) => ipcRenderer.invoke('shortcut:set', p),
  removeShortcut: (p) => ipcRenderer.invoke('shortcut:remove', p),
  pickFile: (p) => ipcRenderer.invoke('dialog:file', p)
})
