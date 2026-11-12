import { createElement, useEffect, useSyncExternalStore } from 'react';
import type { Workspace } from '@shared/types';
import { browserStore, webviewId, type BrowserEntry } from '../browserStore';

interface WebviewEl extends HTMLElement { getWebContentsId(): number }

/**
 * 페이지 하나. 자리가 있으면 그 자리에 둔다. 없으면 창의 왼쪽 위 모서리에 두고 2x2 픽셀만, 거의 투명하게 그리게 한다.
 * 숨기거나, 창 밖으로 빼거나, 다른 것으로 완전히 가리면 Chromium 이 그 페이지를 그리지 않아 에이전트가 화면을 찍을 수 없다 (실측).
 */
function Page({ entry, projectId }: { entry: BrowserEntry; projectId: string }) {
  useEffect(() => {
    const el = document.getElementById(webviewId(entry.workspaceId)) as WebviewEl | null;
    if (!el) return undefined;
    // 페이지가 준비되면 메인 프로세스에 알린다: 에이전트의 조작이 이 페이지로 간다.
    const ready = (): void => { try { window.dure.browser.register(entry.workspaceId, el.getWebContentsId()).catch(() => undefined); } catch { /* 아직 붙지 않음 */ } };
    el.addEventListener('dom-ready', ready);
    el.addEventListener('did-attach', ready);
    return () => { el.removeEventListener('dom-ready', ready); el.removeEventListener('did-attach', ready); };
  }, [entry.workspaceId]);
  const r = entry.rect;
  const style = r
    ? { position: 'fixed', left: r.left, top: r.top, width: r.width, height: r.height, zIndex: 5 }
    : { position: 'fixed', left: 0, top: 0, width: 1280, height: 800, zIndex: 5, pointerEvents: 'none', opacity: 0.01, clipPath: 'inset(0 1278px 798px 0)' };
  // 로그인 정보는 두레 전용 저장소에, 프로젝트마다 따로 둔다 (다른 브라우저와도, 다른 프로젝트와도 섞이지 않는다).
  return createElement('webview', { id: webviewId(entry.workspaceId), src: entry.url, partition: `persist:dure-browser-${projectId}`, className: 'browser-view', style });
}

/** 앱 맨 위에 한 번 둔다. 모든 워크스페이스의 브라우저 페이지를 갖고 있다. */
export function BrowserHost({ workspaces, loaded }: { workspaces: Workspace[]; /** 워크스페이스 목록을 한 번이라도 받았는가 */ loaded: boolean }) {
  const entries = useSyncExternalStore(browserStore.subscribe, browserStore.all);
  // 에이전트가 페이지를 열려 한다 (그 워크스페이스의 보기가 열려 있지 않아도 된다).
  useEffect(() => window.dure.browser.onOpen((workspaceId, url) => browserStore.ensure(workspaceId, url, true)), []);
  const ids = workspaces.map((w) => w.id).join(',');
  // 지워진 워크스페이스의 페이지를 닫는다. 목록을 받기 전에는 하지 않는다 (받기 전의 빈 목록으로 다 닫아 버리지 않게).
  useEffect(() => { if (loaded) browserStore.keepOnly(new Set(ids ? ids.split(',') : [])); }, [ids, loaded]);
  const projectOf = (workspaceId: string): string | undefined => workspaces.find((w) => w.id === workspaceId)?.projectId;
  return <>{entries.map((e) => { const p = projectOf(e.workspaceId); return p ? <Page key={e.workspaceId} entry={e} projectId={p} /> : null; })}</>;
}
