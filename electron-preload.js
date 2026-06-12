const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartMaktabDesktop', {
    silentPrint: (html) => ipcRenderer.invoke('silent-print', html)
});
