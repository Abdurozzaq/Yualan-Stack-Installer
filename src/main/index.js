const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const url = require('url');
const Store = require('electron-store');
const { ensureDirSync } = require('fs-extra');
const installer = require('./installer');

const store = new Store({ name: 'yualan-config' });

let mainWindow;
let lastOptions = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 720,
    minWidth: 1366,
    minHeight: 720,
    maxWidth: 1366,
    maxHeight: 720,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
    title: 'Yualan Stack Installer',
    icon: path.join(__dirname, '../../assets/icon.png'),
  });

  const ui = url.format({
    pathname: path.join(__dirname, '../renderer/index.html'),
    protocol: 'file:',
    slashes: true,
  });
  mainWindow.loadURL(ui);
}

app.whenReady().then(() => {
  ensureDirSync(path.join(app.getPath('userData')));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC
ipcMain.handle('dialog:choose-install-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('installer:read-env', async (_evt, installDir) => {
  if (!installDir) return {};
  try { return await installer.readExistingEnv(installDir); } catch { return {}; }
});

ipcMain.handle('installer:check-installation', async (_evt, installDir) => {
  if (!installDir) return false;
  try { return await installer.checkExistingInstallation(installDir); } catch { return false; }
});

ipcMain.handle('dialog:choose-file', async (_evt, { filters }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'Zip', extensions: ['zip'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

// Legacy: installer:install performs setup + app install
ipcMain.handle('installer:install', async (_evt, options) => {
  store.set('installOptions', options);
  lastOptions = options;
  return installer.install(options, (evt) => {
    mainWindow.webContents.send('installer:event', evt);
  });
});

// Legacy: installer:start -> start services
ipcMain.handle('installer:start', async (_evt) => installer.start((evt) => mainWindow.webContents.send('installer:event', evt), lastOptions || store.get('installOptions')));

// New API: setup server (stack only)
ipcMain.handle('installer:setup-server', async (_evt, options) => {
  store.set('installOptions', { ...(lastOptions || {}), ...(options || {}) });
  lastOptions = store.get('installOptions');
  return installer.setupServer(lastOptions, (evt) => mainWindow.webContents.send('installer:event', evt));
});

// New API: install application (can be versioned)
ipcMain.handle('installer:install-app', async (_evt, options) => {
  const opts = { ...(lastOptions || store.get('installOptions') || {}), ...(options || {}) };
  store.set('installOptions', opts);
  lastOptions = opts;
  return installer.installApp(opts, (evt) => mainWindow.webContents.send('installer:event', evt));
});

// New API: start only services (postgres + apache)
ipcMain.handle('installer:start-services', async (_evt, options) => {
  const opts = { ...(lastOptions || store.get('installOptions') || {}), ...(options || {}) };
  lastOptions = opts;
  return installer.startServices((evt) => mainWindow.webContents.send('installer:event', evt), opts);
});
ipcMain.handle('installer:stop', async (_evt, options) => {
  const opts = { ...(lastOptions || store.get('installOptions') || {}), ...(options || {}) };
  return installer.stop(opts);
});
ipcMain.handle('installer:cleanup-ports', async () => {
  return installer.cleanupPorts();
});

ipcMain.handle('installer:get-activity-logs', async (_evt, activity) => {
  return installer.getActivityLogs(activity);
});

ipcMain.handle('installer:clear-activity-logs', async (_evt, activity) => {
  return installer.clearActivityLogs(activity);
});
ipcMain.handle('installer:open', async (_evt, url) => {
  const appUrl = url || store.get('appUrl') || 'http://localhost:8080';
  await shell.openExternal(appUrl);
  return true;
});
ipcMain.handle('installer:reset-db', async () => installer.resetDb(lastOptions || store.get('installOptions'), (evt) => mainWindow.webContents.send('installer:event', evt)));
