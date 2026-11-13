import { useCallback, useEffect, useState } from 'react';
import { Help } from './Help';
import type { CleanupItem, CompletionChoice, CompletionPlan, Project } from '@shared/types';
import { choiceSummary, defaultChoice, formatBytes, ignoredNote, seenCounts, worktreeRisk } from '../cleanupView';
import { clock } from '../conversationView';

/** 프로젝트의 "정리 대기": 에이전트가 최종 산출물이 아니라고 보고 옮겨 둔 것. 잘못 옮긴 것은 되돌린다. */
export function CleanupList({ project, readOnly }: { project: Project; readOnly: boolean }) {
  const [items, setItems] = useState<CleanupItem[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    window.dure.cleanup.list(project.id).then(setItems).catch((e: Error) => setError(e.message));
  }, [project.id]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'cleanup' || topic === 'projects') load(); });
  }, [load]);

  const restore = (id: string): void => {
    setError('');
    window.dure.cleanup.restore(id).catch((e: Error) => setError(e.message));
  };
  const total = items.reduce((n, i) => n + i.size, 0);

  return (
    <div className="section">
      <div className="section-head">
        <h2>정리 대기{items.length > 0 && <span className="count">{items.length}</span>}</h2>
        {items.length > 0 && <span className="muted">{formatBytes(total)}</span>}
      </div>
      {error && <div className="error" style={{ marginBottom: 8 }}>{error}</div>}
      {items.length === 0
        ? <div className="rows"><div className="rows-empty">옮겨 둔 것이 없습니다. 에이전트가 작업을 끝내며 최종 산출물이 아닌 파일(실험용 스크립트, 로그, 임시 메모)을 여기로 옮깁니다.</div></div>
        : (
          <div className="rows">
            {items.map((i) => (
              <div key={i.id} className="row cleanup-row">
                <div className="grow">
                  <div className="cleanup-path">{i.isDir ? `${i.path}/` : i.path}</div>
                  <div className="cleanup-meta">{i.workspaceName} · {formatBytes(i.size)} · {clock(i.createdAt)}{i.reason && ` · ${i.reason}`}</div>
                </div>
                {!readOnly && i.workspaceId !== null && <button className="btn ghost" title="작업 폴더의 원래 자리로 돌려놓습니다" onClick={() => restore(i.id)}>되돌리기</button>}
                <button className="btn ghost" title="고른 폴더로 꺼냅니다 (정리 대기에서는 빠집니다)" onClick={() => { setError(''); window.dure.cleanup.export(i.id).catch((e: Error) => setError(e.message)); }}>내보내기</button>
              </div>
            ))}
          </div>
        )}
      <Help>지운 것이 아니라 저장소 밖에 옮겨 둔 것입니다. 커밋에 들어가지 않습니다. 프로젝트를 완료 처리할 때 목록을 보고 지웁니다.</Help>
    </div>
  );
}

