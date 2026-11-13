import { useCallback, useEffect, useState } from 'react';
import type { Repo, VerifyState, Workspace } from '@shared/types';
import { verifyLine } from '../verifyView';

/** 저장소의 확인 명령을 적는 칸. Enter 를 누르거나 칸을 벗어나면 저장한다. */
export function VerifyCommand({ repo, readOnly, onError }: { repo: Repo; readOnly: boolean; onError: (m: string) => void }) {
  const [text, setText] = useState(repo.verifyCommand);
  useEffect(() => { setText(repo.verifyCommand); }, [repo.verifyCommand]);
  const commit = (): void => {
    if (text.trim() === repo.verifyCommand) return;
    window.dure.repos.setVerify(repo.id, text).catch((e: Error) => { onError(e.message); setText(repo.verifyCommand); });
  };
  return (
    <label className="verify-cmd" title="에이전트가 TODO 를 완료로 바꿀 때 두레가 이 명령을 그 워크스페이스의 작업 폴더에서 돌립니다. 실패하면 완료로 바뀌지 않습니다. 비워 두면 확인하지 않습니다">
      <span className="muted">확인 명령</span>
      <input type="text" value={text} disabled={readOnly} spellCheck={false} placeholder="예: pnpm test  (비워 두면 확인하지 않습니다)"
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
    </label>
  );
}

/** 워크스페이스의 마지막 확인: 통과했는지, 실패했으면 출력. "지금 확인" 으로 직접 돌릴 수 있다. 확인 명령이 없으면 보이지 않는다. */
export function VerifyStatus({ workspace, readOnly }: { workspace: Workspace; readOnly?: boolean }) {
  const [state, setState] = useState<VerifyState | null>(null);
  const [open, setOpen] = useState(false);
  const [, setNow] = useState(0);
  const load = useCallback(() => {
    window.dure.verify.statuses(workspace.projectId).then((all) => setState(all[workspace.id] ?? null)).catch(() => setState(null));
  }, [workspace.id, workspace.projectId]);
  useEffect(() => {
    load();
    const off = window.dure.onChanged((topic) => { if (topic === 'todos' || topic === 'repos') load(); });
    const t = setInterval(() => setNow((n) => n + 1), 60_000);
    return () => { off(); clearInterval(t); };
  }, [load]);
  if (!state) return null;
  return (
    <div className={`verify ${state.state}`}>
      <div className="verify-line">
        <span className={`dot ${state.state === 'running' ? 'working' : state.state === 'failed' ? 'error' : state.state === 'passed' ? 'idle' : 'stopped'}`} />
        <span className="grow" title={`확인 명령: ${state.command}`}>{verifyLine(state, Date.now())}</span>
        {state.state === 'failed' && <button className="btn ghost" onClick={() => setOpen((v) => !v)}>{open ? '출력 닫기' : '출력 보기'}</button>}
        {!readOnly && <button className="btn ghost" disabled={state.state === 'running'} title={`지금 확인 명령을 돌립니다: ${state.command}`} onClick={() => { window.dure.verify.run(workspace.id).catch(() => undefined); }}>지금 확인</button>}
      </div>
      {open && state.state === 'failed' && <pre className="verify-out">{state.output || '(출력 없음)'}</pre>}
    </div>
  );
}
