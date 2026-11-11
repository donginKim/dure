import { createElement, useEffect, useRef, useState } from 'react';
import type { Workspace } from '@shared/types';
import { normalizeUrl, recallUrl, rememberUrl } from '../browserView';

/** Electron 의 webview 요소 중 여기서 쓰는 것 */
interface WebviewEl extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  reload(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
}

/**
 * 워크스페이스의 "브라우저" 보기. 에이전트가 띄운 개발 서버 같은 것을 앱 안에서 본다.
 * 여기 열린 페이지는 보통의 웹 페이지다: 두레의 기능이나 파일에 닿지 못한다. http, https 만 연다.
 */
export function BrowserPane({ workspace }: { workspace: Workspace }) {
  const [url, setUrl] = useState(() => recallUrl(workspace.id, window.localStorage));
  const [draft, setDraft] = useState(url);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [error, setError] = useState('');
  const view = useRef<WebviewEl | null>(null);

  useEffect(() => {
    const el = view.current;
    if (!el) return undefined;
    const sync = (): void => {
      try {
        setNav({ back: el.canGoBack(), forward: el.canGoForward() });
        const now = el.getURL();
        if (now && /^https?:/i.test(now)) { setDraft(now); rememberUrl(workspace.id, now, window.localStorage); }
      } catch { /* 아직 붙지 않음 */ }
    };
    const start = (): void => { setLoading(true); setError(''); };
    const stop = (): void => { setLoading(false); sync(); };
    const fail = (e: Event): void => {
      const d = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean; validatedURL?: string };
      // -3 은 사용자가 멈추거나 다른 곳으로 넘어간 것이다.
      if (d.isMainFrame === false || d.errorCode === -3) return;
      setLoading(false);
      setError(`열지 못했습니다: ${d.validatedURL ?? ''} (${d.errorDescription ?? '알 수 없는 오류'}). 개발 서버가 떠 있는지 확인하세요.`);
    };
    el.addEventListener('did-start-loading', start);
    el.addEventListener('did-stop-loading', stop);
    el.addEventListener('did-navigate', sync);
    el.addEventListener('did-navigate-in-page', sync);
    el.addEventListener('did-fail-load', fail);
    return () => {
      el.removeEventListener('did-start-loading', start);
      el.removeEventListener('did-stop-loading', stop);
      el.removeEventListener('did-navigate', sync);
      el.removeEventListener('did-navigate-in-page', sync);
      el.removeEventListener('did-fail-load', fail);
    };
  }, [workspace.id, url === '']);

  const go = (): void => {
    const next = normalizeUrl(draft);
    if (!next) { setError('열 수 없는 주소입니다. http 나 https 주소를 적으세요 (예: localhost:3000).'); return; }
    setError('');
    rememberUrl(workspace.id, next, window.localStorage);
    if (url === '' || !view.current) setUrl(next);
    else view.current.loadURL(next).catch(() => undefined);
    setDraft(next);
  };

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="btn ghost" disabled={!nav.back} title="뒤로" onClick={() => view.current?.goBack()}>←</button>
        <button className="btn ghost" disabled={!nav.forward} title="앞으로" onClick={() => view.current?.goForward()}>→</button>
        <button className="btn ghost" disabled={url === ''} title={loading ? '멈춤' : '새로 고침'} onClick={() => (loading ? view.current?.stop() : view.current?.reload())}>{loading ? '×' : '↻'}</button>
        <input
          type="text" className="browser-url" value={draft} spellCheck={false} placeholder="주소 (예: localhost:3000)"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) go(); }}
        />
        <button className="btn" onClick={go}>열기</button>
      </div>
      {error && <div className="error" style={{ margin: '8px 12px 0' }}>{error}</div>}
      {url === ''
        ? <div className="chat-empty">주소를 적고 Enter 를 누르세요. 에이전트가 띄운 개발 서버(예: localhost:3000)를 여기서 볼 수 있습니다.<br />여기 열린 페이지는 두레의 기능이나 파일에 닿지 못합니다.</div>
        // 로그인 정보는 두레 전용 저장소에 따로 둔다 (다른 브라우저와 섞이지 않는다).
        : createElement('webview', { ref: view, src: url, partition: 'persist:dure-browser', className: 'browser-view' })}
    </div>
  );
}
