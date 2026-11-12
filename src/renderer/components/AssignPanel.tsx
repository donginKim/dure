import { useCallback, useEffect, useState } from 'react';
import { validRepoName } from '@shared/plan';
import type { AssignChoice, AssignmentIn, AssignmentOut, Brief, Repo } from '@shared/types';
import { assignChoiceProblem, assignProgressLine, ASSIGN_STATE_LABEL } from '../planView';
import { STATUS_LABEL } from '../tree';
import { Markdown } from './Markdown';
import { describeError } from './WorkspaceView';

const NEW = '__new__';

/** 받은 배정 하나: 내용을 보고, 워크스페이스마다 어느 저장소에 만들지 골라 수락하거나 거절한다. */
function IncomingCard({ a, repos }: { a: AssignmentIn; repos: Repo[] }) {
  const [choices, setChoices] = useState<AssignChoice[]>(() => a.items.map(() => ({ repoId: repos[0]?.id ?? '', newRepo: '' })));
  const [share, setShare] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const patch = (i: number, p: Partial<AssignChoice>): void => setChoices((list) => list.map((c, k) => (k === i ? { ...c, ...p } : c)));
  const problem = assignChoiceProblem(a.items, choices);
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(describeError((e as Error).message)); } finally { setBusy(false); }
  };
  return (
    <div className="permit">
      <div className="permit-title">"{a.fromName}" 이(가) 일을 나눠 주었습니다 · 워크스페이스 {a.items.length}개, TODO {a.items.reduce((n, it) => n + it.todos.length, 0)}개</div>
      <div className="permit-hint">수락하면 <b>내 PC 에</b> 워크스페이스와 TODO 가 만들어집니다. 아직 만들어진 것은 없습니다. 다른 사람이 쓴 내용이니 읽어 보고 수락하세요. 만들어진 에이전트는 "승인 필요" 로 시작합니다.</div>
      {a.summary && (
        <div className="assign-summary">
          <button className="btn ghost" onClick={() => setOpen((v) => !v)}>{open ? '기획서 정리 접기' : '기획서 정리 보기'}</button>
          {open && <div className="plan-summary"><Markdown text={a.summary} /></div>}
        </div>
      )}
      {a.items.map((it, i) => (
        <div key={i} className="plan-ws">
          <div className="plan-ws-line">
            <span className="plan-kind">새로 만듦</span>
            <input type="text" className="plan-ws-name" value={choices[i]?.name ?? it.name} placeholder="워크스페이스 이름" onChange={(e) => patch(i, { name: e.target.value })} />
            <select value={choices[i]?.repoId || NEW} title="어느 저장소에 만들지" onChange={(e) => patch(i, { repoId: e.target.value === NEW ? '' : e.target.value })}>
              {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              <option value={NEW}>새 저장소 만들기…</option>
            </select>
            {!choices[i]?.repoId && (
              <input type="text" className={`assign-repo${choices[i]?.newRepo && !validRepoName(choices[i]!.newRepo!.trim()) ? ' bad' : ''}`} value={choices[i]?.newRepo ?? ''} placeholder="새 저장소 이름 (영문, 숫자, . _ -)" onChange={(e) => patch(i, { newRepo: e.target.value })} />
            )}
          </div>
          {it.role && <div className="plan-detail">맡을 일: {it.role}</div>}
          <div className="plan-todos">
            {it.todos.map((t, k) => (
              <div key={k} className="plan-todo">
                <span className={`plan-who${t.assignee === 'user' ? ' me' : ''}`}>{t.assignee === 'user' ? '나' : '에이전트'}</span>
                <div className="plan-todo-text"><div>{t.title}</div>{t.detail && <div className="plan-detail">{t.detail}</div>}</div>
              </div>
            ))}
            {it.todos.length === 0 && <div className="plan-none">TODO 가 없습니다.</div>}
          </div>
        </div>
      ))}
      <label className="assign-share" title="끄면 나눠 준 사람은 내가 수락했다는 것만 압니다">
        <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
        만들어진 워크스페이스를 "{a.fromName}" 에게 공개합니다 (그 사람에게 TODO 의 제목과 상태가 보이고, 에이전트끼리 메시지를 주고받을 수 있습니다. 코드는 보이지 않습니다)
      </label>
      {error && <div className="error">{error}</div>}
      <div className="permit-actions">
        {declining ? (
          <>
            <input type="text" autoFocus className="plan-reason" value={reason} placeholder="거절하는 이유 (나눠 준 사람에게 전해집니다. 비워도 됩니다)" onChange={(e) => setReason(e.target.value)} />
            <button className="btn" disabled={busy} onClick={() => void run(() => window.dure.assignments.decline(a.id, reason))}>거절하기</button>
            <button className="btn ghost" disabled={busy} onClick={() => setDeclining(false)}>취소</button>
          </>
        ) : (
          <>
            {problem && <span className="plan-count">{problem}</span>}
            <button className="btn primary" disabled={busy || problem !== null} onClick={() => void run(() => window.dure.assignments.accept(a.id, choices.map((c) => ({ repoId: c.repoId, newRepo: c.repoId ? undefined : c.newRepo?.trim(), name: c.name?.trim() || undefined })), share))}>{busy ? '만드는 중…' : `수락하고 워크스페이스 ${a.items.length}개 만들기`}</button>
            <button className="btn" disabled={busy} onClick={() => setDeclining(true)}>거절</button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 배정: 다른 사람이 나눠 준 일(수락을 기다리는 것)과, 내가 나눠 준 일의 현황.
 * 나눠 준 일은 읽기만 한다: 그 사람의 PC 에 있는 TODO 의 제목과 상태가 보인다.
 */
export function AssignPanel({ projectId, repos, readOnly }: { projectId: string; repos: Repo[]; readOnly: boolean }) {
  const [incoming, setIncoming] = useState<AssignmentIn[]>([]);
  const [outgoing, setOutgoing] = useState<AssignmentOut[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [briefError, setBriefError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const load = useCallback(() => {
    void Promise.all([window.dure.assignments.incoming(projectId), window.dure.assignments.outgoing(projectId), window.dure.assignments.briefs(projectId)])
      .then(([i, o, b]) => { setIncoming(i.filter((a) => a.state === 'pending')); setOutgoing(o); setBriefs(b); }).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'peers' || topic === 'coordinator' || topic === 'repos') load(); });
  }, [load]);
  if (incoming.length === 0 && outgoing.length === 0 && briefs.length === 0) return null;
  const act = (p: Promise<void>): void => { setBriefError(''); p.catch((e: Error) => setBriefError(e.message)).finally(load); };
  return (
    <div className="assign">
      {!readOnly && briefs.map((b) => (
        <div key={b.id} className="permit">
          <div className="permit-title">"{b.fromName}" 이(가) 기획서 정리를 보냈습니다</div>
          <div className="permit-hint">이 프로젝트에서 무엇을 만드는지 정리한 글입니다. 나에게 맡긴 일은 없습니다. 자료로 받으면 내 에이전트가 읽을 수 있습니다 (다른 사람이 쓴 글이고 지시가 아니라고 함께 적어 둡니다).</div>
          <div className="assign-summary">
            <button className="btn ghost" onClick={() => setShown((s) => ({ ...s, [b.id]: !s[b.id] }))}>{shown[b.id] ? '접기' : '읽어 보기'}</button>
            {shown[b.id] && <div className="plan-summary"><Markdown text={b.summary} /></div>}
          </div>
          {briefError && <div className="error">{briefError}</div>}
          <div className="permit-actions">
            <button className="btn primary" onClick={() => act(window.dure.assignments.takeBrief(b.id))}>자료로 받기</button>
            <button className="btn" onClick={() => act(window.dure.assignments.dropBrief(b.id))}>버리기</button>
          </div>
        </div>
      ))}
      {!readOnly && incoming.map((a) => <IncomingCard key={a.id} a={a} repos={repos} />)}
      {outgoing.length > 0 && (
        <div className="assign-out">
          <div className="plan-label">나눠 준 일 <span className="count">{outgoing.length}</span><span className="plan-hint">다른 사람의 PC 에 있는 일입니다. 여기서는 보기만 합니다</span></div>
          <div className="rows">
            {outgoing.map((a) => (
              <div key={a.id} className="assign-row">
                <button className="row assign-head" onClick={() => setOpen((o) => ({ ...o, [a.id]: !o[a.id] }))}>
                  <span className={`tag assign-${a.state}`}>{ASSIGN_STATE_LABEL[a.state]}</span>
                  <div className="grow"><b>{a.peerName}</b> · {a.items.map((it) => it.name).join(', ')}</div>
                  <span className="muted">{assignProgressLine(a)}</span>
                </button>
                {open[a.id] && (
                  <div className="assign-detail">
                    {a.state === 'declined' && <div className="plan-note">거절했습니다{a.note ? `: ${a.note}` : '.'} 이 일은 만들어지지 않았습니다.</div>}
                    {a.state === 'sent' && a.items.map((it, i) => <div key={i} className="plan-detail">{it.name}: {it.role || '(맡을 일 없음)'} · TODO {it.todos.length}개</div>)}
                    {a.state === 'accepted' && a.progress.length === 0 && <div className="plan-detail">수락했습니다. 진행 상황은 그 사람이 워크스페이스를 공개했을 때만 보입니다.</div>}
                    {a.progress.map((w) => (
                      <div key={w.workspaceId} className="assign-ws">
                        <div><b>{w.name}</b> <span className="tag">{(STATUS_LABEL as Record<string, string>)[w.status] ?? w.status}</span> {w.summary && <span className="muted">{w.summary}</span>}</div>
                        {w.todos.map((t, i) => <div key={i} className={`assign-todo ${t.status}`}><span className="assign-mark">{t.status === 'done' ? '✓' : t.status === 'doing' ? '▶' : '·'}</span>{t.title}</div>)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
