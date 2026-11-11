import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, safeStorage } from 'electron';
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
      // 워크스페이스의 "브라우저" 보기 (개발 서버를 앱 안에서 본다)
      webviewTag: true,
    },
  });
  // 내장 브라우저는 두레의 권한을 갖지 않는 보통의 웹 페이지다: preload 와 node 를 붙이지 않고, http·https 만 연다.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^https?:\/\//i.test(params.src ?? '')) event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function start(): Promise<void> {
  await app.whenReady();
  // 내장 브라우저 안의 페이지: 새 창을 열지 못하게 하고(같은 보기에서 열린다), http·https 밖으로 나가지 못하게 한다.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void contents.loadURL(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault(); });
    // 카메라, 마이크, 위치 같은 권한은 주지 않는다.
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  });
  try {
    core = await createCore({
      // 개발·검증용으로 다른 폴더를 쓸 수 있게 한다. 평소에는 설정하지 않는다.
      dataDir: process.env.DURE_DATA_DIR || app.getPath('userData'),
      worktreeRoot: process.env.DURE_WORKTREE_ROOT || join(homedir(), 'dure', 'worktrees'),
      repoRoot: process.env.DURE_REPO_ROOT || undefined,
      // DB 비밀번호는 macOS 키체인의 열쇠로 암호화해 둔다. 쓸 수 없는 환경이면 저장을 거절한다 (평문으로 두지 않는다).
      secrets: {
        encrypt: (plain) => {
          if (!safeStorage.isEncryptionAvailable()) throw new Error('이 환경에서는 비밀번호를 안전하게 저장할 수 없습니다 (키체인을 쓸 수 없음).');
          return safeStorage.encryptString(plain).toString('base64');
        },
        decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
      },
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
