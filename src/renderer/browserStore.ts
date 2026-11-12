/**
 * 워크스페이스마다의 브라우저 페이지. 페이지(webview)는 앱 맨 위의 BrowserHost 가 갖고 있고, 워크스페이스의 "브라우저" 보기는 그 자리만 빌려준다.
 * 보기를 떠나도 페이지가 살아 있어야 한다: 에이전트가 그 페이지를 조작하는 중일 수 있다.
 */
export interface Rect { left: number; top: number; width: number; height: number }
export interface BrowserEntry {
  workspaceId: string;
  /** 처음 여는 주소 (webview 의 src). 그 뒤의 이동은 webview 가 스스로 한다 */
  url: string;
  /** 화면에 보일 자리. 없으면 보이지 않는 곳에 둔다 (그래도 페이지는 돈다) */
  rect: Rect | null;
  /** 에이전트가 연 페이지인가 (보기에 표시한다) */
  byAgent: boolean;
}

type Listener = () => void;

export function createBrowserStore() {
  let entries: BrowserEntry[] = [];
  const listeners = new Set<Listener>();
  const emit = (): void => { for (const l of listeners) l(); };
  const patch = (workspaceId: string, p: Partial<BrowserEntry>): void => {
    entries = entries.map((e) => (e.workspaceId === workspaceId ? { ...e, ...p } : e));
    emit();
  };
  return {
    subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
    all: (): BrowserEntry[] => entries,
    get: (workspaceId: string): BrowserEntry | undefined => entries.find((e) => e.workspaceId === workspaceId),
    /** 페이지가 없으면 만든다. 있으면 그대로 둔다 (이동은 webview 에 직접 시킨다). */
    ensure(workspaceId: string, url: string, byAgent = false): void {
      const found = entries.find((e) => e.workspaceId === workspaceId);
      if (found) { if (byAgent && !found.byAgent) patch(workspaceId, { byAgent: true }); return; }
      entries = [...entries, { workspaceId, url, rect: null, byAgent }];
      emit();
    },
    setRect(workspaceId: string, rect: Rect | null): void {
      const e = entries.find((x) => x.workspaceId === workspaceId);
      if (!e) return;
      const same = (a: Rect | null, b: Rect | null): boolean => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
      if (!same(e.rect, rect)) patch(workspaceId, { rect });
    },
    /** 워크스페이스가 지워졌다: 그 페이지를 닫는다. */
    keepOnly(workspaceIds: Set<string>): void {
      const next = entries.filter((e) => workspaceIds.has(e.workspaceId));
      if (next.length !== entries.length) { entries = next; emit(); }
    },
  };
}

export const browserStore = createBrowserStore();
/** webview 요소를 찾는 데 쓰는 id */
export const webviewId = (workspaceId: string): string => `dure-webview-${workspaceId}`;
