import { useCallback, useEffect, useState } from 'react';
import type { ReviewState } from '@shared/types';

/**
 * 커밋 창의 리뷰: 리뷰 에이전트가 변경을 읽고 찾은 것. 높음부터 보인다.
 * "에이전트에게 고치게 하기" 는 고른 것(없으면 전부)을 그 워크스페이스의 에이전트에게 보낸다.
 */
export function ReviewSection({ workspaceId, hasChanges }: { workspaceId: string; hasChanges: boolean }) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => { window.dure.review.status(workspaceId).then(setState).catch(() => setState(null)); }, [workspaceId]);
  useEffect(() => {
    load();
    return window.dure.onChanged((topic) => { if (topic === 'commit') load(); });
  }, [load]);
  useEffect(() => { setPicked([]); }, [state?.at]);
  const run = (): void => { setError(''); setNote(''); window.dure.review.run(workspaceId).then(setState).catch((e: Error) => setError(e.message)); };
  const send = (): void => {
    setError('');
    window.dure.review.sendToAgent(workspaceId, picked.length ? picked : undefined)
      .then(() => setNote(`${picked.length || state?.findings.length || 0}건을 에이전트에게 보냈습니다. 고친 뒤 커밋 초안을 다시 올리면 다시 리뷰합니다.`))
      .catch((e: Error) => setError(e.message));
  };
  const running = state?.state === 'running';
  return (
    <div className="review">
      <div className="review-head">
        <div className="grow">
          <b>리뷰</b>{' '}
          <span className="muted">
            {running ? '리뷰 에이전트가 변경을 읽는 중… (몇 분 걸릴 수 있습니다)'
              : !state ? '아직 리뷰하지 않았습니다. 에이전트가 커밋 초안을 올리면 저절로 리뷰합니다 (설정).'
                : state.state === 'failed' ? `리뷰하지 못했습니다: ${state.error}`
                  : state.findings.length === 0 ? `찾은 문제가 없습니다.${state.summary ? ` ${state.summary}` : ''}`
                    : `${state.findings.length}건 · ${state.summary}`}
            {state?.stale && !running && ' (리뷰한 뒤에 바뀌었습니다)'}
          </span>
        </div>
        <button className="btn ghost" disabled={running || !hasChanges} onClick={run}>{state ? '다시 리뷰' : '리뷰 받기'}</button>
        {state?.state === 'done' && state.findings.length > 0 && (
          <button className="btn" onClick={send} title="고른 것(고르지 않으면 전부)을 이 워크스페이스의 에이전트에게 보내 고치게 합니다">
            {picked.length ? `${picked.length}건 에이전트에게 고치게 하기` : '에이전트에게 고치게 하기'}
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {note && <div className="muted review-note">{note}</div>}
      {state?.state === 'done' && state.findings.length > 0 && (
        <div className="review-list">
          {state.findings.map((f, i) => (
            <label key={i} className={`review-item sev-${f.severity}`}>
              <input type="checkbox" checked={picked.includes(i)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, i] : p.filter((x) => x !== i)))} />
              <span className="review-sev">{f.severity}</span>
              <span className="grow">
                <span className="review-title">{f.title}</span>
                {f.file && <code className="review-where">{f.file}{f.line ? `:${f.line}` : ''}</code>}
                {f.detail && <span className="review-detail">{f.detail}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
