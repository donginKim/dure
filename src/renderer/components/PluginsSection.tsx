import { useCallback, useEffect, useState } from 'react';
import type { Plugin } from '@shared/types';
import { Empty } from './Empty';

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const cmd = (s: Plugin['mcpServers'][number]): string => (s.url ? s.url : [s.command, ...(s.args ?? [])].join(' '));

/** 플러그인 하나의 내용: 승인하기 전에 사용자가 무엇이 에이전트와 이 PC 에 닿는지 본다. */
export function Contents({ p }: { p: Plugin }) {
  return (
    <div className="plug-contents">
      {p.instructions && (
        <div>
          <div className="plug-label">에이전트 지시문에 덧붙는 글 <span className="muted">({p.instructions.length.toLocaleString('ko-KR')}자 · 켠 프로젝트의 모든 요청에 실립니다)</span></div>
          <pre className="plug-pre">{p.instructions}</pre>
        </div>
      )}
      {p.mcpServers.length > 0 && (
        <div>
          <div className="plug-label warn">이 PC 에서 실행되거나 연결되는 MCP 서버 <span className="muted">(에이전트가 쓰는 도구가 됩니다. 믿는 것만 승인하세요)</span></div>
          {p.mcpServers.map((s) => (
            <div key={s.name} className="plug-line"><b>{s.name}</b> <code>{cmd(s)}</code>{s.env && Object.keys(s.env).length > 0 && <span className="muted"> · 환경 변수 {Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(', ')}</span>}</div>
          ))}
        </div>
      )}
      {p.panels.length > 0 && (
        <div>
          <div className="plug-label">소식판 <span className="muted">(두레가 아래 주소에서 소식을 읽어 "소식" 화면에 보여 줍니다. 에이전트나 토큰은 쓰지 않습니다)</span></div>
          {p.panels.map((pn) => <div key={pn.title} className="plug-line"><b>{pn.title}</b> <span className="muted">· {pn.feeds.map((f) => `${f.name} (${new URL(f.url).hostname})`).join(', ')}</span></div>)}
        </div>
      )}
      {p.makers.length > 0 && (
        <div>
          <div className="plug-label">만들기 양식 <span className="muted">(켠 프로젝트의 "만들기" 에 뜹니다. 누를 때 아래 글이 모델에게 주문으로 건네집니다)</span></div>
          {p.makers.map((m, i) => <div key={i} className="plug-line"><b>{m.name}</b> <span className="muted">· {m.format === 'slides' ? '발표 자료' : m.format === 'visual' ? '그림' : '보고서'} 틀 · {m.prompt}</span></div>)}
        </div>
      )}
      {p.schedules.length > 0 && (
        <div>
          <div className="plug-label">예약 본보기 <span className="muted">(저절로 돌지 않습니다. 프로젝트의 예약에서 골라 추가합니다)</span></div>
          {p.schedules.map((s, i) => <div key={i} className="plug-line"><b>{s.title}</b> <span className="muted">· {s.kind === 'weekly' ? `매주 ${DAYS[s.weekday ?? 1]}요일` : '매일'} {s.time} · {s.prompt}</span></div>)}
        </div>
      )}
      {p.memory.length > 0 && (
        <div>
          <div className="plug-label">프로젝트 기억에 넣는 것 <span className="muted">(켤 때 한 번)</span></div>
          {p.memory.map((m, i) => <div key={i} className="plug-line">{m.text}</div>)}
        </div>
      )}
      {!p.instructions && p.mcpServers.length === 0 && p.schedules.length === 0 && p.memory.length === 0 && p.panels.length === 0 && p.makers.length === 0 && <div className="muted">담긴 것이 없습니다.</div>}
    </div>
  );
}

/**
 * 설치형 플러그인 (설정). 폴더나 git 주소에서 받아 설치하고, 내용을 보고 승인한다. 프로젝트마다 켜는 것은 프로젝트의 현황 탭에서 한다.
 * 플러그인은 글과 설정만 담는다: 두레 안에서 플러그인의 코드를 돌리지 않는다.
 */
