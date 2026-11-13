import { useCallback, useEffect, useState } from 'react';
import type { Agreement, AgreementKind } from '@shared/types';
import { Markdown } from './Markdown';

const KIND_LABEL: Record<AgreementKind, string> = { api: 'API', naming: '이름', decision: '결정', other: '기타' };

/**
 * 프로젝트의 약속 (현황 탭). 모든 에이전트가 읽고 따른다. 에이전트가 제안한 것은 받아들여야 약속이 된다.
 * 사용자가 적거나 고치거나 받아들이면 그 프로젝트의 모든 에이전트에게 알린다.
 */
export function AgreementsSection({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const [list, setList] = useState<Agreement[]>([]);
  const [editing, setEditing] = useState<{ id?: string; kind: AgreementKind; title: string; body: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.agreements.list(projectId, true).then(setList).catch(() => setList([])); }, [projectId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'todos') load(); });
  }, [load]);
  const run = (p: Promise<unknown>): void => { setError(''); p.then(load).catch((e: Error) => setError(e.message)); };
  const active = list.filter((a) => a.status === 'active');
  const proposed = list.filter((a) => a.status === 'proposed');
  const save = (): void => {
    if (!editing) return;
    run(window.dure.agreements.save(projectId, editing).then(() => setEditing(null)));
  };
  return (
    <div className="section">
      <div className="section-head">
        <h2>약속 <span className="count">{active.length}</span></h2>
        {!readOnly && !editing && <button className="btn" onClick={() => setEditing({ kind: 'api', title: '', body: '' })}>약속 적기</button>}
      </div>
      {error && <div className="error">{error}</div>}
      {proposed.map((a) => {
        const old = a.replaces ? active.find((x) => x.id === a.replaces) : undefined;
        return (
          <div key={a.id} className="agreement proposed">
            <div className="agreement-head">
              <span className="tag">{KIND_LABEL[a.kind]}</span>
              <b className="grow">{a.title}</b>
              <span className="muted">{a.author} 의 제안{old ? ` · "${old.title}" 을(를) 바꾸자는 것` : ''}</span>
              {!readOnly && <button className="btn primary" onClick={() => run(window.dure.agreements.accept(a.id))} title="약속으로 받아들이고 모든 에이전트에게 알립니다">받아들이기</button>}
              {!readOnly && <button className="btn ghost" onClick={() => run(window.dure.agreements.remove(a.id))}>버리기</button>}
            </div>
            <div className="agreement-body"><Markdown text={a.body} /></div>
          </div>
        );
      })}
      {editing && (
        <div className="agreement edit">
          <div className="agreement-head">
            <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as AgreementKind })}>
              {(Object.keys(KIND_LABEL) as AgreementKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <input type="text" className="grow" autoFocus value={editing.title} placeholder='제목 (예: "POST /login 요청과 응답")' onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          </div>
          <textarea className="agreement-text" value={editing.body} placeholder="내용 (마크다운). 에이전트가 이것만 보고 맞출 수 있게 구체적으로: 경로, 필드 이름과 형식, 예시" onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
          <div className="agreement-head">
            <span className="muted grow">저장하면 이 프로젝트의 모든 에이전트에게 알립니다.</span>
            <button className="btn primary" disabled={!editing.title.trim() || !editing.body.trim()} onClick={save}>저장</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>취소</button>
          </div>
        </div>
      )}
      {active.length === 0 && proposed.length === 0 && !editing && <div className="rows-empty">아직 약속이 없습니다. API 형식이나 이름 규칙처럼 모든 워크스페이스가 지켜야 할 것을 적으면, 에이전트들이 읽고 따릅니다. 에이전트도 제안할 수 있습니다.</div>}
      {active.map((a) => (
        <div key={a.id} className="agreement">
          <div className="agreement-head">
            <span className="tag">{KIND_LABEL[a.kind]}</span>
            <button className="agreement-title grow" onClick={() => setOpen(open === a.id ? null : a.id)}>{a.title}</button>
            <span className="muted">{a.author}</span>
            {!readOnly && <button className="btn ghost" onClick={() => setEditing({ id: a.id, kind: a.kind, title: a.title, body: a.body })}>고치기</button>}
            {!readOnly && <button className="btn ghost danger" onClick={() => run(window.dure.agreements.remove(a.id))}>지우기</button>}
          </div>
          {open === a.id && <div className="agreement-body"><Markdown text={a.body} /></div>}
        </div>
      ))}
    </div>
  );
}
