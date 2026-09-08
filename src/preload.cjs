const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('focusGuard', {
  call: (action, data) => ipcRenderer.invoke('focus:command', action, data),
  subscribe: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('focus:state', listener); return () => ipcRenderer.removeListener('focus:state', listener); }
});