export function PluginsSection({ onOpenMarket }: { onOpenMarket?: () => void }) {
  const [list, setList] = useState<Plugin[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.plugins.list().then(setList).catch(() => undefined); }, []);
  useEffect(() => { load(); return window.dure.onChanged((topic) => { if (topic === 'plugins') load(); }); }, [load]);
  const run = (p: Promise<unknown>, after?: (v: unknown) => void): void => {
    setBusy(true); setError('');
    p.then((v) => after?.(v)).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const installed = (v: unknown): void => { const p = v as Plugin | null; if (p) setOpen((o) => ({ ...o, [p.id]: true })); };
  return (
    <div className="section">
      <div className="section-head"><h2>플러그인 <span className="count">{list.length}</span></h2></div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      <div className="rows">
        {list.length === 0 && <Empty hint="팀의 코드 규칙, 예약 본보기, 외부 도구(MCP 서버) 연결을 묶어 설치합니다. plugin.json 이 있는 폴더나 git 저장소면 됩니다. 설치한 뒤 내용을 보고 승인해야 쓸 수 있고, 프로젝트마다 켭니다.">설치한 플러그인이 없습니다.</Empty>}
        {list.map((p) => (
          <div key={p.id} className="plug">
            <div className="row">
              <div className="grow">
                <div><b>{p.name}</b> <span className="muted">{p.version}</span> {p.approved ? <span className="tag">승인됨</span> : <span className="tag warn">{p.changed ? '내용이 바뀜 · 다시 승인 필요' : '승인 필요'}</span>}</div>
                <div className="muted plug-desc">{p.description || p.id} · {p.source.replace(/^(folder|git):/, '')}</div>
              </div>
              <button className="btn ghost" onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}>{open[p.id] ? '접기' : '내용 보기'}</button>
              {!p.approved && <button className="btn primary" disabled={busy} title="아래 내용이 에이전트와 이 PC 에 닿는 것을 허락합니다" onClick={() => { setOpen((o) => ({ ...o, [p.id]: true })); if (open[p.id]) run(window.dure.plugins.approve(p.id, p.hash)); }}>{open[p.id] ? '이 내용으로 승인' : '내용 보고 승인'}</button>}
              <button className="btn ghost" disabled={busy} title="받은 곳에서 다시 받습니다. 내용이 바뀌면 다시 승인해야 합니다" onClick={() => run(window.dure.plugins.update(p.id), installed)}>다시 받기</button>
              <button className="btn ghost" disabled={busy} onClick={() => run(window.dure.plugins.remove(p.id))}>지우기</button>
            </div>
            {open[p.id] && <Contents p={p} />}
          </div>
        ))}
      </div>
      <div className="plug-catalog">
        <div className="plug-catalog-head">
          <b>플러그인 마켓</b> <span className="muted">모음에서 둘러보고 골라 설치합니다 (소식판, 만들기 양식, 예약 본보기, 팀 규칙)</span>
          <span className="grow" />
          {onOpenMarket && <button className="btn" onClick={onOpenMarket}>마켓 열기</button>}
        </div>
      </div>
      <div className="plug-install">
        <button className="btn" disabled={busy} onClick={() => run(window.dure.plugins.installFolder(), installed)}>폴더에서 설치</button>
        <input type="text" value={url} placeholder="git 주소로 설치 (https://… 또는 git@…)" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && url.trim()) run(window.dure.plugins.installGit(url.trim()), (v) => { installed(v); setUrl(''); }); }} />
        <button className="btn" disabled={busy || !url.trim()} onClick={() => run(window.dure.plugins.installGit(url.trim()), (v) => { installed(v); setUrl(''); })}>{busy ? '받는 중…' : '받기'}</button>
      </div>
    </div>
  );
}

/** 프로젝트에서 플러그인을 켜고 끈다 (현황 탭). 승인한 것만 켤 수 있다. 설치한 것이 없으면 보이지 않는다. */
export function ProjectPlugins({ projectId, readOnly, onOpenSettings }: { projectId: string; readOnly?: boolean; onOpenSettings?: () => void }) {
  const [list, setList] = useState<Plugin[]>([]);
  const [on, setOn] = useState<string[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    window.dure.plugins.list().then(setList).catch(() => undefined);
    window.dure.plugins.enabled(projectId).then(setOn).catch(() => undefined);
  }, [projectId]);
  useEffect(() => { load(); return window.dure.onChanged((topic) => { if (topic === 'plugins') load(); }); }, [load]);
  if (list.length === 0) return null;
  return (
    <div className="section">
      <div className="section-head">
        <h2>플러그인 <span className="plan-hint">켠 것의 지시문과 도구가 이 프로젝트의 에이전트에게 실립니다 (다음에 시작할 때부터)</span></h2>
        {onOpenSettings && <button className="btn ghost" onClick={onOpenSettings}>마켓에서 더 설치</button>}
      </div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      <div className="rows">
        {list.map((p) => (
          <label key={p.id} className="row plug-toggle">
            <input type="checkbox" checked={on.includes(p.id)} disabled={readOnly || (!p.approved && !on.includes(p.id))}
              onChange={(e) => { setError(''); window.dure.plugins.setEnabled(projectId, p.id, e.target.checked).then(load).catch((err: Error) => setError(err.message)); }} />
            <div className="grow">
              <div><b>{p.name}</b> {!p.approved && <span className="tag warn">{p.changed ? '다시 승인 필요 (지금은 쓰이지 않음)' : '승인 필요'}</span>}</div>
              <div className="muted plug-desc">{[p.instructions ? `지시문 ${p.instructions.length.toLocaleString('ko-KR')}자` : '', p.mcpServers.length ? `MCP 서버 ${p.mcpServers.length}` : '', p.schedules.length ? `예약 본보기 ${p.schedules.length}` : '', p.memory.length ? `기억 ${p.memory.length}` : ''].filter(Boolean).join(' · ') || p.description}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
