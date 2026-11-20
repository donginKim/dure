import { homedir } from 'node:os';
import { createBonjourDiscovery } from '@core/peers/bonjour';
import { createHttpTransport } from '@core/peers/httpTransport';
import { createBrowserHost } from './browserDriver';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, safeStorage, globalShortcut, screen, shell } from 'electron';
import { isAppUrl } from './appUrl';
import { createCore, type Core } from '@core/index';
import { resolveShellEnv } from '@core/shellEnv';
import { registerIpc } from './ipc';
import { startTray } from './tray';

app.setName('dure');
// 개발·검증용: 다른 데이터 폴더를 쓰면 브라우저 프로필도 그쪽으로 옮겨, 띄워 둔 앱과 섞이지 않게 한다.
if (process.env.DURE_DATA_DIR) app.setPath('userData', process.env.DURE_DATA_DIR);

let core: Core | undefined;
let unregisterIpc: (() => void) | undefined;
let stopTray: (() => void) | undefined;
let quitting = false;

/**
 * 두레의 화면이 든 창은 두레의 화면에만 머문다: 다른 주소로 넘어가지 않고, 새 창을 열지 않는다.
 * (에이전트나 다른 사람이 보낸 글이 화면에 그려지다가 창을 바깥 페이지로 보내면, 그 페이지가 두레의 기능을 쥐게 된다.)
 * 도움말의 고정된 바깥 링크만 보통 브라우저로 연다.
 */
function lockDown(win: BrowserWindow): void {
  const stay = (event: Electron.Event, url: string): void => { if (!isAppUrl(url)) event.preventDefault(); };
  win.webContents.on('will-navigate', stay);
  win.webContents.on('will-redirect', stay);
  win.webContents.on('will-frame-navigate', (event) => { if (!isAppUrl(event.url)) event.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.|docs\.)?claude\.com\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: '두레',
    // 창 위쪽의 제목 줄을 따로 두지 않는다: 앱의 색이 창 끝까지 이어진다 (신호등 단추는 왼쪽 위에 그대로 있다).
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#15171c',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 워크스페이스의 "브라우저" 보기 (개발 서버를 앱 안에서 본다)
      webviewTag: true,
      // 창이 가려져 있어도 화면을 늦추지 않는다: 사용자가 다른 앱을 쓰는 동안에도 에이전트가 브라우저 페이지를 쓰고 화면을 찍는다.
      backgroundThrottling: false,
    },
  });
  // 내장 브라우저는 두레의 권한을 갖지 않는 보통의 웹 페이지다: preload 와 node 를 붙이지 않고, http·https 만 연다.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    // 두레 자신의 저장소(세션)를 쓰지 못하게 한다: 브라우저용 저장소가 아니면 붙이지 않는다.
    if (!String(params.partition ?? '').startsWith('persist:dure-browser')) event.preventDefault();
    delete (params as Record<string, unknown>).allowpopups;
    if (!/^https?:\/\//i.test(params.src ?? '')) event.preventDefault();
  });
  lockDown(win);
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  // 검증용: 창을 최소화한 채로 띄운다 (가려진 창에서의 동작을 확인할 때).
  // 로그인할 때 저절로 켜진 것이면 창을 최소화한 채로 둔다 (일하던 화면을 가리지 않게).
  const atLogin = process.argv.includes('--at-login') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  if (process.env.DURE_START_MINIMIZED || atLogin) win.once('ready-to-show', () => win.minimize());
}

