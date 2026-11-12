import { BrowserWindow, nativeImage, webContents, type WebContents } from 'electron';
import type { BrowserDriver } from '@core/browserService';
import { IPC_EVENTS } from '@shared/ipc';

interface Page { wc: WebContents; logs: string[] }
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
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
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
    const page: Page = { wc, logs: [] };
    const note = (line: string): void => { page.logs.push(line); if (page.logs.length > MAX_LOGS) page.logs.splice(0, page.logs.length - MAX_LOGS); };
    // Electron 판에 따라 인자의 모양이 다르다: (event) 하나에 level·message 가 있거나, (event, level, message) 로 온다.
    wc.on('console-message', (...args: unknown[]) => {
      const e = args[0] as { level?: string | number; message?: string } | undefined;
      const level = typeof args[1] === 'number' ? args[1] : e?.level;
      const message = typeof args[2] === 'string' ? args[2] : e?.message;
      const kind = level === 3 || level === 'error' ? '오류' : level === 2 || level === 'warning' ? '경고' : null;
      // Electron 이 개발 실행에서 내는 안내는 페이지의 문제가 아니다.
      if (kind && message && !message.startsWith('Electron Security Warning')) note(`[${kind}] ${message.replace(/\s+/g, ' ')}`);
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => { if (code !== -3) note(`[불러오지 못함${isMainFrame ? '' : ' (일부)'}] ${url}: ${description}`); });
    wc.on('did-start-navigation', (_e, url, _inPlace, isMainFrame) => { if (isMainFrame) note(`--- ${url} 로 이동 ---`); });
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
      if (alive(workspaceId)) return;
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (!win) throw new Error('두레 창이 닫혀 있어 브라우저를 열 수 없다.');
      const ready = new Promise<void>((resolve) => { waiting.set(workspaceId, [...(waiting.get(workspaceId) ?? []), resolve]); });
      win.webContents.send(IPC_EVENTS.browserOpen, workspaceId, url);
      await within(ready, 12_000, '브라우저 페이지 준비');
    },
    async navigate(workspaceId, url) {
      const { wc } = must(workspaceId);
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
      return within(must(workspaceId).wc.executeJavaScript(expression, true), 8000, '페이지 읽기');
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
  };
  return { driver, register };
}
