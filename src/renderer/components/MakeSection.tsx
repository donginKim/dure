import { useCallback, useEffect, useState } from 'react';
import type { Make, MakeKind } from '@shared/types';
import { Empty } from './Empty';

const when = (at: number): string => new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * 만들기: 프로젝트에 쌓인 것(할 일, 기억, 작업 보고)과 붙여 넣은 글로 보고서·발표 자료·눌러 보는 그림을 만든다.
 * 누를 때 한 번만 모델을 부른다. 결과는 따로 창에 띄우거나 HTML 파일로 저장한다.
 */
export function MakeSection({ projectId, readOnly }: { projectId: string; readOnly?: boolean }) {
  const [kinds, setKinds] = useState<MakeKind[]>([]);
  const [list, setList] = useState<Make[]>([]);
  const [direction, setDirection] = useState('');
  const [extra, setExtra] = useState('');
  const [more, setMore] = useState(false);
  const [all, setAll] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const load = useCallback(() => {
    window.dure.makes.list(projectId).then(setList).catch(() => undefined);
    window.dure.makes.kinds(projectId).then(setKinds).catch(() => undefined);
  }, [projectId]);
  useEffect(() => { load(); return window.dure.onChanged((topic) => { if (topic === 'makes' || topic === 'plugins') load(); }); }, [load]);
  const working = list.some((m) => m.state === 'working');
  const make = (kind: string): void => {
    setError(''); setSaved('');
    window.dure.makes.create(projectId, kind, direction, extra).then(() => { setDirection(''); setExtra(''); setMore(false); }).catch((e: Error) => setError(e.message));
  };
  const shown = all ? list : list.slice(0, 5);
  return (
    <div className="section">
      <div className="section-head"><h2>만들기 <span className="plan-hint">쌓인 일과 기억으로 문서를 만듭니다 · 누를 때 한 번만 모델을 씁니다</span></h2></div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      {!readOnly && (
        <div className="make-box">
          <div className="make-kinds">
            {kinds.map((k) => (
              <button key={k.id} className="make-kind" disabled={working} onClick={() => make(k.id)} title={k.plugin ? `플러그인 "${k.plugin}" 의 양식 (${k.hint})` : k.hint}>
                <b>{k.name}</b><span className="muted">{k.plugin ? `${k.plugin} · ${k.hint}` : k.hint}</span>
              </button>
            ))}
          </div>
          <div className="make-opts">
            <input type="text" value={direction} maxLength={1000} disabled={working} placeholder="방향 (선택) — 예: 임원 보고용, 일정 위험을 앞에" onChange={(e) => setDirection(e.target.value)} />
            <button className="btn ghost" aria-expanded={more} onClick={() => setMore((v) => !v)}>{more ? '자료 접기' : '자료 붙여 넣기'}</button>
          </div>
          {more && <textarea className="make-extra" value={extra} maxLength={20000} rows={5} disabled={working} placeholder="회의록, 메모처럼 문서에 담을 글을 붙여 넣습니다 (2만 자까지). 비워 두면 프로젝트에 쌓인 것만 씁니다." onChange={(e) => setExtra(e.target.value)} />}
        </div>
      )}
      <div className="rows" aria-live="polite">
        {list.length === 0 && <Empty hint="위의 양식을 누르면 이 프로젝트의 할 일, 기억, 커밋 기록을 간추려 한 장짜리 문서로 만듭니다. 플러그인으로 회사 양식을 더할 수 있습니다.">아직 만든 문서가 없습니다.</Empty>}
        {shown.map((m) => (
          <div key={m.id} className="row make-row">
            <span className={`tag make-${m.state}`}>{m.state === 'working' ? '만드는 중' : m.state === 'failed' ? '실패' : m.kindName}</span>
            <div className="grow">
              <div className="make-title">{m.title}</div>
              <div className="muted make-sub">
                {m.state === 'failed' ? m.error : m.state === 'working' ? '보통 1~3분 걸립니다. 다른 화면에 가 있어도 됩니다.' : `${when(m.createdAt)}${m.tokens ? ` · ${m.tokens.toLocaleString('ko-KR')} 토큰` : ''}${m.direction ? ` · ${m.direction}` : ''}`}
              </div>
            </div>
            {m.state === 'done' && <button className="btn" onClick={() => { window.dure.makes.open(m.id).catch((e: Error) => setError(e.message)); }}>열기</button>}
            {m.state === 'done' && <button className="btn ghost" onClick={() => { window.dure.makes.save(m.id).then((p) => { if (p) setSaved(p); }).catch((e: Error) => setError(e.message)); }}>저장</button>}
            {m.state !== 'working' && <button className="btn ghost" onClick={() => { window.dure.makes.remove(m.id).catch(() => undefined); }}>지우기</button>}
          </div>
        ))}
        {list.length > 5 && <button className="btn ghost" onClick={() => setAll((v) => !v)}>{all ? '접기' : `외 ${list.length - 5}개 보기`}</button>}
        {saved && <div className="muted make-saved">저장했습니다: {saved} · 저장한 파일은 보통 브라우저에서 열립니다. 남에게 받은 자료가 섞인 문서라면 두레의 "열기" 로 보는 쪽이 안전합니다.</div>}
      </div>
    </div>
  );
}