// 두레 창이 다른 창에 가려지거나 최소화돼도 Chromium 이 화면 그리기를 멈추지 않게 한다 (에이전트의 브라우저 조작과 화면 찍기가 그때도 돼야 한다).
// 비용: 가려진 동안에도 화면을 그리므로 전력을 조금 더 쓴다.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const guarded = new WeakSet<Electron.Session>();
// 내장 브라우저의 페이지가 클라이언트 인증서를 요구해도 주지 않는다 (기본 동작은 저장소의 첫 인증서를 저절로 쓴다).
app.on('select-client-certificate', (event, contents, _url, _list, callback) => {
  if (contents?.getType() !== 'webview') return;
  event.preventDefault();
  (callback as (cert?: Electron.Certificate) => void)();
});

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
    // 그 저장소(세션)에 한 번만 건다: 카메라·마이크·위치 같은 권한은 주지 않고, 파일을 내려받지 못하게 한다.
    const session = contents.session;
    if (!guarded.has(session)) {
      guarded.add(session);
      session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      session.on('will-download', (event) => event.preventDefault());
    }
  });
  const browserHost = createBrowserHost();
  try {
    core = await createCore({
      browser: browserHost.driver,
      // 다른 사람의 두레와의 연결: 같은 네트워크에서 HTTP 로 직접 주고받고, Bonjour 로 서로 찾는다. 설정에서 켜야 듣는다.
      peerTransport: createHttpTransport(),
      peerDiscovery: createBonjourDiscovery(),
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
      // 묶인 앱이면 그 묶음의 경로 (…/Dure.app/Contents/MacOS/Dure 에서 세 단계 위). 소스에서 설치한 앱의 업데이트에 쓴다.
      runningApp: app.isPackaged ? join(process.execPath, '..', '..', '..') : null,
      updateReopen: !process.env.DURE_UPDATE_NO_REOPEN,
    });
  } catch (e) {
    dialog.showErrorBox('두레를 시작하지 못했습니다', e instanceof Error ? e.message : String(e));
    app.exit(1);
    return;
  }
  // 로그인할 때 켜기: 설정을 macOS 의 로그인 항목에 맞춘다 (묶인 앱에서만. 개발 중에는 건드리지 않는다).
  if (app.isPackaged && process.platform === 'darwin') {
    const applyLogin = (): void => {
      try {
        const want = core!.settings.get().openAtLogin;
        if (app.getLoginItemSettings().openAtLogin !== want) app.setLoginItemSettings({ openAtLogin: want, args: ['--at-login'] });
      } catch { /* 로그인 항목을 바꾸지 못해도 두레는 돈다 */ }
    };
    applyLogin();
    core.settings.on('changed', applyLogin);
  }
  unregisterIpc = registerIpc(core, browserHost);
  createWindow();
  // 메뉴 막대의 아이콘: 창을 열지 않고도 지금 나를 기다리는 것이 보인다 (설정에서 끈다).
  try { stopTray = startTray(core, lockDown); } catch { /* 아이콘을 못 띄워도 두레는 돈다 */ }
  // 빠른 메모: 어느 앱에서든 단축키로 작은 입력 창을 띄운다. 설정이 바뀌면 다시 건다.
  let bound = '';
  const applyCapture = (): void => {
    const want = core!.settings.get().captureShortcut;
    if (want === bound) return;
    if (bound) { try { globalShortcut.unregister(bound); } catch { /* 이미 풀렸다 */ } }
    bound = '';
    if (!want) return;
    try { if (globalShortcut.register(want, openCapture)) bound = want; } catch { /* 쓸 수 없는 단축키: 걸지 않는다 */ }
  };
  applyCapture();
  core.settings.on('changed', applyCapture);
}

let captureWin: BrowserWindow | null = null;
/** 빠른 메모 입력 창: 화면 위쪽 가운데의 작은 창. 적고 Enter 를 누르거나 다른 곳을 누르면 닫힌다. */
function openCapture(): void {
  if (captureWin && !captureWin.isDestroyed()) { captureWin.show(); captureWin.focus(); return; }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = 560; const height = 132;
  const win = new BrowserWindow({
    width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + area.height * 0.18),
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#1c1f26', title: '빠른 메모',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  captureWin = win;
  win.on('closed', () => { if (captureWin === win) captureWin = null; });
  win.on('blur', () => { if (!win.isDestroyed()) win.close(); });
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  lockDown(win);
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#capture`);
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'capture' });
}

// 같은 데이터 폴더로 두 번 켜지 않는다 (같은 DB 와 작업 폴더를 둘이 함께 쓰면 엉킨다). 이미 켜져 있으면 그 창을 앞으로 가져온다.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && isAppUrl(x.webContents.getURL()) && !/#(capture|tray)$/.test(x.webContents.getURL()));
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
  void start();
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch { /* 끝나는 중 */ } });

// 터미널과 에이전트 프로세스가 고아로 남지 않게, 코어를 닫은 뒤에 종료한다.
app.on('before-quit', (event) => {
  if (quitting || !core) return;
  event.preventDefault();
  quitting = true;
  stopTray?.();
  unregisterIpc?.();
  void core.dispose().finally(() => app.quit());
});
