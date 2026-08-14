const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('teamsEchoAPI', {
  triggerSafetyCheck: (data) => ipcRenderer.send('trigger-safety-check', data),
  safetyResponse: (type) => ipcRenderer.send('safety-response', type),
  stopAutomation: () => ipcRenderer.send('stop-automation'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  getRuntimeProfile: () => ipcRenderer.invoke('get-runtime-profile'),
  onStatusUpdate: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('status-update', listener);
    return () => ipcRenderer.removeListener('status-update', listener);
  },
  onSafetyModeInfo: (callback) => {
    const listener = (_event, turboMode) => callback(turboMode);
    ipcRenderer.on('safety-mode-info', listener);
    return () => ipcRenderer.removeListener('safety-mode-info', listener);
  },
});
