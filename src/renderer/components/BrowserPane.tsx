import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Workspace } from '@shared/types';
import { browserStore, webviewId } from '../browserStore';
import { normalizeUrl, recallUrl, rememberUrl } from '../browserView';

/** Electron 의 webview 요소 중 여기서 쓰는 것 */
interface WebviewEl extends HTMLElement {
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
 * 워크스페이스의 "브라우저" 보기. 에이전트가 띄운 개발 서버 같은 것을 앱 안에서 본다. 에이전트도 같은 페이지를 열고 누를 수 있다.
 * 페이지 자체는 BrowserHost 가 갖고 있고, 여기는 주소창과 페이지가 놓일 자리다 (보기를 떠나도 페이지는 살아 있다).
 * 여기 열린 페이지는 보통의 웹 페이지다: 두레의 기능이나 파일에 닿지 못한다. http, https 만 연다.
 */
export function BrowserPane({ workspace }: { workspace: Workspace }) {
  const id = workspace.id;
  const entry = useSyncExternalStore(browserStore.subscribe, () => browserStore.get(id));
  const [draft, setDraft] = useState(() => recallUrl(id, window.localStorage));
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [error, setError] = useState('');
  const slot = useRef<HTMLDivElement | null>(null);
  const view = (): WebviewEl | null => document.getElementById(webviewId(id)) as WebviewEl | null;
  const has = entry !== undefined;

  // 지난번에 보던 주소가 있으면 그 페이지를 연다.
  useEffect(() => {
    const last = recallUrl(id, window.localStorage);
    if (last && !browserStore.get(id)) browserStore.ensure(id, last);
  }, [id]);

  // 페이지가 놓일 자리를 알린다. 보기를 떠나면 자리를 뺀다.
  useEffect(() => {
    const el = slot.current;
    if (!el || !has) return undefined;
    const report = (): void => { const r = el.getBoundingClientRect(); browserStore.setRect(id, { left: r.left, top: r.top, width: r.width, height: r.height }); };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    ro.observe(document.body);
    window.addEventListener('resize', report);
    const timer = window.setInterval(report, 500); // 옆 패널을 접는 것처럼 크기는 그대로인데 자리만 바뀌는 경우
    return () => { ro.disconnect(); window.removeEventListener('resize', report); window.clearInterval(timer); browserStore.setRect(id, null); };
  }, [id, has]);

  useEffect(() => {
    if (!has) return undefined;
    let el: WebviewEl | null = null;
    let off = (): void => undefined;
    const sync = (): void => {
      try {
        if (!el) return;
        setNav({ back: el.canGoBack(), forward: el.canGoForward() });
        const now = el.getURL();
        if (now && /^https?:/i.test(now)) { setDraft(now); rememberUrl(id, now, window.localStorage); }
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
    // 페이지 요소는 BrowserHost 가 그린다: 한 박자 뒤에 생길 수 있다.
    const attach = window.setInterval(() => {
      el = view();
      if (!el) return;
      window.clearInterval(attach);
      const pairs: [string, (e: Event) => void][] = [['did-start-loading', start], ['did-stop-loading', stop], ['did-navigate', sync], ['did-navigate-in-page', sync], ['did-fail-load', fail]];
      for (const [name, fn] of pairs) el.addEventListener(name, fn);
      off = () => { for (const [name, fn] of pairs) el?.removeEventListener(name, fn); };
      sync();
    }, 100);
    return () => { window.clearInterval(attach); off(); };
  }, [id, has]);

  const go = (): void => {
    const next = normalizeUrl(draft);
    if (!next) { setError('열 수 없는 주소입니다. http 나 https 주소를 적으세요 (예: localhost:3000).'); return; }
    setError('');
    rememberUrl(id, next, window.localStorage);
    const el = view();
    if (!has || !el) browserStore.ensure(id, next);
    else el.loadURL(next).catch(() => undefined);
    setDraft(next);
  };

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="btn ghost" disabled={!nav.back} title="뒤로" onClick={() => view()?.goBack()}>←</button>
        <button className="btn ghost" disabled={!nav.forward} title="앞으로" onClick={() => view()?.goForward()}>→</button>
        <button className="btn ghost" disabled={!has} title={loading ? '멈춤' : '새로 고침'} onClick={() => (loading ? view()?.stop() : view()?.reload())}>{loading ? '×' : '↻'}</button>
        <input
          type="text" className="browser-url" value={draft} spellCheck={false} placeholder="주소 (예: localhost:3000)"
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) go(); }}
        />
        <button className="btn" onClick={go}>열기</button>
        {entry?.byAgent && <span className="tag" title="에이전트가 이 페이지를 열었습니다. 에이전트가 누르고 입력하는 것이 여기 그대로 보입니다">에이전트가 사용 중</span>}
      </div>
      {error && <div className="error" style={{ margin: '8px 12px 0' }}>{error}</div>}
      {has
        ? <div className="browser-slot" ref={slot} />
        : <div className="chat-empty">주소를 적고 Enter 를 누르세요. 에이전트가 띄운 개발 서버(예: localhost:3000)를 여기서 볼 수 있습니다. 에이전트도 이 페이지를 열어 직접 확인할 수 있습니다.<br />여기 열린 페이지는 두레의 기능이나 파일에 닿지 못합니다.</div>}
    </div>
  );
}
