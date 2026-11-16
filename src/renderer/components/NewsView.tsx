import { useCallback, useEffect, useState } from 'react';
import type { NewsPanel } from '@shared/types';
import type { Selection } from '../tree';
import { Empty } from './Empty';

const ago = (at: number): string => { if (!at) return ''; const m = Math.round((Date.now() - at) / 60_000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };

/**
 * 소식: 승인한 플러그인의 소식판(피드 묶음)을 한 화면에 모은다. 두레가 피드를 직접 읽어 보여 준다 (LLM 을 쓰지 않는다).
 * 이 화면을 열 때만 읽고, 20분 동안은 받아 둔 것을 쓴다.
 */
export function NewsView({ onSelect }: { onSelect: (s: Selection) => void }) {
  const [panels, setPanels] = useState<NewsPanel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Record<string, number>>({});
  const load = useCallback((force = false) => {
    setBusy(true);
    window.dure.plugins.news(force).then(setPanels).catch(() => setPanels([])).finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(); return window.dure.onChanged((topic) => { if (topic === 'plugins') load(); }); }, [load]);
  return (
    <div className="page">
      <div className="section-head"><h1>소식</h1><button className="btn ghost" disabled={busy} onClick={() => load(true)}>{busy ? '읽는 중…' : '새로 고침'}</button></div>
      {panels && panels.length === 0 && (
        <Empty hint="소식판이 든 플러그인을 설치하고 승인하면 여기에 모입니다 (예: 오늘의 뉴스, 이주의 트렌드)." actions={<button className="btn" onClick={() => onSelect({ type: 'market' })}>플러그인 마켓 열기</button>}>보여 줄 소식판이 없습니다.</Empty>
      )}
      <div className="news-grid">
        {(panels ?? []).map((p) => {
          const key = `${p.plugin}|${p.title}`;
          const f = p.feeds[Math.min(tab[key] ?? 0, p.feeds.length - 1)]!;
          return (
            <div key={key} className="news-panel">
              <div className="news-head"><b>{p.title}</b><span className="muted">{p.plugin}</span></div>
              <div className="news-tabs" role="tablist">
                {p.feeds.map((x, i) => <button key={x.url} role="tab" aria-selected={x === f} className={x === f ? 'on' : ''} onClick={() => setTab((t) => ({ ...t, [key]: i }))}>{x.name}</button>)}
              </div>
              {f.error && f.items.length === 0 && <div className="muted news-empty">{f.error}</div>}
              {f.items.map((it, i) => (
                <button key={i} className="news-item" disabled={!it.link} title={it.title} onClick={() => { if (it.link) window.dure.plugins.openLink(it.link).catch(() => undefined); }}>
                  <span className="news-title">{it.title}</span><span className="muted">{ago(it.at)}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
