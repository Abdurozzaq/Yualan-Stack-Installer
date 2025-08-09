const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chooseInstallDir: () => ipcRenderer.invoke('dialog:choose-install-dir'),
  chooseFile: (opts) => ipcRenderer.invoke('dialog:choose-file', opts || {}),
  install: (options) => ipcRenderer.invoke('installer:install', options),
  setupServer: (options) => ipcRenderer.invoke('installer:setup-server', options || {}),
  installApp: (options) => ipcRenderer.invoke('installer:install-app', options || {}),
  startServices: (options) => ipcRenderer.invoke('installer:start-services', options || {}),
  start: () => ipcRenderer.invoke('installer:start'),
  stop: (options) => ipcRenderer.invoke('installer:stop', options || {}),
  cleanupPorts: () => ipcRenderer.invoke('installer:cleanup-ports'),
  openApp: (url) => ipcRenderer.invoke('installer:open', url),
  resetDb: () => ipcRenderer.invoke('installer:reset-db'),
  readEnv: (installDir) => ipcRenderer.invoke('installer:read-env', installDir),
  checkInstallation: (installDir) => ipcRenderer.invoke('installer:check-installation', installDir),
  onInstallerEvent: (cb) => ipcRenderer.on('installer:event', (_e, data) => cb(data)),
});