/** 프로젝트 완료 처리: 지울 것을 보고 고른 뒤 완료로 옮긴다. */
export function CompleteDialog({ project, onClose, onDone }: { project: Project; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<CompletionPlan | null>(null);
  const [choice, setChoice] = useState<CompletionChoice>({ removeWorktrees: [], removeItems: [], seen: {} });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    window.dure.cleanup.plan(project.id).then((p) => { if (alive) { setPlan(p); setChoice(defaultChoice(p)); } }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [project.id]);

  const toggle = (key: 'removeWorktrees' | 'removeItems', id: string): void => {
    setChoice((c) => ({ ...c, [key]: c[key].includes(id) ? c[key].filter((x) => x !== id) : [...c[key], id] }));
  };
  const submit = async (): Promise<void> => {
    setBusy(true); setError('');
    try {
      await window.dure.cleanup.complete(project.id, { ...choice, seen: plan ? seenCounts(plan) : {} });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      // 상태가 바뀌었을 수 있다. 다시 읽고, 고른 것도 새 상태에 맞춰 처음부터 다시 정하게 한다.
      window.dure.cleanup.plan(project.id).then((p) => { setPlan(p); setChoice(defaultChoice(p)); }).catch(() => undefined);
    } finally { setBusy(false); }
  };
  const running = plan?.workspaces.filter((w) => w.agentRunning).length ?? 0;
  const allItems = plan !== null && plan.items.length > 0 && plan.items.every((i) => choice.removeItems.includes(i.id));

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dialog wide">
        <h3>"{project.name}" 완료 처리</h3>
        <div className="complete-lead">
          프로젝트를 "완료" 로 옮깁니다. TODO, 에이전트끼리의 대화, 올린 자료 같은 기록은 남고, 나중에 다시 열 수 있습니다.
          아래에서 체크한 것만 지웁니다. <b>지운 것은 되돌릴 수 없습니다.</b>
        </div>
        {error && <div className="error">{error}</div>}
        {!plan && !error && <div className="muted">확인하는 중…</div>}
        {plan && (
          <>
            {running > 0 && <div className="notice">켜져 있는 에이전트 {running}개를 끕니다. 채팅 방식의 대화는 다시 열고 시작하면 이어집니다.</div>}
            <div className="complete-title">작업 폴더</div>
            <div className="rows complete-rows">
              {plan.workspaces.length === 0 && <div className="rows-empty">워크스페이스가 없습니다.</div>}
              {plan.workspaces.map((w) => {
                const risk = worktreeRisk(w);
                return (
                  <label key={w.id} className={`row complete-row${!w.exists ? ' off' : ''}`}>
                    <input type="checkbox" disabled={!w.exists || busy} checked={w.exists && choice.removeWorktrees.includes(w.id)} onChange={() => toggle('removeWorktrees', w.id)} />
                    <div className="grow">
                      <div>{w.name} <span className="muted">· {w.branch}</span></div>
                      <div className="cleanup-path">{w.worktreePath}</div>
                      {!w.exists && <div className="cleanup-meta">작업 폴더가 이미 없습니다</div>}
                      {risk && <div className={`complete-risk${w.uncommitted !== 0 ? ' bad' : ''}`}>{risk}</div>}
                      {ignoredNote(w) && <div className="complete-risk">{ignoredNote(w)}</div>}
                    </div>
                  </label>
                );
              })}
            </div>
            <Help>작업 폴더만 지웁니다. 브랜치와 커밋은 저장소에 그대로 남습니다.</Help>
            <div className="complete-title">
              정리 대기
              {plan.items.length > 0 && (
                <button className="btn ghost" onClick={() => setChoice((c) => ({ ...c, removeItems: allItems ? [] : plan.items.map((i) => i.id) }))}>{allItems ? '모두 해제' : '모두 선택'}</button>
              )}
            </div>
            <div className="rows complete-rows">
              {plan.items.length === 0 && <div className="rows-empty">옮겨 둔 것이 없습니다.</div>}
              {plan.items.map((i) => (
                <label key={i.id} className="row complete-row">
                  <input type="checkbox" disabled={busy} checked={choice.removeItems.includes(i.id)} onChange={() => toggle('removeItems', i.id)} />
                  <div className="grow">
                    <div className="cleanup-path">{i.isDir ? `${i.path}/` : i.path}</div>
                    <div className="cleanup-meta">{i.workspaceName} · {formatBytes(i.size)}{i.reason && ` · ${i.reason}`}</div>
                  </div>
                </label>
              ))}
            </div>
            <Help>체크하지 않은 것은 정리 대기에 그대로 남습니다.</Help>
          </>
        )}
        <div className="dialog-actions">
          {plan && <span className="complete-summary">{choiceSummary(plan, choice)}</span>}
          <button className="btn" disabled={busy} onClick={onClose}>취소</button>
          <button className="btn primary" disabled={!plan || busy} onClick={() => void submit()}>{busy ? '처리하는 중…' : '완료 처리'}</button>
        </div>
      </div>
    </div>
  );
}
