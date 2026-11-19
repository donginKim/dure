import { useCallback, useEffect, useState } from 'react';
import type { AuditActorKind, AuditEntry, AuditFilter, AuditOutcome, AuditVerify, Project } from '@shared/types';
import { ACTOR_LABEL, actionLabel, detailText, groupOf, GROUPS, OUTCOME_LABEL, timeText } from '../auditView';
import { Empty } from './Empty';

const PERIODS: { id: string; label: string; ms: number }[] = [{ id: 'day', label: '오늘', ms: 86_400_000 }, { id: 'week', label: '7일', ms: 7 * 86_400_000 }, { id: 'month', label: '30일', ms: 30 * 86_400_000 }, { id: 'all', label: '전체', ms: 0 }];

/**
 * 감사 기록: 누가(사용자, 에이전트, 다른 사람, 두레) 무엇을 했고 어떻게 됐는지. 본문(프롬프트, 메시지, 조회 결과, 비밀 값)은 담지 않는다.
 * 줄마다 앞 줄의 지문으로 이어져 있어, 고치거나 빼면 "이어짐 확인" 에서 드러난다. JSONL·CSV 로 내보낸다.
 */
export function AuditView({ projects }: { projects: Project[] }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [actor, setActor] = useState<AuditActorKind | ''>('');
  const [outcome, setOutcome] = useState<AuditOutcome | ''>('');
  const [group, setGroup] = useState('');
  const [projectId, setProjectId] = useState('');
  const [period, setPeriod] = useState('week');
  const [check, setCheck] = useState<AuditVerify | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const filter = useCallback((): AuditFilter => {
    const ms = PERIODS.find((p) => p.id === period)?.ms ?? 0;
    return { actor: actor || undefined, outcome: outcome || undefined, projectId: projectId || undefined, since: ms ? Date.now() - ms : undefined };
  }, [actor, outcome, projectId, period]);
  // 묶음은 동작 이름의 앞머리 여럿이라 화면에서 거른다 (서버는 앞머리 하나만 거른다).
  const inGroup = useCallback((e: AuditEntry): boolean => !group || groupOf(e.action) === group, [group]);

  const load = useCallback(() => {
    const f = filter();
    window.dure.audit.list({ ...f, limit: 300 }).then(setRows).catch((e: Error) => setError(e.message));
    window.dure.audit.count(f).then(setTotal).catch(() => undefined);
  }, [filter]);
  useEffect(() => { load(); return window.dure.onChanged((topic) => { if (topic === 'audit') load(); }); }, [load]);

  const more = (): void => {
    const last = rows[rows.length - 1];
    if (!last) return;
    window.dure.audit.list({ ...filter(), limit: 300, before: last.seq }).then((next) => setRows((cur) => [...cur, ...next])).catch((e: Error) => setError(e.message));
  };
  const verify = (): void => { setBusy(true); setError(''); window.dure.audit.verify().then(setCheck).catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); };
  const save = (format: 'jsonl' | 'csv'): void => {
    setBusy(true); setError(''); setNote('');
    window.dure.audit.export(format, filter()).then((p) => { if (p) setNote(`내보냈습니다: ${p}`); }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const shown = rows.filter(inGroup);
  const projectName = (id: string): string => projects.find((p) => p.id === id)?.name ?? '';

  return (
    <div className="page audit">
      <div className="section-head">
        <h1>감사 기록</h1>
        <div className="audit-actions">
          <button className="btn ghost" disabled={busy} onClick={verify} title="첫 줄부터 끝 줄까지 지문이 이어져 있는지 확인합니다. 누가 줄을 고치거나 뺐으면 어디서 어긋났는지 알려 줍니다">이어짐 확인</button>
          <button className="btn" disabled={busy} onClick={() => save('jsonl')} title="지금 거른 조건의 기록을 내보냅니다. 받는 쪽이 지문으로 이어짐을 다시 확인할 수 있는 형식입니다">JSONL 로 내보내기</button>
          <button className="btn ghost" disabled={busy} onClick={() => save('csv')} title="표 계산 프로그램에서 열어 보는 용도입니다">CSV</button>
        </div>
      </div>
      <div className="sub">누가 무엇을 했고 어떻게 됐는지를 적습니다. 프롬프트·메시지·조회 결과·비밀 값 같은 본문은 적지 않습니다 (이름, 종류, 개수, 결과만). 보관 기간은 설정의 "감사 기록" 에서 정합니다.</div>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      {check && (
        <div className={`notice ${check.ok ? 'ok' : 'audit-bad'}`} role="status">
          <span className="grow">
            {check.ok
              ? <>이어져 있습니다. {check.count.toLocaleString('ko-KR')}줄 ({check.firstSeq}번 ~ {check.lastSeq}번){check.pruned > 0 && ` · 보관 기간이 지나 지운 줄 ${check.pruned.toLocaleString('ko-KR')}개`}. 마지막 지문 <code>{check.head.slice(0, 16)}…</code></>
              : <><b>{check.brokenAt}번 줄에서 이어짐이 어긋났습니다.</b> 그 줄이나 그 앞의 줄이 고쳐졌거나 빠졌습니다. 그 앞의 {check.count.toLocaleString('ko-KR')}줄은 이어져 있습니다.</>}
          </span>
          <button className="btn ghost" onClick={() => setCheck(null)}>닫기</button>
        </div>
      )}
      {note && <div className="notice ok"><span className="grow audit-path">{note}</span><button className="btn ghost" onClick={() => setNote('')}>닫기</button></div>}
      <div className="audit-filters">
        <label>기간 <select value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <label>누가 <select value={actor} onChange={(e) => setActor(e.target.value as AuditActorKind | '')}><option value="">모두</option>{(Object.keys(ACTOR_LABEL) as AuditActorKind[]).map((a) => <option key={a} value={a}>{ACTOR_LABEL[a]}</option>)}</select></label>
        <label>무엇을 <select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">모두</option>{GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
        <label>결과 <select value={outcome} onChange={(e) => setOutcome(e.target.value as AuditOutcome | '')}><option value="">모두</option>{(Object.keys(OUTCOME_LABEL) as AuditOutcome[]).map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}</select></label>
        <label>프로젝트 <select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">모두</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <span className="grow" />
        <span className="muted">{group ? `${shown.length.toLocaleString('ko-KR')}줄 (읽어 온 ${rows.length.toLocaleString('ko-KR')}줄 가운데)` : `${total.toLocaleString('ko-KR')}줄`}</span>
      </div>
      {shown.length === 0 && <Empty hint="에이전트를 시작하거나, 승인에 답하거나, 플러그인을 설치하는 것 같은 일이 생기면 여기에 한 줄씩 쌓입니다.">이 조건에 맞는 기록이 없습니다.</Empty>}
      {shown.length > 0 && (
        <div className="audit-table" role="table" aria-label="감사 기록">
          <div className="audit-row audit-head" role="row"><span role="columnheader">때</span><span role="columnheader">누가</span><span role="columnheader">무엇을</span><span role="columnheader">대상</span><span role="columnheader">결과</span><span role="columnheader">까닭·덧붙임</span></div>
          {shown.map((e) => (
            <div key={e.seq} className={`audit-row ${e.outcome}`} role="row" title={`${e.seq}번 · ${e.action} · ${e.hash.slice(0, 16)}…`}>
              <span role="cell" className="audit-time">{timeText(e.at)}</span>
              <span role="cell"><span className={`tag audit-${e.actor}`}>{ACTOR_LABEL[e.actor]}</span>{e.actorName && <span className="audit-who"> {e.actorName}</span>}</span>
              <span role="cell" className="audit-what">{actionLabel(e.action)}</span>
              <span role="cell" className="audit-target">{[projectName(e.projectId), e.target].filter(Boolean).join(' › ')}</span>
              <span role="cell"><span className={`tag audit-out-${e.outcome}`}>{OUTCOME_LABEL[e.outcome]}</span></span>
              <span role="cell" className="audit-why">{[e.reason, detailText(e)].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
        </div>
      )}
      {rows.length > 0 && rows.length < total && <button className="btn ghost audit-more" onClick={more}>앞의 기록 더 보기</button>}
    </div>
  );
}
