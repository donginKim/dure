import { BrowserWindow, nativeImage, webContents, type WebContents } from 'electron';
import type { BrowserDriver } from '@core/browserService';
import { IPC_EVENTS } from '@shared/ipc';

interface Page {
  wc: WebContents; logs: string[];
  /** 다른 문서로 넘어간 횟수 */
  navs: number;
  /** 에이전트가 이 페이지를 쓰고 있는 것으로 볼 때까지의 시각. 그 동안 뜨는 알림 창은 저절로 닫는다 */
  agentUntil: number;
}
const MAX_LOGS = 200;
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${what} 이(가) ${Math.round(ms / 1000)}초 안에 끝나지 않았다.`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/**
 * 내장 브라우저의 페이지를 움직이는 쪽. 페이지는 화면의 webview 이고, 화면이 그 webContents 의 id 를 알려 준다 (register).
 * 에이전트가 아직 없는 페이지를 열려 하면 화면에 만들라고 알리고 기다린다.
 */
export function createBrowserHost(): { driver: BrowserDriver; register(workspaceId: string, webContentsId: number): void } {
  const pages = new Map<string, Page>();
  const waiting = new Map<string, (() => void)[]>();

  const alive = (workspaceId: string): Page | undefined => {
    const p = pages.get(workspaceId);
    if (p && !p.wc.isDestroyed()) return p;
    pages.delete(workspaceId);
    return undefined;
  };
  /**
   * 페이지에 Chromium 의 디버깅 프로토콜(CDP)로 명령을 보낸다. 화면 찍기에 쓴다 (capturePage 는 보기에 나와 있지 않은 페이지에서 멈춘다).
   */
  const cdp = async <T = unknown>(wc: WebContents, method: string, params: Record<string, unknown> = {}): Promise<T> => {
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    } catch {
      throw new Error('이 페이지에 개발자 도구가 열려 있어 화면을 찍을 수 없다. 사용자에게 닫아 달라고 하라.');
    }
    return within(wc.debugger.sendCommand(method, params) as Promise<T>, 8000, method);
  };
  const must = (workspaceId: string): Page => {
    const p = alive(workspaceId);
    if (!p) throw new Error('열린 페이지가 없다. 먼저 browser_open 으로 주소를 열어라.');
    return p;
  };

  function register(workspaceId: string, webContentsId: number): void {
    const wc = webContents.fromId(Number(webContentsId));
    // 두레 창 안의 webview 만 받는다. 두레의 화면 자체나 다른 창을 페이지로 등록하게 두지 않는다.
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') throw new Error('브라우저 페이지가 아닙니다.');
    const host = wc.hostWebContents;
    if (!host || !BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents === host)) throw new Error('두레 창의 페이지가 아닙니다.');
    if (pages.get(workspaceId)?.wc === wc) return;
    const page: Page = { wc, logs: [], navs: 0, agentUntil: 0 };
    const note = (line: string): void => { page.logs.push(line); if (page.logs.length > MAX_LOGS) page.logs.splice(0, page.logs.length - MAX_LOGS); };
    // Electron 판에 따라 인자의 모양이 다르다: (event) 하나에 level·message 가 있거나, (event, level, message) 로 온다.
    wc.on('console-message', (...args: unknown[]) => {
      const e = args[0] as { level?: string | number; message?: string; frame?: unknown } | undefined;
      // 페이지 안의 프레임(iframe)이 낸 것은 적지 않는다: 다른 주소의 내용일 수 있다.
      if (e?.frame && e.frame !== wc.mainFrame) return;
      const level = typeof args[1] === 'number' ? args[1] : e?.level;
      const message = typeof args[2] === 'string' ? args[2] : e?.message;
      const kind = level === 3 || level === 'error' ? '오류' : level === 2 || level === 'warning' ? '경고' : null;
      // Electron 이 개발 실행에서 내는 안내는 페이지의 문제가 아니다.
      if (kind && message && !message.startsWith('Electron Security Warning')) note(`[${kind}] ${message.replace(/\s+/g, ' ')}`);
    });
    // 주소는 적지 않는다 (쿼리에 비밀 값이 있을 수 있고, 프레임의 주소는 다른 곳일 수 있다).
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => { if (code !== -3) note(`[불러오지 못함${isMainFrame ? '' : ' (페이지 안의 일부)'}] ${description}`); });
    // 다른 문서로 넘어가면 기록을 비운다: 앞 페이지(사용자가 보던 다른 사이트일 수 있다)의 기록이 에이전트에게 가지 않게 한다.
    wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) { page.navs++; page.logs.length = 0; } });
    // 페이지가 "나가시겠습니까" 로 이동을 막지 못하게 한다.
    wc.on('will-prevent-unload', (event) => event.preventDefault());
    // 에이전트가 누른 버튼이 알림 창(alert, confirm)을 띄우면 페이지가 멈춘다: 에이전트가 쓰는 동안에는 저절로 닫고 기록에 남긴다.
    // 사용자가 직접 쓰는 동안에는 건드리지 않는다.
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      void wc.debugger.sendCommand('Page.enable').catch(() => undefined);
      wc.debugger.on('message', (_e, method, params: { type?: string; message?: string }) => {
        if (method !== 'Page.javascriptDialogOpening' || Date.now() > page.agentUntil) return;
        note(`[알림 창] ${params.type ?? ''}: ${String(params.message ?? '').replace(/\s+/g, ' ').slice(0, 300)} (두레가 닫았다)`);
        void wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: params.type !== 'beforeunload' }).catch(() => undefined);
      });
    } catch { /* 개발자 도구가 열려 있으면 붙지 못한다. 알림 창은 사용자가 닫아야 한다 */ }
    // 배경을 칠하지 않은 페이지는 webview 안에서 투명하다: 찍으면 검은 바탕에 검은 글자가 된다.
    // 보통의 브라우저처럼 흰 바탕을 깔아 둔다. 'user' 로 넣어 페이지가 정한 배경이 있으면 그것이 이긴다.
    const white = (): void => { wc.insertCSS('html { background-color: #fff; }', { cssOrigin: 'user' }).catch(() => undefined); };
    wc.on('dom-ready', white);
    white();
    wc.once('destroyed', () => { if (pages.get(workspaceId)?.wc === wc) pages.delete(workspaceId); });
    // 보기에 나와 있지 않아도 타이머와 화면 갱신을 늦추지 않게 한다.
    try { wc.setBackgroundThrottling(false); } catch { /* 이 판에서는 지원하지 않음 */ }
    pages.set(workspaceId, page);
    for (const done of waiting.get(workspaceId) ?? []) done();
    waiting.delete(workspaceId);
  }

  const driver: BrowserDriver = {
    async ensure(workspaceId, url) {
      if (alive(workspaceId)) return false;
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (!win) throw new Error('두레 창이 닫혀 있어 브라우저를 열 수 없다.');
      const ready = new Promise<void>((resolve) => { waiting.set(workspaceId, [...(waiting.get(workspaceId) ?? []), resolve]); });
      win.webContents.send(IPC_EVENTS.browserOpen, workspaceId, url);
      try {
        await within(ready, 12_000, '브라우저 페이지 준비');
      } finally {
        waiting.delete(workspaceId);
      }
      return true;
    },
    async navigate(workspaceId, url) {
      const page = must(workspaceId);
      page.agentUntil = Date.now() + 25_000;
      const { wc } = page;
      if (wc.getURL() === url && !wc.isLoading()) { wc.reload(); await within(new Promise<void>((r) => wc.once('did-stop-loading', () => r())), 20_000, '페이지 불러오기'); return; }
      try {
        await within(wc.loadURL(url), 20_000, '페이지 불러오기');
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        // 불러오는 도중 다른 곳으로 넘어간 것은 실패가 아니다.
        if (/ERR_ABORTED|\(-3\)/.test(m)) return;
        throw new Error(`열지 못했다: ${m.replace(/\s+/g, ' ').slice(0, 200)}. 개발 서버가 떠 있는지, 주소와 포트가 맞는지 확인하라.`);
      }
    },
    async info(workspaceId) {
      const p = alive(workspaceId);
      return p ? { url: p.wc.getURL(), title: p.wc.getTitle() } : { url: '', title: '' };
    },
    evaluate(workspaceId, expression) {
      const page = must(workspaceId);
      page.agentUntil = Date.now() + 10_000;
      // 사용자 동작으로 치지 않는다 (false): 페이지가 그 틈에 창을 띄우거나 내려받기를 시작하지 못한다.
      return within(page.wc.executeJavaScript(expression, false), 8000, '페이지 읽기');
    },
    async idle(workspaceId) {
      const { wc } = must(workspaceId);
      const end = Date.now() + 10_000;
      while (!wc.isDestroyed() && wc.isLoading() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    },
    async screenshot(workspaceId) {
      const { wc } = must(workspaceId);
      // CDP 로 찍는다: 지금 화면을 새로 그려서 준다. (capturePage 는 가려진 창에서 예전에 그린 화면을 돌려준다, 실측)
      // 창이 가려져도 그리기가 멈추지 않게 앱을 띄울 때 설정해 둔다 (main/index.ts).
      const shot = await cdp<{ data: string }>(wc, 'Page.captureScreenshot', { format: 'jpeg', quality: 80 });
      let image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      if (image.isEmpty()) throw new Error('화면을 찍지 못했다. browser_snapshot 으로 내용을 읽어라.');
      const { width } = image.getSize();
      if (width > 1280) image = image.resize({ width: 1280 });
      return { data: image.toJPEG(70).toString('base64'), mimeType: 'image/jpeg' };
    },
    logs(workspaceId) {
      return [...(alive(workspaceId)?.logs ?? [])];
    },
    frames(workspaceId) {
      const p = alive(workspaceId);
      try { return p ? p.wc.mainFrame.framesInSubtree.map((f) => f.url) : []; } catch { return ['unknown:']; }
    },
    navigations(workspaceId) {
      return alive(workspaceId)?.navs ?? -1;
    },
  };
  return { driver, register };
}
