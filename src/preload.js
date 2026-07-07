const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teamsEchoAPI', {
  triggerSafetyCheck: (data) => ipcRenderer.send('trigger-safety-check', data),
  safetyResponse: (type) => ipcRenderer.send('safety-response', type),
  stopAutomation: () => ipcRenderer.send('stop-automation'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, msg) => callback(msg));
  },
  onForegroundLost: (callback) => {
    ipcRenderer.on('foreground-lost', (_event, appName) => callback(appName));
  },
  resumeAfterForegroundLost: () => ipcRenderer.send('resume-after-foreground-lost'),
});