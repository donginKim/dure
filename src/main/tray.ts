import { join } from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from 'electron';
import type { Core } from '@core/index';
import { trayState } from '@core/trayState';
import type { TrayState } from '@shared/types';
import { isAppUrl } from './appUrl';
import { TRAY_ICONS } from './trayIcons';

/** 두레의 큰 창 (빠른 메모나 메뉴 막대의 작은 창이 아닌 것) */
export function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => {
    if (w.isDestroyed()) return false;
    const url = w.webContents.getURL();
    return isAppUrl(url) && !/#(capture|tray)$/.test(url);
  });
}

/** 큰 창을 앞으로 가져온다. */
export function showMain(): BrowserWindow | undefined {
  const w = mainWindow();
  if (!w) return undefined;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
  return w;
}

export function readTray(core: Core): TrayState {
  const doing = core.doing.all();
  return trayState({
    stewardName: core.settings.get().stewardName || '비서',
    attention: () => core.attention.list(),
    projects: () => core.projects.list(),
    workspaces: (id) => core.workspaces.listAll(id),
    doing: (id) => doing[id]?.text ?? '',
    digest: () => core.digest.daily(0),
    grass: (days) => core.paddy.days(null, days),
  });
}

const WIDTH = 360; const HEIGHT = 540;
const MOOD_TIP: Record<TrayState['mood'], string> = { rest: '다 쉬는 중', work: '에이전트가 일하는 중', wait: '내 확인을 기다리는 중' };

/**
 * 메뉴 막대의 아이콘. 두레의 창을 열지 않고도 지금 나를 기다리는 것이 있는지 보인다:
 * 아이콘은 비서의 얼굴이고 (쉬는 중, 일하는 중, 내 확인을 기다림), 기다리는 것이 있으면 그 수를 옆에 적는다.
 * 누르면 아이콘 아래에 작은 창이 뜬다 (확인할 것, 일하는 에이전트, 오늘 한 일, 잔디, 비서에게 한 줄). 다른 곳을 누르면 닫힌다.
 * 설정에서 끌 수 있다. 돌려주는 함수는 정리한다.
 */
export function startTray(core: Core, lockDown: (win: BrowserWindow) => void): () => void {
  let tray: Tray | null = null;
  let panel: BrowserWindow | null = null;
  let closedAt = 0;
  let shown = '';
  const images = new Map<TrayState['mood'], Electron.NativeImage>();
  const image = (mood: TrayState['mood']): Electron.NativeImage => {
    let img = images.get(mood);
    // 36px 그림을 18pt 로: 레티나 화면에서 또렷하다.
    if (!img) { img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICONS[mood], 'base64'), { scaleFactor: 2 }); images.set(mood, img); }
    return img;
  };

  const refresh = (): void => {
    if (!tray || tray.isDestroyed()) return;
    let st: TrayState;
    try { st = readTray(core); } catch { return; }
    const key = `${st.mood}:${st.waitingCount}:${st.agents.length}`;
    if (key === shown) return;
    shown = key;
    tray.setImage(image(st.mood));
    tray.setTitle(st.waitingCount > 0 ? ` ${st.waitingCount}` : '');
    tray.setToolTip(`두레 · ${MOOD_TIP[st.mood]}${st.waitingCount > 0 ? ` (${st.waitingCount}건)` : ''}${st.agents.length ? ` · 에이전트 ${st.agents.length}` : ''}`);
  };
  let timer: NodeJS.Timeout | undefined;
  const soon = (): void => { clearTimeout(timer); timer = setTimeout(refresh, 400); };

  const closePanel = (): void => { if (panel && !panel.isDestroyed()) panel.close(); };
  const toggle = (): void => {
    if (panel && !panel.isDestroyed()) { closePanel(); return; }
    // 아이콘을 눌러 닫은 직후다 (다른 곳을 눌러 닫히는 것이 먼저 일어난다): 다시 열지 않는다.
    if (Date.now() - closedAt < 250) return;
    if (!tray) return;
    const b = tray.getBounds();
    const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - WIDTH / 2, area.x + 8), area.x + area.width - WIDTH - 8));
    const y = Math.round(Math.max(b.y + b.height + 4, area.y + 4));
    const win = new BrowserWindow({
      width: WIDTH, height: Math.min(HEIGHT, area.height - 16), x, y,
      frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#1c1f26', title: '두레',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    panel = win;
    // 전체 화면으로 쓰는 앱 위에서도 뜬다.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on('closed', () => { if (panel === win) panel = null; closedAt = Date.now(); });
    win.on('blur', () => { if (!win.isDestroyed()) win.close(); });
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    lockDown(win);
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#tray`);
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'tray' });
  };

  const menu = (): Menu => Menu.buildFromTemplate([
    { label: '두레 열기', click: () => { showMain(); } },
    { type: 'separator' },
    { label: '메뉴 막대에서 숨기기', click: () => { try { core.settings.update({ menuBar: false }); } catch { /* 설정을 못 바꿔도 그대로 둔다 */ } } },
    { label: '두레 끝내기', click: () => app.quit() },
  ]);

  const apply = (): void => {
    const want = core.settings.get().menuBar;
    if (want && !tray) {
      tray = new Tray(image('rest'));
      tray.on('click', toggle);
      tray.on('right-click', () => { closePanel(); tray?.popUpContextMenu(menu()); });
      shown = '';
      refresh();
    } else if (!want && tray) {
      closePanel();
      tray.destroy(); tray = null;
    }
  };

  const sources = [core.attention, core.service, core.settings, core.doing] as const;
  const onChange = (): void => { apply(); soon(); };
  for (const s of sources) s.on('changed', onChange);
  // 놓친 변화가 있어도 늦지 않게 맞춘다.
  const tick = setInterval(refresh, 30_000);
  apply();

  return () => {
    clearInterval(tick); clearTimeout(timer);
    for (const s of sources) s.off('changed', onChange);
    closePanel();
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };
}

/** 작은 창을 닫는다 (그 안에서 무엇을 눌러 큰 창으로 갈 때). */
export function closeTrayPanels(): void {
  for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed() && /#tray$/.test(w.webContents.getURL())) w.close(); }
}
