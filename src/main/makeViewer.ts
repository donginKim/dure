import { BrowserWindow, session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let guarded = false;

/**
 * 만든 문서를 따로 창에 띄운다. 문서는 에이전트가 쓴 HTML 이라 두레의 권한을 주지 않는다:
 * preload 와 node 가 없고, 저장소(세션)가 따로이며, 그 문서 파일 말고는 어떤 주소도 읽지 못한다 (네트워크, 다른 파일 모두 막는다).
 */
export function openMake(dir: string, id: string, title: string, html: string): void {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('열 수 없는 문서입니다.');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.html`);
  writeFileSync(file, html);
  const ses = session.fromPartition('dure-make');
  if (!guarded) {
    guarded = true;
    const root = `${pathToFileURL(dir).toString()}/`;
    ses.webRequest.onBeforeRequest((d, done) => {
      const u = d.url;
      const own = u.startsWith(root) && /^[0-9a-f-]{36}\.html$/.test(u.slice(root.length));
      done({ cancel: !(own || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:')) });
    });
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
  }
  const win = new BrowserWindow({
    width: 1180, height: 780, title, backgroundColor: '#ffffff',
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.on('page-title-updated', (e) => e.preventDefault());
  void win.loadFile(file);
}
