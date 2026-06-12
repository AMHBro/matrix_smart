const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { startServer } = require('./server');

let server;

function createWindow(port) {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1000,
        minHeight: 700,
        title: 'Smart Maktab OS',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'electron-preload.js')
        }
    });

    win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(() => {
    ipcMain.handle('silent-print', async (_event, html) => {
        return new Promise((resolve) => {
            const printWindow = new BrowserWindow({
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true
                }
            });

            printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
            printWindow.webContents.once('did-finish-load', () => {
                printWindow.webContents.print({ silent: true, printBackground: true }, (success, errorType) => {
                    printWindow.close();
                    resolve({ success, error: errorType || '' });
                });
            });
        });
    });

    server = startServer(0);
    server.on('listening', () => {
        createWindow(server.address().port);
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && server?.listening) createWindow(server.address().port);
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (server) server.close();
});
