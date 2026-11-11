import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { createCore, type Core } from '@core/index';
import { resolveShellEnv } from '@core/shellEnv';
import { registerIpc } from './ipc';

app.setName('dure');
// 개발·검증용: 다른 데이터 폴더를 쓰면 브라우저 프로필도 그쪽으로 옮겨, 띄워 둔 앱과 섞이지 않게 한다.
if (process.env.DURE_DATA_DIR) app.setPath('userData', process.env.DURE_DATA_DIR);

let core: Core | undefined;
let unregisterIpc: (() => void) | undefined;
let quitting = false;

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

async function start(): Promise<void> {
  await app.whenReady();
  try {
    core = await createCore({
      // 개발·검증용으로 다른 폴더를 쓸 수 있게 한다. 평소에는 설정하지 않는다.
      dataDir: process.env.DURE_DATA_DIR || app.getPath('userData'),
      worktreeRoot: process.env.DURE_WORKTREE_ROOT || join(homedir(), 'dure', 'worktrees'),
      repoRoot: process.env.DURE_REPO_ROOT || undefined,
      baseEnv: await resolveShellEnv(),
    });
  } catch (e) {
    dialog.showErrorBox('두레를 시작하지 못했습니다', e instanceof Error ? e.message : String(e));
    app.exit(1);
    return;
  }
  unregisterIpc = registerIpc(core);
  createWindow();
}

void start();

app.on('window-all-closed', () => app.quit());

// 터미널과 에이전트 프로세스가 고아로 남지 않게, 코어를 닫은 뒤에 종료한다.
app.on('before-quit', (event) => {
  if (quitting || !core) return;
  event.preventDefault();
  quitting = true;
  unregisterIpc?.();
  void core.dispose().finally(() => app.quit());
});
