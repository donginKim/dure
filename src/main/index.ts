import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: '두레',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
