// main/preload.js
// Gives the pages one small, safe tool: asking the desktop window to take focus back
// (used after alert/confirm dialogs, which can otherwise leave text boxes frozen on Windows).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncbeeShell', {
  refocus: () => ipcRenderer.send('syncbee:refocus')
});