import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CatalogEntry, MarketKind, MarketSource, Plugin } from '@shared/types';
import type { Selection } from '../tree';
import { Empty } from './Empty';
import { Contents } from './PluginsSection';

const KIND: Record<MarketKind, string> = { panels: '소식판', makers: '만들기 양식', schedules: '예약 본보기', instructions: '지시문', mcp: 'MCP 서버' };
const KINDS = Object.keys(KIND) as MarketKind[];
const ago = (at: number): string => { const m = Math.round((Date.now() - at) / 60_000); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`; };

/**
 * 플러그인 마켓: 모음(git 저장소)들에 든 플러그인을 둘러보고 설치한다. 모음은 여럿 둘 수 있다 (두레의 기본 모음, 팀의 모음).
 * 설치만으로는 쓰이지 않는다: 여기서 내용을 보고 승인한 뒤, 프로젝트에서 켠다. 플러그인은 글과 설정만 담는다.
 * 이 화면을 열 때만 모음을 받아 오고, 10분 동안은 받아 둔 것을 쓴다.
 */
export function MarketView({ onSelect }: { onSelect: (s: Selection) => void }) {
  const [sources, setSources] = useState<MarketSource[] | null>(null);
  const [mine, setMine] = useState<Plugin[]>([]);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<MarketKind | ''>('');
  const [open, setOpen] = useState('');
  const [url, setUrl] = useState('');
  const load = useCallback((force = false) => {
    setBusy(true);
    window.dure.plugins.market(force).then(setSources).catch((e: Error) => { setError(e.message); setSources([]); }).finally(() => setBusy(false));
  }, []);
  const loadMine = useCallback(() => { window.dure.plugins.list().then(setMine).catch(() => undefined); }, []);
  useEffect(() => { load(); loadMine(); }, [load, loadMine]);
  // 설치·승인·지우기가 일어나면 표시를 맞춘다 (받아 둔 것을 쓰므로 저장소를 다시 받지 않는다).
  useEffect(() => window.dure.onChanged((topic) => { if (topic === 'plugins') { loadMine(); load(); } }), [load, loadMine]);

  const act = (key: string, p: Promise<unknown>, after?: () => void): void => {
    setWorking(key); setError('');
    p.then(() => after?.()).catch((e: Error) => setError(e.message)).finally(() => setWorking(''));
  };
  const setExtra = (next: string[], after?: () => void): void => act('sources', window.dure.settings.update({ pluginSources: next }).then(() => load(true)), after);
  const extras = (sources ?? []).filter((s) => !s.base).map((s) => s.url);
  const needle = q.trim().toLowerCase();
  const match = useCallback((e: CatalogEntry): boolean => (!kind || e.kinds.includes(kind))
    && (!needle || [e.name, e.description, e.id, ...e.contents.panels, ...e.contents.makers, ...e.contents.schedules, ...e.contents.mcp].some((t) => t.toLowerCase().includes(needle))), [kind, needle]);
  const total = useMemo(() => (sources ?? []).reduce((n, s) => n + s.entries.length, 0), [sources]);
  const shown = useMemo(() => (sources ?? []).reduce((n, s) => n + s.entries.filter(match).length, 0), [sources, match]);

  return (
    <div className="page market">
      <div className="section-head">
        <h1>플러그인 마켓</h1>
        <button className="btn ghost" disabled={busy} onClick={() => load(true)}>{busy ? '받는 중…' : '새로 고침'}</button>
      </div>
      <div className="sub">모음에서 골라 설치합니다. 설치한 뒤 내용을 보고 승인해야 쓰이고, 프로젝트마다 켭니다. 플러그인은 글과 설정만 담습니다 (두레가 플러그인의 코드를 돌리지 않습니다).</div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      <div className="market-bar">
        <input type="text" value={q} placeholder="이름, 설명, 담긴 것으로 찾기" aria-label="플러그인 찾기" onChange={(e) => setQ(e.target.value)} />
        <div className="market-chips" role="group" aria-label="갈래로 거르기">
          <button className={`mk-chip${kind === '' ? ' on' : ''}`} aria-pressed={kind === ''} onClick={() => setKind('')}>전체</button>
          {KINDS.map((k) => <button key={k} className={`mk-chip${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(kind === k ? '' : k)}>{KIND[k]}</button>)}
        </div>
      </div>
      {sources === null && <div className="muted market-wait">모음을 받아 오는 중…</div>}
      {sources !== null && sources.length === 0 && <Empty hint="아래에서 모음의 git 주소를 더하거나, 설정의 '플러그인 모음' 에 기본 모음의 주소를 적습니다.">모음이 없습니다.</Empty>}
      {sources !== null && total > 0 && shown === 0 && <div className="muted market-wait">찾는 것이 없습니다. <button className="btn ghost" onClick={() => { setQ(''); setKind(''); }}>거르기 풀기</button></div>}
      {(sources ?? []).map((s) => {
        const entries = s.entries.filter(match);
        if (entries.length === 0 && !s.error && (needle || kind)) return null;
        return (
          <section key={s.url} className="market-source" aria-label={`모음 ${s.label}`}>
            <div className="market-source-head">
              <b>{s.label}</b>
              <span className="muted">{s.base ? '기본 모음' : '더한 모음'} · {s.entries.length}개 · {ago(s.at)} 받음</span>
              <span className="grow" />
              {!s.base && <button className="btn ghost" disabled={working !== ''} title="마켓에서 이 모음을 뺍니다 (설치한 플러그인은 그대로 남습니다)" onClick={() => setExtra(extras.filter((u) => u !== s.url))}>모음 빼기</button>}
            </div>
            {s.error && <div className="error">받지 못했습니다: {s.error}{s.entries.length > 0 ? ' (앞서 받아 둔 목록을 보입니다)' : ''}</div>}
            {!s.error && s.entries.length === 0 && <div className="muted market-wait">이 모음에는 플러그인이 없습니다 (폴더마다 plugin.json 이 있어야 합니다).</div>}
            <div className="market-grid">
              {entries.map((e) => {
                const key = `${s.url}#${e.dir}`;
                const have = mine.find((p) => p.id === e.id);
                const newer = have !== undefined && e.installedVersion !== '' && e.installedVersion !== e.version;
                const isOpen = open === key && have !== undefined;
                return (
                  <article key={key} className={`market-card${isOpen ? ' open' : ''}`}>
                    <div className="market-card-head"><b>{e.name}</b><span className="muted">{e.version}</span></div>
                    <p className="market-desc">{e.description || e.id}</p>
                    <div className="market-tags">
                      {e.kinds.map((k) => <span key={k} className={`tag${k === 'mcp' ? ' warn' : ''}`} title={k === 'mcp' ? `이 PC 에서 실행되거나 연결되는 도구: ${e.contents.mcp.join(', ')}. 믿는 것만 승인하세요` : k === 'instructions' ? '에이전트 지시문에 덧붙는 글' : (e.contents[k as 'panels' | 'makers' | 'schedules'] ?? []).join(', ')}>{KIND[k]}{k !== 'instructions' && k !== 'mcp' ? ` ${e.contents[k as 'panels' | 'makers' | 'schedules'].length}` : ''}</span>)}
                    </div>
                    <div className="market-card-foot">
                      {!have && <span className="muted">설치 안 됨</span>}
                      {have && (have.approved ? <span className="tag market-ok">설치됨 · 승인됨</span> : <span className="tag warn">{have.changed ? '내용이 바뀜 · 다시 승인 필요' : '승인 필요'}</span>)}
                      <span className="grow" />
                      {have && <button className="btn ghost" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : key)}>{isOpen ? '접기' : '내용 보기'}</button>}
                      {!have && <button className="btn primary" disabled={working !== ''} onClick={() => act(key, window.dure.plugins.installFrom(s.url, e.dir), () => setOpen(key))}>{working === key ? '받는 중…' : '설치'}</button>}
                      {have && newer && <button className="btn" disabled={working !== ''} title={`설치된 판 ${e.installedVersion} → ${e.version}. 내용이 바뀌면 다시 승인해야 합니다`} onClick={() => act(key, window.dure.plugins.installFrom(s.url, e.dir), () => setOpen(key))}>{working === key ? '받는 중…' : `${e.version} 으로 올리기`}</button>}
                    </div>
                    {isOpen && have && (
                      <div className="market-detail">
                        <Contents p={have} />
                        <div className="market-detail-foot">
                          <span className="muted">{have.approved ? '승인한 내용입니다. 프로젝트의 현황 탭에서 켭니다.' : '위 내용이 에이전트와 이 PC 에 닿는 것을 허락할 때만 승인하세요.'}</span>
                          <span className="grow" />
                          <button className="btn ghost" disabled={working !== ''} onClick={() => act(key, window.dure.plugins.remove(have.id), () => setOpen(''))}>지우기</button>
                          {!have.approved && <button className="btn primary" disabled={working !== ''} onClick={() => act(key, window.dure.plugins.approve(have.id, have.hash))}>이 내용으로 승인</button>}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
      <div className="market-add">
        <b>모음 더하기</b>
        <span className="muted">팀이나 다른 사람의 플러그인 모음 (폴더마다 plugin.json 이 든 git 저장소). 10개까지.</span>
        <div className="market-add-row">
          <input type="text" value={url} placeholder="https://github.com/팀/dure-plugins.git 또는 git@…" aria-label="모음의 git 주소" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !e.nativeEvent.isComposing) setExtra([...extras, url.trim()], () => setUrl('')); }} />
          <button className="btn" disabled={working !== '' || !url.trim()} onClick={() => setExtra([...extras, url.trim()], () => setUrl(''))}>{working === 'sources' ? '받는 중…' : '더하기'}</button>
        </div>
        <div className="muted">폴더나 저장소 하나를 바로 설치하려면 <button className="btn ghost" onClick={() => onSelect({ type: 'settings' })}>설정의 플러그인</button> 에서 합니다.</div>
      </div>
    </div>
  );
}
